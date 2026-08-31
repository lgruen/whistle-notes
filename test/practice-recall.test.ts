import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alignAttempt,
  countVerdicts,
  undoTuningCorrection,
  type Alignment,
  type TargetNote,
} from "../src/practice/align.js";
import { holdScoreText, scoreHold } from "../src/practice/drill.js";
import {
  TARGET_GAP_SEC,
  intervalName,
  listenCountText,
  ordinal,
  overlayModel,
  scoreText,
  takeawayText,
  targetPlayback,
  transpositionText,
  tuningText,
  verdictChips,
  type HeardNote,
} from "../src/practice/recall.js";
import { drawDiffOverlay, trailFromFrames } from "../src/ui/diffroll.js";
import { midiToHz, transcribe, type PitchFrame } from "../src/dsp/index.js";
import { sequence } from "./fixtures/synth.js";

/**
 * The recall exercise, tested where it is arithmetic and words.
 *
 * Three claims are worth defending here and none of them is visible in a
 * screenshot:
 *
 * 1. **A target can be played at all.** Targets carry durations and no start
 *    times, so laying them on a timeline is a conversion — and the one thing
 *    that conversion must not do is butt two identical notes together, which
 *    would hand the user a melody with a note silently missing.
 * 2. **The overlay draws the aligner's claim and not a different one.** Every
 *    pitch on that canvas is in the *attempt's* register, so the vertical
 *    distance between a note and its ghost is the residual the strip reports.
 *    Get the sign or the transposition wrong and the picture is a confident,
 *    beautifully drawn lie.
 * 3. **The sentences are true of the attempt they describe.** "The 4th note came
 *    out a semitone sharp" is the whole product; a wrong ordinal or a flipped
 *    sharp/flat is worse than saying nothing.
 */

/** Attempt notes from float MIDI pitches laid end to end, keeping the
 *  sub-semitone part in `centsOffset` exactly as `src/dsp` does. */
function whistled(pitches: readonly number[], durationSec = 0.4): HeardNote[] {
  const notes: HeardNote[] = [];
  let cursor = 0;
  for (const pitch of pitches) {
    const midi = Math.round(pitch);
    notes.push({
      midi,
      centsOffset: (pitch - midi) * 100,
      durationSec,
      startSec: cursor,
      endSec: cursor + durationSec,
    });
    cursor += durationSec + 0.1;
  }
  return notes;
}

function melody(midis: readonly number[], durSec = 0.4): TargetNote[] {
  return midis.map((midi) => ({ midi, durSec }));
}

/** A five-note phrase with steps and a leap: ordinary material. */
const PHRASE = [84, 86, 88, 91, 89];

/** The same phrase, turned around and brought home. Long enough that no shifted
 *  register fits it as well as its own does — which a five-note phrase with two
 *  notes missing genuinely does not guarantee. */
const LONG = [84, 86, 88, 91, 89, 86, 84];

describe("playing a target", () => {
  it("lays a melody with no start times on a timeline", () => {
    const scheduled = targetPlayback(melody([84, 86], 0.5));
    expect(scheduled).toEqual([
      { midi: 84, startSec: 0, endSec: 0.5, durationSec: 0.5 },
      { midi: 86, startSec: 0.5 + TARGET_GAP_SEC, endSec: 1 + TARGET_GAP_SEC, durationSec: 0.5 },
    ]);
  });

  /**
   * The bug this pins is the one that makes an exercise quietly unfair: two
   * identical notes butted together are one long note, the envelope never
   * closes, and the app asks for a melody it did not play.
   */
  it("leaves a gap between repeated notes, so they are two notes", () => {
    const scheduled = targetPlayback(melody([84, 84, 84]));
    for (let i = 1; i < scheduled.length; i++) {
      expect(scheduled[i].startSec - scheduled[i - 1].endSec).toBeCloseTo(TARGET_GAP_SEC, 12);
    }
  });

  it("survives a note of no length at all", () => {
    // `parseTarget` admits `durSec: 0` from a hand-edited store; the synth has
    // its own minimum, and this only has to not produce a negative span.
    const scheduled = targetPlayback([{ midi: 84, durSec: 0 }]);
    expect(scheduled[0].endSec).toBe(0);
    expect(scheduled[0].durationSec).toBe(0);
  });
});

