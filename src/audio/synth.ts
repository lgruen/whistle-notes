/**
 * Playback of a transcription, so a beginner can check by ear before hunting
 * for the notes on a keyboard.
 *
 * Everything is scheduled up front against the audio clock: one oscillator and
 * one gain per note, `start`/`stop` times computed once. The main thread is
 * then free to be janky without the melody stuttering, which a `setTimeout`
 * per note could never promise.
 */

import { midiToHz, type Note } from "../dsp/index.js";
import { transposeMidi } from "../notes/format.js";

/** A note placed on the playback timeline, in seconds from the first note. */
export interface ScheduledNote {
  /** Sounding MIDI number, i.e. already transposed. */
  midi: number;
  startSec: number;
  durationSec: number;
}

export interface ScheduleOptions {
  /** Silence longer than this is a "thinking" pause, not a musical rest. */
  maxGapSec?: number;
  /** ...and is replayed as this much, so a take with a long hesitation in the
   *  middle does not make the user sit through it again. */
  compressedGapSec?: number;
  /** Floor on note length: a 90 ms note is audible, a 20 ms one is a click. */
  minDurationSec?: number;
}

/** Envelope, sized to be click-free without smearing short notes. */
const ATTACK_SEC = 0.005;
const RELEASE_SEC = 0.03;
const PEAK_GAIN = 0.25;
/** Scheduling lead-in, so the first note is not already late when it is set. */
const LEAD_SEC = 0.08;

/**
 * Lay notes out on a playback timeline.
 *
 * Pure and exported for its own sake: the gap rule is the only musical judgment
 * in the synth, and it is much easier to test as arithmetic than by listening.
 * Rhythm is otherwise preserved exactly as transcribed — v1 does not quantise,
 * so what you hear is what the segmenter actually measured.
 */
export function playbackSchedule(
  notes: readonly Note[],
  transpose: number,
  options: ScheduleOptions = {},
): ScheduledNote[] {
  const maxGap = options.maxGapSec ?? 1;
  const compressed = options.compressedGapSec ?? 0.5;
  const minDuration = options.minDurationSec ?? 0.09;

  const scheduled: ScheduledNote[] = [];
  let cursor = 0;
  let previousEnd: number | null = null;

  for (const note of notes) {
    if (previousEnd !== null) {
      const gap = Math.max(0, note.startSec - previousEnd);
      cursor += gap > maxGap ? compressed : gap;
    }
    const duration = Math.max(minDuration, note.durationSec);
    scheduled.push({
      midi: transposeMidi(note.midi, transpose),
      startSec: cursor,
      durationSec: duration,
    });
    cursor += duration;
    previousEnd = note.endSec;
  }
  return scheduled;
}

/** Total sounding length of a schedule, in seconds. */
export function scheduleDuration(scheduled: readonly ScheduledNote[]): number {
  const last = scheduled[scheduled.length - 1];
  return last ? last.startSec + last.durationSec : 0;
}

export interface PlaybackHandlers {
  /** Called when the sounding note changes, with an index into `notes`. */
  onIndex(index: number | null): void;
  /** Called once when playback finishes or is stopped. */
  onEnd(): void;
}

let ctx: AudioContext | null = null;
let voices: { osc: OscillatorNode; gain: GainNode }[] = [];
let raf = 0;
let handlers: PlaybackHandlers | null = null;

export function isPlaying(): boolean {
  return ctx !== null;
}

/**
 * Start playback. Must be called synchronously from a tap handler — a fresh
 * `AudioContext` is created here and can only autoplay inside a gesture.
 *
 * ## Why a fresh context per playback
 *
 * The capture context is closed on stop, so there is nothing to reuse; and on
 * iOS reusing a context that has ever had a microphone attached is exactly what
 * routes output to the *earpiece* at whisper volume. Building a new one after
 * the tracks are stopped gets normal media routing. A context costs about a
 * millisecond, and it is closed again when playback ends, so there is no
 * accumulation.
 */
export function startPlayback(
  notes: readonly Note[],
  transpose: number,
  playbackHandlers: PlaybackHandlers,
): void {
  stopPlayback();
  const scheduled = playbackSchedule(notes, transpose);
  if (scheduled.length === 0) return;

  ctx = new AudioContext();
  // Swallowed, not left floating: Safari rejects `resume()` when it disagrees
  // about the gesture, and the schedule below is what actually matters.
  ctx.resume().catch(() => undefined);
  handlers = playbackHandlers;

  const t0 = ctx.currentTime + LEAD_SEC;
  for (const note of scheduled) {
    const start = t0 + note.startSec;
    const end = start + note.durationSec;
    // A note shorter than attack+release gets a shortened sustain rather than
    // a negative one; the envelope stays monotonic either way.
    const sustainEnd = Math.max(start + ATTACK_SEC, end - RELEASE_SEC);

    const osc = ctx.createOscillator();
    // Triangle: a sine is so plain it is hard to pick out of a room, and a
    // triangle's weak odd harmonics read as "a note" without any of the buzz
    // that would make octave errors hard to hear.
    osc.type = "triangle";
    osc.frequency.value = midiToHz(note.midi);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + ATTACK_SEC);
    gain.gain.setValueAtTime(PEAK_GAIN, sustainEnd);
    gain.gain.linearRampToValueAtTime(0, sustainEnd + RELEASE_SEC);

    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(sustainEnd + RELEASE_SEC + 0.01);
    voices.push({ osc, gain });
  }

  const total = scheduleDuration(scheduled);
  let lastIndex: number | null = null;

  const tick = (): void => {
    if (!ctx) return;
    const elapsed = ctx.currentTime - t0;

    // The index of the last note that has started, rather than the note
    // strictly sounding *now*: it keeps the highlight steady through rests
    // instead of blinking off in every gap.
    let index: number | null = null;
    for (let i = 0; i < scheduled.length; i++) {
      if (scheduled[i].startSec <= elapsed) index = i;
      else break;
    }
    if (index !== lastIndex) {
      lastIndex = index;
      handlers?.onIndex(index);
    }

    if (elapsed >= total + RELEASE_SEC) {
      stopPlayback();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

/** Stop playback immediately, without a click, and release the context. */
export function stopPlayback(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;

  const closing = ctx;
  const ending = handlers;
  ctx = null;
  handlers = null;

  if (closing) {
    const now = closing.currentTime;
    for (const { osc, gain } of voices) {
      // Cancel the schedule, pin the envelope where it actually is, then ramp
      // out over 20 ms. Cutting a mid-note oscillator dead is a click, and a
      // click on Stop is the one sound users report as "broken".
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.02);
      try {
        osc.stop(now + 0.03);
      } catch {
        // Already stopped; nothing to do.
      }
    }
    // Long enough for the ramp to finish before the context goes away.
    setTimeout(() => void closing.close().catch(() => undefined), 120);
  }
  voices = [];
  ending?.onEnd();
}
