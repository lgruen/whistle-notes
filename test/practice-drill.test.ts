import { describe, expect, it } from "vitest";
import { alignAttempt, type TargetNote } from "../src/practice/align.js";
import {
  DEFAULT_DRILL_RANGE,
  ECHO_MAX_NOTES,
  ECHO_MIN_NOTES,
  ECHO_MIN_OBSERVATIONS,
  MIN_HOLD_SEC,
  drillRange,
  echoPhrase,
  echoRampText,
  echoSucceeded,
  holdHistoryText,
  holdPlayback,
  holdReference,
  holdScoreText,
  holdTakeaway,
  isDefaultRange,
  makeRng,
  nextEchoLength,
  scoreHold,
  stepWeights,
} from "../src/practice/drill.js";
import type { TrailPoint } from "../src/practice/recall.js";
import {
  HOLD_NEEDLE_CENTS,
  holdReadoutText,
  needleOffsetPercent,
} from "../src/ui/holdmeter.js";
import {
  emptyStats,
  recordAttempt,
  type IntervalStat,
  type PracticeStats,
} from "../src/practice/stats.js";

/**
 * The two echo drills, as arithmetic.
 *
 * Three claims are worth pinning here and none of them is visible on screen.
 *
 * **The hold score must not be laundered.** `scoreHold` reports the distance
 * between what was held and what was played, and the one way to get that
 * catastrophically wrong is to feed it a trail the segmenter has already
 * tuning-corrected — which would take a whistler who is reliably 40 cents sharp
 * and tell them they are perfect. The tests below hold it to reporting the
 * offset it is given.
 *
 * **The adaptive generator must actually adapt, and must not over-adapt.** The
 * bias is a multiplier on a weight, so it is exactly checkable at the weights
 * (`stepWeights`) and statistically checkable in the phrases. Both are here,
 * because the first one can be right while the phrase generator ignores it.
 *
 * **With no history it must be a plain random walk.** Not "approximately" — the
 * fallback is what the formula degenerates to when every multiplier is 1, so
 * seeded output with empty stats has to be *identical* to seeded output with no
 * stats at all. If that ever stops being true, there are two code paths where
 * the design says there is one.
 */

/* ── Seeded randomness ────────────────────────────────────────────────── */

