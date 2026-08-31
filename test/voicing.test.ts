import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PitchTracker, mergeConfig, transcribe, type Note } from "../src/dsp/index.js";
import { prepare } from "../src/dsp/segment.js";
import { addNoise, sequence, type SynthSignal } from "./fixtures/synth.js";

/**
 * Voicing: the adaptive noise floor, and the four ways it has gone wrong.
 *
 * The floor is a percentile of "frames that are not a whistle", and the whole
 * difficulty is in the words *which frames*. Admit too much and a cough, a
 * door or the microphone's own warm-up counts as a measurement of the room, so
 * the floor rises to its level and stays there for as long as the window
 * remembers it. Admit too little and a room that genuinely changes level can
 * never be believed again, so the floor stays where the room used to be. And
 * one file can contain both a room and no room at all: digital silence is not
 * a level, but a percentile taken over it is happy to report −240 dBFS as one.
 *
 * From outside, every one of those looks the same — notes missing *after* an
 * event rather than during it, a take that starts whistling immediately
 * transcribing to nothing, a level gate that silently stopped existing. None of
 * them has a visible connection to its cause, which is why these tests look at
 * the floor itself and not only at the notes.
 *
 * These cases are all synthetic and seeded: a flaky voicing test is
 * indistinguishable from a real regression.
 */

const SR = 48000;
const NAMES = (notes: Note[]): string[] => notes.map((n) => n.noteName);

/** The adaptive floor, frame by frame, as segmentation actually saw it. */
function floorTrace(samples: Float32Array): { floorDb: number[]; tSec: number[]; background: boolean[] } {
  const frames = new PitchTracker(SR, DEFAULT_CONFIG).push(samples);
  const { voicing } = prepare(frames, DEFAULT_CONFIG, SR);
  return { floorDb: voicing.floorDb, tSec: frames.map((f) => f.tSec), background: voicing.background };
}

/** Largest frame-to-frame step in the floor, in dB. */
function maxFloorJump(samples: Float32Array): number {
  const { floorDb } = floorTrace(samples);
  let worst = 0;
  for (let i = 1; i < floorDb.length; i++) {
    if (!Number.isFinite(floorDb[i]) || !Number.isFinite(floorDb[i - 1])) continue;
    worst = Math.max(worst, Math.abs(floorDb[i] - floorDb[i - 1]));
  }
  return worst;
}

/** Eight seconds of E6 over quiet room tone, with 300 ms of loud broadband
 *  noise dropped in at `burstAtSec` when asked for. */
function toneWithBurst(burstAtSec: number | null): Float32Array {
  const tone = addNoise(sequence([{ midi: 88, durSec: 8.0, amp: 0.25 }], { leadInSec: 1.0, tailSec: 0.5 }), {
    type: "pink",
    levelDb: -55,
    seed: 4,
  });
  const samples = new Float32Array(tone.samples);
  if (burstAtSec !== null) {
    const burst = addNoise(sequence([], { leadInSec: 11 }), { type: "white", levelDb: -3, seed: 9 });
    for (let i = Math.round(burstAtSec * SR); i < Math.round((burstAtSec + 0.3) * SR); i++) {
      samples[i] += burst.samples[i];
    }
  }
  return samples;
}

/** Pink room tone that steps from one level to another partway through. */
function roomStep(quietDb: number, loudDb: number, stepSec: number, totalSec: number): Float32Array {
  const blank = (): SynthSignal => sequence([], { leadInSec: totalSec });
  const quiet = addNoise(blank(), { type: "pink", levelDb: quietDb, seed: 11 }).samples;
  const loud = addNoise(blank(), { type: "pink", levelDb: loudDb, seed: 12 }).samples;
  const out = new Float32Array(quiet.length);
  const step = Math.round(stepSec * SR);
  for (let i = 0; i < out.length; i++) out[i] = i < step ? quiet[i] : loud[i];
  return out;
}

