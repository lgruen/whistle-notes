/**
 * Per-frame pitch estimation: band-limited FFT peak picking with parabolic
 * interpolation.
 *
 * ## Why a spectral method here
 *
 * A whistle is nearly a pure sine — the mouth is a Helmholtz resonator, not a
 * vibrating string — so the usual reason to prefer time-domain methods (YIN,
 * MPM: they follow a *periodicity* even when the fundamental is missing) buys
 * nothing, while their weakness at high f0 bites hard. Autocorrelation locates
 * a period in whole samples: at 4 kHz on a 48 kHz signal that period is 12
 * samples, so one sample of lag error is 144 cents — more than a semitone,
 * before interpolation. An FFT bin, by contrast, is a constant number of *Hz*
 * wide, while a semitone gets wider in Hz the higher you go. So spectral
 * resolution measured in cents **improves** exactly where whistles live:
 * an 8192-point transform at 48 kHz has 5.86 Hz bins, which is 20 cents at
 * 500 Hz and 2.6 cents at 4 kHz. The requirement is ±50.
 *
 * ## Everything here is threshold-free
 *
 * This module never decides whether a frame is a note. It reports what it
 * measured — a frequency, and four numbers describing how much that frequency
 * deserves to be believed — and segmentation makes every judgement call. That
 * split is what lets the Node harness cache frames once and then re-run a whole
 * parameter sweep in milliseconds. See CLAUDE.md.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import { RealFft } from "./fft.js";
import type { AnalysisConfig, PitchFrame } from "./types.js";
import { hannSumSquares, hannWindow } from "./window.js";

/** Amplitude floor for dBFS conversions: digital silence reads as −240 dBFS
 *  rather than −∞, so every field of a `PitchFrame` is finite by construction. */
const AMPLITUDE_EPS = 1e-12;
/** Power floor, the square of the amplitude floor. */
const POWER_EPS = AMPLITUDE_EPS * AMPLITUDE_EPS;
/** Ratios in dB are clamped to this. A ratio against a numerically-zero
 *  denominator is "infinitely good", which is true and useless; a bounded
 *  number keeps histograms and CSV columns readable. */
const MAX_RATIO_DB = 120;

/** A sample at or beyond this magnitude counts as clipping. Slightly under 1.0
 *  because converters and resamplers round, and a signal that has been squashed
 *  against the rail rarely comes back reading exactly full scale. */
const CLIP_THRESHOLD = 0.98;

/**
 * Hard ceiling on the peak search as a fraction of the sample rate.
 *
 * Nyquist is `sr/2`, but the top of the band is where anti-alias filters roll
 * off and where any aliased image would land, so nothing up there is
 * trustworthy. At 48 kHz this is 19.2 kHz and never binds; at 8 kHz it clamps
 * the search to 3.2 kHz, which is the honest answer for that signal.
 */
const MAX_BAND_FRACTION_OF_SR = 0.4;

/** Linear amplitude → dBFS, floored. */
function amplitudeToDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, AMPLITUDE_EPS));
}

/** A power ratio → dB, floored and clamped to a readable range. */
function ratioToDb(numerator: number, denominator: number): number {
  const db = 10 * Math.log10(Math.max(numerator, POWER_EPS) / Math.max(denominator, POWER_EPS));
  return Math.max(-MAX_RATIO_DB, Math.min(MAX_RATIO_DB, db));
}

/**
 * Everything about an analysis setup that does not change from frame to frame:
 * the FFT plan, the window table, the band's bin range.
 *
 * Built once per (sample rate, config) pair and reused. The FFT's twiddle
 * tables and scratch buffers are the expensive part — rebuilding them 94 times
 * a second on a phone would be pure waste.
 */
