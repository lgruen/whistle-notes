/**
 * Default parameters and the user-facing presets.
 *
 * Every value here is a **starting point** chosen from the physics of
 * whistling and from what the detector can resolve — not a tuned constant.
 * M2/M3 re-derive them from measured histograms on real recordings using the
 * harness's sweep mode. Treat a number in this file as a hypothesis.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import type { DspConfig, DspConfigOverrides } from "./types.js";

export const DEFAULT_CONFIG: DspConfig = {
  analysis: {
    // 2048 samples ≈ 43 ms at 48 kHz. The trade is resolution against
    // stationarity: longer windows localise the peak better but smear
    // vibrato, and a whistle's vibrato is fast enough to matter.
    windowSize: 2048,
    // FFT length 8192. Padding buys no new information — it interpolates the
    // spectrum so the 3-point parabolic peak fit sits on a smoother curve and
    // stops biasing its answer towards the bin centre.
    zeroPadFactor: 4,
    // ≈ 94 frames/second at 48 kHz: fine enough to catch a short note's
    // onset, coarse enough to stay cheap on a phone.
    hopSize: 512,
    // Whistles live from roughly 500 Hz to 4 kHz. The margin below catches
    // low whistles while still excluding speech fundamentals (85–255 Hz) and
    // mains hum, which is why band-limiting is such cheap noise rejection.
    minHz: 400,
    maxHz: 4500,
    // Octave-error guard: a half-frequency peak within 6 dB of the winner is
    // more likely to be the true fundamental than a coincidence.
    subOctaveToleranceDb: 6,
    removeDc: true,
  },

  voicing: {
    // A near-pure tone puts most of its in-band energy under one mainlobe;
    // breath noise scores close to zero. 0.5 is a deliberately loose gate —
    // the SNR and hysteresis checks do the discriminating work.
    minClarity: 0.5,
    minSnrDb: 12,
    // Only 6 dB: this rejects genuinely ambiguous frames without punishing a
    // whistle that happens to share the room with a second tone.
    minPeakToSecondDb: 6,
    // The 20th percentile of recent unvoiced levels: low enough to sit in the
    // quiet part of the distribution, high enough not to chase a single
    // anomalously silent frame.
    noiseFloorPercentile: 20,
    noiseFloorWindowSec: 3,
    // Asymmetric by design — see VoicingConfig. Starting a note demands
    // 12 dB over the floor; holding one needs only 6.
    onsetAboveFloorDb: 12,
    sustainAboveFloorDb: 6,
    warmupSec: 0.3,
  },

  smoothing: {
    // Under ~32 ms of agreement is not a note anyone whistled.
    minVoicedRunFrames: 3,
    // Five frames ≈ 53 ms. A median removes isolated octave jumps outright
    // rather than averaging them into a wrong-but-plausible pitch, which is
    // exactly the failure mode a mean would produce here.
    medianFilterFrames: 5,
  },

  segment: {
    // 12 semitones/second: far faster than vibrato or drift, far slower than
    // a note change, so it cleanly isolates deliberate glides and scoops.
    glideSlopeStPerSec: 12,
    // 60 cents — a bit over half a semitone. The "wobble snap" knob.
    toleranceCents: 60,
    refMedianLength: 15,
    confirmFrames: 3,
    driftCapSemitones: 1.5,
    // Whistlers scoop into notes. Dropping the first quarter of a long note
    // keeps the approach out of the pitch estimate.
    attackTrimFraction: 0.25,
    attackTrimMinMs: 120,
    // 80 ms is around the shortest deliberate note in a whistled melody.
    minNoteMs: 80,
    // Under 60 ms at the same pitch is a detector dropout, not a rest.
    gapMergeMs: 60,
    restGapMs: 180,
  },

  tuning: {
    a4Hz: 440,
    enableAutoTuning: true,
    maxTuningOffsetCents: 50,
    // Circular resultant length; below this the offsets are scattered enough
    // that "the whistler is detuned" is the wrong explanation.
    minTuningConcentration: 0.6,
    minTuningNotes: 4,
  },
};

/**
 * Presets for the user-facing "wobble snap" control.
 *
 * They move only the *taste* axis — how much pitch movement still counts as
 * one note. Voicing thresholds deliberately stay identical across presets:
 * those are measured properties of the signal, not a preference, and letting
 * a taste knob change them would make "Forgiving" mean two unrelated things
 * at once.
 */
export const PRESETS = {
  /** Splits readily. Best for someone whose pitch is already steady. */
  strict: { segment: { toleranceCents: 40, driftCapSemitones: 1.0 } },
  /** The default. */
  normal: { segment: { toleranceCents: 60, driftCapSemitones: 1.5 } },
  /** Holds a note through a lot of wobble. Fewer, longer, calmer notes. */
  forgiving: { segment: { toleranceCents: 90, driftCapSemitones: 2.0 } },
} as const satisfies Record<string, DspConfigOverrides>;

export type PresetName = keyof typeof PRESETS;

/**
 * Shallow-merges per group, returning a new config. Used by the presets and
 * by the harness's `--set group.key=value` flag; never mutates its input.
 *
 * Written out group by group rather than looped: an object literal has to
 * satisfy `DspConfig` in full, so adding a group to the config and forgetting
 * it here is a compile error rather than a silently dropped section.
 */
export function mergeConfig(base: DspConfig, overrides: DspConfigOverrides): DspConfig {
  return {
    analysis: { ...base.analysis, ...overrides.analysis },
    voicing: { ...base.voicing, ...overrides.voicing },
    smoothing: { ...base.smoothing, ...overrides.smoothing },
    segment: { ...base.segment, ...overrides.segment },
    tuning: { ...base.tuning, ...overrides.tuning },
  };
}

/** `DEFAULT_CONFIG` with a named preset applied. */
export function presetConfig(name: PresetName, base: DspConfig = DEFAULT_CONFIG): DspConfig {
  return mergeConfig(base, PRESETS[name]);
}
