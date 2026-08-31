/**
 * Synthetic whistle signals with ground truth true by construction.
 *
 * CI must never depend on a recording: the real one is the user's own and is
 * gitignored out of this public repo. Everything the accuracy, robustness and
 * segmentation tests need is generated here instead, which has the pleasant
 * side effect that the expected answer is known exactly rather than agreed by
 * ear.
 *
 * A whistle is close to an ideal target for this: the mouth acts as a
 * Helmholtz resonator, so the sound is nearly a pure sine with almost no
 * harmonics. Modelling it as `amp · sin(φ)` is not a simplification we are
 * getting away with — it is genuinely most of the physics.
 */

import { midiToHz } from "../../src/dsp/tuning.js";

export interface SynthNote {
  /** Ground-truth pitch. Also sets the frequency unless `hz` overrides it. */
  midi: number;
  /** Exact frequency override in Hz, for tests that need a specific number
   *  (a round 1 kHz, say) rather than an equal-tempered one. Ground truth
   *  stays `midi`. */
  hz?: number;
  /** Constant detune in cents. The knob for accuracy sweeps: at ±40 cents a
   *  correct pipeline must still round to `midi`, and at ±60 it must not. */
  detuneCents?: number;
  durSec: number;
  /** Silence after this note, before the next. */
  gapSec?: number;
  /** Peak vibrato deviation in cents. */
  vibratoCents?: number;
  /** Vibrato rate in Hz. Human vibrato is roughly 4–7 Hz. */
  vibratoHz?: number;
  /** Start this many cents away from the target and slide to it — negative
   *  for the upward scoop most whistlers actually produce. Linear, so the
   *  slope it presents to the glide detector is exactly known. */
  glideInCents?: number;
  /** Duration of that slide, in ms. */
  glideInMs?: number;
  /** Total drift across the note, in cents, applied linearly. */
  driftCents?: number;
  /** Peak amplitude, 0..1. Default 0.5 leaves headroom for added noise. */
  amp?: number;
}

/** Where a note truly is, for tests to compare against. */
export interface ExpectedNote {
  midi: number;
  startSec: number;
  endSec: number;
}

/** A generated signal plus its ground truth. Shaped like the app's decode
 *  result so fixtures drop straight into `transcribe(samples, sampleRate)`. */
export interface SynthSignal {
  samples: Float32Array;
  sampleRate: number;
  expected: ExpectedNote[];
}

export interface SequenceOptions {
  sampleRate?: number;
  a4Hz?: number;
  /** Raised-cosine attack and release length, in ms. */
  edgeMs?: number;
  /** Silence before the first note — useful for exercising the mic-warmup
   *  discard and the adaptive noise floor, both of which need something to
   *  measure before the first note arrives. */
  leadInSec?: number;
  /** Silence after the last note. */
  tailSec?: number;
}

/**
 * Raised-cosine edge, 0 → 1 over `edge` samples and back.
 *
 * Not cosmetic: a hard start is a step function, and a step has energy at
 * every frequency. Switching a sine on abruptly sprays broadband noise across
 * the spectrum at exactly the moment the detector is trying to find a note
 * onset, which produces test failures that look like detector bugs and are
 * not. Ten milliseconds is enough to make the transient negligible while
 * staying far shorter than any note.
 */
function edgeGain(i: number, len: number, edge: number): number {
  if (edge <= 0) return 1;
  if (i < edge) return 0.5 * (1 - Math.cos((Math.PI * i) / edge));
  if (i >= len - edge) return 0.5 * (1 - Math.cos((Math.PI * (len - 1 - i)) / edge));
  return 1;
}

/**
 * Render a melody.
 *
 * **Phase is accumulated, never computed as `sin(2π·f·t)`.** This is the
 * single most important line in the file. If the frequency varies, the
 * instantaneous frequency of `sin(2π·f(t)·t)` is its derivative,
 * `f(t) + t·f′(t)` — not `f(t)`. A 50-cent vibrato written that way drifts
 * further off target the longer the note runs, and the resulting fixture
 * quietly tests something nobody intended. Integrating instead
 * (`φ += 2π·f[n]/sr`) makes the instantaneous frequency exactly `f[n]` by
 * construction, at every sample.
 */
