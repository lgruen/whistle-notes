import { describe, expect, it } from "vitest";
import { alignAttempt, type Alignment, type TargetNote } from "../src/practice/align.js";
import {
  EWMA_ALPHA,
  STATS_VERSION,
  emptyStats,
  forgetTarget,
  intervalWeakness,
  recordAttempt,
  slotTrouble,
  statsFromJson,
  statsToJson,
  weakestIntervals,
  type PracticeStats,
} from "../src/practice/stats.js";

/**
 * The practice history: what it remembers, what it deliberately refuses to
 * conflate, and what it does when the stored copy comes back damaged.
 *
 * The interesting failures here are all *quiet* ones. An EWMA seeded at zero
 * claims a perfect first attempt nobody made. A wrong note's 1200-cent residual
 * folded into the aim average makes a whistler who hit every note look like
 * they cannot aim. A slot tally that survives its target being re-recorded
 * points a heatmap at the wrong bar. None of those throw, none show up as a
 * blank screen, and all of them make the app give advice about a person who
 * does not exist.
 */

const melody = (midis: readonly number[]): TargetNote[] =>
  midis.map((midi) => ({ midi, durSec: 0.4 }));

/** An attempt expressed as a signed cents deviation per slot, or `null` for a
 *  note that was never sung. */
function attemptOf(target: readonly TargetNote[], deviations: readonly (number | null)[]): Alignment {
  const sung = target
    .map((note, i) => ({ note, cents: deviations[i] }))
    .filter((entry) => entry.cents !== null)
    .map((entry) => {
      const pitch = entry.note.midi + (entry.cents as number) / 100;
      const midi = Math.round(pitch);
      return { midi, centsOffset: (pitch - midi) * 100, durationSec: 0.4 };
    });
  return alignAttempt(sung, target);
}

/** C major triad up and back: intervals +4, +3, -3, -4. */
const TRIAD = melody([60, 64, 67, 64, 60]);

describe("per-interval statistics", () => {
  it("keys on the directed step in the target, not the position", () => {
    const stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, 0, 0, 0, 0]), 1);
    // Four transitions, four distinct directed intervals. The first slot has no
    // interval into it and contributes to none of them.
    expect([...stats.intervals.keys()].sort((a, b) => a - b)).toEqual([-4, -3, 3, 4]);
    for (const stat of stats.intervals.values()) {
      expect(stat.observations).toBe(1);
      expect(stat.clean).toBe(1);
    }
  });

  it("counts a rising third and a falling third as different skills", () => {
    // The triad's two thirds are slot 2 (+3, rising) and slot 3 (−3, falling).
    // Rising sung 50 cents flat, falling sung true. An unsigned "third" bucket
    // would average these into a 25-cent wobble and drill neither.
    const stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, 0, -50, 0, 0]), 1);
    expect(stats.intervals.get(3)?.absCentsEwma).toBeCloseTo(50, 9);
    expect(stats.intervals.get(-3)?.absCentsEwma).toBeCloseTo(0, 9);
    expect(stats.intervals.get(4)?.absCentsEwma).toBeCloseTo(0, 9);
    expect(stats.intervals.get(-4)?.absCentsEwma).toBeCloseTo(0, 9);
  });

  it("starts the average at the first observation, not at zero", () => {
    // Seeded at zero, a first attempt 60 cents flat would read as 15 and take
    // half a dozen attempts to tell the truth — which is most of the sessions
    // anyone will ever do.
    const one = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, -60, 0, 0, 0]), 1);
    expect(one.intervals.get(4)?.absCentsEwma).toBeCloseTo(60, 9);

    const two = recordAttempt(one, "t", TRIAD, attemptOf(TRIAD, [0, -20, 0, 0, 0]), 2);
    expect(two.intervals.get(4)?.absCentsEwma).toBeCloseTo(60 + EWMA_ALPHA * (20 - 60), 9);
    expect(two.intervals.get(4)?.centsObservations).toBe(2);
  });

  it("keeps a wrong note out of the aim average and into its own rate", () => {
    // The separation this whole schema exists for. A note an octave out has a
    // 1200-cent residual; folding it into "how well do you aim" would report a
    // whistler who hit four of five notes dead on as being twelve semitones
    // out on average, and prescribe breath exercises for a memory problem.
    const stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, 1200, 0, 0, 0]), 1);
    const rising4th = stats.intervals.get(4);
    expect(rising4th?.wrong).toBe(1);
    expect(rising4th?.wrongRateEwma).toBe(1);
    expect(rising4th?.centsObservations).toBe(0);
    expect(rising4th?.absCentsEwma).toBe(0);
    expect(rising4th?.observations).toBe(1);
  });

  it("keeps a note that was never sung out of both", () => {
    const stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, null, 0, 0, 0]), 1);
    const rising4th = stats.intervals.get(4);
    expect(rising4th?.missing).toBe(1);
    expect(rising4th?.observations).toBe(0);
    expect(rising4th?.wrongRateEwma).toBe(0);
    expect(rising4th?.centsObservations).toBe(0);
  });

  it("lets a rate recover, which is the point of an EWMA", () => {
    let stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, 1200, 0, 0, 0]), 1);
    expect(stats.intervals.get(4)?.wrongRateEwma).toBe(1);
    for (let i = 0; i < 10; i++) {
      stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [0, 0, 0, 0, 0]), 2 + i);
    }
    expect(stats.intervals.get(4)?.wrongRateEwma).toBeLessThan(0.1);
    // ...while the lifetime count is the long memory and never forgets.
    expect(stats.intervals.get(4)?.wrong).toBe(1);
    expect(stats.intervals.get(4)?.clean).toBe(10);
  });

  it("never mutates the stats it was handed", () => {
    const before = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, 0, 0, 0, 0]), 1);
    const snapshot = statsToJson(before);
    recordAttempt(before, "t", TRIAD, attemptOf(TRIAD, [0, -60, 0, 0, 0]), 2);
    expect(statsToJson(before)).toEqual(snapshot);
  });
});

