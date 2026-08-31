/**
 * When it is acceptable to swap in a new service worker — the one rule in the
 * update path that is a judgment call rather than plumbing, so it lives here as
 * a pure function instead of inside a closure in `main.ts`.
 *
 * A service-worker update means a page reload, and a reload throws away
 * everything the app is holding: the take being recorded, the analysis in
 * flight, the transcript on screen. The two failure modes pull against each
 * other — an installed PWA resumed from the background can sit on
 * months-old code, and a reload at the wrong moment destroys work the user
 * cannot get back — so the answer depends on *what is on screen* and on *what
 * prompted the question*.
 */

import type { Phase } from "./state.js";

/**
 * What made us consider applying the update.
 *
 * - `state`: a phase change, i.e. the app moved on while the user was here.
 * - `foreground`: the page just became visible again after being hidden.
 *
 * The distinction only matters in the `result` phase; see below.
 */
export type UpdateTrigger = "state" | "foreground";

export interface UpdateContext {
  phase: Phase;
  /** The store's view of playback. */
  playing: boolean;
  /** The capture module's view of the microphone. Both are consulted because
   *  they can briefly disagree: the store is updated by the app, the capture
   *  module by the audio callback. */
  recording: boolean;
}

/**
 * Whether a waiting worker may take over right now.
 *
 * `idle` and `error` hold nothing worth keeping, so an update lands
 * immediately. `recording` and `analyzing` are work in progress and are never
 * interrupted.
 *
 * `result` is the interesting one. A finished transcript is a *document*: the
 * user is at the piano reading note names off it, not touching the phone, for
 * as long as it takes to find them. A deploy landing in that window would blank
 * the screen mid-read for no reason the user could possibly infer — so a
 * result is never reloaded out from under a user who is looking at it.
 *
 * The one moment it *is* applied is a foreground return: the app was hidden and
 * has just come back, so nobody was mid-sentence, and the alternative is an
 * installed app that stays stale until the user happens to pass through `idle`
 * — which, if they leave a result on screen, may be never.
 *
 * Being honest about the cost: this still discards the transcript, because
 * nothing is persisted across a reload. It trades a rare, visible loss for an
 * unbounded staleness that has no symptom at all. If results are ever
 * persisted, this case should simply become `true`.
 */
export function shouldApplyUpdate(context: UpdateContext, trigger: UpdateTrigger): boolean {
  if (context.recording || context.playing) return false;
  switch (context.phase) {
    case "idle":
    case "error":
      return true;
    case "result":
      return trigger === "foreground";
    case "recording":
    case "analyzing":
      return false;
  }
}
