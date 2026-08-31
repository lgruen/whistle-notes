import { describe, expect, it } from "vitest";
import type { TargetNote } from "../src/practice/align.js";
import {
  FOLLOW_GAP_SEC,
  FOLLOW_TAIL_SEC,
  appendFollowPoint,
  followDone,
  followModel,
} from "../src/practice/follow.js";
import type { TrailPoint } from "../src/practice/recall.js";

/**
 * The warm-up's layout and timing.
 *
 * Small pieces of arithmetic sitting under something animated, which is exactly
 * the shape of code that is hard to check by looking at it: a playhead 80 ms
 * ahead of the melody looks fine in a screenshot and wrong in the hand.
 *
 * The claim worth pinning about `followModel` is that the picture and the sound
 * come from **one** timeline. If the roll ever derived its own layout, a note
 * drawn under the playhead would stop being the note sounding, and the whole
 * mode would be subtly, unfixably out of step.
 */

const melody = (midis: readonly number[], durSec = 0.5): TargetNote[] =>
  midis.map((midi) => ({ midi, durSec }));

describe("followModel", () => {
  it("lays the melody out end to end, with a gap that re-articulates", () => {
    const model = followModel(melody([84, 84, 86]));
    expect(model.notes.map((note) => note.startSec)).toEqual([
      0,
      0.5 + FOLLOW_GAP_SEC,
      2 * (0.5 + FOLLOW_GAP_SEC),
    ]);
    // Without a gap two identical notes in a row are one long note — the trap
    // `TARGET_GAP_SEC` documents, and the reason this constant is not zero.
    expect(FOLLOW_GAP_SEC).toBeGreaterThan(0);
  });

  it("runs on past the last note, so the final one can be finished", () => {
    const model = followModel(melody([84, 86]));
    const last = model.notes[model.notes.length - 1];
    expect(model.spanSec).toBeCloseTo(last.endSec + FOLLOW_TAIL_SEC, 9);
    expect(followDone(last.endSec, model)).toBe(false);
    expect(followDone(model.spanSec, model)).toBe(true);
  });

  it("gives the plot air above and below, and never zooms in past an octave", () => {
    const tight = followModel(melody([84, 85]));
    expect(tight.minMidi).toBeLessThan(84);
    expect(tight.maxMidi).toBeGreaterThan(85);
    expect(tight.maxMidi - tight.minMidi).toBeGreaterThanOrEqual(12);
  });

  it("still produces a drawable plot from nothing at all", () => {
    const empty = followModel([]);
    expect(empty.notes).toHaveLength(0);
    expect(empty.spanSec).toBeGreaterThan(0);
    expect(empty.maxMidi).toBeGreaterThan(empty.minMidi);
  });
});

describe("appendFollowPoint", () => {
  it("keeps the pitches it is given", () => {
    const trail: TrailPoint[] = [];
    appendFollowPoint(trail, 0.1, 84);
    appendFollowPoint(trail, 0.2, 84.5);
    expect(trail).toEqual([
      { tSec: 0.1, midi: 84 },
      { tSec: 0.2, midi: 84.5 },
    ]);
  });

  it("records silence as one break, however long it lasts", () => {
    const trail: TrailPoint[] = [];
    appendFollowPoint(trail, 0.1, 84);
    for (let i = 0; i < 100; i++) appendFollowPoint(trail, 0.2 + i / 60, null);
    appendFollowPoint(trail, 2, 86);
    expect(trail).toHaveLength(3);
    expect(Number.isNaN(trail[1].midi)).toBe(true);
    // The pen goes back down at the pitch that came back, not at a line drawn
    // across the gap.
    expect(trail[2]).toEqual({ tSec: 2, midi: 86 });
  });

  it("treats an unusable number as silence rather than drawing it", () => {
    const trail: TrailPoint[] = [];
    appendFollowPoint(trail, 0, Infinity);
    expect(Number.isNaN(trail[0].midi)).toBe(true);
  });

  it("drops the oldest points when the cap bites", () => {
    const trail: TrailPoint[] = [];
    for (let i = 0; i < 20; i++) appendFollowPoint(trail, i, 84 + i, 5);
    expect(trail).toHaveLength(5);
    // Oldest first: the playhead is at the new end, which is where the user is
    // looking.
    expect(trail[trail.length - 1].tSec).toBe(19);
    expect(trail[0].tSec).toBe(15);
  });
});
