import { describe, expect, it } from "vitest";
import { shouldApplyUpdate, type UpdateContext, type UpdateTrigger } from "../src/ui/sw-update.js";
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
