import { describe, expect, it } from "vitest";
import {
  createUpdatePolicy,
  shouldApplyUpdate,
  type UpdateContext,
  type UpdateTrigger,
} from "../src/ui/sw-update.js";
import type { Phase } from "../src/ui/state.js";

/**
 * The service-worker update policy, as a truth table.
 *
 * This is the one part of the update path worth testing, because it is the only
 * part that is a judgment call: everything else is `registerSW` plumbing. It is
 * also the part that is invisible until it is wrong, and wrong in the worst
 * possible way — a page reload that silently destroys a take mid-recording, or
 * a transcript the user was reading off at the piano.
 *
 * The failure mode in the other direction is just as real and has no symptom at
 * all: an installed PWA resumed from the background can sit on stale code for
 * days, so "never update" is not a safe default either.
 */

function context(phase: Phase, over: Partial<UpdateContext> = {}): UpdateContext {
  return { phase, playing: false, recording: false, ...over };
}

const TRIGGERS: UpdateTrigger[] = ["state", "foreground"];

describe("phases that hold nothing worth keeping", () => {
  it("updates immediately, however the question came up", () => {
    for (const trigger of TRIGGERS) {
      expect(shouldApplyUpdate(context("idle"), trigger)).toBe(true);
      expect(shouldApplyUpdate(context("error"), trigger)).toBe(true);
    }
  });
});

describe("work in progress", () => {
  it("is never interrupted", () => {
    for (const trigger of TRIGGERS) {
      // A reload here throws away a take that cannot be re-whistled.
      expect(shouldApplyUpdate(context("recording"), trigger)).toBe(false);
      expect(shouldApplyUpdate(context("analyzing"), trigger)).toBe(false);
    }
  });

  it("counts audio the store has not caught up with yet", () => {
    // `recording` comes from the capture module and `playing` from the synth;
    // both can be true while the store still says `idle`, because they are
    // updated by audio callbacks rather than by the app.
    for (const trigger of TRIGGERS) {
      expect(shouldApplyUpdate(context("idle", { recording: true }), trigger)).toBe(false);
      expect(shouldApplyUpdate(context("idle", { playing: true }), trigger)).toBe(false);
      expect(shouldApplyUpdate(context("result", { playing: true }), trigger)).toBe(false);
    }
  });
});

describe("a finished transcript", () => {
  it("is not reloaded out from under someone reading it", () => {
    // The user is at the piano hunting for the notes, not touching the phone.
    // Nothing about a deploy landing in that window is visible to them; the
    // screen would simply blank and come back empty.
    expect(shouldApplyUpdate(context("result"), "state")).toBe(false);
  });

  it("does update on the way back from the background", () => {
    // Nobody is mid-read at the instant the app is foregrounded, and this is
    // the only moment a result-phase user ever passes through — without it an
    // installed app that is left showing a result stays stale indefinitely.
    expect(shouldApplyUpdate(context("result"), "foreground")).toBe(true);
  });
});

/**
 * The hand-over, which is where the policy above actually gets used.
 *
 * A correct truth table is not enough on its own, and that was the bug: the
 * policy decided *whether to ask the waiting worker to take over*, and then
 * `vite-plugin-pwa`'s own `controlling` listener did the reload — in every
 * client the new worker claimed, whatever that client happened to be doing. So
 * a second tab could be reloaded mid-take by a decision the first tab made,
 * and even in the deciding tab the reload landed some time after the question
 * was asked.
 *
 * Hence two decisions per client instead of one, and this state machine.
 */
describe("the hand-over", () => {
  function spy() {
    const calls: string[] = [];
    const policy = createUpdatePolicy({
      skipWaiting: () => calls.push("skip"),
      reload: () => calls.push("reload"),
    });
    return { calls, policy };
  }

  it("does nothing at all until a worker is actually waiting", () => {
    const { calls, policy } = spy();
    expect(policy.stage()).toBe("none");
    expect(policy.apply(context("idle"), "state")).toBe("none");
    expect(policy.apply(context("idle"), "foreground")).toBe("none");
    expect(calls).toEqual([]);
  });

  it("asks the worker to take over at the first safe moment, not before", () => {
    const { calls, policy } = spy();
    policy.onWaiting();
    expect(policy.apply(context("recording", { recording: true }), "state")).toBe("none");
    expect(calls).toEqual([]);
    expect(policy.apply(context("idle"), "state")).toBe("skip-waiting");
    expect(calls).toEqual(["skip"]);
  });

  it("keeps asking until the worker actually takes control", () => {
    // `messageSkipWaiting` posts to `registration.waiting`, and answers a
    // registration whose waiting worker has gone by doing nothing at all —
    // with no rejection to catch. Advancing on the *send* would strand the
    // update until the next cold launch; advancing on `controlling` turns the
    // same case into a retry at the next safe moment.
    const { calls, policy } = spy();
    policy.onWaiting();
    policy.apply(context("idle"), "state");
    policy.apply(context("idle"), "state");
    expect(calls).toEqual(["skip", "skip"]);
    expect(policy.stage()).toBe("waiting");

    policy.onControlling();
    expect(policy.stage()).toBe("controlling");
  });

  it("defers the reload in the client that is busy, however it got there", () => {
    // The reload half is the one that costs something, and it is reached
    // whether or not *this* client asked for it: a worker claims every client
    // in its scope, so the second tab arrives here because the first tab said
    // yes. Left to the plugin, that tab reloads mid-take.
    const { calls, policy } = spy();
    policy.onWaiting();
    policy.onControlling();

    expect(policy.apply(context("recording", { recording: true }), "state")).toBe("none");
    expect(policy.apply(context("analyzing"), "state")).toBe("none");
    expect(policy.apply(context("result", { playing: true }), "foreground")).toBe("none");
    // Reading a transcript is not a safe moment either, until the app has been
    // away and come back.
    expect(policy.apply(context("result"), "state")).toBe("none");
    expect(calls).toEqual([]);

    // The take finishes and the user does nothing more: now it is free.
    expect(policy.apply(context("result"), "foreground")).toBe("reload");
    expect(calls).toEqual(["reload"]);
  });

  it("reloads once, even if state keeps changing while the page unloads", () => {
    // `location.reload()` returns immediately and the page keeps running until
    // the navigation commits, so anything subscribed to state changes will ask
    // again in that window.
    const { calls, policy } = spy();
    policy.onWaiting();
    policy.onControlling();
    expect(policy.apply(context("idle"), "state")).toBe("reload");
    expect(policy.apply(context("idle"), "state")).toBe("none");
    expect(policy.apply(context("idle"), "foreground")).toBe("none");
    expect(calls).toEqual(["reload"]);
  });

  it("never walks backwards when a second deploy lands mid-wait", () => {
    // A client that already owes a reload does not go back to negotiating a
    // skip: the reload it owes will pick up whatever is newest by then.
    const { calls, policy } = spy();
    policy.onWaiting();
    policy.onControlling();
    policy.onWaiting();
    expect(policy.stage()).toBe("controlling");
    expect(policy.apply(context("idle"), "state")).toBe("reload");
    expect(calls).toEqual(["reload"]);
  });

  it("never skips *and* reloads for the same worker", () => {
    // The deferred application is a plain reload: by the time this client is
    // told the worker is controlling, the skipping has already happened, and
    // asking for it again would be a message to a worker that is no longer
    // waiting.
    const { calls, policy } = spy();
    policy.onWaiting();
    policy.apply(context("idle"), "state");
    policy.onControlling();
    policy.apply(context("idle"), "state");
    expect(calls).toEqual(["skip", "reload"]);
  });
});
