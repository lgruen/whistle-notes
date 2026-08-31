import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PitchTracker, transcribe, type Note } from "../src/dsp/index.js";
import { prepare } from "../src/dsp/segment.js";
import { addNoise, sequence, type SynthSignal } from "./fixtures/synth.js";

/**
 * Voicing: the adaptive noise floor, and the two ways it used to go wrong.
 *
 * Both failures share a mechanism. The floor is a low percentile of "frames
 * that are not a whistle", and *any* frame that fails the tone tests used to
 * qualify — however loud. A cough, a door or the microphone's own warm-up
 * therefore counted as a measurement of the room, and once one of them was in
 * the sample set the floor rose to its level and stayed there for as long as
 * the trailing window remembered it. What that looks like from outside is
 * notes going missing *after* an event rather than during it, or a take that
 * starts whistling immediately transcribing to nothing at all — symptoms with
 * no visible connection to their cause, which is why they need tests that look
 * at the floor itself and not only at the notes.
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

describe("adaptive noise floor", () => {
  it("is not poisoned by a loud non-tonal burst", () => {
    // A cough two seconds in used to blank the *following* 1.3 seconds and
    // fabricate re-articulations either side of the hole, because the burst sat
    // in the trailing window as though it were a measurement of the room.
    const clean = transcribe(toneWithBurst(null), SR).notes;
    expect(NAMES(clean)).toEqual(["E6"]);

    const notes = transcribe(toneWithBurst(2.0), SR).notes;
    expect(new Set(NAMES(notes))).toEqual(new Set(["E6"]));

    // The tone is genuinely unrecoverable while the burst masks it, so a break
    // *there* is honest. Anywhere else is not: after the burst the note must
    // resume immediately and run to the end.
    const last = notes[notes.length - 1];
    expect(last.startSec).toBeLessThan(2.4);
    expect(last.endSec).toBeCloseTo(clean[0].endSec, 1);
    for (const note of notes) expect(note.startSec).not.toBeGreaterThan(2.4);
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
      expect(maxFloorJump(samples), name).toBeLessThan(3);
    }
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
