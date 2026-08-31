/**
 * Public entry point for the DSP island. Everything outside `src/dsp` imports
 * from here and from nowhere else inside it.
 *
 * The pipeline in one paragraph: a ring buffer cuts the signal into
 * half-overlapping windows (`tracker.ts`); each window is Hann-windowed,
 * zero-padded and transformed, and the strongest peak inside the whistle band
 * is refined by a parabolic fit to sub-bin accuracy (`pitch.ts`); the resulting
 * stream of frequency estimates, each carrying four numbers describing how much
 * it deserves to be believed, is turned into notes by a state machine that
 * knows about wobble, glides, drift and dropouts (`segment.ts`).
 *
 * The pitch stage makes no decisions and the segmentation stage does no signal
 * processing. That separation is what lets the Node harness cache frames once
 * and sweep every threshold in milliseconds — see CLAUDE.md.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import { DEFAULT_CONFIG } from "./config.js";
import { segmentNotes } from "./segment.js";
import { PitchTracker } from "./tracker.js";
import type { DspConfig, TranscriptionResult } from "./types.js";

export * from "./types.js";
export * from "./config.js";
export * from "./tuning.js";
export { PitchTracker } from "./tracker.js";
export { segmentNotes, durationClasses, hasRestBefore } from "./segment.js";
export type { SegmentationResult, DurationClass } from "./segment.js";
export { analyzeFrame, createAnalyzer } from "./pitch.js";
export type { Analyzer } from "./pitch.js";

/**
 * Transcribe a whole signal.
 *
 * Identical in behaviour to streaming the same samples through
 * {@link PitchTracker} in any chunk size: this function *is* that, plus
 * segmentation. The live path and the file-import path can therefore never
 * disagree about what was whistled, and a bad result on the phone reproduces
 * exactly in `tools/transcribe-file.ts`.
 */
export function transcribe(
  samples: Float32Array,
  sampleRate: number,
  cfg: DspConfig = DEFAULT_CONFIG,
): TranscriptionResult {
  const frames = new PitchTracker(sampleRate, cfg).push(samples);
  const { notes, tuningOffsetCents } = segmentNotes(frames, cfg, sampleRate);
  return { notes, frames, sampleRate, tuningOffsetCents };
}
