import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  durationClasses,
  hasRestBefore,
  midiToHz,
  midiToName,
  type Note,
  type PitchFrame,
} from "../src/dsp/index.js";
import {
  playbackSchedule,
  scheduleDuration,
  supersawDetuneCents,
  voiceSpec,
} from "../src/audio/synth.js";
import { formatClock } from "../src/ui/live.js";
import { sequenceText } from "../src/ui/notelist.js";
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

/**
 * The chip list used to carry its own copies of these two rules, with a
 * different long-note ratio and a different boundary on the rest gap than the
 * segmenter's. Two definitions of "long" in one screen is one too many, so the
 * UI now consumes `src/dsp`'s — and these tests pin the behaviour the chips
 * actually get, at the boundaries where a second implementation would show.
 */
describe("duration classes come from the segmenter", () => {
  it("are relative to the take's own median, not to absolute seconds", () => {
    // The same 0.3 s note is "long" in a fast take and "short" in a slow one.
    const fast = [note(72, 0, 0.15), note(74, 0.2, 0.15), note(76, 0.4, 0.3)];
    expect(durationClasses(fast)[2]).toBe("long");

    const slow = [note(72, 0, 0.8), note(74, 1, 0.8), note(76, 2, 0.3)];
    expect(durationClasses(slow)[2]).toBe("short");
  });

  it("call 1.6× the median long — the UI's old copy of this said 1.7×", () => {
    const notes = [note(72, 0, 0.2), note(74, 0.3, 0.2), note(76, 0.6, 0.32)];
    expect(durationClasses(notes)[2]).toBe("long");
  });

  it("has nothing to say about an empty take", () => {
    expect(durationClasses([])).toEqual([]);
  });
});

