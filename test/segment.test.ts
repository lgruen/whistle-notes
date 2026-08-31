import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  durationClasses,
  hasRestBefore,
  mergeConfig,
  presetConfig,
  transcribe,
  type DspConfig,
  type Note,
} from "../src/dsp/index.js";
import { addNoise, sequence } from "./fixtures/synth.js";

/**
 * Segmentation: turning a continuous pitch track into notes.
 *
 * Every case here is a specific thing whistlers do — wobbling, drifting,
 * sliding into notes, running out of breath halfway through one — expressed as
 * a signal whose right answer is known by construction. The pitch stage is
 * accurate to hundredths of a cent (see `pitch.test.ts`), so anything that
 * fails here is a segmentation decision, not a measurement.
 */

const NOTE_NAMES = (notes: Note[]): string[] => notes.map((n) => n.noteName);
const MIDIS = (notes: Note[]): number[] => notes.map((n) => n.midi);

/** Transcribe a synthetic signal with an optional config override. */
function run(
  signal: { samples: Float32Array; sampleRate: number },
  overrides?: Partial<DspConfig["segment"]>,
): Note[] {
  const cfg = overrides ? mergeConfig(DEFAULT_CONFIG, { segment: overrides }) : DEFAULT_CONFIG;
  return transcribe(signal.samples, signal.sampleRate, cfg).notes;
}

/** Add broadband noise over a time range, leaving the rest untouched. Used to
 *  build a *confidence dropout*: energy in the band, but nothing tone-shaped. */
function noiseOver(
  signal: { samples: Float32Array; sampleRate: number },
  fromSec: number,
  toSec: number,
  amplitude: number,
): { samples: Float32Array; sampleRate: number } {
  const out = new Float32Array(signal.samples);
  // A tiny LCG rather than Math.random: a flaky segmentation test is
  // indistinguishable from a real regression.
  let seed = 12345;
  for (let i = Math.round(fromSec * signal.sampleRate); i < Math.round(toSec * signal.sampleRate); i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] += amplitude * (seed / 0x3fffffff - 1);
  }
  return { samples: out, sampleRate: signal.sampleRate };
}