describe("adaptive noise floor", () => {
  it("is not poisoned by a loud non-tonal burst", () => {
    // A cough two seconds in used to blank the *following* 1.3 seconds and
    // fabricate re-articulations either side of the hole, because the burst sat
    // in the trailing window as though it were a measurement of the room.
    const clean = transcribe(toneWithBurst(null), SR).notes;
    expect(NAMES(clean)).toEqual(["E6"]);

    // The whistler never stopped, so neither should the note. The tone really
    // is unrecoverable for the 300 ms the burst masks it — but a gap that is
    // *louder* than the notes either side of it is a room event, not a rest,
    // and a re-articulation would have been just as inaudible under it.
    const notes = transcribe(toneWithBurst(2.0), SR).notes;
    expect(NAMES(notes)).toEqual(["E6"]);
    expect(notes[0].startSec).toBeCloseTo(clean[0].startSec, 1);
    expect(notes[0].endSec).toBeCloseTo(clean[0].endSec, 1);
  });

  it("does not use that as a licence to merge repeated notes in a noisy room", () => {
    // The other side of the masking rule. Two E6s with a real silence between
    // them stay two, however much noise is in the room — because the gap sits
    // at the *room's* level, below the notes, and not above them as a burst
    // does. Without this distinction the rule would quietly turn every
    // re-articulated note in a café into one long one.
    const repeated = addNoise(
      sequence(
        [
          { midi: 88, durSec: 0.4, gapSec: 0.25, amp: 0.25 },
          { midi: 88, durSec: 0.4, amp: 0.25 },
        ],
        { leadInSec: 0.5, tailSec: 0.4 },
      ),
      { type: "pink", levelDb: -40, seed: 7 },
    );
    expect(NAMES(transcribe(repeated.samples, SR).notes)).toEqual(["E6", "E6"]);
  });

  it("measures the same floor with and without that burst", () => {
    // The mechanism, asserted directly: 300 ms of loud noise is an *event*, and
    // an event is not evidence about the level of the room. If it were, the
    // floor here would differ by tens of dB for seconds afterwards.
    const withBurst = floorTrace(toneWithBurst(2.0));
    const without = floorTrace(toneWithBurst(null));
    for (let i = 0; i < without.floorDb.length; i++) {
      expect(Math.abs(withBurst.floorDb[i] - without.floorDb[i]), `frame ${i}`).toBeLessThan(1);
    }
    // ...and no frame of the burst itself was believed as background.
    for (let i = 0; i < withBurst.background.length; i++) {
      if (withBurst.tSec[i] >= 2.0 && withBurst.tSec[i] < 2.3) {
        expect(withBurst.background[i], `burst frame at ${withBurst.tSec[i].toFixed(2)}s`).toBe(false);
      }
    }
  });

  it("moves continuously from frame to frame", () => {
    // The floor used to flip between a local percentile and a global one the
    // moment the local window ran short of samples, which stepped it by tens of
    // dB between adjacent frames. `isTrueSilence` reads the same number, so a
    // step like that also invents silences — and an invented silence is what
    // stops a dropout from being merged and turns one note into three.
    for (const [name, samples] of [
      ["tone with burst", toneWithBurst(2.0)],
      ["tone alone", toneWithBurst(null)],
      [
        "melody in a noisy room",
        addNoise(
          sequence(
            [84, 86, 88, 89, 91, 89, 88, 84].map((midi) => ({ midi, durSec: 0.35, gapSec: 0.12 })),
            { leadInSec: 0.4, tailSec: 0.4 },
          ),
          { type: "pink", levelDb: -45, seed: 2 },
        ).samples,
      ],
    ] as const) {
      expect(maxFloorJump(samples), name).toBeLessThan(1);
    }
  });

  it("follows a room that changes level, in both directions", () => {
    // One recording can contain two rooms: a window opens, a fan starts, the
    // phone is put down on a different table. An earlier version compared every
    // frame against a single number for the whole take, so a room that stepped
    // by more than `backgroundAboveFloorDb` could never be believed again —
    // measured on this exact signal, *zero* of the 730 frames after the step
    // were admitted as background, the floor stayed 19 dB low for the rest of
    // the take, and the onset gate under-gated by the same amount.
    for (const [quietDb, loudDb] of [
      [-60, -42],
      [-42, -60],
    ] as const) {
      const label = `${quietDb} → ${loudDb} dB at t=8s`;
      const samples = roomStep(quietDb, loudDb, 8, 16);
      const frames = new PitchTracker(SR, DEFAULT_CONFIG).push(samples);
      const { voicing } = prepare(frames, DEFAULT_CONFIG, SR);

      // Two seconds after the step and thereafter, the floor is the new room.
      // Compared against the frames' own measured level rather than against the
      // level the noise was *asked* for, so this tests the estimator and not
      // the fixture's calibration.
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].tSec < 10 || frames[i].tSec > 15.5) continue;
        expect(
          Math.abs(voicing.floorDb[i] - frames[i].bandRmsDb),
          `${label}, frame at ${frames[i].tSec.toFixed(2)}s`,
        ).toBeLessThan(3.5);
      }
      // And it is genuinely tracking, not merely landing in the right place:
      // the two halves must differ by about the step.
      const at = (t: number): number => voicing.floorDb[frames.findIndex((f) => f.tSec >= t)];
      expect(Math.abs(at(6) - at(14)) - Math.abs(quietDb - loudDb), label).toBeGreaterThan(-3);
    }
  });

  it("a muted stretch cannot switch the level gate off", () => {
    // Any imported file can have digital zeroes in it — an editor's trimmed
    // tail, a moment where the phone dropped the microphone. Those frames are
    // −240 dBFS, and a fifth of a take at that level used to drag the whole
    // file's floor there. `floor + 12` is then −228, which every frame in the
    // file clears: the level gate stopped existing, silently, for the whole
    // take. There are two independent defences now and this asserts both.
    //
    // The signal: room tone and one whistled E6, then everything from t=4s
    // muted, with a −75 dBFS ghost of a G6 sitting in the muted stretch. Not a
    // realistic recording — it is the two failure modes side by side.
    const room = addNoise(sequence([{ midi: 88, durSec: 0.8, amp: 0.25 }], { leadInSec: 1.0, tailSec: 8.0 }), {
      type: "pink",
      levelDb: -50,
      seed: 5,
    });
    const samples = new Float32Array(room.samples);
    for (let i = Math.round(4.0 * SR); i < samples.length; i++) samples[i] = 0;
    const ghost = sequence([{ midi: 91, durSec: 1.0, amp: 0.00025 }], {}).samples;
    for (let i = 0; i < ghost.length; i++) samples[Math.round(6.0 * SR) + i] += ghost[i];

    // One: the floor is *local*, so the muted tail says nothing about the room
    // three seconds earlier. It used to say −240 there.
    const { floorDb, tSec } = floorTrace(samples);
    for (let i = 0; i < floorDb.length; i++) {
      if (tSec[i] > 3.0) break;
      expect(floorDb[i], `frame at ${tSec[i].toFixed(2)}s`).toBeGreaterThan(-70);
      expect(floorDb[i], `frame at ${tSec[i].toFixed(2)}s`).toBeLessThan(-45);
    }

    // Two: inside the muted stretch the floor genuinely *is* −240, because that
    // genuinely is the level there — and `absoluteFloorDb` is what stops that
    // from being a licence. Switch it off and the ghost becomes a note.
    expect(NAMES(transcribe(samples, SR).notes)).toEqual(["E6"]);
    const ungated = mergeConfig(DEFAULT_CONFIG, { voicing: { absoluteFloorDb: -Infinity } });
    expect(NAMES(transcribe(samples, SR, ungated).notes)).toEqual(["E6", "G6"]);
  });
});

