/**
 * Public entry point for the DSP island. Everything outside `src/dsp` imports
 * from here and from nowhere else inside it.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  NAIVE STUB — replaced wholesale in M2/M3.                           │
 * │                                                                      │
 * │  `transcribe` and `PitchTracker` below implement the real signatures │
 * │  with a deliberately crude algorithm (coarse autocorrelation, then   │
 * │  round-and-group segmentation) so the UI can be built against the    │
 * │  frozen contract while the real detector is written in parallel.     │
 * │                                                                      │
 * │  It is honest about being bad: it ignores nearly every field of      │
 * │  DspConfig, its frame metrics are plausibly-shaped placeholders      │
 * │  rather than the real measurements, and it will make octave errors   │
 * │  on clean input. Do not tune anything against it, and do not build   │
 * │  a feature that depends on its behaviour — only on its types.        │
 * │                                                                      │
 * │  M2 replaces the pitch stage (band-limited FFT peak picking with     │
 * │  parabolic interpolation); M3 replaces the segmentation. The         │
 * │  exported signatures stay exactly as they are.                       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import { DEFAULT_CONFIG } from "./config.js";
import { hzToMidiFloat, midiToHz, midiToName, nearestNote } from "./tuning.js";
import type { DspConfig, Note, PitchFrame, TranscriptionResult } from "./types.js";

export * from "./types.js";
export * from "./config.js";
export * from "./tuning.js";

const EPS = 1e-12;

/** Linear amplitude to dBFS, floored so silence yields a finite number. */
function toDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, EPS));
}

/**
 * Streaming pitch detector.
 *
 * The important property — which the stub already honours and the real
 * implementation must keep — is **chunk-size independence**: `push()` may be
 * fed 128 samples at a time from an AudioWorklet or the entire recording in
 * one go, and the frames that come out are identical either way. That is what
 * lets the live meter and the offline transcription run literally the same
 * code, and what makes the Node harness a faithful reproduction of the phone.
 */
export class PitchTracker {
  private readonly cfg: DspConfig;
  private readonly sampleRate: number;
  /** Samples received but not yet consumed by a completed frame. */
  private tail: Float32Array = new Float32Array(0);
  /** Absolute index, in samples, of `tail[0]` within the whole signal. */
  private tailStart = 0;

  constructor(sampleRate: number, cfg: DspConfig = DEFAULT_CONFIG) {
    this.sampleRate = sampleRate;
    this.cfg = cfg;
  }

  /** Feed more audio; returns whatever frames just became complete. */
  push(chunk: Float32Array): PitchFrame[] {
    const { windowSize, hopSize } = this.cfg.analysis;

    const merged = new Float32Array(this.tail.length + chunk.length);
    merged.set(this.tail, 0);
    merged.set(chunk, this.tail.length);

    const frames: PitchFrame[] = [];
    let offset = 0;
    while (offset + windowSize <= merged.length) {
      frames.push(
        this.analyse(
          merged.subarray(offset, offset + windowSize),
          // Window *centre*, per the PitchFrame contract.
          (this.tailStart + offset + windowSize / 2) / this.sampleRate,
        ),
      );
      offset += hopSize;
    }

    this.tail = merged.slice(offset);
    this.tailStart += offset;
    return frames;
  }