describe("makeRng", () => {
  it("gives the same stream for the same seed, and a different one otherwise", () => {
    const a = Array.from({ length: 8 }, makeRng(1234));
    const b = Array.from({ length: 8 }, makeRng(1234));
    const c = Array.from({ length: 8 }, makeRng(1235));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("stays inside [0, 1)", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 5000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

/* ── The register a drill plays in ────────────────────────────────────── */

describe("drillRange", () => {
  it("falls back to the default register when nothing has been measured", () => {
    expect(drillRange(null)).toEqual(DEFAULT_DRILL_RANGE);
    expect(isDefaultRange(null)).toBe(true);
    // A range with its ends crossed is not a measurement either.
    expect(drillRange({ lowMidi: 90, highMidi: 84 })).toEqual(DEFAULT_DRILL_RANGE);
  });

  it("keeps a sensible measurement as it is", () => {
    const measured = { lowMidi: 72, highMidi: 90 };
    expect(drillRange(measured)).toEqual(measured);
    expect(isDefaultRange(measured)).toBe(false);
  });

  it("clamps an absurd range around its centre rather than believing it", () => {
    // One squeaked take at each end. The middle is still the best guess at
    // where this person lives; the width is not.
    const clamped = drillRange({ lowMidi: 60, highMidi: 108 });
    expect(clamped.highMidi - clamped.lowMidi).toBe(24);
    expect((clamped.lowMidi + clamped.highMidi) / 2).toBe(84);
  });

  it("widens a range too narrow to hold a phrase, symmetrically", () => {
    const widened = drillRange({ lowMidi: 84, highMidi: 88 });
    expect(widened.highMidi - widened.lowMidi).toBe(12);
    expect((widened.lowMidi + widened.highMidi) / 2).toBe(86);
  });
});

describe("holdReference", () => {
  const range = { lowMidi: 78, highMidi: 90 };

  it("stays a semitone inside both ends", () => {
    const rng = makeRng(42);
    for (let i = 0; i < 300; i++) {
      const midi = holdReference(range, rng);
      expect(midi).toBeGreaterThanOrEqual(range.lowMidi + 1);
      expect(midi).toBeLessThanOrEqual(range.highMidi - 1);
      expect(Number.isInteger(midi)).toBe(true);
    }
  });

  it("never hands back the note that was just drilled", () => {
    const rng = makeRng(9);
    let previous = 84;
    for (let i = 0; i < 300; i++) {
      const midi = holdReference(range, rng, previous);
      expect(midi).not.toBe(previous);
      expect(midi).toBeGreaterThanOrEqual(range.lowMidi + 1);
      expect(midi).toBeLessThanOrEqual(range.highMidi - 1);
      previous = midi;
    }
  });

  it("still answers when the range is too narrow to have an inside", () => {
    expect(holdReference({ lowMidi: 84, highMidi: 85 }, makeRng(1))).toBeGreaterThan(80);
  });
});

describe("holdPlayback", () => {
  it("is one sustained note the synth can schedule", () => {
    const [note, ...rest] = holdPlayback(84, 2.5);
    expect(rest).toHaveLength(0);
    expect(note).toEqual({ midi: 84, startSec: 0, endSec: 2.5, durationSec: 2.5 });
  });
});

/* ── Scoring a hold ───────────────────────────────────────────────────── */

/** A held note as the trail sees it: one point every 11 ms, at `midi`, for
 *  `seconds`, starting at `from`. */
function held(
  from: number,
  seconds: number,
  midi: number | ((i: number) => number),
): TrailPoint[] {
  const step = 1 / 94;
  const count = Math.round(seconds / step);
  return Array.from({ length: count }, (_, i) => ({
    tSec: from + i * step,
    midi: typeof midi === "number" ? midi : midi(i),
  }));
}

describe("scoreHold", () => {
  it("reports the offset it was given, uncorrected", () => {
    // The whole point. A trail that has been through the segmenter's global
    // tuning correction would arrive here centred on zero, and this drill would
    // congratulate a whistler who is consistently sharp.
    const score = scoreHold(held(0, 2, 84.4), 84);
    expect(score).not.toBeNull();
    expect(score!.medianCents).toBeCloseTo(40, 6);
    expect(score!.wobbleCents).toBeCloseTo(0, 6);
  });

  it("measures wobble as half the interquartile range", () => {
    // A ±30-cent sweep at 1 Hz over four seconds. A sine spends most of its
    // time near its extremes, so the quartiles land wide of ±15 — the number
    // that matters is that a note swinging a quarter-tone reports a wobble in
    // the tens of cents while its median stays near the middle.
    const score = scoreHold(held(0, 4, (i) => 84 + 0.3 * Math.sin((i / 94) * 2 * Math.PI)), 84);
    expect(Math.abs(score!.medianCents)).toBeLessThan(6);
    expect(score!.wobbleCents).toBeGreaterThan(10);
    expect(score!.wobbleCents).toBeLessThan(30);
  });

  it("shrugs off a single cracked frame, which a standard deviation would not", () => {
    const points = held(0, 2, 84);
    points[40].midi = 96;
    const score = scoreHold(points, 84);
    expect(score!.medianCents).toBeCloseTo(0, 6);
    expect(score!.wobbleCents).toBeLessThan(5);
  });

  it("ignores the scoop into the note", () => {
    // A quarter-second glide up from a whole tone below, then a steady second
    // and a half. Including the approach would report this as flat.
    const scoop = held(0, 0.25, (i) => 82 + (2 * i) / 24);
    const steady = held(0.25, 1.5, 84);
    const score = scoreHold([...scoop, ...steady], 84);
    expect(score!.medianCents).toBeCloseTo(0, 0);
  });

  it("scores the longest held stretch, not the first noise in the take", () => {
    const cough = held(0, 0.3, 79);
    const gap = 0.5;
    const note = held(0.3 + gap, 2, 84);
    const score = scoreHold([...cough, ...note], 84);
    expect(score!.medianCents).toBeCloseTo(0, 6);
    expect(score!.steadySec).toBeGreaterThan(1);
  });

  it("refuses to invent a measurement when there is nothing sustained", () => {
    expect(scoreHold([], 84)).toBeNull();
    expect(scoreHold(held(0, MIN_HOLD_SEC / 2, 84), 84)).toBeNull();
    // Three separate blips, none of them a held note.
    expect(
      scoreHold([...held(0, 0.2, 84), ...held(1, 0.2, 84), ...held(2, 0.2, 84)], 84),
    ).toBeNull();
  });
});

describe("what the hold drill says", () => {
  const score = (medianCents: number, wobbleCents: number) => ({
    medianCents,
    wobbleCents,
    steadySec: 2,
    frames: 150,
  });

  it("names a direction and a distance, and keeps the two numbers apart", () => {
    expect(holdScoreText(score(12, 18))).toBe("Held it 12 cents sharp, wobble ±18 cents.");
    expect(holdScoreText(score(-40, 6))).toBe("Held it 40 cents flat, wobble ±6 cents.");
    expect(holdScoreText(score(3, 9))).toBe("Held it dead on, wobble ±9 cents.");
  });

  it("says the same thing about a whole semitone as the recall screen does", () => {
    expect(holdScoreText(score(-101, 5))).toContain("a semitone flat");
  });

  it("puts steadiness before aim, because aim needs something to aim with", () => {
    // Both bad: the swing is the one to fix first.
    expect(holdTakeaway(score(-60, 40))).toMatch(/wander/i);
    // Steady and well off.
    expect(holdTakeaway(score(-80, 5))).toMatch(/sitting away/i);
    // Steady and close.
    expect(holdTakeaway(score(20, 5))).toMatch(/close/i);
    expect(holdTakeaway(score(2, 4))).toMatch(/right on it/i);
  });

  it("says nothing about a trend until there is one", () => {
    expect(holdHistoryText(null)).toBe("");
    expect(holdHistoryText({ count: 2, offsetEwma: 30, wobbleEwma: 10, updatedAt: 1 })).toBe("");
    expect(
      holdHistoryText({ count: 6, offsetEwma: 22, wobbleEwma: 14, updatedAt: 1 }),
    ).toBe("Lately: running 22 cents sharp, wobble ±14 cents.");
  });
});

/* ── The adaptive phrase generator ────────────────────────────────────── */

const RANGE = { lowMidi: 78, highMidi: 90 };

/** A history in which one directed interval keeps coming out as a wrong note.
 *  Built through `recordAttempt` rather than by hand, so the fixture is the
 *  same shape a real session produces. */
function statsWeakAt(interval: number, attempts = 6): PracticeStats {
  const target: TargetNote[] = [
    { midi: 84, durSec: 0.4 },
    { midi: 84 + interval, durSec: 0.4 },
  ];
  let stats = emptyStats();
  for (let i = 0; i < attempts; i++) {
    // Second note a whole tone away from where it should be: a wrong note every
    // time, which is what a weakness looks like in the ledger.
    const sung = [
      { midi: 84, centsOffset: 0, durationSec: 0.4 },
      { midi: 84 + interval + 2, centsOffset: 0, durationSec: 0.4 },
    ];
    stats = recordAttempt(stats, "t", target, alignAttempt(sung, target), i + 1);
  }
  return stats;
}

function steps(phrase: readonly TargetNote[]): number[] {
  return phrase.slice(1).map((note, i) => note.midi - phrase[i].midi);
}

describe("stepWeights", () => {
  it("prefers small steps and allows the wide ones a whistler is weak at", () => {
    const weights = stepWeights(null);
    expect(weights.get(2)!).toBeGreaterThan(weights.get(7)!);
    expect(weights.get(7)!).toBeGreaterThan(weights.get(9)!);
    expect(weights.get(9)!).toBeGreaterThan(0);
    // Symmetric before the history says otherwise: a rising and a falling step
    // are equally likely until there is evidence about either.
    for (let step = 1; step <= 12; step++) {
      expect(weights.get(step)).toBe(weights.get(-step));
    }
  });

  it("multiplies a measured weakness up, and leaves everything else alone", () => {
    const base = stepWeights(emptyStats());
    const adapted = stepWeights(statsWeakAt(9));
    expect(adapted.get(9)!).toBeGreaterThan(base.get(9)! * 2);
    // A weak rising 9 says nothing about the falling one, or about anything
    // else: the ledger is directed and so is the bias.
    expect(adapted.get(-9)).toBe(base.get(-9));
    expect(adapted.get(2)).toBe(base.get(2));
  });

  it("ignores an interval with too little evidence behind it", () => {
    const thin = statsWeakAt(9, ECHO_MIN_OBSERVATIONS - 1);
    expect(stepWeights(thin)).toEqual(stepWeights(null));
  });

  it("ignores a weakness at an interval no phrase could contain", () => {
    // A melody in the library can leap two octaves; the drill's steps stop at
    // one, and a bias for a step that is not a candidate must not appear as a
    // new candidate.
    const wide = stepWeights(statsWeakAt(19));
    expect(wide).toEqual(stepWeights(null));
    expect(wide.has(19)).toBe(false);
  });
});

describe("echoPhrase", () => {
  it("is reproducible from its seed", () => {
    const options = { length: 5, range: RANGE, stats: statsWeakAt(9) };
    expect(echoPhrase(makeRng(11), options)).toEqual(echoPhrase(makeRng(11), options));
    expect(echoPhrase(makeRng(11), options)).not.toEqual(echoPhrase(makeRng(12), options));
  });

  it("is exactly the plain random walk while the history is thin", () => {
    // Not "close to": with every multiplier at 1 the two calls run the same
    // arithmetic in the same order, so a difference here means a second code
    // path has appeared where the design says there is one.
    for (const stats of [null, emptyStats(), statsWeakAt(9, ECHO_MIN_OBSERVATIONS - 1)]) {
      expect(echoPhrase(makeRng(5), { length: 6, range: RANGE, stats })).toEqual(
        echoPhrase(makeRng(5), { length: 6, range: RANGE }),
      );
    }
  });

  it("stays inside the register and never repeats a note", () => {
    for (let seed = 0; seed < 200; seed++) {
      const phrase = echoPhrase(makeRng(seed), { length: 6, range: RANGE });
      for (const note of phrase) {
        expect(note.midi).toBeGreaterThanOrEqual(RANGE.lowMidi);
        expect(note.midi).toBeLessThanOrEqual(RANGE.highMidi);
        expect(Number.isInteger(note.midi)).toBe(true);
      }
      expect(steps(phrase).every((step) => step !== 0)).toBe(true);
    }
  });

  it("clamps its length to what the drill asks for", () => {
    expect(echoPhrase(makeRng(1), { length: 1 })).toHaveLength(ECHO_MIN_NOTES);
    expect(echoPhrase(makeRng(1), { length: 99 })).toHaveLength(ECHO_MAX_NOTES);
    expect(echoPhrase(makeRng(1), {})).toHaveLength(ECHO_MIN_NOTES);
  });

  it("mostly walks in small steps when it has nothing to go on", () => {
    const counts = new Map<number, number>();
    for (let seed = 0; seed < 400; seed++) {
      for (const step of steps(echoPhrase(makeRng(seed), { length: 6, range: RANGE }))) {
        counts.set(Math.abs(step), (counts.get(Math.abs(step)) ?? 0) + 1);
      }
    }
    let small = 0;
    let total = 0;
    for (const [size, count] of counts) {
      total += count;
      if (size <= 4) small += count;
    }
    expect(small / total).toBeGreaterThan(0.5);
    // ...and it is a bias, not a rule: wide leaps do happen.
    expect([...counts.keys()].some((size) => size >= 8)).toBe(true);
  });

  /**
   * The claim the whole drill rests on, measured rather than asserted.
   *
   * Deliberately *not* a check on an exact sequence — that would pin the
   * generator's implementation rather than its behaviour, and would break the
   * moment anyone changed the order of a loop. What matters is that a measured
   * weakness comes up materially more often than it did before the app knew
   * about it, and that it does not swallow the drill whole.
   */
  it("over-samples a measured weakness without collapsing onto it", () => {
    const count = (stats: PracticeStats | null, want: number): number => {
      let seen = 0;
      let total = 0;
      for (let seed = 0; seed < 600; seed++) {
        for (const step of steps(echoPhrase(makeRng(seed), { length: 6, range: RANGE, stats }))) {
          total++;
          if (step === want) seen++;
        }
      }
      return seen / total;
    };
    const before = count(null, 9);
    const after = count(statsWeakAt(9), 9);
    expect(after).toBeGreaterThan(before * 2);
    // Still a drill and not a metronome: the weak step is over-sampled, not
    // the only thing left.
    expect(after).toBeLessThan(0.5);
  });
});

/* ── The difficulty ramp ──────────────────────────────────────────────── */

describe("the ramp", () => {
  const phrase: TargetNote[] = [84, 88, 86].map((midi) => ({ midi, durSec: 0.5 }));
  const sungAs = (midis: readonly number[], cents = 0) =>
    midis.map((midi) => ({ midi, centsOffset: cents, durationSec: 0.5 }));

  it("counts the right notes, wobbly or not, as a success", () => {
    expect(echoSucceeded(alignAttempt(sungAs([84, 88, 86]), phrase))).toBe(true);
    // 45 cents out on every note: `off`, not `wrong`. Demanding better than
    // that from a beginner's whistle would mean the ramp never moved.
    expect(echoSucceeded(alignAttempt(sungAs([84, 88, 86], 45), phrase))).toBe(true);
  });

  it("does not count a wrong, missed or added note", () => {
    expect(echoSucceeded(alignAttempt(sungAs([84, 89, 86]), phrase))).toBe(false);
    expect(echoSucceeded(alignAttempt(sungAs([84, 88]), phrase))).toBe(false);
    expect(echoSucceeded(alignAttempt(sungAs([84, 88, 86, 84]), phrase))).toBe(false);
    expect(echoSucceeded(alignAttempt([], phrase))).toBe(false);
  });

  it("moves one note at a time and stops at both ends", () => {
    expect(nextEchoLength(3, true)).toBe(4);
    expect(nextEchoLength(6, true)).toBe(ECHO_MAX_NOTES);
    expect(nextEchoLength(4, false)).toBe(3);
    expect(nextEchoLength(3, false)).toBe(ECHO_MIN_NOTES);
  });

  it("says what it just did", () => {
    expect(echoRampText(3, 4)).toMatch(/one more/i);
    expect(echoRampText(4, 3)).toMatch(/one back/i);
    expect(echoRampText(3, 3)).toMatch(/same length/i);
  });
});

/* ── The ledger the drill reads ───────────────────────────────────────── */

describe("the shared interval ledger", () => {
  it("is the same one the drill writes to and the generator reads from", () => {
    // The loop the whole adaptive design turns on: an echo folds its intervals
    // in through the same entry point recall uses, and the next phrase's
    // weights come straight back out of it.
    const weak = statsWeakAt(9);
    const stat: IntervalStat | undefined = weak.intervals.get(9);
    expect(stat?.observations).toBeGreaterThanOrEqual(ECHO_MIN_OBSERVATIONS);
    expect(stepWeights(weak).get(9)!).toBeGreaterThan(stepWeights(null).get(9)!);
  });
});

/* ── The live needle ──────────────────────────────────────────────────── */

describe("the hold meter's needle", () => {
  it("is centred on the reference and pins at the ends", () => {
    expect(needleOffsetPercent(0)).toBe(0);
    expect(needleOffsetPercent(HOLD_NEEDLE_CENTS / 2)).toBeCloseTo(25, 9);
    expect(needleOffsetPercent(HOLD_NEEDLE_CENTS)).toBeCloseTo(50, 9);
    expect(needleOffsetPercent(10 * HOLD_NEEDLE_CENTS)).toBeCloseTo(50, 9);
    expect(needleOffsetPercent(-10 * HOLD_NEEDLE_CENTS)).toBeCloseTo(-50, 9);
  });

  it("spans a whole semitone each way, not the transcriber's half", () => {
    // A beginner's first holds land 40–80 cents out. A bar that pinned at 50
    // would show them a needle against the wall that never moves as they
    // improve — the feedback would vanish exactly where it is needed.
    expect(HOLD_NEEDLE_CENTS).toBeGreaterThanOrEqual(100);
  });

  it("stops printing a number once the number stops helping", () => {
    expect(holdReadoutText(null)).toBe("—");
    expect(holdReadoutText(NaN)).toBe("—");
    expect(holdReadoutText(0)).toBe("0¢");
    expect(holdReadoutText(12.4)).toBe("+12¢");
    expect(holdReadoutText(-40)).toBe("-40¢");
    // A whole tone out is the wrong note, usually the wrong register, and
    // "+1204¢" is a true statement that helps nobody.
    expect(holdReadoutText(1204)).toBe("↑");
    expect(holdReadoutText(-1204)).toBe("↓");
  });
});
