/**
 * Analysis windows.
 *
 * Chopping a signal into finite blocks is itself a multiplication by a
 * rectangle, and a rectangle's spectrum is a sinc — first sidelobe only 13 dB
 * down, decaying at 6 dB/octave. A second tone 20 dB quieter than the whistle
 * would sit *underneath* that skirt and vanish. A Hann window trades a wider
 * mainlobe (4 bins instead of 2) for sidelobes 31 dB down decaying at
 * 18 dB/octave, which is the trade this pipeline wants: the whistle band is
 * sparse, so resolution is cheap and dynamic range is precious.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

/**
 * Cache keyed by length. A Hann table is pure trigonometry — the same numbers
 * every time — and recomputing 2048 cosines per frame at 94 frames/second on a
 * phone is a waste of a battery.
 */
const hannCache = new Map<number, Float64Array>();

/**
 * Periodic (DFT-symmetric) Hann window of length `n`: `0.5·(1 − cos(2πi/n))`.
 *
 * Periodic, not symmetric — the denominator is `n`, not `n − 1`. The symmetric
 * form is for filter design; for spectral analysis the periodic form is the one
 * whose DFT is exactly three non-zero bins, which is what makes the
 * parabolic-interpolation step below well behaved. The difference is one sample
 * and it matters more than it looks.
 *
 * The returned array is shared and cached: **treat it as read-only.**
 */
export function hannWindow(n: number): Float64Array {
  const cached = hannCache.get(n);
  if (cached) return cached;

  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  hannCache.set(n, w);
  return w;
}

/** Σ w[i]² — the normalisation Parseval needs to turn bin energy back into an
 *  RMS level. Cached alongside the window it describes. */
const hannSumSquaresCache = new Map<number, number>();

export function hannSumSquares(n: number): number {
  const cached = hannSumSquaresCache.get(n);
  if (cached !== undefined) return cached;

  const w = hannWindow(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += w[i] * w[i];
  hannSumSquaresCache.set(n, sum);
  return sum;
}