export interface Analyzer {
  readonly sampleRate: number;
  readonly config: AnalysisConfig;
  /** Transform length: `windowSize × zeroPadFactor`, rounded up to a power of
   *  two so odd window sizes still work. */
  readonly fftSize: number;
  /**
   * Padded bins per unpadded bin, `fftSize / windowSize`.
   *
   * This is the scale factor for every "how wide is a mainlobe" question below.
   * A periodic Hann window's mainlobe is 4 unpadded bins across (±2 from the
   * peak) no matter the frequency, so in the padded spectrum it is ±2·this.
   */
  readonly binsPerNaturalBin: number;
  /** First and last bin of the search band, inclusive. */
  readonly kLo: number;
  readonly kHi: number;
  /** Half-width of the peak's mainlobe, in padded bins. */
  readonly mainlobeHalfWidth: number;
  readonly fft: RealFft;
  /** Window table (shared, read-only) and its Σw² normalisation. */
  readonly windowTable: Float64Array;
  readonly windowSumSquares: number;
  /** Scratch: the DC-removed, windowed block handed to the FFT. */
  readonly windowed: Float64Array;
  /** Scratch: in-band powers, sorted in place to take a median. */
  readonly bandScratch: Float64Array;
}

/** Round up to the next power of two (identity if already one). */
function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Build the reusable analysis state for one sample rate and configuration. */
export function createAnalyzer(sampleRate: number, config: AnalysisConfig): Analyzer {
  const { windowSize, zeroPadFactor, minHz, maxHz } = config;
  if (!Number.isInteger(windowSize) || windowSize < 8) {
    throw new Error(`windowSize must be an integer ≥ 8, got ${windowSize}`);
  }
  if (!(zeroPadFactor >= 1)) throw new Error(`zeroPadFactor must be ≥ 1, got ${zeroPadFactor}`);

  const fftSize = nextPowerOfTwo(Math.round(windowSize * zeroPadFactor));
  const fft = new RealFft(fftSize);
  const binHz = sampleRate / fftSize;

  const bandTopHz = Math.min(maxHz, MAX_BAND_FRACTION_OF_SR * sampleRate);
  const bandBottomHz = Math.min(minHz, bandTopHz);
  // Bin 0 is DC and bin fftSize/2 is Nyquist; both are excluded so that the
  // three-point peak fit always has neighbours to work with.
  const kLo = Math.max(1, Math.ceil(bandBottomHz / binHz));
  const kHi = Math.min(fftSize / 2 - 1, Math.floor(bandTopHz / binHz));

  const binsPerNaturalBin = fftSize / windowSize;

  return {
    sampleRate,
    config,
    fftSize,
    binsPerNaturalBin,
    kLo,
    kHi,
    mainlobeHalfWidth: Math.max(1, Math.round(2 * binsPerNaturalBin)),
    fft,
    windowTable: hannWindow(windowSize),
    windowSumSquares: hannSumSquares(windowSize),
    windowed: new Float64Array(windowSize),
    bandScratch: new Float64Array(Math.max(1, kHi - kLo + 1)),
  };
}

/** A `PitchFrame` reporting "there was nothing here", with real level readings
 *  so the adaptive noise floor still has something to learn from. */
function silentFrame(tSec: number, bandRmsDb: number, broadbandRmsDb: number, clipped: boolean): PitchFrame {
  return {
    tSec,
    hz: null,
    clarity: 0,
    snrDb: 0,
    peakToSecondDb: 0,
    bandRmsDb,
    broadbandRmsDb,
    clipped,
  };
}

/**
 * Fit a parabola through three log-magnitude points and return the peak's
 * offset from the centre bin, in bins.
 *
 * Why *log* magnitude: the mainlobe of a Gaussian window is exactly a parabola
 * in dB, and a Hann mainlobe is close enough that the residual bias is a small
 * fraction of a bin. Fitting the linear magnitude instead systematically pulls
 * the estimate towards the bin centre.
 *
 * Returns 0 when the three points are not concave — a flat or convex triple is
 * not a peak, and the formula would happily extrapolate to somewhere absurd.
 */
