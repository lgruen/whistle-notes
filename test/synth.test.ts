import { describe, expect, it } from "vitest";
import { addNoise, addTone, rms, sequence } from "./fixtures/synth.js";

/** Dominant autocorrelation lag within a plausible period range. */
function dominantPeriod(samples: Float32Array, minLag: number, maxLag: number): number {
  let bestLag = -1;
  let bestScore = -Infinity;
  const n = samples.length - maxLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += samples[i] * samples[i + lag];
    if (acc > bestScore) {
      bestScore = acc;
      bestLag = lag;
    }
  }
  return bestLag;
}

/** Mean frequency over a slice, from zero crossings. Crude but independent of
 *  the generator's own maths, which is the point when testing the generator. */
function zeroCrossingHz(samples: Float32Array, sampleRate: number): number {
  let first = -1;
  let last = -1;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  if (crossings < 2) return NaN;
  return ((crossings - 1) * sampleRate) / (last - first);
}

describe("sequence", () => {
  it("generates a 1 kHz sine with a 48-sample period at 48 kHz", () => {
    const { samples, sampleRate } = sequence([{ midi: 83, hz: 1000, durSec: 0.5 }]);
    expect(sampleRate).toBe(48000);

    // Analyse the steady middle, away from the raised-cosine edges.
    const slice = samples.subarray(8000, 12096);
    expect(dominantPeriod(slice, 20, 200)).toBe(48);
    expect(zeroCrossingHz(slice, sampleRate)).toBeCloseTo(1000, 0);
  });

  it("produces a sane RMS", () => {
    const { samples } = sequence([{ midi: 83, hz: 1000, durSec: 0.5, amp: 0.5 }]);
    // A sine of peak 0.5 has RMS 0.5/√2 ≈ 0.354 over its sustained part; the
    // 10 ms edges pull the whole-buffer figure down only slightly.
    expect(rms(samples.subarray(8000, 12096))).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it("uses equal temperament when no explicit hz is given", () => {
    const { samples, sampleRate } = sequence([{ midi: 69, durSec: 0.4 }]);
    expect(zeroCrossingHz(samples.subarray(4800, 14400), sampleRate)).toBeCloseTo(440, 0);
  });

  it("applies a constant detune in cents", () => {
    const { samples, sampleRate } = sequence([
      { midi: 69, durSec: 0.4, detuneCents: 40 },
    ]);
    const hz = zeroCrossingHz(samples.subarray(4800, 14400), sampleRate);
    expect(1200 * Math.log2(hz / 440)).toBeCloseTo(40, 0);
  });

  it("accumulates phase, so vibrato stays inside its stated bounds", () => {
    // The regression test for the sin(2πft) trap. With that formulation the
    // instantaneous frequency is f(t) + t·f′(t), so the deviation grows
    // without limit as the note runs; here it must stay within ±100 cents no
    // matter how late in the note you look.
    const durSec = 3;
    const { samples, sampleRate } = sequence([
      { midi: 69, durSec, vibratoCents: 100, vibratoHz: 5 },
    ]);

    const bound = 440 * Math.pow(2, 100 / 1200);
    for (const startSec of [0.2, 1.0, 2.0, 2.7]) {
      const from = Math.round(startSec * sampleRate);
      const hz = zeroCrossingHz(samples.subarray(from, from + Math.round(0.2 * sampleRate)), sampleRate);
      expect(hz).toBeGreaterThan(440 / Math.pow(2, 100 / 1200) - 5);
      expect(hz).toBeLessThan(bound + 5);
    }
  });

  it("glides in linearly and arrives on pitch", () => {
    const { samples, sampleRate } = sequence([
      { midi: 69, durSec: 1, glideInCents: -200, glideInMs: 300 },
    ]);
    // Starts a whole tone below...
    const start = zeroCrossingHz(samples.subarray(500, 2500), sampleRate);
    expect(1200 * Math.log2(start / 440)).toBeLessThan(-140);
    // ...and is settled on pitch well after the glide ends.
    const settled = zeroCrossingHz(samples.subarray(24000, 44000), sampleRate);
    expect(settled).toBeCloseTo(440, 0);
  });

  it("drifts across a note", () => {
    const { samples, sampleRate } = sequence([{ midi: 69, durSec: 2, driftCents: 150 }]);
    const early = zeroCrossingHz(samples.subarray(2400, 7200), sampleRate);
    const late = zeroCrossingHz(samples.subarray(88000, 95000), sampleRate);
    expect(1200 * Math.log2(late / early)).toBeGreaterThan(100);
  });

  it("lays out notes, gaps and lead-in on an exact sample grid", () => {
    const { samples, sampleRate, expected } = sequence(
      [
        { midi: 72, durSec: 0.25, gapSec: 0.1 },
        { midi: 76, durSec: 0.25 },
      ],
      { leadInSec: 0.5, tailSec: 0.2 },
    );

    expect(expected).toEqual([
      { midi: 72, startSec: 0.5, endSec: 0.75 },
      { midi: 76, startSec: 0.85, endSec: 1.1 },
    ]);
    expect(samples.length).toBe(Math.round(1.3 * sampleRate));

    // Lead-in, gap and tail are exactly silent — a segmentation test that
    // wants "true silence" must actually get it.
    expect(rms(samples.subarray(0, Math.round(0.5 * sampleRate)))).toBe(0);
    expect(rms(samples.subarray(Math.round(0.76 * sampleRate), Math.round(0.84 * sampleRate)))).toBe(0);
    expect(rms(samples.subarray(Math.round(1.11 * sampleRate)))).toBe(0);
  });

  it("fades in and out instead of clicking", () => {
    const { samples } = sequence([{ midi: 72, durSec: 0.3 }]);
    expect(Math.abs(samples[0])).toBeLessThan(1e-6);
    expect(Math.abs(samples[samples.length - 1])).toBeLessThan(1e-6);
    // Ramp is monotone-ish in envelope: the peak inside the first 10 ms is
    // well below the sustained peak.
    const firstMs = Math.max(...Array.from(samples.subarray(0, 48)).map(Math.abs));
    expect(firstMs).toBeLessThan(0.05);
  });

  it("keeps notes short enough to have no room for full edges", () => {
    // A 5 ms note is shorter than two 10 ms edges; it must still be finite
    // and bounded rather than producing NaN or overshoot.
    const { samples } = sequence([{ midi: 72, durSec: 0.005 }]);
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(samples).map(Math.abs))).toBeLessThanOrEqual(0.5 + 1e-6);
  });
});