describe("rests come from the segmenter", () => {
  it("uses the configured gap, exclusively", () => {
    const gap = DEFAULT_CONFIG.segment.restGapMs / 1000;
    // Exactly at the threshold is *not* a rest — the UI's old copy used `>=`
    // and disagreed with the notes it was describing at the boundary.
    expect(hasRestBefore(note(72, 0, 0.2, gap), DEFAULT_CONFIG)).toBe(false);
    expect(hasRestBefore(note(72, 0, 0.2, gap + 0.01), DEFAULT_CONFIG)).toBe(true);
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

describe("playback scheduling", () => {
  it("preserves musical gaps and compresses hesitations", () => {
    const notes = [
      note(72, 0, 0.4),
      note(74, 0.6, 0.4), // 0.2 s gap: musical, kept
      note(76, 4.0, 0.4), // 3.0 s gap: a pause for thought, compressed
    ];
    const schedule = playbackSchedule(notes, 0);
    expect(schedule[0].startSec).toBeCloseTo(0, 10);
    expect(schedule[1].startSec).toBeCloseTo(0.6, 10); // 0.4 played + 0.2 waited
    expect(schedule[2].startSec).toBeCloseTo(1.5, 10); // ...then 0.4 + 0.5, not 3.0
    expect(scheduleDuration(schedule)).toBeCloseTo(1.9, 10);
  });

  it("drops leading silence: the first note always starts at zero", () => {
    expect(playbackSchedule([note(72, 12, 0.4)], 0)[0].startSec).toBe(0);
  });

  it("floors note length so a very short note is a note, not a click", () => {
    expect(playbackSchedule([note(72, 0, 0.01)], 0)[0].durationSec).toBeCloseTo(0.09, 10);
  });

  it("plays at the display octave", () => {
    expect(playbackSchedule([note(96, 0, 0.4)], -2)[0].midi).toBe(72);
    expect(playbackSchedule([note(96, 0, 0.4)], 0)[0].midi).toBe(96);
  });

  it("never goes backwards, whatever the gaps", () => {
    const notes = [note(72, 0, 0.3), note(74, 9, 0.3), note(76, 9.4, 0.3)];
    const schedule = playbackSchedule(notes, 0);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].startSec).toBeGreaterThanOrEqual(schedule[i - 1].startSec);
    }
    expect(scheduleDuration([])).toBe(0);
  });
});

/**
 * The supersaw, as arithmetic.
 *
 * Whether it *sounds* good is a question for a phone speaker, and nothing here
 * claims an answer to it. What can be settled on paper is everything that would
 * make it sound wrong for a reason that is not taste: a spread that is not
 * symmetric drags the perceived pitch off the note the user is trying to check,
 * and a stack that is not level-matched turns the toggle into a volume control.
 */
describe("the supersaw spread", () => {
  it("is symmetric about the written pitch", () => {
    const spread = supersawDetuneCents();
    for (let i = 0; i < spread.length; i++) {
      // Exactly, not approximately: the two halves are the same expression with
      // one sign flipped, so any drift here would be a real asymmetry. Summing
      // rather than negating, because the centre entry is `0` and `-0` is a
      // different value to `Object.is` while being the same detune.
      expect(spread[i] + spread[spread.length - 1 - i]).toBe(0);
    }
    expect(spread.reduce((sum, cents) => sum + cents, 0)).toBe(0);
  });

  it("keeps exactly one oscillator on the note, so the pitch stays unambiguous", () => {
    expect(supersawDetuneCents().filter((cents) => cents === 0)).toHaveLength(1);
    expect(supersawDetuneCents(5).filter((cents) => cents === 0)).toHaveLength(1);
    // An even count has no centre to put it on, and says so rather than
    // rounding one of the pairs onto the fundamental.
    expect(supersawDetuneCents(6).filter((cents) => cents === 0)).toHaveLength(0);
  });

  it("is bounded by the stated maximum, and reaches it exactly once each way", () => {
    const spread = supersawDetuneCents(7, 25);
    expect(Math.min(...spread)).toBe(-25);
    expect(Math.max(...spread)).toBe(25);
    for (const cents of spread) expect(Math.abs(cents)).toBeLessThanOrEqual(25);
    // A quarter-tone stack would be a different instrument.
    expect(spread.filter((cents) => Math.abs(cents) === 25)).toHaveLength(2);
  });

  it("orders the oscillators from flat to sharp, with no duplicates", () => {
    const spread = supersawDetuneCents();
    for (let i = 1; i < spread.length; i++) expect(spread[i]).toBeGreaterThan(spread[i - 1]);
  });

  it("spaces the pairs the JP-8000 way: clustered inside, flung out at the edges", () => {
    const spread = supersawDetuneCents(7, 25);
    const sharpSide = spread.slice(4); // the three above the fundamental
    const gaps = [sharpSide[0], sharpSide[1] - sharpSide[0], sharpSide[2] - sharpSide[1]];
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    // Evenly spaced would put the inner pair at 1/3 of maximum; pulling it in
    // to under a quarter is what makes the stack one thick voice rather than
    // three audible chorus taps.
    expect(sharpSide[0] / 25).toBeLessThan(0.25);
    expect(sharpSide[1] / 25).toBeGreaterThan(0.45);
    expect(sharpSide[1] / 25).toBeLessThan(0.65);
  });

  it("is deterministic, and generalises to other oscillator counts", () => {
    expect(supersawDetuneCents()).toEqual(supersawDetuneCents());
    expect(supersawDetuneCents(5)).toHaveLength(5);
    expect(supersawDetuneCents(9)).toHaveLength(9);
    // Degenerate counts stay finite rather than dividing by a zero pair count.
    expect(supersawDetuneCents(1)).toEqual([0]);
    expect(supersawDetuneCents(0)).toEqual([]);
    expect(supersawDetuneCents(9).every(Number.isFinite)).toBe(true);
  });
});

describe("the two playback voices", () => {
  it("leaves the clean voice exactly what it was", () => {
    const clean = voiceSpec("clean");
    expect(clean.oscillatorType).toBe("triangle");
    expect(clean.detuneCents).toEqual([0]);
    expect(clean.peakGain).toBeCloseTo(0.25, 10);
    expect(clean.releaseSec).toBeCloseTo(0.03, 10);
    expect(clean.lowpassHz).toBeNull();
  });

  it("scales the supersaw by 1/√N, because detuned saws sum as power", () => {
    const clean = voiceSpec("clean");
    const saw = voiceSpec("supersaw");
    const n = saw.detuneCents.length;

    // Seven saws at 1/√7 the amplitude carry the same RMS as one at full: they
    // beat rather than reinforce, so their *powers* add. The extra factor is a
    // perceptual trim for the saw's brighter spectrum, not a fudge.
    const trim = (saw.peakGain * Math.sqrt(n)) / clean.peakGain;
    expect(trim).toBeGreaterThan(0.6);
    expect(trim).toBeLessThanOrEqual(1);
    // Even with every oscillator momentarily in phase the note cannot clip on
    // its own — which is the arithmetic the 1/√N is quietly also buying.
    expect(saw.peakGain * n).toBeLessThan(1);
  });

  it("gives the supersaw a longer tail and a lid on the fizz", () => {
    const saw = voiceSpec("supersaw");
    expect(saw.oscillatorType).toBe("sawtooth");
    expect(saw.detuneCents).toEqual(supersawDetuneCents());
    expect(saw.releaseSec).toBeGreaterThan(voiceSpec("clean").releaseSec);
    expect(saw.lowpassHz).not.toBeNull();

    // A note at the scheduler's 90 ms floor is shorter than attack+release, so
    // it *does* spill past its own end — deliberately, and boundedly:
    // `sustainEnd` shortens the sustain and never the release, so the overhang
    // can only ever be attack + release − floor. Keeping that under ~70 ms is
    // what makes a run of very short notes read as legato and not as a chord.
    const shortestNoteSec = 0.09; // `playbackSchedule`'s minDuration default
    expect(0.005 + saw.releaseSec - shortestNoteSec).toBeLessThan(0.07);
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
