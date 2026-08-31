import { describe, expect, it } from "vitest";
import {
  IS_SHARP,
  PC_TO_STEP,
  TREBLE_BOTTOM_STEP,
  centsOffset,
  formatCents,
  hzToMidiFloat,
  midiToHz,
  midiToName,
  nearestNote,
  staffPosition,
  staffStep,
  suggestOctaveShift,
  transposeMidi,
} from "../src/notes/format.js";

describe("hz ↔ midi", () => {
  it("anchors A4 = 440 Hz at MIDI 69", () => {
    expect(hzToMidiFloat(440)).toBeCloseTo(69, 12);
    expect(midiToHz(69)).toBeCloseTo(440, 12);
  });

  it("moves an octave per doubling and a semitone per 2^(1/12)", () => {
    expect(hzToMidiFloat(880)).toBeCloseTo(81, 12);
    expect(hzToMidiFloat(220)).toBeCloseTo(57, 12);
    expect(midiToHz(60)).toBeCloseTo(261.6255653, 6); // middle C
    expect(hzToMidiFloat(440 * Math.pow(2, 1 / 12))).toBeCloseTo(70, 10);
  });

  it("honours a configurable A4", () => {
    expect(hzToMidiFloat(415, 415)).toBeCloseTo(69, 12);
    expect(midiToHz(69, 442)).toBeCloseTo(442, 12);
    // 442 Hz is ~7.85 cents sharp of 440, so a 440 Hz tone reads flat there.
    expect(centsOffset(440, 69, 442)).toBeCloseTo(-7.85, 1);
  });

  it("round-trips", () => {
    for (const midi of [24, 48, 60, 69, 84, 96, 108]) {
      expect(hzToMidiFloat(midiToHz(midi))).toBeCloseTo(midi, 10);
    }
  });

  it("returns NaN rather than a wrong answer for non-positive input", () => {
    expect(hzToMidiFloat(-1)).toBeNaN();
  });
});

describe("midiToName", () => {
  it("uses scientific pitch with MIDI 60 = C4", () => {
    expect(midiToName(60)).toBe("C4");
    expect(midiToName(69)).toBe("A4");
    expect(midiToName(61)).toBe("C#4");
    expect(midiToName(59)).toBe("B3");
    expect(midiToName(72)).toBe("C5");
    expect(midiToName(90)).toBe("F#6");
  });

  it("handles the bottom of the MIDI range", () => {
    expect(midiToName(0)).toBe("C-1");
    expect(midiToName(21)).toBe("A0"); // lowest piano key
    expect(midiToName(108)).toBe("C8"); // highest piano key
  });
});

describe("rounding to the nearest semitone", () => {
  it("keeps a ±40-cent whistle on the right note", () => {
    // The accuracy requirement: anything inside ±50 cents must round home.
    for (const cents of [-40, -25, -10, 0, 10, 25, 40]) {
      const hz = midiToHz(69 + cents / 100);
      const near = nearestNote(hz);
      expect(near.midi).toBe(69);
      expect(near.centsOffset).toBeCloseTo(cents, 6);
    }
  });

  it("breaks the half-semitone tie upward, consistently in both directions", () => {
    // Math.round sends .5 toward +infinity, so the tie rule is "round up".
    const eps = 1e-6;
    expect(nearestNote(midiToHz(69.5 - eps)).midi).toBe(69);
    expect(nearestNote(midiToHz(69.5 + eps)).midi).toBe(70);
    expect(nearestNote(midiToHz(68.5 - eps)).midi).toBe(68);
    expect(nearestNote(midiToHz(68.5 + eps)).midi).toBe(69);
  });

  it("keeps centsOffset inside the documented [-50, +50) range", () => {
    for (let midiFloat = 40; midiFloat <= 100; midiFloat += 0.017) {
      const { centsOffset: cents } = nearestNote(midiToHz(midiFloat));
      expect(cents).toBeGreaterThanOrEqual(-50);
      expect(cents).toBeLessThan(50);
    }
  });

  it("reports the residual against a given note", () => {
    expect(centsOffset(midiToHz(69.3), 69)).toBeCloseTo(30, 6);
    expect(centsOffset(midiToHz(68.8), 69)).toBeCloseTo(-20, 6);
  });
});

