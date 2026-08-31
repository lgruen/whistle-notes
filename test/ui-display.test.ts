import { describe, expect, it } from "vitest";
import { midiToHz, midiToName, type Note, type PitchFrame } from "../src/dsp/index.js";
import { formatClock } from "../src/ui/live.js";
import { durationClass, medianDuration, sequenceText } from "../src/ui/notelist.js";
import { rollMidiRange, rollSpanSec } from "../src/ui/pianoroll.js";

/**
 * The display layer's arithmetic, tested where it is cheap to test.
 *
 * None of this needs a DOM: every function here turns notes and frames into
 * numbers or strings, and the DOM modules only ever paste those results into an
 * element. That split is deliberate — a wrong gap-compression rule or an
 * off-by-one in the piano roll's range is invisible in a screenshot and obvious
 * in an assertion.
 */

function note(
  midi: number,
  startSec: number,
  durationSec: number,
  gapBeforeSec = 0,
): Note {
  return {
    midi,
    noteName: midiToName(midi),
    centsOffset: 0,
    startSec,
    endSec: startSec + durationSec,
    durationSec,
    pitchHz: midiToHz(midi),
    confidence: 0.9,
    gapBeforeSec,
    flags: {},
  };
}

function frame(tSec: number, hz: number | null, clarity = 0.9): PitchFrame {
  return {
    tSec,
    hz,
    clarity,
    snrDb: 20,
    peakToSecondDb: 12,
    bandRmsDb: -30,
    broadbandRmsDb: -30,
    clipped: false,
  };
}

describe("duration classes", () => {
  it("is relative to the take's own median, not to absolute seconds", () => {
    // The same 0.3 s note is "long" in a fast take and "short" in a slow one.
    expect(durationClass(0.3, 0.15)).toBe("long");
    expect(durationClass(0.3, 0.8)).toBe("short");
    expect(durationClass(0.3, 0.3)).toBe("medium");
  });

  it("has no opinion when there is no median to compare against", () => {
    expect(durationClass(0.4, 0)).toBe("medium");
  });

  it("takes the median so one held final note cannot rescale everything", () => {
    expect(medianDuration([note(72, 0, 0.2), note(74, 0.3, 0.2), note(76, 0.6, 4)])).toBe(0.2);
    expect(medianDuration([])).toBe(0);
    expect(medianDuration([note(72, 0, 0.2), note(74, 0.3, 0.4)])).toBeCloseTo(0.3, 12);
  });
});

describe("the copyable sequence line", () => {
  it("names notes at the display octave", () => {
    const notes = [note(96, 0, 0.3), note(98, 0.3, 0.3)];
    expect(sequenceText(notes, 0)).toBe("C7 D7");
    expect(sequenceText(notes, -2)).toBe("C5 D5");
  });

  it("marks rests, but never before the first note", () => {
    const notes = [note(84, 0, 0.3, 0.5), note(86, 0.8, 0.3, 0.2), note(88, 1.2, 0.3, 0.05)];
    expect(sequenceText(notes, 0)).toBe("C6 / D6 E6");
  });
});

describe("piano-roll range", () => {
  it("pads the content and keeps at least an octave in view", () => {
    const range = rollMidiRange([frame(0, midiToHz(84))], [note(84, 0, 0.3)]);
    expect(range.max - range.min).toBeGreaterThanOrEqual(12);
    expect(range.min).toBeLessThan(84);
    expect(range.max).toBeGreaterThan(84);
  });

  it("ignores frames that are noise rather than tone", () => {
    // A low-clarity frame two octaves away must not stretch the axis.
    const range = rollMidiRange(
      [frame(0, midiToHz(84)), frame(0.01, midiToHz(40), 0.05), frame(0.02, null)],
      [],
    );
    expect(range.min).toBeGreaterThan(60);
  });

  it("falls back to the whistling register when there is nothing to show", () => {
    const range = rollMidiRange([], []);
    expect(range.min).toBeLessThan(84);
    expect(range.max).toBeGreaterThan(84);
  });

  it("only ever widens when given a previous range", () => {
    const wide = { min: 60, max: 96 };
    const range = rollMidiRange([frame(0, midiToHz(84))], [], wide);
    expect(range.min).toBeLessThanOrEqual(wide.min);
    expect(range.max).toBeGreaterThanOrEqual(wide.max);
  });

  it("spans the whole take when finished, and a minimum window while live", () => {
    const frames = [frame(0, midiToHz(84)), frame(1.5, midiToHz(86))];
    expect(rollSpanSec(frames, false)).toBe(1.5);
    expect(rollSpanSec(frames, true)).toBe(4);
    expect(rollSpanSec([frame(0, null), frame(9, midiToHz(84))], true)).toBe(9);
    expect(rollSpanSec([], false)).toBe(0.5);
  });
});

describe("the recording clock", () => {
  it("counts in m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(60)).toBe("1:00");
    expect(formatClock(-3)).toBe("0:00");
  });
});
