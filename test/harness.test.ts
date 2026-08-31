import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, type DspConfig, type PitchFrame } from "../src/dsp/index.js";
import { FrameSource, parseSetting } from "../tools/transcribe-file.js";

/**
 * The offline harness's two silent-wrong-answer bugs.
 *
 * Neither of these produced an error or an obviously bad transcription. Both
 * produced a *plausible* one — a number that parsed to NaN, a sweep that
 * re-labelled frames it had not recomputed — which is the expensive kind of
 * wrong, because the output of this tool is the evidence every DSP decision in
 * the project is argued from.
 */

describe("--set", () => {
  it("takes numbers and booleans", () => {
    expect(parseSetting("segment.toleranceCents=80")).toEqual({ segment: { toleranceCents: 80 } });
    expect(parseSetting("segment.attackTrimFraction=0.3")).toEqual({
      segment: { attackTrimFraction: 0.3 },
    });
    expect(parseSetting("analysis.removeDc=false")).toEqual({ analysis: { removeDc: false } });
    expect(parseSetting("tuning.a4Hz=442")).toEqual({ tuning: { a4Hz: 442 } });
  });

  it("refuses a value of the wrong type instead of quietly producing NaN", () => {
    // `60c` used to become `Number("60c")` — NaN — and every comparison against
    // NaN is false, so the run produced a different transcription and said
    // nothing. A sweep is only worth something if the numbers in it are the
    // numbers that were asked for.
    expect(() => parseSetting("segment.toleranceCents=60c")).toThrow(/is a number/);
    expect(() => parseSetting("segment.toleranceCents=")).toThrow(/is a number/);
    expect(() => parseSetting("segment.minNoteMs=eighty")).toThrow(/is a number/);
    expect(() => parseSetting("tuning.enableAutoTuning=yes")).toThrow(/is a boolean/);
    expect(() => parseSetting("tuning.enableAutoTuning=1")).toThrow(/is a boolean/);
  });

  it("still refuses unknown paths", () => {
    expect(() => parseSetting("segment.tolerence=60")).toThrow(/unknown config key/);
    expect(() => parseSetting("wobble.snap=60")).toThrow(/unknown config path/);
    expect(() => parseSetting("segment.toleranceCents")).toThrow(/group.key=value/);
  });
});

describe("the frame cache", () => {
  const frame: PitchFrame = {
    tSec: 0,
    hz: 1000,
    clarity: 0.9,
    snrDb: 30,
    peakToSecondDb: 20,
    bandRmsDb: -20,
    broadbandRmsDb: -20,
    clipped: false,
  };
  const cache = { sampleRate: 48000, analysis: DEFAULT_CONFIG.analysis, frames: [frame] };

  it("serves cached frames for the settings they were computed with", () => {
    const source = new FrameSource(undefined, cache);
    expect(source.needsAnalysis(DEFAULT_CONFIG)).toBe(false);
    expect(source.frames(DEFAULT_CONFIG).frames).toHaveLength(1);

    // Segmentation thresholds do not touch the frames, which is the whole point
    // of the threshold-free pitch stage.
    const resegmented = mergeConfig(DEFAULT_CONFIG, { segment: { toleranceCents: 90 } });
    expect(source.needsAnalysis(resegmented)).toBe(false);
  });

  it("refuses to re-segment frames under analysis settings that did not produce them", () => {
    // This is the bug that made a whole class of sweeps meaningless. A
    // `windowSize` sweep over a cache re-segments the *same* frames and reports
    // perfect stability because nothing changed; a `hopSize` sweep is worse
    // still, because segmentation converts frame indices to seconds through the
    // hop while the frames stay on the old grid — every timing in the output is
    // then scaled by a ratio nobody intended.
    const source = new FrameSource(undefined, cache);
    for (const analysis of [{ windowSize: 4096 }, { hopSize: 256 }, { zeroPadFactor: 1 }]) {
      const cfg: DspConfig = mergeConfig(DEFAULT_CONFIG, { analysis });
      expect(source.needsAnalysis(cfg)).toBe(true);
      expect(() => source.frames(cfg)).toThrow(/different analysis settings/);
    }
  });

  it("does not care what order the analysis keys are in", () => {
    // The cache arrives from JSON, so key order is whatever the writer used.
    const reordered = {
      ...cache,
      analysis: Object.fromEntries(
        Object.entries(DEFAULT_CONFIG.analysis).reverse(),
      ) as DspConfig["analysis"],
    };
    expect(new FrameSource(undefined, reordered).needsAnalysis(DEFAULT_CONFIG)).toBe(false);
  });
});
