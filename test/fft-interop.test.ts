import { describe, expect, it } from "vitest";
import FFT from "fft.js";

// fft.js is a CommonJS package with `export = FFT` and no `exports` field, so
// a default import is an interop question, not a given. This test is the
// vitest leg of a three-way smoke test (vitest / tsx / vite build) that pins
// down the answer on day one, before the whole DSP core is written on top of
// it. If this file ever fails, the fix belongs in the build config — not in a
// scattering of `require` calls through src/dsp.
describe("fft.js interop", () => {
  it("default-imports and constructs", () => {
    const fft = new FFT(16);
    expect(fft.size).toBe(16);
  });

  it("finds the right peak bin for a known sine", () => {
    const N = 16;
    const cycles = 2; // exactly 2 periods across the window → energy in bin 2
    const input = new Array<number>(N);
    for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * cycles * i) / N);

    const fft = new FFT(N);
    const spectrum = fft.createComplexArray();
    fft.realTransform(spectrum, input);
    fft.completeSpectrum(spectrum);

    // Interleaved [re0, im0, re1, im1, ...]; only bins 0..N/2 are independent.
    let peakBin = 0;
    let peakMag = -Infinity;
    for (let bin = 0; bin <= N / 2; bin++) {
      const re = spectrum[2 * bin];
      const im = spectrum[2 * bin + 1];
      const mag = Math.hypot(re, im);
      if (mag > peakMag) {
        peakMag = mag;
        peakBin = bin;
      }
    }

    expect(peakBin).toBe(cycles);
    // A unit-amplitude real sine lands N/2 of magnitude in each of its two
    // conjugate bins — a sanity check that this is a real DFT, not garbage.
    expect(peakMag).toBeCloseTo(N / 2, 6);
  });
});
