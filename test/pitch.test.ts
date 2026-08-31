import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  PitchTracker,
  hzToMidiFloat,
  mergeConfig,
  transcribe,
  type DspConfig,
  type PitchFrame,
} from "../src/dsp/index.js";
import { addNoise, addSaw, sequence, type SynthSignal } from "./fixtures/synth.js";

/**
 * Accuracy and robustness of the pitch stage.
 *
 * These are the tests that decide whether the *frequency* coming out of the
 * FFT can be trusted; segmentation is tested separately in `segment.test.ts`.
 * Everything here is synthetic, so the right answer is known by construction
 * rather than agreed by ear, and CI never needs a recording.
 *
 * The requirement to keep in mind: a whistled note only has to land within
 * ±50 cents of the truth to round to the right key on a piano. Measured error
 * below is two orders of magnitude smaller than that, which is what buys the
 * headroom for everything the segmentation stage then has to survive.
 */

/** Frames comfortably inside a note, away from its edges — a window that
 *  straddles an onset legitimately reports a blend of the two. */
function steadyFrames(signal: SynthSignal, cfg: DspConfig, guardSec: number): PitchFrame[] {
  const [note] = signal.expected;
  const frames = new PitchTracker(signal.sampleRate, cfg).push(signal.samples);
  return frames.filter((f) => f.tSec >= note.startSec + guardSec && f.tSec <= note.endSec - guardSec);
}

