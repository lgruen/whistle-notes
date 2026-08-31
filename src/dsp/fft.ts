/**
 * A thin, allocation-free wrapper over `fft.js` that answers the only question
 * this pipeline ever asks a Fourier transform: *how much energy is in each bin
 * of this real-valued block?*
 *
 * Everything downstream works in power (`|X|²`) rather than magnitude. Squaring
 * is where a magnitude spectrum would have taken a square root and then the
 * dB conversion would have squared it again; skipping the round trip costs a
 * factor of two in the `10·log10` constants and nothing else.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import FFT from "fft.js";

/** Smallest transform `fft.js` accepts, and the smallest that means anything. */
const MIN_FFT_SIZE = 4;

/**
 * A reusable real-input FFT of a fixed size.
 *
 * Reusable because the scratch buffers dominate: at 94 frames/second an
 * 8192-point transform would otherwise allocate ~200 kB per frame and hand the
 * garbage collector a job it does not need in an audio hot path. One instance
 * per (window size, zero-pad factor) pair is enough — construct it once and
 * call {@link powerSpectrum} forever.
 *
 * **Not re-entrant**: consecutive calls overwrite the same output buffer, so
 * consume the result before calling again.
 */
export class RealFft {
  /** Transform length, i.e. window size × zero-pad factor. Power of two. */
  readonly size: number;
  /** Number of independent bins, `size / 2 + 1` (DC through Nyquist). */
  readonly binCount: number;

  private readonly fft: FFT;
  /** Zero-padded real input. Allocated once; the tail past the window stays
   *  zero for the object's whole life, so padding costs nothing per frame. */
  private readonly input: Float64Array;
  /** Interleaved `[re0, im0, re1, im1, …]` output from fft.js. */
  private readonly spectrum: number[];
  private readonly power: Float64Array;

  constructor(size: number) {
    if (size < MIN_FFT_SIZE || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two ≥ ${MIN_FFT_SIZE}, got ${size}`);
    }
    this.size = size;
    this.binCount = size / 2 + 1;
    this.fft = new FFT(size);
    this.input = new Float64Array(size);
    this.spectrum = this.fft.createComplexArray();
    this.power = new Float64Array(this.binCount);
  }

  /**
   * Power spectrum `|X[k]|²` for `k = 0 … size/2`.
   *
   * `samples` may be shorter than `size`; the remainder is the zero padding.
   * Padding adds no information — the underlying signal is still only as
   * resolved as its window length allows — but it interpolates the spectrum
   * onto a finer grid, which is what stops the three-point parabolic peak fit
   * in `pitch.ts` from biasing its answer towards the nearest bin centre.
   *
   * Only bins 0…size/2 are computed: for real input the rest are complex
   * conjugates and carry no new information, which is why `fft.js`'s
   * `completeSpectrum` is deliberately *not* called here.
   *
   * The returned array is internal scratch — read it, don't keep it.
   */
  powerSpectrum(samples: ArrayLike<number>): Float64Array {
    if (samples.length > this.size) {
      throw new Error(`input of ${samples.length} exceeds FFT size ${this.size}`);
    }
    for (let i = 0; i < samples.length; i++) this.input[i] = samples[i];
    // Anything past `samples.length` is already zero: the buffer starts zeroed
    // and every write below `size` is overwritten by a caller of the same
    // length. Callers with a *shrinking* input would leave stale tails, so
    // clear defensively — it is one pass over memory that never runs in
    // practice because window size is fixed for the life of the object.
    for (let i = samples.length; i < this.size; i++) this.input[i] = 0;

    this.fft.realTransform(this.spectrum, this.input as unknown as number[]);

    for (let k = 0; k < this.binCount; k++) {
      const re = this.spectrum[2 * k];
      const im = this.spectrum[2 * k + 1];
      this.power[k] = re * re + im * im;
    }
    return this.power;
  }
}