describe("segmentation", () => {
  it("transcribes a clean melody exactly", () => {
    const melody = [84, 86, 88, 89, 91, 89, 88, 84];
    const signal = sequence(
      melody.map((midi) => ({ midi, durSec: 0.35, gapSec: 0.12 })),
      { leadInSec: 0.4, tailSec: 0.4 },
    );
    const notes = run(signal);

    expect(MIDIS(notes)).toEqual(melody);
    expect(NOTE_NAMES(notes)).toEqual(["C6", "D6", "E6", "F6", "G6", "F6", "E6", "C6"]);
    for (const [i, note] of notes.entries()) {
      expect(Math.abs(note.centsOffset), `note ${i} pitch`).toBeLessThan(5);
      expect(note.confidence).toBeGreaterThan(0.8);
      // Onsets land within a window of the truth. A window that straddles an
      // onset legitimately sees half a note, so half a window is the floor on
      // how precisely any of this can be timed.
      expect(Math.abs(note.startSec - signal.expected[i].startSec)).toBeLessThan(0.05);
      expect(Math.abs(note.durationSec - 0.35)).toBeLessThan(0.06);
    }
  });

  it("holds one note through vibrato", () => {
    // ±60 cents at 5 Hz is a realistic human wobble and spans more than a
    // semitone peak to peak; the point is that it is an *oscillation*, and a
    // note is what it oscillates around.
    const signal = sequence([{ midi: 88, durSec: 1.2, vibratoCents: 60, vibratoHz: 5 }], {
      leadInSec: 0.3,
      tailSec: 0.3,
    });
    const notes = run(signal);

    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(88);
    expect(notes[0].durationSec).toBeGreaterThan(1.0);
    // The reported pitch is the centre of the wobble, not one of its edges —
    // this is what fails if the glide detector strips out the middle of the
    // oscillation and leaves a bimodal set of extremes to take a median of.
    expect(Math.abs(notes[0].centsOffset)).toBeLessThan(30);
  });

  it("holds one note through slow drift, and rounds it correctly", () => {
    // 70 cents of drift never breaks the frame-to-frame tolerance, so only the
    // drift cap could split it — and 0.7 semitones is under the 1.5 cap.
    const signal = sequence([{ midi: 88, durSec: 1.0, driftCents: 70 }], { leadInSec: 0.3, tailSec: 0.3 });
    const notes = run(signal);

    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(88);
    expect(notes[0].flags.drifted).toBe(true);
  });

  it("splits a drift across a semitone boundary exactly where the preset says", () => {
    // Starts 60 cents flat of E6 and slides 150 cents upward, ending 90 cents
    // sharp — squarely across the E6/F6 boundary. There is no single right
    // answer, which is precisely why it is a preset knob: Strict hears two
    // notes, Normal and Forgiving hear one that drifted.
    const signal = sequence([{ midi: 88, durSec: 1.2, detuneCents: -60, driftCents: 150 }], {
      leadInSec: 0.3,
      tailSec: 0.3,
    });

    const strict = transcribe(signal.samples, signal.sampleRate, presetConfig("strict")).notes;
    expect(NOTE_NAMES(strict)).toEqual(["E6", "F6"]);

    for (const preset of ["normal", "forgiving"] as const) {
      const notes = transcribe(signal.samples, signal.sampleRate, presetConfig(preset)).notes;
      expect(NOTE_NAMES(notes), preset).toEqual(["E6"]);
      expect(notes[0].flags.drifted, preset).toBe(true);
    }
  });

  it("hears a portamento as two notes and nothing in between", () => {
    // An octave slide over 120 ms passes through eleven semitones. Reporting
    // any of them would be worse than useless to someone trying to find the
    // melody on a piano.
    const signal = sequence(
      [
        { midi: 84, durSec: 0.4 },
        { midi: 96, durSec: 0.4, glideInCents: -1200, glideInMs: 120 },
      ],
      { leadInSec: 0.3, tailSec: 0.3 },
    );
    expect(MIDIS(run(signal))).toEqual([84, 96]);

    // The same holds for a short slide, where the frames are not steep enough
    // to be marked transitional and the confirmation rule has to carry it.
    const gentle = sequence(
      [
        { midi: 84, durSec: 0.4 },
        { midi: 89, durSec: 0.4, glideInCents: -500, glideInMs: 120 },
      ],
      { leadInSec: 0.3, tailSec: 0.3 },
    );
    expect(MIDIS(run(gentle))).toEqual([84, 89]);
  });

  it("ignores a scoop into a note when naming it", () => {
    // Whistlers approach from below. Three semitones of approach in 100 ms is
    // an ordinary attack, not a note anybody played.
    for (const [cents, ms] of [
      [300, 100],
      [200, 150],
    ] as const) {
      const signal = sequence([{ midi: 88, durSec: 0.6, glideInCents: -cents, glideInMs: ms }], {
        leadInSec: 0.3,
        tailSec: 0.3,
      });
      const notes = run(signal);
      expect(MIDIS(notes), `scoop ${cents}c over ${ms}ms`).toEqual([88]);
      expect(Math.abs(notes[0].centsOffset), `scoop ${cents}c over ${ms}ms`).toBeLessThan(15);
      expect(notes[0].flags.glidedIn).toBe(true);
    }
  });

  it("merges a repeated note across a confidence dropout", () => {
    // Sixty milliseconds where the detector loses the tone but the band is
    // still full of energy: a breathy moment, a scrape of the microphone. The
    // whistler did not re-articulate, so this is one note.
    const base = sequence(
      [
        { midi: 88, durSec: 0.35, gapSec: 0.06 },
        { midi: 88, durSec: 0.35 },
      ],
      { leadInSec: 0.3, tailSec: 0.3 },
    );
    const dropout = noiseOver(base, 0.65, 0.71, 0.12);

    const notes = run(dropout);
    expect(MIDIS(notes)).toEqual([88]);
    expect(notes[0].durationSec).toBeGreaterThan(0.7);
  });

  it("keeps a repeated note separate across true silence", () => {
    // Byte for byte the same voicing gap as the test above — the *only*
    // difference is that the gap is silent. That is the whole rule: pitch
    // cannot distinguish one long note from two short ones, level can.
    const base = sequence(
      [
        { midi: 88, durSec: 0.35, gapSec: 0.06 },
        { midi: 88, durSec: 0.35 },
      ],
      { leadInSec: 0.3, tailSec: 0.3 },
    );

    expect(MIDIS(run(base))).toEqual([88, 88]);
    // And it stays two even when the gap is well inside the merge window, so
    // the silence rule is doing the work rather than the duration rule.
    expect(MIDIS(run(base, { gapMergeMs: 400 }))).toEqual([88, 88]);
  });

  it("drops a distant blip instead of gluing it onto the previous note", () => {
    // A 60 ms speck is below `minNoteMs` and has to go somewhere — but "absorb
    // into a neighbour" only makes sense for a neighbour that is adjacent. This
    // one is 600 ms of unmistakable silence away. Merging them used to hand the
    // survivor the *blip's* pitch (F6 for a note that was whistled at E6),
    // stretch it across the silence, and then feed the attack trim a span three
    // quarters of which was nothing at all.
    const signal = sequence(
      [
        { midi: 88, durSec: 0.3, gapSec: 0.6 },
        { midi: 89, durSec: 0.06 },
      ],
      { leadInSec: 0.5, tailSec: 0.5 },
    );
    const notes = run(signal);

    expect(NOTE_NAMES(notes)).toEqual(["E6"]);
    expect(notes[0].startSec).toBeCloseTo(0.5, 1);
    expect(notes[0].durationSec).toBeLessThan(0.4);
    expect(Math.abs(notes[0].centsOffset)).toBeLessThan(15);
  });

  it("still absorbs a short note into the neighbour it is actually touching", () => {
    // The other half of the same rule: contiguity is the test, not distance in
    // the note list. A wobble that briefly reads a semitone off in the middle
    // of a held note is adjacent to it, and belongs to it.
    const signal = sequence([{ midi: 88, durSec: 0.8, vibratoCents: 45, vibratoHz: 5 }], {
      leadInSec: 0.3,
      tailSec: 0.3,
    });
    const notes = run(signal, { minNoteMs: 250 });
    expect(NOTE_NAMES(notes)).toEqual(["E6"]);
    expect(notes[0].durationSec).toBeGreaterThan(0.7);
  });

  it("finds no notes in silence or breath", () => {
    expect(run(sequence([], { leadInSec: 2 }))).toEqual([]);
    for (const type of ["pink", "white"] as const) {
      for (const levelDb of [-50, -35, -25]) {
        const breath = addNoise(sequence([], { leadInSec: 2 }), { type, levelDb, seed: 5 });
        expect(run(breath), `${type} at ${levelDb} dBFS`).toEqual([]);
      }
    }
  });
});

