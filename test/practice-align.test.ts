import { describe, expect, it } from "vitest";
import {
  CLEAN_CENTS,
  GAP_COST,
  OFF_CENTS,
  SUB_MAX_COST,
  alignAttempt,
  countVerdicts,
  substitutionCost,
  verdictForCents,
  type Alignment,
  type AttemptNote,
  type TargetNote,
} from "../src/practice/align.js";

/**
 * The diagnosis engine, tested the way the DSP is: by constructing attempts
 * whose ground truth is true by construction and asserting the engine recovers
 * it exactly.
 *
 * Every case here is a sentence the app will one day say to a beginner. "Your
 * third note was 40 cents flat" is only useful if it is *true*, and the ways it
 * can quietly stop being true are all structural: a dropped note that cascades
 * into ten wrong ones, a wrong note reported as a missing-plus-extra pair one
 * slot to the left, a register the aligner could not find. None of those show
 * up in a screenshot of a piano roll; all of them show up here.
 */

/** Attempt notes from float MIDI pitches, keeping the sub-semitone part in
 *  `centsOffset` exactly as `src/dsp` would. */
function whistled(pitches: readonly number[], durations?: readonly number[]): AttemptNote[] {
  return pitches.map((pitch, i) => {
    const midi = Math.round(pitch);
    return {
      midi,
      centsOffset: (pitch - midi) * 100,
      durationSec: durations?.[i] ?? 0.4,
    };
  });
}

function melody(midis: readonly number[], durations?: readonly number[]): TargetNote[] {
  return midis.map((midi, i) => ({ midi, durSec: durations?.[i] ?? 0.4 }));
}

const verdicts = (alignment: Alignment): string[] => alignment.slots.map((s) => s.verdict);

/** A five-note phrase with a mix of steps and a leap: ordinary material. */
const PHRASE = [60, 62, 64, 67, 65];

/** Deterministic PRNG, same one the DSP fuzz tests use. `Math.random` in a fuzz
 *  test means a failure nobody can reproduce, which is worse than no fuzz. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the cost design", () => {
  /**
   * The one inequality the whole engine rests on. If a substitution could ever
   * cost more than two gaps, the aligner would answer "you missed a note and
   * added one" where the truth is "you sang one wrong note" — which is not just
   * a worse sentence, it moves the reported error off by a slot and doubles the
   * count.
   */
  it("never makes throwing two notes away cheaper than pairing them", () => {
    for (let cents = 0; cents <= 2400; cents += 5) {
      expect(substitutionCost(cents / 100), `${cents}c`).toBeLessThan(2 * GAP_COST);
    }
    // ...and the bound is actually reached, so the margin is a design choice
    // and not an accident of the range swept above.
    expect(substitutionCost(24)).toBeCloseTo(SUB_MAX_COST, 12);
    expect(substitutionCost(2)).toBeCloseTo(SUB_MAX_COST, 12);
  });

  it("is free inside the wobble a good whistle has anyway", () => {
    expect(substitutionCost(0)).toBe(0);
    expect(substitutionCost(CLEAN_CENTS / 100)).toBe(0);
    expect(substitutionCost(-CLEAN_CENTS / 100)).toBe(0);
    expect(substitutionCost(0.31)).toBeGreaterThan(0);
  });

  it("keeps a dropped note cheaper to admit than to paper over", () => {
    // A melody in whole-tone steps: shifting every later note onto the wrong
    // slot costs this much per slot, and two slots already outvote one gap.
    expect(2 * substitutionCost(2)).toBeGreaterThan(GAP_COST);
  });
});