/** Per-frame pitch error in cents against a known true pitch. */
function errorsCents(frames: PitchFrame[], trueMidi: number, a4Hz = 440): number[] {
  return frames
    .filter((f) => f.hz !== null && f.hz > 0)
    .map((f) => 100 * (hzToMidiFloat(f.hz as number, a4Hz) - trueMidi));
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/** MIDI 71 (B4, 494 Hz) to 107 (B7, 3951 Hz) spans the whole whistling
 *  register with room to spare at both ends. */
const MIDI_RANGE = Array.from({ length: 37 }, (_, i) => 71 + i);
const DETUNES = [-40, -20, 0, 20, 40];

describe("frame accuracy", () => {
  it("tracks the whole whistle register at every detuning, to within a few cents", () => {
    const worst = { error: 0, at: "" };
    const allErrors: number[] = [];

    for (const midi of MIDI_RANGE) {
      for (const detuneCents of DETUNES) {
        const signal = sequence([{ midi, durSec: 0.25, detuneCents }], { sampleRate: 48000 });
        const trueMidi = midi + detuneCents / 100;
        const errors = errorsCents(steadyFrames(signal, DEFAULT_CONFIG, 0.05), trueMidi);

        expect(errors.length, `no pitched frames for midi ${midi} ${detuneCents}c`).toBeGreaterThan(5);
        const error = Math.abs(median(errors));
        allErrors.push(error);
        if (error > worst.error) worst.error = error, worst.at = `midi ${midi} ${detuneCents}c`;

        // The requirement that actually matters: ±40 cents off a note must
        // still round *to* that note, and never past it.
        expect(Math.round(trueMidi + error / 100), `rounding at ${worst.at}`).toBe(midi);
      }
    }

    // The plan's bar is 5 cents. Measured is ~0.02, so this also catches a
    // silent regression to, say, linear-magnitude interpolation (~1 cent) long
    // before it would ever change a transcription.
    expect(median(allErrors)).toBeLessThan(0.5);
    expect(worst.error, `worst at ${worst.at}`).toBeLessThan(5);
  });

  it("is accurate at every plausible device sample rate", () => {
    // The pipeline never asks for a rate; iOS in particular ignores the
    // request. 22050 is the awkward one: it puts the band's top edge much
    // closer to Nyquist.
    for (const sampleRate of [22050, 44100, 48000]) {
      for (const midi of [71, 84, 96, 107]) {
        const signal = sequence([{ midi, durSec: 0.3 }], { sampleRate });
        const errors = errorsCents(steadyFrames(signal, DEFAULT_CONFIG, 0.06), midi);
        expect(errors.length, `no frames at ${sampleRate} Hz, midi ${midi}`).toBeGreaterThan(5);
        expect(Math.abs(median(errors)), `${sampleRate} Hz, midi ${midi}`).toBeLessThan(5);
      }
    }
  });

  it("improves with zero padding, and the default configuration is comfortably inside spec", () => {
    // Zero padding adds no information — the signal is still only resolved as
    // well as the window length allows — but it evaluates the spectrum on a
    // finer grid, which stops the three-point parabola from being fitted to
    // points that straddle the true peak too coarsely. The effect is large and
    // monotone, which is what this test pins down.
    const results = new Map<string, number>();
    for (const windowSize of [2048, 4096]) {
      for (const zeroPadFactor of [1, 2, 4]) {
        const cfg = mergeConfig(DEFAULT_CONFIG, { analysis: { windowSize, zeroPadFactor } });
        const errors: number[] = [];
        for (const midi of [71, 79, 88, 96, 107]) {
          for (const detuneCents of [-40, 0, 33]) {
            const signal = sequence([{ midi, durSec: 0.3, detuneCents }], { sampleRate: 48000 });
            errors.push(
              Math.abs(median(errorsCents(steadyFrames(signal, cfg, 0.07), midi + detuneCents / 100))),
            );
          }
        }
        results.set(`${windowSize}x${zeroPadFactor}`, Math.max(...errors));
      }
    }

    for (const [key, worst] of results) {
      // Even the unpadded configurations meet the ±50 cent requirement with
      // room to spare — the choice between them is not about correctness.
      expect(worst, `worst error for ${key}`).toBeLessThan(5);
    }
    // ...but padding still pays, by more than an order of magnitude.
    expect(results.get("2048x4")).toBeLessThan(results.get("2048x1") as number);
    expect(results.get("4096x4")).toBeLessThan(results.get("4096x1") as number);
    // The shipped default is one of the best in the matrix.
    expect(results.get("2048x4")).toBeLessThan(0.5);
  });
});

describe("robustness", () => {
  it("holds accuracy in noise, and refuses rather than guesses when it cannot", () => {
    // "SNR" here is broadband: noise RMS against the tone's RMS. The tone wins
    // far below 0 dB because it concentrates its energy in one bin while the
    // noise spreads across four thousand — the per-bin ratio is enormously
    // better than the wideband one. Band-limiting helps again on pink noise,
    // most of whose energy sits below the whistle band entirely.
    const toneRmsDb = 20 * Math.log10(0.5 / Math.SQRT2);
    const noisyTake = (type: "pink" | "white", snrDb: number): SynthSignal => {
      const clean = sequence([{ midi: 88, durSec: 0.6 }], {
        sampleRate: 48000,
        leadInSec: 0.3,
        tailSec: 0.3,
      });
      const noisy = addNoise(clean, { type, levelDb: toneRmsDb - snrDb, seed: 7 });
      return { ...noisy, expected: clean.expected };
    };

    for (const snrDb of [20, 10, 6]) {
      for (const type of ["pink", "white"] as const) {
        const take = noisyTake(type, snrDb);
        const label = `${type} noise at ${snrDb} dB SNR`;
        expect(Math.abs(median(errorsCents(steadyFrames(take, DEFAULT_CONFIG, 0.08), 88))), label).toBeLessThan(5);
        // ...and the note survives segmentation intact.
        expect(transcribe(take.samples, take.sampleRate).notes.map((n) => n.midi), label).toEqual([88]);
      }
    }

    // At 0 dB and below the *frames* are still accurate — an FFT peak survives
    // a long way into noise, because the tone's energy sits in one bin while
    // the noise is spread across four thousand. What stops it is the voicing
    // gate: adding equal-RMS noise lifts the in-band background to within ~7 dB
    // of the tone, and a note may only *start* 12 dB above the background.
    // That is the intended trade. A wrong note is worse than no note, because
    // a beginner cannot tell them apart at the piano.
    for (const snrDb of [0, -12]) {
      for (const type of ["pink", "white"] as const) {
        const take = noisyTake(type, snrDb);
        for (const note of transcribe(take.samples, take.sampleRate).notes) {
          expect(note.midi, `${type} noise at ${snrDb} dB SNR invented a note`).toBe(88);
        }
      }
    }
    expect(transcribe(noisyTake("pink", 0).samples, 48000).notes).toEqual([]);
  });

  it("rejects a loud low-frequency interferer by band-limiting", () => {
    // A 150 Hz sawtooth is the honest version of this test. A sine below the
    // band would simply vanish; a sawtooth's harmonics fall off as 1/n and so
    // reach into the whistle band no matter how low its fundamental sits —
    // which is what a voice, a violin or an engine actually does. Band-limiting
    // still wins the important half of the argument by discarding the
    // fundamental, where nearly all of the interferer's energy is.
    const whistleRmsDb = 20 * Math.log10(0.15 / Math.SQRT2);
    const clean = sequence([{ midi: 88, durSec: 0.6, amp: 0.15 }], {
      sampleRate: 48000,
      leadInSec: 0.2,
      tailSec: 0.2,
    });

    // Ten dB *below* the whistle, the sawtooth may as well not be there: its
    // fundamental is outside the band and its in-band harmonics are 1/n of an
    // already-quieter signal.
    const quiet = addSaw(clean, 150, whistleRmsDb - 10);
    expect(transcribe(quiet.samples, quiet.sampleRate).notes.map((n) => n.midi)).toEqual([88]);

    // At equal RMS the peak search still wins by a wide margin — the whistle's
    // energy is in one bin, the sawtooth's is spread over thirty harmonics.
    const even = addSaw(clean, 150, whistleRmsDb);
    const evenFrames = steadyFrames({ ...even, expected: clean.expected }, DEFAULT_CONFIG, 0.08);
    expect(Math.abs(median(errorsCents(evenFrames, 88)))).toBeLessThan(5);
    expect(median(evenFrames.map((f) => f.clarity))).toBeGreaterThan(DEFAULT_CONFIG.voicing.minClarity);

    // Ten dB louder, the peak search still finds the whistle — that is the
    // band-limiting working — but the frame no longer *looks* like a pure tone,
    // so voicing declines it. Reporting nothing is the correct answer here;
    // reporting a confident note would be a lie.
    const loud = addSaw(clean, 150, whistleRmsDb + 10);
    const frames = steadyFrames({ ...loud, expected: clean.expected }, DEFAULT_CONFIG, 0.08);
    expect(Math.abs(median(errorsCents(frames, 88)))).toBeLessThan(25);
    expect(median(frames.map((f) => f.clarity))).toBeLessThan(DEFAULT_CONFIG.voicing.minClarity);
    expect(transcribe(loud.samples, loud.sampleRate).notes).toEqual([]);
  });

  it("reports levels that agree with Parseval", () => {
    // bandRmsDb is derived from bin energies rather than from the samples, so
    // it is only correct if the window normalisation is. A full-band sine of
    // amplitude 0.5 has RMS 0.3536, i.e. −9.03 dBFS.
    const signal = sequence([{ midi: 88, durSec: 0.5, amp: 0.5 }], { sampleRate: 48000 });
    const frames = steadyFrames(signal, DEFAULT_CONFIG, 0.06);
    expect(median(frames.map((f) => f.bandRmsDb))).toBeCloseTo(-9.03, 1);
    // Nothing outside the band, so the two levels must agree.
    expect(median(frames.map((f) => f.broadbandRmsDb))).toBeCloseTo(-9.03, 1);
    // And the band level can never exceed the broadband one.
    for (const f of frames) expect(f.bandRmsDb).toBeLessThanOrEqual(f.broadbandRmsDb + 1e-9);
  });

  it("flags clipping and stays silent on silence", () => {
    const loud = sequence([{ midi: 88, durSec: 0.3, amp: 1.0 }], { sampleRate: 48000 });
    expect(steadyFrames(loud, DEFAULT_CONFIG, 0.06).some((f) => f.clipped)).toBe(true);

    const quiet = new PitchTracker(48000).push(new Float32Array(48000));
    for (const f of quiet) {
      expect(f.hz).toBeNull();
      expect(f.bandRmsDb).toBeLessThan(-200);
      expect(Number.isFinite(f.snrDb)).toBe(true);
      expect(Number.isFinite(f.peakToSecondDb)).toBe(true);
    }
  });
});