describe("the overlay", () => {
  it("draws the target where the user should have whistled it", () => {
    // Echoed a perfect 5th above, cleanly. The aligner reports -7 (add -7 to
    // the attempt to reach the target), so every ghost is 7 semitones *up*
    // from the written pitch — i.e. right on top of the notes that were sung.
    const attempt = whistled(PHRASE.map((midi) => midi + 7));
    const alignment = alignAttempt(attempt, melody(PHRASE));
    expect(alignment.transposition).toBe(-7);

    const model = overlayModel({ alignment, attempt });
    expect(model.items).toHaveLength(PHRASE.length);
    model.items.forEach((item, i) => {
      expect(item.targetMidi).toBe(PHRASE[i] + 7);
      expect(item.heardMidi).toBeCloseTo(PHRASE[i] + 7, 9);
      expect(item.outcome).toBe("clean");
    });
  });

  it("puts every sung note on the span it was actually sung in", () => {
    const attempt = whistled(PHRASE);
    const model = overlayModel({ alignment: alignAttempt(attempt, melody(PHRASE)), attempt });
    model.items.forEach((item, i) => {
      expect(item.startSec).toBe(attempt[i].startSec);
      expect(item.endSec).toBe(attempt[i].endSec);
    });
  });

  /**
   * The distance *is* the message. A slot sung 40 cents flat has to come back as
   * a ghost 0.4 semitones above the note, in the attempt's own register — which
   * is the one place a sign error would produce a picture that looks fine and
   * says the opposite of the truth.
   */
  it("separates a note from its ghost by exactly the residual", () => {
    const attempt = whistled([84, 86, 87.6, 91, 89]);
    const alignment = alignAttempt(attempt, melody(PHRASE));
    const model = overlayModel({ alignment, attempt });

    const slot = model.items[2];
    expect(slot.outcome).toBe("off");
    // Around the attempt's own reference, which one flat note in five pulls a
    // couple of cents — and the ghost moves with it, so the vertical distance
    // on the picture is still exactly the residual on the chip.
    expect(slot.residualCents! + alignment.offsetCents).toBeCloseTo(-40, 6);
    expect((slot.heardMidi ?? 0) - (slot.targetMidi ?? 0)).toBeCloseTo(
      slot.residualCents! / 100,
      9,
    );
  });

  it("wedges a missed note into the silence where it should have been", () => {
    // The middle note simply never happened.
    const attempt = whistled([84, 86, 91, 89]);
    const alignment = alignAttempt(attempt, melody(PHRASE));
    const model = overlayModel({ alignment, attempt });

    expect(model.items.map((item) => item.outcome)).toEqual([
      "clean",
      "clean",
      "missing",
      "clean",
      "clean",
    ]);
    const missing = model.items[2];
    // It has a real, positive span...
    expect(missing.endSec).toBeGreaterThan(missing.startSec);
    // ...it is centred on the silence between the notes either side. (Not
    // *contained* by it: a note wide enough to tap will overhang a 100 ms
    // breath, and reading as squeezed in between is truer than being hidden.)
    const centre = (missing.startSec + missing.endSec) / 2;
    expect(centre).toBeGreaterThanOrEqual(model.items[1].endSec);
    expect(centre).toBeLessThanOrEqual(model.items[3].startSec);
    // ...and it is a position, not a measurement: nothing was heard.
    expect(missing.heardMidi).toBeNull();
    expect(missing.targetMidi).toBe(88);
  });

  it("shares the gap between several missed notes in a row", () => {
    // Two notes dropped out of the middle of a longer phrase. Longer, because
    // a four-note target with two notes missing is genuinely ambiguous about
    // which register the attempt was in — and the aligner is right to say so.
    const attempt = whistled([84, 86, 89, 86, 84]);
    const alignment = alignAttempt(attempt, melody(LONG));
    const model = overlayModel({ alignment, attempt });

    const missing = model.items.filter((item) => item.outcome === "missing");
    expect(missing).toHaveLength(2);
    // In order, contiguous, and neither of them zero-width.
    for (let i = 0; i < missing.length; i++) {
      expect(missing[i].endSec).toBeGreaterThan(missing[i].startSec);
      if (i > 0) expect(missing[i].startSec).toBeCloseTo(missing[i - 1].endSec, 9);
    }
  });

  it("gives a run of missed notes room even when nothing was sung around them", () => {
    // Two notes run together with no gap at all: the window the missed note
    // should occupy has zero width, and it still has to be drawable.
    const attempt: HeardNote[] = [
      { midi: 84, centsOffset: 0, durationSec: 0.4, startSec: 0, endSec: 0.4 },
      { midi: 89, centsOffset: 0, durationSec: 0.4, startSec: 0.4, endSec: 0.8 },
    ];
    const model = overlayModel({ alignment: alignAttempt(attempt, melody(PHRASE)), attempt });
    for (const item of model.items) {
      expect(Number.isFinite(item.startSec)).toBe(true);
      expect(item.endSec).toBeGreaterThan(item.startSec);
      expect(item.startSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps an extra note in the melody's order, with no ghost behind it", () => {
    const attempt = whistled([84, 86, 95, 88, 91, 89]);
    const alignment = alignAttempt(attempt, melody(PHRASE));
    const model = overlayModel({ alignment, attempt });

    expect(model.items).toHaveLength(6);
    const extra = model.items.find((item) => item.outcome === "extra");
    expect(extra?.index).toBe(2);
    expect(extra?.slot).toBeNull();
    expect(extra?.targetMidi).toBeNull();
    expect(extra?.heardMidi).toBe(95);
  });

  it("leaves room above and below everything it draws", () => {
    const attempt = whistled(PHRASE);
    const model = overlayModel({
      alignment: alignAttempt(attempt, melody(PHRASE)),
      attempt,
      trail: [{ tSec: 0, midi: 70 }],
    });
    // The trail is part of the picture, so the axis has to contain it.
    expect(model.minMidi).toBeLessThan(70);
    expect(model.maxMidi).toBeGreaterThan(91);
    expect(model.maxMidi - model.minMidi).toBeGreaterThanOrEqual(12);
  });

  it("has a shape even with nothing in it", () => {
    const model = overlayModel({
      alignment: { transposition: 0, offsetCents: 0, cost: 0, slots: [], extras: [] },
      attempt: [],
    });
    expect(model.items).toEqual([]);
    expect(model.maxMidi - model.minMidi).toBeGreaterThanOrEqual(12);
    expect(model.spanSec).toBeGreaterThan(0);
  });
});

describe("the verdict strip", () => {
  it("gives one chip per drawn item, in the melody's order", () => {
    const attempt = whistled([84, 86, 95, 88, 91, 89]);
    const model = overlayModel({ alignment: alignAttempt(attempt, melody(PHRASE)), attempt });
    const chips = verdictChips(model);

    expect(chips.map((chip) => chip.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(chips.map((chip) => chip.outcome)).toEqual([
      "clean",
      "clean",
      "extra",
      "clean",
      "clean",
      "clean",
    ]);
    // Positions are the melody's, so the extra breaks the run rather than
    // shifting everything after it.
    expect(chips.map((chip) => chip.position)).toEqual([1, 2, null, 3, 4, 5]);
  });

  /**
   * The line the ear-first rule leaves this screen: the app names what you did,
   * never what it wanted. A wrong note and an extra note are things the user
   * produced; a missed slot and the target behind every ghost are not.
   */
  it("names the notes that came out, and never the ones that were wanted", () => {
    const attempt = whistled([84, 86, 95, 91, 89]);
    const chips = verdictChips(
      overlayModel({ alignment: alignAttempt(attempt, melody(PHRASE)), attempt }),
    );
    const wrong = chips.find((chip) => chip.outcome === "wrong");
    expect(wrong?.nameMidi).toBe(95);
    for (const chip of chips) {
      if (chip.outcome === "clean" || chip.outcome === "missing") {
        expect(chip.nameMidi).toBeNull();
      }
    }
  });
});

describe("what the app says about an attempt", () => {
  const attemptWith = (pitches: readonly number[]): Alignment =>
    alignAttempt(whistled(pitches), melody(PHRASE));

  it("counts what happened without dressing it up", () => {
    expect(scoreText(attemptWith(PHRASE))).toBe("5 of 5 notes clean");
    expect(scoreText(attemptWith([84, 86, 87.6, 91, 89]))).toBe(
      "4 of 5 notes clean · 1 a little off",
    );
    expect(scoreText(attemptWith([84, 86, 91, 89]))).toBe("4 of 5 notes clean · 1 missed");
    expect(scoreText(attemptWith([84, 86, 95, 88, 91, 89]))).toBe(
      "5 of 5 notes clean · 1 extra",
    );
  });

  it("forgives the register out loud, because it is not a mistake", () => {
    expect(transpositionText(0)).toMatch(/register it played in/);
    const above = transpositionText(-7);
    expect(above).toContain("a 5th above");
    expect(above).toMatch(/which is fine/);
    expect(transpositionText(12)).toContain("an octave below");
    expect(transpositionText(-19)).toContain("an octave and a 5th above");
  });

  it("names an interval the way a person would say it", () => {
    expect(intervalName(0)).toBe("the same note");
    expect(intervalName(1)).toBe("a semitone");
    expect(intervalName(4)).toBe("a major 3rd");
    expect(intervalName(-7)).toBe("a 5th");
    expect(intervalName(12)).toBe("an octave");
    expect(intervalName(24)).toBe("2 octaves");
    expect(intervalName(17)).toBe("an octave and a 4th");
  });

  /** The sentence the whole feature is for. Ordinals count from one, and the
   *  direction is the user's, not the aligner's. */
  it("says the one thing worth doing something about", () => {
    // A wrong note beats everything else.
    expect(takeawayText(attemptWith([84, 86, 89, 91, 89]))).toBe(
      "The 3rd note came out a semitone sharp.",
    );
    expect(takeawayText(attemptWith([84, 86, 87, 91, 89]))).toBe(
      "The 3rd note came out a semitone flat.",
    );
    // Then a note that never arrived.
    expect(takeawayText(attemptWith([84, 86, 91, 89]))).toBe("The 3rd note never arrived.");
    // Then the worst of the merely-imprecise ones, in cents.
    expect(takeawayText(attemptWith([84, 86.4, 87.55, 91, 89]))).toBe(
      "The 3rd note came out 45 cents flat.",
    );
    // Then, if that is all that happened, the extras.
    expect(takeawayText(attemptWith([84, 86, 95, 88, 91, 89]))).toMatch(/one note in there/);
    // And an attempt with nothing wrong with it says so.
    expect(takeawayText(attemptWith(PHRASE))).toBe("Every note landed. Nothing to fix.");
  });

  it("counts an octave error as an octave rather than as 1200 cents", () => {
    // One note cracked into the octave above; the rest is fine, so the aligner
    // stays in the original register and reports a single wrong slot.
    const alignment = attemptWith([84, 86, 100, 91, 89]);
    expect(alignment.transposition).toBe(0);
    expect(takeawayText(alignment)).toBe("The 3rd note came out an octave high.");
  });

  it("has ordinals a person can read", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
    ]);
  });

  it("counts listens without an opinion about the number", () => {
    expect(listenCountText(0)).toBe("");
    expect(listenCountText(1)).toBe("Heard it once.");
    expect(listenCountText(4)).toBe("Heard it 4 times.");
    // No "only", no "already", no "again": the difficulty knob is the user's.
    expect(listenCountText(9)).not.toMatch(/only|already|just/i);
  });
});

/* ── The canvas ───────────────────────────────────────────────────────── */

interface Point {
  x: number;
  y: number;
}

/** Records the paths the renderer builds; a `roundRect` is one `moveTo` and no
 *  `lineTo`, a gridline is one of each, and the trail is many of both. */
class RecordingContext {
  readonly paths: { moves: Point[]; lines: Point[]; fills: number; strokes: number }[] = [];
  private current = { moves: [] as Point[], lines: [] as Point[], fills: 0, strokes: 0 };

  font = "";
  textBaseline = "";
  textAlign = "";
  strokeStyle = "";
  fillStyle = "";
  globalAlpha = 1;
  lineWidth = 1;
  lineJoin = "";
  readonly labels: string[] = [];

  setTransform(): void {}
  clearRect(): void {}
  closePath(): void {}
  arcTo(): void {}
  fillText(text: string): void {
    this.labels.push(text);
  }
  fill(): void {
    this.current.fills++;
  }
  stroke(): void {
    this.current.strokes++;
  }
  beginPath(): void {
    this.current = { moves: [], lines: [], fills: 0, strokes: 0 };
    this.paths.push(this.current);
  }
  moveTo(x: number, y: number): void {
    this.current.moves.push({ x, y });
  }
  lineTo(x: number, y: number): void {
    this.current.lines.push({ x, y });
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  clientWidth = 350;
  clientHeight = 150;
  readonly context = new RecordingContext();
  getContext(): RecordingContext {
    return this.context;
  }
}

beforeEach(() => {
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The whistler's own reference, end to end through the real pipeline.
 *
 * These are the only tests in this file that synthesise audio and run
 * `transcribe`, and they have to: the decision they pin is about what the
 * *segmenter* hands the aligner. `src/dsp` removes each take's global tuning
 * bias before rounding to note names, so a recall screen fed the corrected
 * notes measures residuals that have already been taken out — and then falls
 * off a cliff the moment that correction's concentration gate stops firing.
 * See the reference note in `practice/align.ts` for the decision itself.
 */
describe("a whistler who runs sharp all the way through", () => {
  const MELODY = [84, 86, 88, 86, 84, 83, 85];

  /** One take through the real pipeline, scored the way `main.ts` scores it. */
  function attemptAt(cents: (i: number) => number): Alignment {
    const target: TargetNote[] = MELODY.map((midi) => ({ midi, durSec: 0.5 }));
    const signal = sequence(
      target.map((note, i) => ({
        midi: note.midi,
        detuneCents: cents(i),
        durSec: 0.5,
        gapSec: 0.12,
      })),
      { sampleRate: 48000 },
    );
    const result = transcribe(signal.samples, signal.sampleRate);
    // Exactly what `applyAttemptTake` does: the correction goes back on before
    // the aligner sees anything.
    const heard = undoTuningCorrection(result.notes, result.tuningOffsetCents);
    return alignAttempt(heard, target);
  }

  it("is told so, and scored against it", () => {
    const alignment = attemptAt(() => 45);
    expect(alignment.offsetCents).toBeCloseTo(45, 0);
    expect(countVerdicts(alignment).clean).toBe(MELODY.length);
    expect(tuningText(alignment.offsetCents)).toBe(
      "You ran about 45 cents sharp throughout — scored against that.",
    );
  });

  it("hears the same number from the hold drill, in the same words", () => {
    // The two exercises measure different things — shape here, absolute aim
    // there — but the same habit, so they must not describe it differently.
    const held = sequence([{ midi: 84, detuneCents: 45, durSec: 2.5 }], { sampleRate: 48000 });
    const frames = transcribe(held.samples, held.sampleRate).frames;
    const score = scoreHold(trailFromFrames(frames, 0), 84);
    expect(holdScoreText(score!)).toContain("45 cents sharp");
    expect(tuningText(attemptAt(() => 45).offsetCents)).toContain("45 cents sharp");
  });

  it("loses the reference gradually as the whistling scatters, with no step", () => {
    // The cliff, measured. The DSP's own correction switches off somewhere
    // between ±20 and ±25 cents of jitter here, and used to take the scoring
    // with it: seven clean notes became two clean, five off and one wrong, with
    // 48-cent residuals. Nothing may step now.
    const jitter = (i: number, spread: number): number => spread * Math.sin(i * 2.399963);
    const mean = (alignment: Alignment): number =>
      alignment.slots.reduce((total, slot) => total + Math.abs(slot.residualCents ?? 0), 0) /
      alignment.slots.length;

    let previous: Alignment | null = null;
    for (const spread of [0, 10, 20, 25, 30, 35, 40]) {
      const alignment = attemptAt((i) => 45 + jitter(i, spread));
      expect(countVerdicts(alignment).wrong, `spread ${spread}`).toBe(0);
      expect(countVerdicts(alignment).missing, `spread ${spread}`).toBe(0);
      // The reference is still most of the bias even at the far end, and the
      // residual it leaves behind grows in step with the scatter rather than
      // jumping when a threshold is crossed.
      expect(alignment.offsetCents, `spread ${spread}`).toBeGreaterThan(20);
      if (previous) {
        expect(previous.offsetCents - alignment.offsetCents, `spread ${spread}`).toBeGreaterThan(0);
        expect(mean(alignment) - mean(previous), `spread ${spread}`).toBeLessThan(10);
      }
      previous = alignment;
    }
    expect(mean(previous!)).toBeLessThan(40);
  });
});

describe("drawing the diff", () => {
  /**
   * An octave below {@link PHRASE}, so the drawn range spans two octave
   * gridlines — which is what {@link mapping} needs to recover the renderer's
   * private geometry without hard-coding a copy of it.
   *
   * The second note is 40 cents *sharp* against the third's 40 flat, so the
   * attempt's own reference is zero by symmetry and the ghosts sit at whole
   * semitones. Otherwise the reference moves them a fraction and the padded
   * range slides off one of the two gridlines this test reads its geometry
   * from.
   */
  const attempt = whistled([74, 76.4, 77.6, 81, 79]);
  const alignment = alignAttempt(attempt, melody([74, 76, 78, 81, 79]));
  const model = overlayModel({ alignment, attempt });

  function draw(highlight: number | null = null): FakeCanvas {
    const canvas = new FakeCanvas();
    drawDiffOverlay(canvas as unknown as HTMLCanvasElement, { model, trail: [], highlight });
    return canvas;
  }

  /** Recover the pitch→y mapping from the octave gridlines, rather than
   *  hard-coding a copy of the renderer's private padding. */
  function mapping(canvas: FakeCanvas): (midi: number) => number {
    const cs: number[] = [];
    for (let midi = Math.ceil(model.minMidi); midi <= model.maxMidi; midi++) {
      if (midi % 12 === 0) cs.push(midi);
    }
    expect(cs.length).toBeGreaterThanOrEqual(2);
    const lines = canvas.context.paths.filter(
      (path) => path.moves.length === 1 && path.lines.length === 1,
    );
    expect(lines).toHaveLength(cs.length);
    const pixelsPerSemitone =
      (lines[0].moves[0].y - lines[lines.length - 1].moves[0].y) / (cs[cs.length - 1] - cs[0]);
    return (midi) => lines[0].moves[0].y - (midi - cs[0]) * pixelsPerSemitone;
  }

  it("draws a ghost for every slot and a note for everything that was sung", () => {
    const canvas = draw();
    // `roundRect` builds one `moveTo` and no `lineTo`; five ghosts, five notes.
    const rects = canvas.context.paths.filter(
      (path) => path.moves.length === 1 && path.lines.length === 0,
    );
    expect(rects).toHaveLength(10);
    expect(rects.filter((path) => path.strokes > 0)).toHaveLength(5);
    expect(rects.filter((path) => path.fills > 0)).toHaveLength(5);
  });

  /**
   * The claim the picture makes, checked against the number the strip reports:
   * a note 40 cents flat is drawn four tenths of a semitone below its ghost.
   */
  it("puts the note exactly its residual away from its ghost", () => {
    const canvas = draw();
    const y = mapping(canvas);
    const semitone = y(0) - y(1);
    const rects = canvas.context.paths.filter(
      (path) => path.moves.length === 1 && path.lines.length === 0,
    );
    // Ghosts are drawn first, in item order, then the notes.
    const ghost = rects[2].moves[0].y;
    const note = rects[5 + 2].moves[0].y;
    expect(note - ghost).toBeCloseTo(0.4 * semitone, 6);
  });

  it("names what was whistled and never what was wanted", () => {
    const canvas = draw();
    // Labels are the octave gridlines (every C) plus one per sung note.
    const names = canvas.context.labels;
    expect(names).toContain("C5");
    // The 3rd note came out at 87.6 → nearest is 88, which is E6. The target
    // it was aimed at is also 88 here, so the honest check is the count: five
    // notes were sung, so at most five note labels beyond the gridlines.
    const cs = names.filter((name) => name.startsWith("C") && !name.startsWith("C#"));
    expect(names.length - cs.length).toBeLessThanOrEqual(5);
  });

  it("frames the slot a tapped chip is asking about", () => {
    const plain = draw();
    const picked = draw(2);
    // One extra stroked rectangle, and nothing else changed in the geometry.
    const rectCount = (canvas: FakeCanvas): number =>
      canvas.context.paths.filter((path) => path.moves.length === 1 && path.lines.length === 0)
        .length;
    expect(rectCount(picked)).toBe(rectCount(plain) + 1);
  });

  it("draws nothing into a canvas with no size", () => {
    const canvas = new FakeCanvas();
    canvas.clientWidth = 0;
    drawDiffOverlay(canvas as unknown as HTMLCanvasElement, { model, trail: [], highlight: null });
    expect(canvas.context.paths).toHaveLength(0);
  });
});

describe("the trail under the notes", () => {
  function frame(tSec: number, midi: number, clarity = 0.9): PitchFrame {
    return {
      tSec,
      hz: midiToHz(midi),
      clarity,
      snrDb: 20,
      peakToSecondDb: 12,
      bandRmsDb: -30,
      broadbandRmsDb: -30,
      clipped: false,
    };
  }

  it("drops the frames that are breath rather than whistle", () => {
    const points = trailFromFrames([
      frame(0, 84),
      frame(0.01, 84, 0.1),
      { ...frame(0.02, 84), hz: null },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].midi).toBeCloseTo(84, 9);
  });

  /**
   * The same correction the transcriber's own roll applies, and for the same
   * reason: the segmenter takes each take's global tuning bias out *before*
   * rounding, so a raw trail would float a fixed fraction of a semitone away
   * from the very rectangles it is drawn to explain.
   */
  it("puts the trail on the notes the segmenter committed to", () => {
    const [raw] = trailFromFrames([frame(0, 84.4)]);
    const [corrected] = trailFromFrames([frame(0, 84.4)], 40);
    expect(raw.midi).toBeCloseTo(84.4, 6);
    expect(corrected.midi).toBeCloseTo(84, 6);
  });
});
