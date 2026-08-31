import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PitchTracker, mergeConfig, presetConfig, transcribe } from "../src/dsp/index.js";
import { sequence } from "./fixtures/synth.js";

/**
 * Contract tests, not accuracy tests.
 *
 * `src/dsp` currently holds a deliberately naive stub, so nothing here asserts
 * that the *right* notes come out — that arrives with the real detector in
 * M2/M3. What these do pin down is the shape of the interface the UI is being
 * built against, and the structural invariants the real implementation must
 * also satisfy. They should survive the stub's deletion unchanged.
 */

const melody = () =>
  sequence(
    [
      { midi: 84, durSec: 0.4, gapSec: 0.1 },
      { midi: 86, durSec: 0.4, gapSec: 0.1 },
      { midi: 88, durSec: 0.4 },
    ],
    { leadInSec: 0.2, tailSec: 0.2 },
  );

describe("transcribe", () => {
  it("returns a well-formed result", () => {
    const { samples, sampleRate } = melody();
    const result = transcribe(samples, sampleRate);

    expect(result.sampleRate).toBe(sampleRate);
    expect(result.frames.length).toBeGreaterThan(0);
    expect(Array.isArray(result.notes)).toBe(true);
    expect(Number.isFinite(result.tuningOffsetCents)).toBe(true);
  });

  it("emits frames on the configured hop grid, timed at window centres", () => {
    const { samples, sampleRate } = melody();
    const { frames } = transcribe(samples, sampleRate);
    const { windowSize, hopSize } = DEFAULT_CONFIG.analysis;

    expect(frames[0].tSec).toBeCloseTo(windowSize / 2 / sampleRate, 9);
    expect(frames[1].tSec - frames[0].tSec).toBeCloseTo(hopSize / sampleRate, 9);

    const expectedCount = Math.floor((samples.length - windowSize) / hopSize) + 1;
    expect(frames).toHaveLength(expectedCount);
  });

  it("fills every documented frame field with a finite value", () => {
    const { samples, sampleRate } = melody();
    for (const f of transcribe(samples, sampleRate).frames) {
      expect(Number.isFinite(f.tSec)).toBe(true);
      expect(f.hz === null || Number.isFinite(f.hz)).toBe(true);
      expect(f.clarity).toBeGreaterThanOrEqual(0);
      expect(f.clarity).toBeLessThanOrEqual(1);
      for (const v of [f.snrDb, f.peakToSecondDb, f.bandRmsDb, f.broadbandRmsDb]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(typeof f.clipped).toBe("boolean");
    }
  });

  it("produces notes that are internally consistent", () => {
    const { samples, sampleRate } = melody();
    const { notes } = transcribe(samples, sampleRate);

    let previousEnd = -Infinity;
    for (const note of notes) {
      expect(Number.isInteger(note.midi)).toBe(true);
      expect(note.durationSec).toBeCloseTo(note.endSec - note.startSec, 9);
      expect(note.endSec).toBeGreaterThan(note.startSec);
      expect(note.centsOffset).toBeGreaterThanOrEqual(-50);
      expect(note.centsOffset).toBeLessThan(50);
      expect(note.gapBeforeSec).toBeGreaterThanOrEqual(0);
      // Notes are ordered and never overlap.
      expect(note.startSec).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = note.endSec;
    }
  });

  it("keeps the reported pitch consistent with the note name", () => {
    const { samples, sampleRate } = melody();
    for (const note of transcribe(samples, sampleRate).notes) {
      // noteName must describe midi, and pitchHz must be within half a
      // semitone of it — the invariant the UI's readout depends on.
      expect(note.noteName).toMatch(/^[A-G]#?-?\d+$/);
      const impliedMidi = 69 + 12 * Math.log2(note.pitchHz / 440);
      expect(Math.abs(impliedMidi - note.midi)).toBeLessThanOrEqual(0.5);
    }
  });

  it("handles degenerate input without throwing", () => {
    expect(() => transcribe(new Float32Array(0), 48000)).not.toThrow();
    expect(transcribe(new Float32Array(0), 48000).frames).toEqual([]);
    expect(transcribe(new Float32Array(100), 48000).notes).toEqual([]);
    expect(() => transcribe(new Float32Array(48000), 48000)).not.toThrow();
  });

  it("is rate-agnostic: it reads the rate it is given", () => {
    for (const sampleRate of [44100, 48000]) {
      const { samples } = sequence([{ midi: 84, durSec: 0.5 }], { sampleRate });
      expect(transcribe(samples, sampleRate).sampleRate).toBe(sampleRate);
    }
  });
});

describe("PitchTracker", () => {
  it("is chunk-size independent", () => {
    // The property that lets the live meter and the offline transcription run
    // the same code: an AudioWorklet's 128-sample blocks and one whole
    // recording must yield byte-identical frames.
    const { samples, sampleRate } = melody();

    const collect = (chunkSize: number) => {
      const tracker = new PitchTracker(sampleRate);
      const frames = [];
      for (let i = 0; i < samples.length; i += chunkSize) {
        frames.push(...tracker.push(samples.subarray(i, Math.min(i + chunkSize, samples.length))));
      }
      return frames;
    };

    const whole = collect(samples.length);
    expect(whole.length).toBeGreaterThan(10);
    for (const chunkSize of [128, 512, 1000]) {
      expect(collect(chunkSize)).toEqual(whole);
    }
  });

  it("emits nothing until a full window has arrived", () => {
    const tracker = new PitchTracker(48000);
    expect(tracker.push(new Float32Array(DEFAULT_CONFIG.analysis.windowSize - 1))).toEqual([]);
    expect(tracker.push(new Float32Array(1))).toHaveLength(1);
  });

  it("tolerates empty pushes", () => {
    const tracker = new PitchTracker(48000);
    expect(tracker.push(new Float32Array(0))).toEqual([]);
  });
});

describe("config", () => {
  it("merges overrides per group without mutating the base", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { segment: { toleranceCents: 999 } });
    expect(merged.segment.toleranceCents).toBe(999);
    // Untouched fields in the same group survive.
    expect(merged.segment.minNoteMs).toBe(DEFAULT_CONFIG.segment.minNoteMs);
    // Other groups survive, and the base is unchanged.
    expect(merged.analysis).toEqual(DEFAULT_CONFIG.analysis);
    expect(DEFAULT_CONFIG.segment.toleranceCents).toBe(60);
  });

  it("orders the wobble-snap presets as their names promise", () => {
    const strict = presetConfig("strict").segment;
    const normal = presetConfig("normal").segment;
    const forgiving = presetConfig("forgiving").segment;

    expect(strict.toleranceCents).toBeLessThan(normal.toleranceCents);
    expect(normal.toleranceCents).toBeLessThan(forgiving.toleranceCents);
    expect(strict.driftCapSemitones).toBeLessThan(forgiving.driftCapSemitones);
    expect(normal).toEqual(DEFAULT_CONFIG.segment);
  });

  it("keeps voicing thresholds identical across presets", () => {
    // The presets are a taste knob, not a sensitivity knob. If this ever
    // fails, "Forgiving" has quietly started meaning two different things.
    for (const name of ["strict", "normal", "forgiving"] as const) {
      expect(presetConfig(name).voicing).toEqual(DEFAULT_CONFIG.voicing);
      expect(presetConfig(name).analysis).toEqual(DEFAULT_CONFIG.analysis);
    }
  });
});