describe("per-target slot tallies", () => {
  it("accumulate across attempts, in slot order", () => {
    let stats = emptyStats();
    stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [0, 0, -40, 0, 0]), 1);
    stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [0, 0, -300, 0, 0]), 2);
    stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [0, 0, null, 0, 0]), 3);

    const tally = stats.targets.get("t");
    expect(tally?.attempts).toBe(3);
    expect(tally?.updatedAt).toBe(3);
    expect(tally?.slots[2]).toEqual({ clean: 0, off: 1, wrong: 1, missing: 1 });
    expect(tally?.slots[0]).toEqual({ clean: 3, off: 0, wrong: 0, missing: 0 });
  });

  it("counts the notes that answered to no slot", () => {
    const sung = [
      { midi: 60, centsOffset: 0, durationSec: 0.4 },
      { midi: 61, centsOffset: 0, durationSec: 0.4 },
      { midi: 64, centsOffset: 0, durationSec: 0.4 },
      { midi: 67, centsOffset: 0, durationSec: 0.4 },
      { midi: 64, centsOffset: 0, durationSec: 0.4 },
      { midi: 60, centsOffset: 0, durationSec: 0.4 },
    ];
    const stats = recordAttempt(emptyStats(), "t", TRIAD, alignAttempt(sung, TRIAD), 1);
    expect(stats.targets.get("t")?.extras).toBe(1);
  });

  it("starts over when the target itself changed length", () => {
    // Slot 4 of a five-note melody and slot 4 of a three-note one are different
    // places. Padding or truncating would leave a heatmap confidently pointing
    // at the wrong bar of a melody that no longer exists.
    let stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, 0, -300, 0, 0]), 1);
    expect(stats.targets.get("t")?.slots).toHaveLength(5);

    const shorter = melody([60, 64, 67]);
    stats = recordAttempt(stats, "t", shorter, attemptOf(shorter, [0, 0, 0]), 2);
    expect(stats.targets.get("t")?.slots).toHaveLength(3);
    expect(stats.targets.get("t")?.attempts).toBe(1);
    expect(stats.targets.get("t")?.slots[2]).toEqual({
      clean: 1,
      off: 0,
      wrong: 0,
      missing: 0,
    });
  });

  it("keeps different targets apart", () => {
    const other = melody([72, 74, 76]);
    let stats = recordAttempt(emptyStats(), "a", TRIAD, attemptOf(TRIAD, [0, 0, 0, 0, 0]), 1);
    stats = recordAttempt(stats, "b", other, attemptOf(other, [0, 0, 0]), 2);
    expect(stats.targets.get("a")?.slots).toHaveLength(5);
    expect(stats.targets.get("b")?.slots).toHaveLength(3);
    // The two share the +2 interval bucket, because that is about the whistler.
    expect(stats.intervals.get(2)?.observations).toBe(2);
  });

  it("forgets a deleted target but not what it taught us", () => {
    const stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, -50, 0, 0, 0]), 1);
    const after = forgetTarget(stats, "t");
    expect(after.targets.has("t")).toBe(false);
    expect(after.intervals.get(4)?.absCentsEwma).toBeCloseTo(50, 9);
    // A target that was never there is not a change.
    expect(forgetTarget(after, "t")).toBe(after);
  });
});