export function sequence(notes: SynthNote[], opts: SequenceOptions = {}): SynthSignal {
  const sampleRate = opts.sampleRate ?? 48000;
  const a4Hz = opts.a4Hz ?? 440;
  const edge = Math.round(((opts.edgeMs ?? 10) / 1000) * sampleRate);

  // Lay out boundaries in whole samples first. Accumulating seconds and
  // converting per note would let rounding error creep along the timeline.
  const layout: { note: SynthNote; start: number; len: number }[] = [];
  let cursor = Math.round((opts.leadInSec ?? 0) * sampleRate);
  for (const note of notes) {
    const len = Math.round(note.durSec * sampleRate);
    layout.push({ note, start: cursor, len });
    cursor += len + Math.round((note.gapSec ?? 0) * sampleRate);
  }
  const total = cursor + Math.round((opts.tailSec ?? 0) * sampleRate);

  const samples = new Float32Array(total);

  for (const { note, start, len } of layout) {
    if (len <= 0) continue;
    const base = note.hz ?? midiToHz(note.midi, a4Hz);
    const amp = note.amp ?? 0.5;
    const noteEdge = Math.min(edge, Math.floor(len / 2));
    const vibratoCents = note.vibratoCents ?? 0;
    const vibratoHz = note.vibratoHz ?? 5;
    const glideCents = note.glideInCents ?? 0;
    const glideLen = Math.round(((note.glideInMs ?? 0) / 1000) * sampleRate);
    const driftCents = note.driftCents ?? 0;
    const detuneCents = note.detuneCents ?? 0;
    const lastIndex = Math.max(1, len - 1);

    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;

      let cents = detuneCents;
      if (glideCents !== 0 && glideLen > 0 && i < glideLen) {
        cents += glideCents * (1 - i / glideLen);
      }
      if (vibratoCents !== 0) cents += vibratoCents * Math.sin(2 * Math.PI * vibratoHz * t);
      if (driftCents !== 0) cents += driftCents * (i / lastIndex);

      samples[start + i] = amp * edgeGain(i, len, noteEdge) * Math.sin(phase);

      // Integrate the *instantaneous* frequency. See the doc comment.
      phase += (2 * Math.PI * base * Math.pow(2, cents / 1200)) / sampleRate;
    }
  }

  return {
    samples,
    sampleRate,
    expected: layout.map(({ note, start, len }) => ({
      midi: note.midi,
      startSec: start / sampleRate,
      endSec: (start + len) / sampleRate,
    })),
  };
}

/** Root-mean-square level of a buffer, in linear amplitude. */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
}

/** Seeded PRNG. Tests that add noise must be reproducible, or a flaky CI run
 *  becomes indistinguishable from a real regression. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseType = "white" | "pink";

export interface NoiseOptions {
  /** `white` is flat; `pink` falls at 3 dB/octave and is a much better model
   *  of room tone, traffic and breath — which matters because it puts most of
   *  its energy *below* the whistle band, where band-limiting discards it. */
  type?: NoiseType;
  /** Target noise RMS in dBFS, e.g. -40. */
  levelDb: number;
  seed?: number;
}

/** Add noise at a specified RMS level. Returns a new signal; never mutates. */
export function addNoise(signal: SynthSignal, opts: NoiseOptions): SynthSignal {
  const { type = "white", levelDb, seed = 1 } = opts;
  const random = mulberry32(seed);
  const n = signal.samples.length;
  const noise = new Float32Array(n);

  // Paul Kellet's pink-noise filter: a bank of one-pole low-passes whose
  // corner frequencies are spread by decade, summing to a very good 1/f
  // approximation across the audio band.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

  for (let i = 0; i < n; i++) {
    // Box-Muller: real acoustic noise is Gaussian, and the tails are what
    // decide whether a robustness test actually stresses the detector.
    const u1 = Math.max(random(), Number.MIN_VALUE);
    const white = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());

    if (type === "white") {
      noise[i] = white;
    } else {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      noise[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
    }
  }

  // Scale to the requested level after the fact, so `levelDb` means the same
  // thing for both colours regardless of the filter's arbitrary gain.
  const gain = Math.pow(10, levelDb / 20) / (rms(noise) || 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = signal.samples[i] + noise[i] * gain;

  return { samples: out, sampleRate: signal.sampleRate, expected: signal.expected };
}

/**
 * Add a steady interfering tone at a given RMS level — mains hum at 50 Hz, a
 * sustained vowel, a second whistler. Mostly used to prove that band-limiting
 * and `peakToSecondDb` do their jobs. Returns a new signal.
 */
export function addTone(signal: SynthSignal, hz: number, levelDb: number): SynthSignal {
  // A sine of peak amplitude A has RMS A/√2, so invert that to hit the level.
  const amp = Math.pow(10, levelDb / 20) * Math.SQRT2;
  const out = new Float32Array(signal.samples.length);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = signal.samples[i] + amp * Math.sin(phase);
    phase += (2 * Math.PI * hz) / signal.sampleRate;
  }
  return { samples: out, sampleRate: signal.sampleRate, expected: signal.expected };
}
