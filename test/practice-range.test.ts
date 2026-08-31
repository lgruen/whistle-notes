import { describe, expect, it } from "vitest";
import type { TargetNote } from "../src/practice/align.js";
import {
  isUsableRange,
  octaveShiftIntoRange,
  rangeFromEnds,
  rangeSpanSemitones,
  representativeMidi,
  transposeIntoRange,
} from "../src/practice/range.js";

/**
 * The register arithmetic.
 *
 * All of it is invisible when it works and maddening when it does not: a
 * practice target played two octaves below where the user can whistle produces
 * an attempt that is *correct* and scores as a register error, and nothing on
 * screen says why. So the rules are pinned here rather than trusted.
 */

const melody = (midis: readonly number[]): TargetNote[] =>
  midis.map((midi) => ({ midi, durSec: 0.4 }));

const note = (midi: number, durationSec: number): { midi: number; durationSec: number } => ({
  midi,
  durationSec,
});

/** Roughly where an adult whistles: C6 to C7. */
const WHISTLER = { lowMidi: 84, highMidi: 96 };

describe("what counts as a range", () => {
  it("needs two different, finite ends", () => {
    expect(isUsableRange(WHISTLER)).toBe(true);
    expect(isUsableRange(null)).toBe(false);
    expect(isUsableRange(undefined)).toBe(false);
    expect(isUsableRange({ lowMidi: 84, highMidi: 84 })).toBe(false);
    expect(isUsableRange({ lowMidi: 96, highMidi: 84 })).toBe(false);
    expect(isUsableRange({ lowMidi: Number.NaN, highMidi: 96 })).toBe(false);
  });

  it("sorts the ends, because people do the takes backwards", () => {
    expect(rangeFromEnds(96, 84)).toEqual(WHISTLER);
    expect(rangeFromEnds(84, 96)).toEqual(WHISTLER);
    expect(rangeSpanSemitones(WHISTLER)).toBe(12);
  });
});

describe("summarising a held-note take", () => {
  it("takes the longest note and ignores the fragments around it", () => {
    // What one "hold a comfortable note" take really looks like: a scoop that
    // got its own short note, the note itself, and a squeak on the way out.
    expect(representativeMidi([note(82, 0.08), note(84, 1.9), note(88, 0.05)])).toBe(84);
  });

  it("is not an average, which those fragments would drag", () => {
    // The mean of these is 85.3 and the median 84 — but the note that was held
    // for nearly two seconds is the answer, and it is the only one.
    expect(representativeMidi([note(84, 1.9), note(96, 0.1), note(76, 0.1)])).toBe(84);
  });

  it("has nothing to say about a take with no notes in it", () => {
    expect(representativeMidi([])).toBeNull();
  });
});

describe("moving a melody into the whistler's register", () => {
  it("does nothing without a measured range", () => {
    const middleC = melody([60, 62, 64]);
    expect(octaveShiftIntoRange(middleC, null)).toBe(0);
    expect(transposeIntoRange(middleC, null)).toEqual(middleC);
    expect(octaveShiftIntoRange(middleC, { lowMidi: 96, highMidi: 84 })).toBe(0);
  });

  it("lifts a written melody two octaves into a whistle", () => {
    // The everyday case: a target written around middle C, a user who whistles
    // an octave or two above the treble staff.
    expect(octaveShiftIntoRange(melody([60, 64, 67, 72]), WHISTLER)).toBe(2);
    expect(transposeIntoRange(melody([60, 64, 67, 72]), WHISTLER)).toEqual(
      melody([84, 88, 91, 96]),
    );
  });

  it("centres on the median, so one high note cannot drag the melody down", () => {
    // Four notes low in the range and one leap at the end. A mean would sit
    // between them and choose the octave that suits neither.
    const withLeap = melody([60, 62, 60, 62, 84]);
    expect(octaveShiftIntoRange(withLeap, WHISTLER)).toBe(
      octaveShiftIntoRange(melody([60, 62, 60, 62]), WHISTLER),
    );
  });

  it("moves in whole octaves only, so every note keeps its name", () => {
    // The reason the shift is not simply "whatever lands the median dead
    // centre": moving a melody by anything but an octave changes the key, and
    // a phrase that used to land on white notes would land on black ones.
    const shifted = transposeIntoRange(melody([61, 63, 66]), WHISTLER);
    for (let i = 0; i < shifted.length; i++) {
      expect((shifted[i].midi - melody([61, 63, 66])[i].midi) % 12).toBe(0);
    }
  });

  it("keeps as much of a too-wide melody in reach as it can", () => {
    // Three octaves of melody, one octave of whistler. Nothing fits, so the
    // question stops being "where is the middle" and becomes "how much can
    // they actually reach" — and centring the median would push notes off
    // *both* ends instead of one.
    const wide = melody([48, 60, 72, 84]);
    const narrow = { lowMidi: 72, highMidi: 84 };
    const shift = octaveShiftIntoRange(wide, narrow);
    const inRange = (notes: TargetNote[]): number =>
      notes.filter((n) => n.midi >= narrow.lowMidi && n.midi <= narrow.highMidi).length;
    for (let other = -4; other <= 4; other++) {
      const moved = wide.map((n) => ({ ...n, midi: n.midi + 12 * other }));
      expect(inRange(transposeIntoRange(wide, narrow))).toBeGreaterThanOrEqual(inRange(moved));
    }
    expect(shift).not.toBe(0);
  });

  it("leaves a melody that already fits where it is", () => {
    // Both criteria agree here, and the tie-break has to be "do nothing":
    // moving a melody nobody asked to have moved needs a reason.
    expect(octaveShiftIntoRange(melody([86, 88, 90]), WHISTLER)).toBe(0);
  });

  it("has nothing to move when there is nothing there", () => {
    expect(octaveShiftIntoRange([], WHISTLER)).toBe(0);
    expect(transposeIntoRange([], WHISTLER)).toEqual([]);
  });

  it("copies rather than aliasing, so a target cannot be edited by playing it", () => {
    const original = melody([84, 86]);
    const copy = transposeIntoRange(original, WHISTLER);
    copy[0].midi = 0;
    expect(original[0].midi).toBe(84);
  });
});
