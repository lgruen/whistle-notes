/**
 * `PitchTracker` — the streaming front end.
 *
 * Its one non-negotiable property is **chunk-size independence**: feeding this
 * class 128 samples at a time (what an AudioWorklet hands you), 512 at a time
 * (what the app's forwarder batches), or an entire 27-second recording in one
 * call must produce byte-identical frames. That is not a nicety. It is what
 * makes the live meter on the phone and the offline transcription in the Node
 * harness *literally the same code*, so a bad transcription can be reproduced
 * and swept offline instead of debugged through a phone.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import { DEFAULT_CONFIG } from "./config.js";
import { analyzeFrame, createAnalyzer, type Analyzer } from "./pitch.js";
import type { DspConfig, PitchFrame } from "./types.js";

/** Extra ring capacity beyond one window, in hops. Purely a batching knob:
 *  larger means fewer copy/analyse alternations when a big buffer arrives. */
const SPARE_HOPS = 8;

export class PitchTracker {
  private readonly analyzer: Analyzer;
  private readonly windowSize: number;
  private readonly hopSize: number;
  private readonly sampleRate: number;

  /**
   * Circular sample buffer.
   *
   * A ring rather than a growing array because the alternative — concatenating
   * the unconsumed tail with each new chunk — is quadratic in the number of
   * pushes, and a live session pushes ~375 times a second. Here every sample is
   * copied exactly once regardless of how it is sliced up.
   */
  private readonly ring: Float32Array;
  /** Contiguous scratch copy of one window, since a window may wrap the ring. */
  private readonly frameBuffer: Float32Array;

  /** Absolute index (in samples since the start of the signal) one past the
   *  last sample written. */
  private writePos = 0;
  /** Absolute index of the first sample of the next frame's window. */
  private readPos = 0;

  constructor(sampleRate: number, cfg: DspConfig = DEFAULT_CONFIG) {
    const { windowSize, hopSize } = cfg.analysis;
    if (!Number.isInteger(hopSize) || hopSize < 1) {
      throw new Error(`hopSize must be a positive integer, got ${hopSize}`);
    }
    this.sampleRate = sampleRate;
    this.windowSize = windowSize;
    this.hopSize = hopSize;
    this.analyzer = createAnalyzer(sampleRate, cfg.analysis);
    // Capacity must exceed one window by at least one hop, so that a full
    // buffer always has room to make progress after emitting a frame.
    this.ring = new Float32Array(windowSize + SPARE_HOPS * hopSize);
    this.frameBuffer = new Float32Array(windowSize);
  }

  /**
   * Feed more audio; returns every frame that just became complete.
   *
   * No frame is ever emitted before a full window of *real* samples has
   * arrived. Analysing a half-filled buffer would mean analysing the implicit
   * zero padding, which reads as a fade-in that was never whistled.
   */
  push(chunk: Float32Array): PitchFrame[] {
    const frames: PitchFrame[] = [];
    const capacity = this.ring.length;
    let consumed = 0;

    while (consumed < chunk.length) {
      // Copy as much as fits without overwriting samples a future window still
      // needs. `capacity > windowSize` guarantees this is non-zero whenever the
      // loop below cannot run, so the two always take turns and never deadlock.
      const pending = this.writePos - this.readPos;
      const space = capacity - pending;
      const take = Math.min(space, chunk.length - consumed);

      if (take > 0) {
        const start = this.writePos % capacity;
        const firstRun = Math.min(take, capacity - start);
        this.ring.set(chunk.subarray(consumed, consumed + firstRun), start);
        if (firstRun < take) {
          this.ring.set(chunk.subarray(consumed + firstRun, consumed + take), 0);
        }
        this.writePos += take;
        consumed += take;
      }

      while (this.writePos - this.readPos >= this.windowSize) {
        frames.push(this.analyseAt(this.readPos));
        this.readPos += this.hopSize;
      }
    }

    return frames;
  }

  /** Copy the window starting at absolute index `from` out of the ring and
   *  analyse it, timestamped at the window's **centre**. */
  private analyseAt(from: number): PitchFrame {
    const capacity = this.ring.length;
    const start = from % capacity;
    const firstRun = Math.min(this.windowSize, capacity - start);
    this.frameBuffer.set(this.ring.subarray(start, start + firstRun), 0);
    if (firstRun < this.windowSize) {
      this.frameBuffer.set(this.ring.subarray(0, this.windowSize - firstRun), firstRun);
    }

    // Centre, not start: a note's onset should be reported where its energy
    // actually is, not half a window late. Everything downstream — note start
    // times, the piano roll, the glide slopes — inherits this convention.
    const tSec = (from + this.windowSize / 2) / this.sampleRate;
    return analyzeFrame(this.analyzer, this.frameBuffer, tSec);
  }
}
