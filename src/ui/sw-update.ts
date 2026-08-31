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

/* ── The hand-over, as a two-step state machine ───────────────────────────
 *
 * `shouldApplyUpdate` answers *may we*; this answers *may we do what, exactly*
 * — and the distinction is the whole reason this section exists.
 *
 * A service-worker hand-over has two moments, not one:
 *
 *  1. **waiting** — a new worker has installed and parked itself. Asking it to
 *     take over is a `SKIP_WAITING` message, and it costs this page nothing:
 *     the page keeps running, and no state is lost.
 *  2. **controlling** — the new worker is now serving this page. *This* is the
 *     moment that costs something, because the only way to actually run the new
 *     code is `location.reload()`, which throws away everything on screen.
 *
 * The two are not the same client's decision. A worker claims **every** client
 * in its scope (`clientsClaim`), so a second tab — or the installed window
 * sitting behind the browser — arrives at step 2 because some *other* tab said
 * yes at step 1. Left to `vite-plugin-pwa`, that second client reloads on its
 * own `controlling` event, mid-take, for a decision it never made. Owning both
 * steps is what makes the policy per-client rather than per-deploy: an update
 * applied in one tab is *installed* everywhere and *reloaded* only where a
 * reload is free.
 */

/**
 * How far this client has got.
 *
 * - `none`: nothing new is waiting.
 * - `waiting`: a new worker is installed and parked; we may send SKIP_WAITING.
 * - `controlling`: the new worker is serving this page; we owe a reload.
 */
export type UpdateStage = "none" | "waiting" | "controlling";

/** What to do about it right now. */
export type UpdateAction = "none" | "skip-waiting" | "reload";

/**
 * The decision, as a pure function of stage, context and trigger.
 *
 * Both stages consult the same policy, which is deliberate: a page that would
 * not be reloaded out from under its user should not have its worker swapped
 * either, because the swap is what leads other clients to reload.
 */
export function updateAction(
  stage: UpdateStage,
  context: UpdateContext,
  trigger: UpdateTrigger,
): UpdateAction {
  if (stage === "none") return "none";
  if (!shouldApplyUpdate(context, trigger)) return "none";
  return stage === "waiting" ? "skip-waiting" : "reload";
}

/** What the machine does when it decides to act. Kept as callbacks so the
 *  policy itself never touches `location` or the plugin. */
export interface UpdatePolicyActions {
  /** Tell the waiting worker to take over. Fire-and-forget: whether it worked
   *  is answered by {@link UpdatePolicy.onControlling}, not by a return value. */
  skipWaiting(): void;
  /** Reload this client, which the new worker already controls. */
  reload(): void;
}

export interface UpdatePolicy {
  /** A new worker is parked in `waiting` (the plugin's `onNeedRefresh`). */
  onWaiting(): void;
  /** The new worker has taken control of *this* client (the plugin's
   *  `onNeedReload`) — because of our own skip-waiting, or another client's. */
  onControlling(): void;
  /** Re-evaluate: a phase change, or a return to the foreground. Returns what
   *  it did, for tests. */
  apply(context: UpdateContext, trigger: UpdateTrigger): UpdateAction;
  stage(): UpdateStage;
}

/**
 * The state machine that turns those decisions into at most one reload.
 *
 * Two things it deliberately does *not* do:
 *
 * - It does not treat a sent SKIP_WAITING as progress. The message can go
 *   nowhere — the registration's `waiting` worker can be gone by the time it is
 *   posted, and `workbox-window` answers that by doing nothing at all, with no
 *   rejection to catch. Staying in `waiting` until the browser says the worker
 *   is *controlling* turns that into a retry at the next safe moment instead of
 *   an update that stalls until the next cold launch. The message is idempotent
 *   and safe moments are user-paced (a phase change, a foreground return), so
 *   the retry costs a `postMessage` at most a few times a session.
 * - It does not walk backwards. A second deploy landing while we are already in
 *   `controlling` leaves the stage alone: the reload we owe will pick up
 *   whatever is newest, so there is nothing to re-negotiate.
 */
export function createUpdatePolicy(actions: UpdatePolicyActions): UpdatePolicy {
  let stage: UpdateStage = "none";

  return {
    onWaiting() {
      if (stage === "none") stage = "waiting";
    },
    onControlling() {
      stage = "controlling";
    },
    apply(context, trigger) {
      const action = updateAction(stage, context, trigger);
      if (action === "skip-waiting") {
        actions.skipWaiting();
      } else if (action === "reload") {
        // A reload is not instant — the page keeps running until the navigation
        // commits — so the stage is cleared first, or a state change in that
        // window would ask for a second one.
        stage = "none";
        actions.reload();
      }
      return action;
    },
    stage() {
      return stage;
    },
  };
}