/**
 * The masking rule: a gap louder than the notes around it is a room event, and
 * the note probably continued underneath it.
 *
 * Sound reasoning with two edges that a round-2 review found unguarded. It had
 * no length limit at all — "length is no evidence here" — so five seconds of
 * noise between two E6s produced a single 6.6-second note, over which a
 * whistler could have played a whole phrase. And it demanded that *every* frame
 * of the gap clear the notes' level, so a single frame in an event's decay
 * flipped the answer, which made the outcome non-monotonic in the gap's length:
 * the same event slightly longer could merge where a shorter one had not.
 */
describe("a gap the room drowned out", () => {
  const broadband = (n: number, levelDb: number, seed: number): Float32Array =>
    addNoise({ samples: new Float32Array(n), sampleRate: SR, expected: [] }, { type: "white", levelDb, seed })
      .samples;

  /** Two E6s in a quiet room with `gapSec` of loud noise between them, of which
   *  `dipSec` in the middle is 20 dB down — loud enough still not to be silence,
   *  quiet enough not to be masking. */
  function masked(gapSec: number, dipSec = 0): Float32Array {
    const total = 1.0 + 0.6 + gapSec + 0.6 + 0.6;
    const n = Math.round(total * SR);
    const out = addNoise({ samples: new Float32Array(n), sampleRate: SR, expected: [] }, {
      type: "pink",
      levelDb: -55,
      seed: 4,
    }).samples;
    const burst = broadband(n, -6, 9);
    const from = Math.round(1.6 * SR);
    const to = Math.round((1.6 + gapSec) * SR);
    const dipFrom = Math.round((1.6 + (gapSec - dipSec) / 2) * SR);
    const dipTo = dipFrom + Math.round(dipSec * SR);
    for (let i = from; i < to; i++) out[i] += burst[i] * (i >= dipFrom && i < dipTo ? 0.1 : 1);
    for (const at of [1.0, 1.6 + gapSec]) {
      const note = sequence([{ midi: 88, durSec: 0.6, amp: 0.25 }], {}).samples;
      const off = Math.round(at * SR);
      for (let i = 0; i < note.length && off + i < n; i++) out[off + i] += note[i];
    }
    return out;
  }

  it("bridges a short event and gives up on a long one, monotonically", () => {
    // Two claims. The rule has a limit — `maskedGapMs`, 400 ms — and below it
    // the note is held through the event while above it the two things actually
    // heard are reported as two notes. And the answer never flips back: once a
    // gap is long enough to be reported as two notes, every longer gap is too.
    //
    // The boundary is asserted with a frame of slack either side, because the
    // rule measures the gap in *voiced* frames and the fixture specifies it in
    // samples: a 43 ms analysis window straddling each end makes the first
    // slightly longer than the second, which is a fact about measurement and
    // not about this rule.
    let seenSplit = false;
    const lengths = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const gapSec of lengths) {
      const count = transcribe(masked(gapSec), SR).notes.length;
      const label = `gap ${gapSec.toFixed(2)}s`;
      if (gapSec <= 0.35) expect(count, label).toBe(1);
      if (gapSec >= 0.45) expect(count, label).toBe(2);
      if (count > 1) seenSplit = true;
      else expect(seenSplit, `${label} merged again after splitting`).toBe(false);
    }
  });

  it("is the config knob it claims to be", () => {
    const generous = mergeConfig(DEFAULT_CONFIG, { segment: { maskedGapMs: 800 } });
    expect(transcribe(masked(0.6), SR).notes).toHaveLength(2);
    expect(transcribe(masked(0.6), SR, generous).notes).toHaveLength(1);
  });

  it("is not decided by one frame in the event's decay", () => {
    // A real event is not a rectangle. Twenty milliseconds of this 300 ms burst
    // dropping 20 dB puts three of the gap's twenty-two frames under the level
    // of the notes — enough for an all-or-nothing rule to call the whole thing a
    // rest, and nowhere near enough for anyone listening to hear one.
    expect(transcribe(masked(0.3, 0.02), SR).notes).toHaveLength(1);
    // Widen the quiet patch and it stops being masked, which is the right
    // answer for the right reason rather than a threshold nobody can see.
    expect(transcribe(masked(0.3, 0.1), SR).notes).toHaveLength(2);
  });
});