describe("global tuning offset", () => {
  it("removes a consistent bias and reports it", () => {
    // A whistler 35 cents sharp on every note is one coin flip away from a
    // wrong transcription throughout. Measuring the bias once fixes all of
    // them together, which is a much better deal than it sounds.
    const melody = [84, 86, 88, 89, 91, 88];
    const signal = sequence(
      melody.map((midi) => ({ midi, durSec: 0.35, gapSec: 0.12, detuneCents: 35 })),
      { leadInSec: 0.3, tailSec: 0.3 },
    );

    const corrected = transcribe(signal.samples, signal.sampleRate);
    expect(corrected.tuningOffsetCents).toBeCloseTo(35, 0);
    expect(MIDIS(corrected.notes)).toEqual(melody);
    for (const note of corrected.notes) expect(Math.abs(note.centsOffset)).toBeLessThan(6);

    // Switched off, the same take keeps its bias visible. The notes are still
    // right at 35 cents — this take is well inside the rounding margin — but
    // the residuals are what a user would see in the UI.
    const raw = transcribe(
      signal.samples,
      signal.sampleRate,
      mergeConfig(DEFAULT_CONFIG, { tuning: { enableAutoTuning: false } }),
    );
    expect(raw.tuningOffsetCents).toBe(0);
    for (const note of raw.notes) expect(note.centsOffset).toBeCloseTo(35, 0);
  });

  it("declines when the offsets are scattered rather than biased", () => {
    // An unsteady whistler is not a detuned one, and "correcting" for
    // unsteadiness would move every note by an arbitrary amount.
    const detunes = [-40, 30, -10, 45, -35, 15];
    const signal = sequence(
      [84, 86, 88, 89, 91, 88].map((midi, i) => ({
        midi,
        durSec: 0.35,
        gapSec: 0.12,
        detuneCents: detunes[i],
      })),
      { leadInSec: 0.3, tailSec: 0.3 },
    );

    const result = transcribe(signal.samples, signal.sampleRate);
    expect(result.tuningOffsetCents).toBe(0);
    expect(MIDIS(result.notes)).toEqual([84, 86, 88, 89, 91, 88]);
  });

  it("never claims more than half a semitone", () => {
    // Beyond ±50 cents the "correction" is just relabelling every note, so the
    // clamp is what stops auto-tuning from transposing a whole take.
    for (const detuneCents of [-49, -25, 25, 49]) {
      const signal = sequence(
        [84, 86, 88, 89, 91, 88].map((midi) => ({ midi, durSec: 0.35, gapSec: 0.12, detuneCents })),
        { leadInSec: 0.3, tailSec: 0.3 },
      );
      const { tuningOffsetCents } = transcribe(signal.samples, signal.sampleRate);
      expect(Math.abs(tuningOffsetCents)).toBeLessThanOrEqual(50);
      expect(tuningOffsetCents).toBeCloseTo(detuneCents, 0);
    }
  });
});