describe("the trouble heatmap", () => {
  it("ranks a slot that is consistently wrong above one that merely wobbles", () => {
    // Pinned on the tally directly, because the weighting *is* the behaviour
    // and routing it through an aligner would only test the aligner again.
    const trouble = slotTrouble({
      attempts: 4,
      extras: 0,
      updatedAt: 0,
      slots: [
        { clean: 4, off: 0, wrong: 0, missing: 0 },
        { clean: 0, off: 4, wrong: 0, missing: 0 },
        { clean: 0, off: 0, wrong: 4, missing: 0 },
        { clean: 0, off: 0, wrong: 0, missing: 4 },
        { clean: 2, off: 1, wrong: 1, missing: 0 },
      ],
    });
    expect(trouble[0]).toBe(0);
    expect(trouble[1]).toBeCloseTo(0.35, 12);
    expect(trouble[2]).toBe(1);
    expect(trouble[3]).toBeCloseTo(0.7, 12);
    expect(trouble[4]).toBeCloseTo((1 + 0.35) / 4, 12);
    // The order is the whole claim: a wrong note beats a note never sung beats
    // a note that only wobbled, and a clean slot is invisible.
    expect(trouble[2]).toBeGreaterThan(trouble[3]);
    expect(trouble[3]).toBeGreaterThan(trouble[1]);
    expect(trouble[1]).toBeGreaterThan(trouble[0]);
    for (const score of trouble) expect(score).toBeLessThanOrEqual(1);
  });

  it("sees a real attempt through to the right slot", () => {
    let stats = emptyStats();
    for (let i = 0; i < 4; i++) {
      stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [0, 0, 900, 0, 0]), i);
    }
    const trouble = slotTrouble(stats.targets.get("t")!);
    expect(trouble).toEqual([0, 0, 1, 0, 0]);
  });

  it("says nothing about a slot with no history", () => {
    expect(slotTrouble({ attempts: 0, slots: [], extras: 0, updatedAt: 0 })).toEqual([]);
    expect(
      slotTrouble({
        attempts: 0,
        slots: [{ clean: 0, off: 0, wrong: 0, missing: 0 }],
        extras: 0,
        updatedAt: 0,
      }),
    ).toEqual([0]);
  });
});