describe("microphone warm-up", () => {
  /** A melody that starts at t=0 and never stops: no silence for the floor to
   *  measure anywhere, and the opening frames are full-level signal. */
  const legato = (leadInSec: number): SynthSignal =>
    sequence(
      [84, 86, 88, 89, 91, 89, 88, 84, 86, 88, 89, 91, 86, 84].map((midi) => ({ midi, durSec: 0.4 })),
      { leadInSec, tailSec: 0 },
    );

  it("does not let a signal-level opening frame set the noise floor", () => {
    // The warm-up discard says those frames may not *become* notes. It never
    // said they were measurements of the room — but that is how they were used,
    // and a take that starts whistling immediately therefore set its own floor
    // to the level of the whistle and transcribed to nothing whatsoever.
    expect(transcribe(legato(0).samples, SR).notes).toHaveLength(14);
    expect(transcribe(legato(0.4).samples, SR).notes).toHaveLength(14);
    expect(NAMES(transcribe(legato(0).samples, SR).notes)).toEqual(
      NAMES(transcribe(legato(0.4).samples, SR).notes),
    );

    // Directly: no frame of the whistle is treated as background, warm-up or
    // not. With nothing else to go on the floor declines to exist, which is the
    // right answer — there is no evidence for one.
    const { background, floorDb } = floorTrace(legato(0).samples);
    expect(background.some(Boolean)).toBe(false);
    expect(floorDb.every((db) => db === -Infinity)).toBe(true);
  });

  it("hears a steady tone that starts at t=0", () => {
    const steady = sequence([{ midi: 88, durSec: 3.0 }], { leadInSec: 0, tailSec: 0 });
    expect(NAMES(transcribe(steady.samples, SR).notes)).toEqual(["E6"]);
  });

  it("hears a full-scale square wave that starts at t=0", () => {
    // Loud, harmonic and clipping-adjacent — everything the warm-up rule was
    // afraid of — but still unmistakably a pitch at 1319 Hz. Band-limited
    // rather than a naive `sign(sin)`: an aliased square folds energy back into
    // the whistle band at frequencies that are harmonics of nothing, and the
    // test would then be measuring the generator.
    const hz = 1318.51;
    const samples = new Float32Array(Math.round(2.0 * SR));
    for (let n = 1; n * hz < SR / 2; n += 2) {
      for (let i = 0; i < samples.length; i++) {
        samples[i] += Math.sin((2 * Math.PI * n * hz * i) / SR) / n;
      }
    }
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    for (let i = 0; i < samples.length; i++) samples[i] /= peak;

    expect(NAMES(transcribe(samples, SR).notes)).toEqual(["E6"]);
  });
});