describe("an attempt that got it right", () => {
  it("is clean everywhere, at no cost, in the register it was sung in", () => {
    const target = melody(PHRASE);
    const alignment = alignAttempt(whistled(PHRASE), target);
    expect(alignment.transposition).toBe(0);
    expect(alignment.cost).toBeCloseTo(0, 12);
    expect(verdicts(alignment)).toEqual(["clean", "clean", "clean", "clean", "clean"]);
    expect(alignment.extras).toEqual([]);
    expect(alignment.slots.map((s) => s.attemptIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("survives the wobble a real whistle arrives with", () => {
    // ±25 cents on every note — inside the clean band, and inside the cost
    // function's free radius, so this must still align 1:1 at zero cost.
    const wobble = [+25, -25, +18, -22, +24];
    const alignment = alignAttempt(
      whistled(PHRASE.map((midi, i) => midi + wobble[i] / 100)),
      melody(PHRASE),
    );
    expect(verdicts(alignment)).toEqual(["clean", "clean", "clean", "clean", "clean"]);
    expect(alignment.cost).toBeCloseTo(0, 12);
    for (let i = 0; i < wobble.length; i++) {
      expect(alignment.slots[i].residualCents).toBeCloseTo(wobble[i], 6);
    }
  });

  it("finds the register, wherever the whistle lives", () => {
    // A whistle sits one to two octaves above written pitch and lands wherever
    // the mouth is comfortable. Nine semitones up, an octave up, a fourth down:
    // same melody, and the app must say so.
    for (const shift of [9, 12, 19, 24, -5, -12]) {
      const alignment = alignAttempt(
        whistled(PHRASE.map((midi) => midi + shift)),
        melody(PHRASE),
      );
      expect(alignment.transposition, `shift ${shift}`).toBe(-shift);
      expect(verdicts(alignment), `shift ${shift}`).toEqual([
        "clean",
        "clean",
        "clean",
        "clean",
        "clean",
      ]);
    }
  });
});

describe("one note off pitch", () => {
  it("is reported as off, with the sign the whistler needs", () => {
    for (const cents of [-40, +40, -35, +65]) {
      const pitches = PHRASE.map((midi, i) => (i === 2 ? midi + cents / 100 : midi));
      const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
      expect(verdicts(alignment), `${cents}c`).toEqual([
        "clean",
        "clean",
        "off",
        "clean",
        "clean",
      ]);
      expect(alignment.slots[2].residualCents, `${cents}c`).toBeCloseTo(cents, 6);
      // `heardMidi` is the nearest semitone to what came out, so it agrees with
      // the target until the error passes a quarter tone — which is the whole
      // reason the *verdict*, not this field, is what names the intended note.
      expect(alignment.slots[2].heardMidi, `${cents}c`).toBe(
        PHRASE[2] + (Math.abs(cents) > 50 ? Math.sign(cents) : 0),
      );
      expect(alignment.extras, `${cents}c`).toEqual([]);
    }
  });

  it("draws the two boundaries exactly where the verdicts say", () => {
    // On the pure function, where the boundary can be hit exactly: building the
    // same cents out of a float MIDI pitch lands 4e-15 below 30 and would make
    // this a test of IEEE-754 rounding rather than of the rule.
    expect(verdictForCents(CLEAN_CENTS - 1e-9)).toBe("clean");
    expect(verdictForCents(CLEAN_CENTS)).toBe("off");
    expect(verdictForCents(OFF_CENTS - 1e-9)).toBe("off");
    expect(verdictForCents(OFF_CENTS)).toBe("wrong");
    expect(verdictForCents(-CLEAN_CENTS)).toBe("off");
    expect(verdictForCents(-OFF_CENTS)).toBe("wrong");

    // ...and the same boundaries survive the trip through the aligner.
    const at = (cents: number): string => {
      const pitches = PHRASE.map((midi, i) => (i === 1 ? midi + cents / 100 : midi));
      return verdicts(alignAttempt(whistled(pitches), melody(PHRASE)))[1];
    };
    expect(at(CLEAN_CENTS - 1)).toBe("clean");
    expect(at(CLEAN_CENTS + 1)).toBe("off");
    expect(at(OFF_CENTS - 1)).toBe("off");
    expect(at(OFF_CENTS + 1)).toBe("wrong");
    expect(at(-OFF_CENTS - 1)).toBe("wrong");
  });
});

describe("one wrong note", () => {
  /**
   * The cascade this test exists to prevent: a semitone error reported as
   * "slot 2 missing, plus an extra note" instead of "slot 2 was a semitone
   * flat". Guaranteed impossible by `SUB_MAX_COST < 2 * GAP_COST`, swept above
   * — this checks the guarantee survives contact with the DP.
   */
  it("is one wrong slot, never a missing plus an extra", () => {
    for (const semitones of [-1, +1, -2, +3, -6, +11]) {
      const pitches = PHRASE.map((midi, i) => (i === 3 ? midi + semitones : midi));
      const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
      expect(verdicts(alignment), `${semitones} st`).toEqual([
        "clean",
        "clean",
        "clean",
        "wrong",
        "clean",
      ]);
      expect(alignment.extras, `${semitones} st`).toEqual([]);
      // ...and it says which note actually came out, in the target's register.
      expect(alignment.slots[3].heardMidi, `${semitones} st`).toBe(PHRASE[3] + semitones);
      expect(alignment.slots[3].residualCents, `${semitones} st`).toBeCloseTo(
        semitones * 100,
        6,
      );
    }
  });

  it("holds even when the whole attempt is in another register", () => {
    const shift = 19;
    const pitches = PHRASE.map((midi, i) => midi + shift + (i === 1 ? -1 : 0));
    const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
    expect(alignment.transposition).toBe(-shift);
    expect(verdicts(alignment)).toEqual(["clean", "wrong", "clean", "clean", "clean"]);
    expect(alignment.slots[1].heardMidi).toBe(PHRASE[1] - 1);
  });
});

describe("a note that was left out", () => {
  it("is exactly one missing, wherever it fell", () => {
    for (let dropped = 0; dropped < PHRASE.length; dropped++) {
      const pitches = PHRASE.filter((_, i) => i !== dropped);
      const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
      const counts = countVerdicts(alignment);
      expect(counts, `dropped ${dropped}`).toEqual({
        clean: PHRASE.length - 1,
        off: 0,
        wrong: 0,
        missing: 1,
        extra: 0,
      });
      expect(alignment.slots[dropped].verdict, `dropped ${dropped}`).toBe("missing");
      expect(alignment.slots[dropped].attemptIndex, `dropped ${dropped}`).toBeNull();
      expect(alignment.slots[dropped].residualCents, `dropped ${dropped}`).toBeNull();
    }
  });

  it("does not cascade when two notes are dropped", () => {
    const pitches = PHRASE.filter((_, i) => i !== 1 && i !== 3);
    const counts = countVerdicts(alignAttempt(whistled(pitches), melody(PHRASE)));
    expect(counts).toEqual({ clean: 3, off: 0, wrong: 0, missing: 2, extra: 0 });
  });

  it("calls a truncated attempt missing rather than wrong", () => {
    // Somebody who forgot how the phrase ends: the first three notes, right.
    const alignment = alignAttempt(whistled(PHRASE.slice(0, 3)), melody(PHRASE));
    expect(verdicts(alignment)).toEqual(["clean", "clean", "clean", "missing", "missing"]);
  });
});

describe("a note that was added", () => {
  it("is exactly one extra, positioned between the slots it fell between", () => {
    // An ornament between the third and fourth notes: far enough from both that
    // it cannot plausibly *be* either of them.
    const pitches = [...PHRASE.slice(0, 3), 71, ...PHRASE.slice(3)];
    const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
    expect(verdicts(alignment)).toEqual(["clean", "clean", "clean", "clean", "clean"]);
    expect(alignment.extras).toEqual([{ attemptIndex: 3, heardMidi: 71, afterSlot: 2 }]);
  });

  it("places an extra before the first note at slot -1", () => {
    const alignment = alignAttempt(whistled([55, ...PHRASE]), melody(PHRASE));
    expect(alignment.extras).toEqual([{ attemptIndex: 0, heardMidi: 55, afterSlot: -1 }]);
    expect(verdicts(alignment)).toEqual(["clean", "clean", "clean", "clean", "clean"]);
  });

  it("places an extra after the last note at the last slot", () => {
    const alignment = alignAttempt(whistled([...PHRASE, 55]), melody(PHRASE));
    expect(alignment.extras).toEqual([
      { attemptIndex: PHRASE.length, heardMidi: 55, afterSlot: PHRASE.length - 1 },
    ]);
  });
});

/**
 * The cases an adversarial reviewer would reach for: where the honest answer is
 * genuinely ambiguous, or where a plausible-looking aligner quietly does the
 * wrong thing.
 */
describe("adversarial", () => {
  it("splits the difference between two targets a semitone apart", () => {
    // Target C then C#, whistled as two identical notes halfway between. There
    // is no wrong note here and nothing is missing: the whistler sang one pitch
    // where two were wanted, sharp of the first and flat of the second, and
    // saying that is more useful than picking a winner.
    const alignment = alignAttempt(whistled([60.5, 60.5]), melody([60, 61]));
    expect(verdicts(alignment)).toEqual(["off", "off"]);
    expect(alignment.slots[0].residualCents).toBeCloseTo(+50, 6);
    expect(alignment.slots[1].residualCents).toBeCloseTo(-50, 6);
    expect(alignment.extras).toEqual([]);
  });

  it("keeps repeated notes one-to-one when they are all there", () => {
    const target = melody([60, 60, 60, 62]);
    const alignment = alignAttempt(whistled([60, 60, 60, 62]), target);
    expect(verdicts(alignment)).toEqual(["clean", "clean", "clean", "clean"]);
    expect(alignment.cost).toBeCloseTo(0, 12);
  });

  it("reports exactly one missing when a repeat is dropped, ambiguity and all", () => {
    // Which of three identical notes went missing is not knowable from pitch,
    // and this engine does not pretend otherwise. What it must not do is turn
    // the ambiguity into two mistakes.
    const alignment = alignAttempt(whistled([60, 60, 62]), melody([60, 60, 60, 62]));
    expect(countVerdicts(alignment)).toEqual({
      clean: 3,
      off: 0,
      wrong: 0,
      missing: 1,
      extra: 0,
    });
    // The missing one is one of the repeats, never the note that differs.
    expect(alignment.slots[3].verdict).toBe("clean");
  });

  it("uses rhythm to break a repeated-note tie", () => {
    // Four identical pitches with four distinguishable lengths. Pitch says
    // nothing at all about which note went missing; the rhythm says everything,
    // and it is the only evidence there is.
    const durations = [0.25, 0.9, 0.5, 0.25];
    const target = melody([60, 60, 60, 60], durations);
    for (const dropped of [0, 3]) {
      const kept = durations.filter((_, i) => i !== dropped);
      const alignment = alignAttempt(whistled([60, 60, 60], kept), target);
      expect(countVerdicts(alignment).missing, `dropped ${dropped}`).toBe(1);
      expect(alignment.slots[dropped].verdict, `dropped ${dropped}`).toBe("missing");
    }

    // The honest limit: two slots identical in *both* pitch and length are
    // indistinguishable, and the engine picks deterministically rather than
    // pretending to know. Slots 0 and 3 are the pair here.
    const flat = melody([60, 60, 60, 60], [0.25, 0.9, 0.5, 0.25]);
    const ambiguous = alignAttempt(whistled([60, 60, 60], [0.9, 0.5, 0.25]), flat);
    expect(countVerdicts(ambiguous).missing).toBe(1);
    expect(["0", "3"]).toContain(
      String(ambiguous.slots.findIndex((s) => s.verdict === "missing")),
    );
  });

  it("puts one note in the wrong octave without disturbing its neighbours", () => {
    // The classic beginner's crack: one note pops an octave. Reported as one
    // wrong note with a residual of exactly an octave — which is enough for a
    // view to say "right note, wrong octave" rather than "wrong note".
    for (const octave of [+12, -12]) {
      const pitches = PHRASE.map((midi, i) => (i === 2 ? midi + octave : midi));
      const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
      expect(verdicts(alignment), `${octave} st`).toEqual([
        "clean",
        "clean",
        "wrong",
        "clean",
        "clean",
      ]);
      expect(alignment.slots[2].residualCents, `${octave} st`).toBeCloseTo(octave * 100, 6);
      expect(alignment.transposition, `${octave} st`).toBe(0);
      expect(alignment.extras, `${octave} st`).toEqual([]);
    }
  });

  it("does not let one octave crack drag the whole attempt's register", () => {
    // The median centring guess is what protects this: a mean would be pulled
    // four semitones by a single octave outlier on a five-note phrase.
    const shift = 12;
    const pitches = PHRASE.map((midi, i) => midi + shift + (i === 0 ? 12 : 0));
    const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
    expect(alignment.transposition).toBe(-shift);
    expect(verdicts(alignment)).toEqual(["wrong", "clean", "clean", "clean", "clean"]);
  });

  it("still corresponds note to note when the attempt is unrelated", () => {
    // A two-note oscillation against a five-note zigzag: nothing in common.
    //
    // The cost inequality bounds how badly this can degenerate. The plain 1:1
    // alignment is always on the table at `min(n,m) × SUB_MAX`, so the DP can
    // never pay more than that — and since every gap costs 1, it can never
    // afford to answer "everything missing, everything extra", which is what a
    // gap cost chosen without reference to `SUB_MAX` produces.
    //
    // Measured: three wrong notes, one clean by coincidence, and a single gap
    // pair where a six-semitone leap was more expensive to pair than to skip.
    // The DP is allowed to re-pair — the guarantee is a bound on the damage,
    // not that gaps never appear.
    const alignment = alignAttempt(whistled([60, 61, 60, 61, 60]), melody([72, 79, 74, 81, 76]));
    const counts = countVerdicts(alignment);
    expect(alignment.cost).toBeLessThanOrEqual(5 * SUB_MAX_COST + 1e-9);
    expect(counts.missing + counts.extra).toBeLessThanOrEqual(2);
    expect(counts.clean + counts.off + counts.wrong).toBeGreaterThanOrEqual(4);
  });

  it("says nothing at all about an attempt that never happened", () => {
    const alignment = alignAttempt([], melody(PHRASE));
    expect(verdicts(alignment)).toEqual(Array(PHRASE.length).fill("missing"));
    expect(alignment.extras).toEqual([]);
    expect(alignment.cost).toBeCloseTo(PHRASE.length * GAP_COST, 12);
  });

  it("survives an empty target, and two empty sequences", () => {
    const orphans = alignAttempt(whistled([60, 62]), []);
    expect(orphans.slots).toEqual([]);
    expect(orphans.extras.map((e) => e.afterSlot)).toEqual([-1, -1]);
    expect(orphans.extras.map((e) => e.attemptIndex)).toEqual([0, 1]);

    const nothing = alignAttempt([], []);
    expect(nothing).toEqual({ transposition: 0, cost: 0, slots: [], extras: [] });
  });

  it("never lets a duration mismatch change a verdict", () => {
    // Timing must never fail a note. A note held six times too long, or a sixth
    // as long, is still the right note — and a wrong one stays wrong.
    for (const durations of [
      [0.05, 3, 0.05, 3, 0.05],
      [3, 0.05, 3, 0.05, 3],
    ]) {
      const clean = alignAttempt(whistled(PHRASE, durations), melody(PHRASE));
      expect(verdicts(clean), durations.join(",")).toEqual(Array(5).fill("clean"));

      const pitches = PHRASE.map((midi, i) => (i === 2 ? midi + 1 : midi));
      const wrong = alignAttempt(whistled(pitches, durations), melody(PHRASE));
      expect(verdicts(wrong)[2], durations.join(",")).toBe("wrong");
      expect(countVerdicts(wrong).missing, durations.join(",")).toBe(0);
    }
  });

  it("refuses to look for a register outside the window it was given", () => {
    // The search radius is a real bound, not a suggestion: with it clamped to
    // zero the aligner is stuck at its centring guess. Worth pinning, because
    // T4 may want a narrow window when the register is already known.
    const alignment = alignAttempt(whistled(PHRASE.map((m) => m + 9)), melody(PHRASE), {
      searchSemitones: 0,
    });
    expect(alignment.transposition).toBe(-9);
    const narrow = alignAttempt(whistled([60, 62, 64]), melody([60, 62, 64]), {
      searchSemitones: 0,
    });
    expect(narrow.transposition).toBe(0);
  });
});

/**
 * Seeded fuzz: 400 random melodies, each perturbed in exactly one known way, in
 * a random register. The point is coverage of shapes a hand-written case never
 * reaches — leaps next to steps, phrases that turn around, registers a fifth
 * away — with ground truth that is true by construction rather than by
 * inspection.
 */
describe("fuzz", () => {
  /** Melodies with no two consecutive notes the same, so "which note went
   *  missing" has an answer at all. */
  function randomMelody(random: () => number): number[] {
    const length = 4 + Math.floor(random() * 7);
    const notes = [60 + Math.floor(random() * 5)];
    while (notes.length < length) {
      const step = 1 + Math.floor(random() * 7);
      const next = notes[notes.length - 1] + (random() < 0.5 ? -step : step);
      notes.push(Math.max(48, Math.min(84, next)));
      // The clamp can produce a repeat; nudge it away.
      if (notes[notes.length - 1] === notes[notes.length - 2]) {
        notes[notes.length - 1] += notes[notes.length - 1] < 66 ? 2 : -2;
      }
    }
    return notes;
  }

  it("recovers the register and the verdict of every pitch perturbation", () => {
    const random = rng(0xa11a);
    const failures: string[] = [];
    for (let take = 0; take < 400; take++) {
      const target = randomMelody(random);
      const shift = Math.round((random() - 0.5) * 28);
      // The wobble every real whistle has, inside the clean band.
      const deviation = target.map(() => (random() - 0.5) * 30);

      const kind = ["clean", "off", "wrong"][Math.floor(random() * 3)];
      const slot = Math.floor(random() * target.length);
      const sign = random() < 0.5 ? -1 : 1;
      if (kind === "off") deviation[slot] = sign * (35 + random() * 30);
      if (kind === "wrong") deviation[slot] = sign * (100 + random() * 200);

      const expected = target.map(() => "clean");
      if (kind !== "clean") expected[slot] = kind;

      const alignment = alignAttempt(
        whistled(target.map((midi, i) => midi + shift + deviation[i] / 100)),
        melody(target),
      );
      const problems: string[] = [];
      if (alignment.transposition !== -shift) {
        problems.push(`register ${alignment.transposition} want ${-shift}`);
      }
      if (verdicts(alignment).join(",") !== expected.join(",")) {
        problems.push(`verdicts ${verdicts(alignment).join(",")} want ${expected.join(",")}`);
      }
      if (alignment.extras.length > 0) problems.push(`${alignment.extras.length} extras`);
      // The reported residual is the deviation that was put in, always.
      for (let i = 0; i < target.length; i++) {
        const residual = alignment.slots[i].residualCents;
        if (residual === null || Math.abs(residual - deviation[i]) > 1e-6) {
          problems.push(`residual[${i}] ${residual} want ${deviation[i]}`);
        }
      }
      if (problems.length > 0) {
        failures.push(`take ${take} (${kind} @${slot}, ${shift} st): ${problems.join("; ")}`);
      }
    }
    // Measured: 400 of 400. This half of the fuzz has no ambiguity in it — the
    // note count is unchanged, so there is exactly one sensible alignment — and
    // anything less than perfect here is a bug, not a hard case.
    expect(failures.length, failures.slice(0, 5).join(" | ")).toBe(0);
  });

  it("recovers the shape of every structural perturbation", () => {
    const random = rng(0xb0b);
    let ambiguous = 0;
    const failures: string[] = [];
    for (let take = 0; take < 400; take++) {
      const target = randomMelody(random);
      const shift = Math.round((random() - 0.5) * 28);
      const sung = target.map((midi) => midi + shift + (random() - 0.5) * 0.3);

      const drop = random() < 0.5;
      const slot = Math.floor(random() * target.length);
      let expectedCounts;
      if (drop) {
        sung.splice(slot, 1);
        expectedCounts = { clean: target.length - 1, off: 0, wrong: 0, missing: 1, extra: 0 };
      } else {
        // An ornament, kept at least 1.5 semitones from both neighbours so that
        // "which note was the extra one" is not itself a coin flip.
        const low = sung[slot] - 1.5;
        const high = sung[slot] + 1.5;
        const before = slot > 0 ? sung[slot - 1] : sung[slot];
        let ornament = random() < 0.5 ? low : high;
        if (Math.abs(ornament - before) < 1.5) ornament = 2 * sung[slot] - ornament;
        sung.splice(slot, 0, ornament);
        expectedCounts = { clean: target.length, off: 0, wrong: 0, missing: 0, extra: 1 };
      }

      const alignment = alignAttempt(whistled(sung), melody(target));
      const counts = countVerdicts(alignment);
      if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) {
        failures.push(
          `take ${take} (${drop ? "drop" : "add"} @${slot}): ${JSON.stringify(counts)} ` +
            `want ${JSON.stringify(expectedCounts)}`,
        );
        continue;
      }
      // Where the gap landed is only knowable when the melody is not
      // self-similar around it; count the disagreements rather than assert.
      const reported = drop
        ? alignment.slots.findIndex((s) => s.verdict === "missing")
        : alignment.extras[0].afterSlot + 1;
      if (reported !== slot) ambiguous++;
    }
    // Measured: 400 of 400 recover the right *shape* — one missing or one
    // extra, never a cascade — and 400 of 400 also put it in the right place.
    // The position is the part that genuinely can be ambiguous (a melody that
    // repeats a figure gives the DP two equally good answers), so it is
    // reported as a budget rather than asserted exactly.
    expect(failures.length, failures.slice(0, 5).join(" | ")).toBe(0);
    expect(ambiguous, "gap placed at an equally-plausible slot").toBeLessThanOrEqual(4);
  });
});