describe("picking what to drill", () => {
  it("puts wrong notes above wobble, and ignores intervals it barely knows", () => {
    let stats = emptyStats();
    // Rising 4ths (+4 here is a major third; use the triad's own steps): the
    // +4 step is sung wrong every time, the +3 step is sung 50 cents flat every
    // time, and the two falling steps are clean.
    for (let i = 0; i < 5; i++) {
      stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [0, 900, -50, 0, 0]), i);
    }
    const ranked = weakestIntervals(stats, { minObservations: 3 });
    expect(ranked.map((stat) => stat.interval)).toEqual([4, 3, -4, -3]);
    expect(intervalWeakness(ranked[0])).toBeGreaterThan(intervalWeakness(ranked[1]));

    // One attempt is an anecdote. With the default threshold nothing qualifies.
    const thin = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, 900, 0, 0, 0]), 1);
    expect(weakestIntervals(thin)).toEqual([]);
    expect(weakestIntervals(thin, { minObservations: 1 })[0].interval).toBe(4);
  });

  it("honours the limit and orders deterministically", () => {
    let stats = emptyStats();
    for (let i = 0; i < 5; i++) {
      stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [0, 0, 0, 0, 0]), i);
    }
    // All four intervals are equally (perfectly) fine, so only the tie-break
    // decides — and it must not depend on Map insertion order.
    expect(weakestIntervals(stats, { limit: 2 }).map((s) => s.interval)).toEqual([-4, -3]);
  });
});

describe("serialisation", () => {
  function populated(): PracticeStats {
    let stats = recordAttempt(emptyStats(), "t", TRIAD, attemptOf(TRIAD, [0, -45, 900, null, 0]), 7);
    stats = recordAttempt(stats, "t", TRIAD, attemptOf(TRIAD, [10, 0, 0, 0, 0]), 9);
    return stats;
  }

  it("round-trips through plain JSON", () => {
    const before = populated();
    const after = statsFromJson(JSON.parse(JSON.stringify(statsToJson(before))));
    expect(statsToJson(after)).toEqual(statsToJson(before));
    expect([...after.intervals.keys()].sort((a, b) => a - b)).toEqual(
      [...before.intervals.keys()].sort((a, b) => a - b),
    );
    expect(after.targets.get("t")).toEqual(before.targets.get("t"));
  });

  it("stamps a version, and refuses to guess at another one", () => {
    const json = statsToJson(populated());
    expect(json.version).toBe(STATS_VERSION);
    expect(statsFromJson({ ...json, version: STATS_VERSION + 1 }).intervals.size).toBe(0);
    expect(statsFromJson({ ...json, version: "1" }).intervals.size).toBe(0);
  });

  it("never throws on anything a storage slot can hold", () => {
    for (const garbage of [
      null,
      undefined,
      0,
      "",
      "not json at all",
      [],
      {},
      { version: 1 },
      { version: 1, intervals: null, targets: 7 },
      { version: 1, intervals: { "4": null }, targets: { t: null } },
      { version: 1, intervals: { notanumber: { observations: 3 } }, targets: {} },
      { version: 1, intervals: {}, targets: { t: { slots: "no" } } },
    ]) {
      const stats = statsFromJson(garbage);
      expect(stats.intervals.size, JSON.stringify(garbage) ?? "undefined").toBe(0);
      expect(stats.targets.size, JSON.stringify(garbage) ?? "undefined").toBe(0);
    }
  });

  it("drops fields it cannot believe rather than importing them", () => {
    const stats = statsFromJson({
      version: 1,
      intervals: {
        "4": {
          observations: "many",
          clean: -3,
          wrong: 2.7,
          absCentsEwma: Number.NaN,
          wrongRateEwma: 5,
          centsObservations: Infinity,
        },
      },
      targets: {
        t: { attempts: -1, extras: null, updatedAt: "yesterday", slots: [{ clean: 2 }, null] },
      },
    });
    const stat = stats.intervals.get(4)!;
    expect(stat.observations).toBe(0);
    expect(stat.clean).toBe(0);
    expect(stat.wrong).toBe(2);
    expect(stat.absCentsEwma).toBe(0);
    expect(stat.centsObservations).toBe(0);
    // A rate is a rate: whatever was stored, it cannot be five.
    expect(stat.wrongRateEwma).toBe(1);

    const tally = stats.targets.get("t")!;
    expect(tally.attempts).toBe(0);
    expect(tally.extras).toBe(0);
    expect(tally.updatedAt).toBe(0);
    expect(tally.slots).toEqual([
      { clean: 2, off: 0, wrong: 0, missing: 0 },
      { clean: 0, off: 0, wrong: 0, missing: 0 },
    ]);
  });
});