describe("addNoise", () => {
  const silence = () => sequence([], { tailSec: 1 });

  it("hits the requested RMS level", () => {
    for (const levelDb of [-60, -40, -20]) {
      const noisy = addNoise(silence(), { levelDb });
      expect(20 * Math.log10(rms(noisy.samples))).toBeCloseTo(levelDb, 1);
    }
  });

  it("is deterministic for a given seed, and different across seeds", () => {
    const a = addNoise(silence(), { levelDb: -30, seed: 7 });
    const b = addNoise(silence(), { levelDb: -30, seed: 7 });
    const c = addNoise(silence(), { levelDb: -30, seed: 8 });
    expect(Array.from(a.samples)).toEqual(Array.from(b.samples));
    expect(Array.from(a.samples)).not.toEqual(Array.from(c.samples));
  });

  it("makes pink noise that is actually pinker than white", () => {
    const sr = 48000;
    const white = addNoise(sequence([], { tailSec: 1, sampleRate: sr }), {
      type: "white",
      levelDb: -20,
      seed: 3,
    });
    const pink = addNoise(sequence([], { tailSec: 1, sampleRate: sr }), {
      type: "pink",
      levelDb: -20,
      seed: 3,
    });

    // Same total energy by construction; compare how much sits low. A crude
    // one-pole low-pass is enough to tell a 1/f slope from a flat one.
    const lowEnergy = (s: Float32Array): number => {
      let y = 0;
      let sum = 0;
      const a = 0.02; // corner around 150 Hz at 48 kHz
      for (let i = 0; i < s.length; i++) {
        y += a * (s[i] - y);
        sum += y * y;
      }
      return sum;
    };
    expect(lowEnergy(pink.samples)).toBeGreaterThan(4 * lowEnergy(white.samples));
  });

  it("does not mutate its input", () => {
    const base = sequence([{ midi: 72, durSec: 0.2 }]);
    const before = Array.from(base.samples);
    addNoise(base, { levelDb: -20 });
    expect(Array.from(base.samples)).toEqual(before);
  });

  it("preserves ground truth through the pipeline", () => {
    const base = sequence([{ midi: 72, durSec: 0.2 }]);
    expect(addNoise(base, { levelDb: -40 }).expected).toEqual(base.expected);
  });
});

describe("addTone", () => {
  it("adds an interfering tone at the requested RMS level", () => {
    const hum = addTone(sequence([], { tailSec: 1 }), 50, -30);
    expect(20 * Math.log10(rms(hum.samples))).toBeCloseTo(-30, 1);
  });

  it("puts the tone at the frequency asked for", () => {
    const { samples, sampleRate } = addTone(sequence([], { tailSec: 1 }), 2000, -20);
    expect(zeroCrossingHz(samples, sampleRate)).toBeCloseTo(2000, 0);
  });

  it("does not mutate its input", () => {
    const base = sequence([{ midi: 72, durSec: 0.2 }]);
    const before = Array.from(base.samples);
    addTone(base, 50, -30);
    expect(Array.from(base.samples)).toEqual(before);
  });
});