  /** STUB: coarse autocorrelation over the band, plus placeholder metrics. */
  private analyse(w: Float32Array, tSec: number): PitchFrame {
    const { minHz, maxHz } = this.cfg.analysis;

    let sumSq = 0;
    let clipped = false;
    for (let i = 0; i < w.length; i++) {
      sumSq += w[i] * w[i];
      if (Math.abs(w[i]) >= 0.999) clipped = true;
    }
    const rmsDb = toDb(Math.sqrt(sumSq / w.length));

    // Search only the lags the configured band admits. `maxHz` gives the
    // shortest period, hence the smallest lag.
    const minLag = Math.max(2, Math.floor(this.sampleRate / maxHz));
    const maxLag = Math.min(Math.floor(this.sampleRate / minHz), (w.length >> 1) - 1);

    let bestLag = -1;
    let bestScore = 0;
    let secondScore = 0;
    let scoreSum = 0;
    let scoreCount = 0;
    const n = w.length - maxLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += w[i] * w[i + lag];
      const score = acc / (sumSq + EPS);
      scoreSum += score;
      scoreCount++;
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestLag = lag;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    const meanScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
    const hz = bestLag > 0 && bestScore > 0 ? this.sampleRate / bestLag : null;

    return {
      tSec,
      hz,
      clarity: Math.max(0, Math.min(1, bestScore)),
      // Placeholders with the right units and rough behaviour. The real
      // versions are spectral and are not derivable from autocorrelation.
      snrDb: toDb(bestScore) - toDb(Math.abs(meanScore)),
      peakToSecondDb: toDb(bestScore) - toDb(secondScore),
      bandRmsDb: rmsDb,
      broadbandRmsDb: rmsDb,
      clipped,
    };
  }
}

/**
 * Offline transcription. Identical in behaviour to streaming the same samples
 * through {@link PitchTracker} — the live path and the file-import path must
 * never be able to disagree about what was whistled.
 */
export function transcribe(
  samples: Float32Array,
  sampleRate: number,
  cfg: DspConfig = DEFAULT_CONFIG,
): TranscriptionResult {
  const frames = new PitchTracker(sampleRate, cfg).push(samples);
  return {
    notes: segmentStub(frames, cfg, sampleRate),
    frames,
    sampleRate,
    // STUB: the real global tuning estimate arrives with M3.
    tuningOffsetCents: 0,
  };
}

/** STUB segmentation: gate, round to semitones, group equal neighbours. */
function segmentStub(frames: PitchFrame[], cfg: DspConfig, sampleRate: number): Note[] {
  const { a4Hz } = cfg.tuning;
  const notes: Note[] = [];
  let run: { midi: number; frames: PitchFrame[] } | null = null;

  const flush = (endSec: number): void => {
    const cur = run;
    run = null;
    if (!cur) return;
    const midiFloats = cur.frames.map((f) => hzToMidiFloat(f.hz as number, a4Hz));
    const meanMidi = midiFloats.reduce((a, b) => a + b, 0) / midiFloats.length;
    const pitchHz = midiToHz(meanMidi, a4Hz);
    const startSec = cur.frames[0].tSec;
    const durationSec = endSec - startSec;
    if (durationSec * 1000 < cfg.segment.minNoteMs) return;
    const prev = notes[notes.length - 1];
    const { midi, centsOffset } = nearestNote(pitchHz, a4Hz);
    notes.push({
      midi,
      noteName: midiToName(midi),
      centsOffset,
      startSec,
      endSec,
      durationSec,
      pitchHz,
      confidence: cur.frames.reduce((a, f) => a + f.clarity, 0) / cur.frames.length,
      gapBeforeSec: prev ? Math.max(0, startSec - prev.endSec) : 0,
      flags: { clipped: cur.frames.some((f) => f.clipped) || undefined },
    });
  };

  for (const f of frames) {
    // STUB voicing: clarity alone. The real gate is the whole VoicingConfig,
    // including the adaptive floor and its onset/sustain hysteresis.
    const voiced = f.hz !== null && f.clarity >= cfg.voicing.minClarity;
    if (!voiced) {
      flush(f.tSec);
      continue;
    }
    const midi = Math.round(hzToMidiFloat(f.hz as number, a4Hz));
    if (run && run.midi !== midi) flush(f.tSec);
    if (!run) run = { midi, frames: [] };
    run.frames.push(f);
  }
  // The last frame still covers one hop of audio, so the final note ends a hop
  // after its centre time, not at it.
  if (frames.length > 0) {
    flush(frames[frames.length - 1].tSec + cfg.analysis.hopSize / sampleRate);
  }

  return notes;
}