describe("display transposition", () => {
  it("shifts by whole octaves", () => {
    expect(transposeMidi(84, -2)).toBe(60);
    expect(transposeMidi(84, 0)).toBe(84);
    expect(transposeMidi(60, 1)).toBe(72);
    expect(midiToName(transposeMidi(84, -2))).toBe("C4");
  });

  it("preserves pitch class, so note names survive transposition", () => {
    for (const midi of [61, 66, 70, 83, 95]) {
      expect(midiToName(transposeMidi(midi, -2)).replace(/-?\d+$/, "")).toBe(
        midiToName(midi).replace(/-?\d+$/, ""),
      );
    }
  });

  it("suggests the octave that centres a melody on the treble staff", () => {
    expect(suggestOctaveShift([84, 86, 88])).toBe(-1); // around C6
    expect(suggestOctaveShift([96, 98, 100])).toBe(-2); // around C7 — typical whistle
    expect(suggestOctaveShift([60, 62, 64])).toBe(0); // already readable
    expect(suggestOctaveShift([])).toBe(0);
  });

  it("uses the median, so one stray note cannot drag the choice", () => {
    expect(suggestOctaveShift([96, 97, 98, 99, 40])).toBe(-2);
  });
});

describe("staff geometry", () => {
  it("maps twelve pitch classes onto seven diatonic steps", () => {
    expect(PC_TO_STEP).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]);
    expect(IS_SHARP.filter(Boolean)).toHaveLength(5);
    // A sharp shares its step with the natural below it — that is what an
    // accidental means on a staff.
    expect(staffStep(61)).toBe(staffStep(60));
    expect(staffStep(90)).toBe(staffStep(89));
  });

  it("places the treble staff's own lines", () => {
    expect(staffStep(64)).toBe(30); // E4, bottom line — the origin
    expect(staffStep(64)).toBe(TREBLE_BOTTOM_STEP);
    expect(staffStep(67)).toBe(32); // G4
    expect(staffStep(71)).toBe(34); // B4, middle line
    expect(staffStep(74)).toBe(36); // D5
    expect(staffStep(77)).toBe(38); // F5, top line
  });

  it("places notes off the staff", () => {
    expect(staffStep(60)).toBe(28); // C4, middle C, below the staff
    expect(staffStep(84)).toBe(42); // C6, well above it
    expect(staffStep(90)).toBe(45); // F#6
  });

  it("moves exactly seven steps per octave", () => {
    expect(staffStep(72) - staffStep(60)).toBe(7);
    expect(staffStep(90) - staffStep(78)).toBe(7);
  });

  it("derives offsets, accidentals and ledger lines", () => {
    expect(staffPosition(64)).toEqual({
      step: 30,
      offsetFromBottomLine: 0,
      sharp: false,
      ledgerOffsets: [],
    });

    // Middle C sits on a single ledger line below the treble staff.
    expect(staffPosition(60)).toEqual({
      step: 28,
      offsetFromBottomLine: -2,
      sharp: false,
      ledgerOffsets: [-2],
    });

    // C6 is the second ledger line above: A5 at 10, C6 at 12.
    expect(staffPosition(84)).toEqual({
      step: 42,
      offsetFromBottomLine: 12,
      sharp: false,
      ledgerOffsets: [10, 12],
    });

    // F#6 sits in the space above the third ledger line, and needs a sharp.
    expect(staffPosition(90)).toEqual({
      step: 45,
      offsetFromBottomLine: 15,
      sharp: true,
      ledgerOffsets: [10, 12, 14],
    });
  });

  it("never puts a ledger line on a note that is on the staff", () => {
    for (let midi = 64; midi <= 77; midi++) {
      expect(staffPosition(midi).ledgerOffsets).toEqual([]);
    }
    // G5 is the space just above the top line: still no ledger.
    expect(staffPosition(79).ledgerOffsets).toEqual([]);
    expect(staffPosition(79).offsetFromBottomLine).toBe(9);
  });

  it("only ever puts ledger lines on even offsets", () => {
    for (let midi = 21; midi <= 108; midi++) {
      for (const offset of staffPosition(midi).ledgerOffsets) {
        expect(Math.abs(offset % 2)).toBe(0);
      }
    }
  });
});

describe("formatCents", () => {
  it("signs the number the way a tuner would", () => {
    expect(formatCents(12.4)).toBe("+12");
    expect(formatCents(-7.2)).toBe("-7");
    expect(formatCents(0)).toBe("0");
    expect(formatCents(0.4)).toBe("0");
  });
});