describe("note annotations", () => {
  it("reports the gap before each note, and which gaps are rests", () => {
    const signal = sequence(
      [
        { midi: 84, durSec: 0.3, gapSec: 0.05 },
        { midi: 86, durSec: 0.3, gapSec: 0.3 },
        { midi: 88, durSec: 0.3 },
      ],
      { leadInSec: 0.3, tailSec: 0.3 },
    );
    const notes = run(signal);
    expect(MIDIS(notes)).toEqual([84, 86, 88]);

    expect(notes[0].gapBeforeSec).toBe(0);
    expect(notes[1].gapBeforeSec).toBeCloseTo(0.05, 1);
    expect(notes[2].gapBeforeSec).toBeCloseTo(0.3, 1);

    expect(hasRestBefore(notes[1], DEFAULT_CONFIG)).toBe(false);
    expect(hasRestBefore(notes[2], DEFAULT_CONFIG)).toBe(true);
  });

  it("classifies durations relative to the take's own median", () => {
    const signal = sequence(
      [
        { midi: 84, durSec: 0.2, gapSec: 0.12 },
        { midi: 86, durSec: 0.2, gapSec: 0.12 },
        { midi: 88, durSec: 0.9, gapSec: 0.12 },
        { midi: 89, durSec: 0.2 },
      ],
      { leadInSec: 0.3, tailSec: 0.3 },
    );
    const notes = run(signal);
    expect(MIDIS(notes)).toEqual([84, 86, 88, 89]);
    expect(durationClasses(notes)).toEqual(["medium", "medium", "long", "medium"]);
    expect(durationClasses([])).toEqual([]);
  });

  it("keeps notes ordered, non-overlapping and self-consistent", () => {
    // The invariants the UI leans on, checked on a signal with everything in
    // it at once: wobble, a slide, a repeat and a rest.
    const signal = sequence(
      [
        { midi: 84, durSec: 0.4, gapSec: 0.05, vibratoCents: 40 },
        { midi: 89, durSec: 0.4, gapSec: 0.25, glideInCents: -500, glideInMs: 120 },
        { midi: 89, durSec: 0.4, gapSec: 0.1 },
        { midi: 89, durSec: 0.4 },
      ],
      { leadInSec: 0.3, tailSec: 0.3 },
    );
    const notes = run(signal);

    let previousEnd = -Infinity;
    for (const note of notes) {
      expect(note.startSec).toBeGreaterThanOrEqual(previousEnd);
      expect(note.endSec).toBeGreaterThan(note.startSec);
      expect(note.durationSec).toBeCloseTo(note.endSec - note.startSec, 9);
      expect(note.centsOffset).toBeGreaterThanOrEqual(-50);
      expect(note.centsOffset).toBeLessThan(50);
      expect(69 + 12 * Math.log2(note.pitchHz / 440)).toBeCloseTo(note.midi + note.centsOffset / 100, 6);
      previousEnd = note.endSec;
    }
    expect(MIDIS(notes)).toEqual([84, 89, 89, 89]);
  });
});
