/**
 * Follow along: the warm-up, and the one place the app deliberately breaks its
 * own record/playback rule.
 *
 * The melody scrolls past on a roll while the synth plays it, and the user's
 * live pitch is drawn over the top as it happens. Nothing is scored, nothing is
 * remembered, and there is no verdict at the end. That is not a missing feature
 * — it is the whole design, and it is what makes the mode possible at all.
 *
 * ## Why an unscored mode can do what a scored one cannot
 *
 * Everywhere else in this app, recording and playback are mutually exclusive,
 * enforced inside `startPlayback` rather than by a disabled button. The reason
 * is echo: `getUserMedia` is asked for `echoCancellation: false` on purpose,
 * because speech AEC and noise suppression eat a sustained whistle, so a phone
 * playing this synth into its own open microphone hears the synth. In the
 * transcriber that would mean transcribing the app's own playback; in recall it
 * would mean *scoring* it, and the user would be told they whistled a melody
 * they only listened to.
 *
 * Here the microphone's output goes nowhere but a line on a canvas. The worst
 * the echo can do is draw the melody's own pitch faintly under the user's — a
 * cosmetic artefact on a picture nobody is graded on, and one the screen warns
 * about in a sentence rather than pretending away. No take is transcribed, no
 * alignment is run, no statistic moves. **If follow-along ever grows a score,
 * this exemption has to go with it.**
 *
 * ## The two clocks, and why there is only one
 *
 * The mic take and the playback run on different `AudioContext`s that started at
 * different moments, and reconciling their clocks would need the capture start
 * time, the playback lead-in and the analysis window's own latency. It would
 * also be pointless: nothing here is measured. So the picture is drawn against
 * **one** clock — the animation loop's — with the playhead at the elapsed time
 * since playback started and each trail point placed at wherever the playhead is
 * *now*, carrying whatever pitch the microphone last reported. The trail is
 * therefore late by the analysis latency (a 43 ms window plus a block or two),
 * which is well under the width of a note and invisible in a warm-up.
 *
 * Pure: no DOM, no storage, no audio. `ui/followroll.ts` is the canvas.
 */

import type { TargetNote } from "./align.js";
import {
  paddedMidiRange,
  targetPlayback,
  type PlayableNote,
  type TrailPoint,
} from "./recall.js";

/**
 * Silence between one note and the next, as the warm-up plays it.
 *
 * Shorter than recall's 80 ms: this melody is meant to be whistled *along with*
 * rather than remembered, so it should read as a line rather than as a list. It
 * still has to be long enough for the synth's 30 ms release to close, or two
 * repeated notes are one long note — the same trap `TARGET_GAP_SEC` documents.
 */
export const FOLLOW_GAP_SEC = 0.05;

/**
 * How long the roll keeps running after the last note has finished.
 *
 * The playhead has to leave the final note behind before the run ends, or the
 * screen goes away at the exact moment the user is still holding it.
 */
export const FOLLOW_TAIL_SEC = 0.8;

export interface FollowModel {
  /** The melody laid out on a timeline, ready for both the synth and the roll. */
  notes: readonly PlayableNote[];
  /** Where the run ends: the last note's end plus {@link FOLLOW_TAIL_SEC}. */
  spanSec: number;
  /** Vertical extent to draw, in MIDI numbers, padded. */
  minMidi: number;
  maxMidi: number;
}

/**
 * Everything the warm-up needs to draw and to play, from one melody.
 *
 * One model for both, deliberately: the roll's x axis and the synth's schedule
 * are the same timeline, so a note drawn at 3.2 s is a note *sounding* at 3.2 s.
 * Deriving them separately is how a follow-along ends up subtly out of step with
 * itself.
 */
export function followModel(
  notes: readonly TargetNote[],
  gapSec: number = FOLLOW_GAP_SEC,
): FollowModel {
  const laid = targetPlayback(notes, gapSec);
  const last = laid[laid.length - 1];
  const range = paddedMidiRange(laid.map((note) => note.midi));
  return {
    notes: laid,
    // A floor, so an empty or zero-length melody still produces a plot with a
    // width rather than a division by zero.
    spanSec: Math.max(1, (last ? last.endSec : 0) + FOLLOW_TAIL_SEC),
    minMidi: range.min,
    maxMidi: range.max,
  };
}

/** Whether the run is over. The screen stops the microphone and the synth on
 *  this, so it is the one place the warm-up's length is decided. */
export function followDone(elapsedSec: number, model: FollowModel): boolean {
  return elapsedSec >= model.spanSec;
}

/**
 * Hard cap on the drawn trail.
 *
 * At 60 frames a second a 60 s melody — the recording cap, and the longest run
 * possible — is 3600 points, so this is a backstop against a browser that
 * animates faster than it should rather than a working limit. Oldest first when
 * it bites, because the playhead is at the *new* end and that is where the user
 * is looking.
 */
export const FOLLOW_TRAIL_MAX = 6000;

/**
 * Add one point to the live trail, in place.
 *
 * In place, and this is the one hot-path function in the practice island: it is
 * called once per animation frame with the microphone open, and returning a new
 * array sixty times a second would hand the collector a few hundred kilobytes
 * per warm-up for no benefit.
 *
 * A `null` pitch — silence, breath, the moment before the microphone opens — is
 * a *break* rather than a point, recorded as a `NaN` so the canvas lifts the pen
 * instead of drawing a line across the gap. Consecutive breaks collapse into
 * one, so a user who whistles nothing at all leaves one marker rather than
 * thousands.
 */
export function appendFollowPoint(
  trail: TrailPoint[],
  tSec: number,
  midi: number | null,
  max: number = FOLLOW_TRAIL_MAX,
): void {
  const last = trail[trail.length - 1];
  if (midi === null || !Number.isFinite(midi)) {
    if (last && Number.isNaN(last.midi)) return;
    trail.push({ tSec, midi: NaN });
  } else {
    trail.push({ tSec, midi });
  }
  if (trail.length > max) trail.splice(0, trail.length - max);
}