function parabolicOffset(pLeft: number, pCentre: number, pRight: number): number {
  const a = 10 * Math.log10(Math.max(pLeft, POWER_EPS));
  const b = 10 * Math.log10(Math.max(pCentre, POWER_EPS));
  const c = 10 * Math.log10(Math.max(pRight, POWER_EPS));

  const denominator = a - 2 * b + c;
  if (!(denominator < 0)) return 0; // not concave: not a peak we can refine
  const delta = (0.5 * (a - c)) / denominator;
  if (!Number.isFinite(delta)) return 0;
  // A true interpolated peak lies inside the centre bin. Anything further means
  // the fit has gone wrong, and the bin index is the better answer.
  return Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Analyse one window of samples.
 *
 * `samples` must be exactly `config.windowSize` long; `tSec` is the time of the
 * window's **centre** (the caller owns the clock — see `tracker.ts`).
 */
export function analyzeFrame(analyzer: Analyzer, samples: ArrayLike<number>, tSec: number): PitchFrame {
  const { config, fftSize, kLo, kHi, windowTable, windowed, windowSumSquares, mainlobeHalfWidth } = analyzer;
  const n = config.windowSize;
  if (samples.length !== n) {
    throw new Error(`expected a block of ${n} samples, got ${samples.length}`);
  }

  // ---- Time domain: clipping check and DC removal ------------------------
  let mean = 0;
  let clipped = false;
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    mean += x;
    if (x >= CLIP_THRESHOLD || x <= -CLIP_THRESHOLD) clipped = true;
  }
  mean = config.removeDc ? mean / n : 0;

  // DC is not merely uninteresting, it is actively harmful: a constant offset
  // convolves the window's whole sidelobe skirt into the low bins, and a
  // whistle at 500 Hz is only ~85 bins away from that skirt.
  for (let i = 0; i < n; i++) windowed[i] = (samples[i] - mean) * windowTable[i];

  const power = analyzer.fft.powerSpectrum(windowed);
  const halfSize = fftSize / 2;

  // ---- Levels, via Parseval ---------------------------------------------
  // For a windowed block, Σ|X[k]|² over all fftSize bins equals fftSize·Σ y[n]²
  // and Σ y[n]² ≈ A²·Σ w[n]² for a signal of RMS A. Inverting gives the RMS
  // back; the factor 2 appears because the one-sided sum below counts each
  // conjugate pair once.
  let bandPower = 0;
  for (let k = kLo; k <= kHi; k++) bandPower += power[k];
  let totalHalfPower = 0;
  for (let k = 1; k < halfSize; k++) totalHalfPower += power[k];

  const normalisation = fftSize * windowSumSquares;
  const bandRmsDb = amplitudeToDb(Math.sqrt((2 * bandPower) / normalisation));
  const broadbandRmsDb = amplitudeToDb(
    Math.sqrt((2 * totalHalfPower + power[0] + power[halfSize]) / normalisation),
  );

  if (kHi - kLo < 2) return silentFrame(tSec, bandRmsDb, broadbandRmsDb, clipped);

  // ---- Peak search, band-limited ----------------------------------------
  // Restricting the search to the whistle band is the cheapest noise rejection
  // available: speech fundamentals (85–255 Hz), mains hum and traffic rumble
  // are simply not candidates, however loud they are.
  let kPeak = kLo;
  let peakPower = power[kLo];
  for (let k = kLo + 1; k <= kHi; k++) {
    if (power[k] > peakPower) {
      peakPower = power[k];
      kPeak = k;
    }
  }
  if (!(peakPower > 0)) return silentFrame(tSec, bandRmsDb, broadbandRmsDb, clipped);

  // A peak sitting on the band edge is a peak whose real summit is outside the
  // band. Its interpolation has no neighbour on one side and its frequency is
  // a guess, so report nothing rather than a confident wrong answer.
  const atBandEdge = kPeak === kLo || kPeak === kHi;

  let peakBin = kPeak;
  let refinedBin = kPeak + parabolicOffset(power[kPeak - 1], power[kPeak], power[kPeak + 1]);

  // ---- Sub-octave sanity check ------------------------------------------
  // The classic spectral failure is locking onto the second harmonic of a tone
  // whose fundamental is present but slightly weaker. Whistles have almost no
  // harmonics, so this rarely fires — but when it does it is the difference
  // between C6 and C5, which is the single most user-visible error possible.
  if (!atBandEdge) {
    const halfTarget = refinedBin / 2;
    const search = Math.max(1, mainlobeHalfWidth);
    const from = Math.max(kLo + 1, Math.round(halfTarget) - search);
    const to = Math.min(kHi - 1, Math.round(halfTarget) + search);
    let kHalf = -1;
    let halfPower = 0;
    for (let k = from; k <= to; k++) {
      if (power[k] > halfPower) {
        halfPower = power[k];
        kHalf = k;
      }
    }
    if (kHalf > 0 && ratioToDb(peakPower, halfPower) <= config.subOctaveToleranceDb) {
      peakBin = kHalf;
      peakPower = halfPower;
      refinedBin = kHalf + parabolicOffset(power[kHalf - 1], power[kHalf], power[kHalf + 1]);
    }
  }

  const hz = atBandEdge ? null : (refinedBin * analyzer.sampleRate) / fftSize;

  // ---- Metrics -----------------------------------------------------------
  // Clarity: how much of the in-band energy sits under the winning mainlobe.
  // A pure tone concentrates nearly all of it there and scores ~1; breath
  // noise spreads energy across the whole band and scores near 0. This is the
  // single most discriminating number the pitch stage produces.
  let mainlobePower = 0;
  const mainFrom = Math.max(kLo, peakBin - mainlobeHalfWidth);
  const mainTo = Math.min(kHi, peakBin + mainlobeHalfWidth);
  for (let k = mainFrom; k <= mainTo; k++) mainlobePower += power[k];
  const clarity = bandPower > 0 ? Math.max(0, Math.min(1, mainlobePower / bandPower)) : 0;

  // SNR against the *median* in-band bin, not the mean: a median ignores the
  // peak itself and any other tone in the room, so it measures the noise bed
  // rather than "the noise bed plus whatever else is playing".
  const bandCount = kHi - kLo + 1;
  const scratch = analyzer.bandScratch;
  for (let k = kLo; k <= kHi; k++) scratch[k - kLo] = power[k];
  const sorted = scratch.subarray(0, bandCount).sort();
  const medianPower =
    bandCount % 2 === 1
      ? sorted[(bandCount - 1) >> 1]
      : 0.5 * (sorted[bandCount / 2 - 1] + sorted[bandCount / 2]);
  const snrDb = ratioToDb(peakPower, medianPower);

  // Peak-to-second: the strongest *independent* competitor. Bins inside the
  // winner's own mainlobe are excluded (plus a two-bin guard for its first
  // sidelobe), and so are the neighbourhoods of the 2nd and 3rd harmonics —
  // a harmonic of the reported pitch is evidence *for* it, not a rival tone,
  // and counting it would make every slightly-buzzy whistle look ambiguous.
  // A peak at *half* the reported pitch is deliberately left in: that is the
  // octave ambiguity the sub-octave check just declined to act on, and the
  // frame really is less trustworthy for it.
  const exclusion = mainlobeHalfWidth + 2;
  const harmonic2 = 2 * refinedBin;
  const harmonic3 = 3 * refinedBin;
  let secondPower = 0;
  for (let k = kLo; k <= kHi; k++) {
    if (Math.abs(k - peakBin) <= exclusion) continue;
    if (Math.abs(k - harmonic2) <= exclusion || Math.abs(k - harmonic3) <= exclusion) continue;
    if (power[k] > secondPower) secondPower = power[k];
  }
  const peakToSecondDb = ratioToDb(peakPower, secondPower);

  return { tSec, hz, clarity, snrDb, peakToSecondDb, bandRmsDb, broadbandRmsDb, clipped };
}
