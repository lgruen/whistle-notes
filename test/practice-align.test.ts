import { describe, expect, it } from "vitest";
import {
  CLEAN_CENTS,
  DURATION_TIEBREAK_COST,
  GAP_COST,
  OFF_CENTS,
  SUB_MAX_COST,
  TRANSPOSE_PRIOR_MAX,
  alignAttempt,
  countVerdicts,
  substitutionCost,
  transpositionPrior,
  verdictForCents,
  type Alignment,
  type AttemptNote,
  type TargetNote,
} from "../src/practice/align.js";
import { BUNDLED_MELODIES } from "../src/practice/bundled.js";

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

  /**
   * The anti-cascade inequality has two more terms in it now. Both the register
   * prior and the duration tie-break ride on the *diagonal*, so a pairing's
   * worst case is all three together — and that has to stay under two gaps or
   * the guarantee above becomes a suggestion.
   */
  it("leaves the anti-cascade inequality room for both tie-breakers", () => {
    for (let semitones = 0; semitones <= 30; semitones += 0.25) {
      expect(
        substitutionCost(semitones) + TRANSPOSE_PRIOR_MAX + DURATION_TIEBREAK_COST,
        `${semitones} st`,
      ).toBeLessThan(2 * GAP_COST);
    }
  });

  it("charges nothing for the register the melody played in, and saturates at an octave", () => {
    expect(transpositionPrior(0)).toBe(0);
    expect(transpositionPrior(12)).toBeCloseTo(TRANSPOSE_PRIOR_MAX, 12);
    expect(transpositionPrior(-12)).toBeCloseTo(TRANSPOSE_PRIOR_MAX, 12);
    // Past an octave it stops growing, for the same reason `substitutionCost`
    // stops at a whole tone — and because an unbounded prior would eventually
    // eat the anti-cascade headroom swept above.
    expect(transpositionPrior(26)).toBeCloseTo(TRANSPOSE_PRIOR_MAX, 12);
    for (let semitones = 0; semitones < 12; semitones++) {
      expect(transpositionPrior(semitones + 1)).toBeGreaterThan(transpositionPrior(semitones));
    }
    // A tie-breaker, not a wall: one note's worth of it is far below one gap.
    expect(TRANSPOSE_PRIOR_MAX).toBeLessThan(GAP_COST);
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
    // Residuals are reported around the attempt's own reference, and a wobble
    // this size has a centre of its own — a few cents, here. So the deviation
    // that went in is what comes back *plus* the reference: the two numbers
    // together are the measurement, and neither is complete alone.
    expect(Math.abs(alignment.offsetCents)).toBeLessThan(10);
    for (let i = 0; i < wobble.length; i++) {
      expect(alignment.slots[i].residualCents! + alignment.offsetCents).toBeCloseTo(wobble[i], 6);
    }
  });

  it("scores a whistler who runs sharp throughout against their own reference", () => {
    // The decision this file's `offsetCents` exists for: 45 cents sharp on
    // every note is one fact about the whistle, not five wrong notes — and the
    // hold drill is where the absolute aim gets reported.
    for (const bias of [-45, -20, 20, 45]) {
      const alignment = alignAttempt(
        whistled(PHRASE.map((midi) => midi + bias / 100)),
        melody(PHRASE),
      );
      expect(alignment.offsetCents, `${bias}c`).toBeCloseTo(bias, 6);
      expect(verdicts(alignment), `${bias}c`).toEqual(Array(5).fill("clean"));
      for (const slot of alignment.slots) {
        expect(slot.residualCents, `${bias}c`).toBeCloseTo(0, 6);
      }
    }
  });

  it("moves its reference smoothly, with no threshold to fall off", () => {
    // The failure this replaced was a *cliff*: the DSP's tuning correction is
    // gated on concentration, so a whistler whose jitter grew by ten cents went
    // from seven clean notes to two clean, five off and one wrong. Nothing here
    // may step: a cent more scatter is a cent less reference.
    const jitter = (i: number, spread: number): number => spread * Math.sin(i * 2.399963);
    const reference = (spread: number): number =>
      alignAttempt(
        whistled(PHRASE.map((midi, i) => midi + (45 + jitter(i, spread)) / 100)),
        melody(PHRASE),
      ).offsetCents;

    let previous = reference(0);
    expect(previous).toBeCloseTo(45, 6);
    for (const spread of [5, 10, 15, 20, 25, 30, 35, 40]) {
      const offset = reference(spread);
      // Never by more than a few cents per five of scatter — a gate would show
      // up here as a double-digit step between two neighbours — and never all
      // the way off, which is what the gated correction did at ±30.
      expect(Math.abs(previous - offset), `spread ${spread}`).toBeLessThan(8);
      expect(offset, `spread ${spread}`).toBeGreaterThan(20);
      previous = offset;
    }
  });

  it("gives one note no reference of its own", () => {
    // Otherwise a single-note attempt is dead on by construction, which is a
    // tautology rather than a measurement.
    const alignment = alignAttempt(whistled([60.4]), melody([60]));
    expect(alignment.offsetCents).toBe(0);
    expect(alignment.slots[0].residualCents).toBeCloseTo(40, 6);
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
      // Around the attempt's own reference — one note off pitch pulls that by a
      // couple of cents on a five-note phrase, and the taper is what keeps it to
      // a couple rather than a fifth of the error.
      expect(alignment.slots[2].residualCents! + alignment.offsetCents, `${cents}c`).toBeCloseTo(
        cents,
        6,
      );
      expect(Math.abs(alignment.offsetCents), `${cents}c`).toBeLessThan(5);
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

    // ...and the same boundaries survive the trip through the aligner, where
    // they are measured around the attempt's own reference. One note out of
    // five moves that by a couple of cents, so the margin here is five rather
    // than one; `at` reads the boundary back off the alignment to stay honest
    // about which quantity is being tested.
    const at = (cents: number): string => {
      const pitches = PHRASE.map((midi, i) => (i === 1 ? midi + cents / 100 : midi));
      const alignment = alignAttempt(whistled(pitches), melody(PHRASE));
      return alignment.slots[1].verdict;
    };
    const around = (cents: number): number => {
      const pitches = PHRASE.map((midi, i) => (i === 1 ? midi + cents / 100 : midi));
      return alignAttempt(whistled(pitches), melody(PHRASE)).offsetCents;
    };
    expect(Math.abs(around(CLEAN_CENTS))).toBeLessThan(5);
    expect(at(CLEAN_CENTS - 5)).toBe("clean");
    expect(at(CLEAN_CENTS + 5)).toBe("off");
    expect(at(OFF_CENTS - 5)).toBe("off");
    expect(at(OFF_CENTS + 5)).toBe("wrong");
    expect(at(-OFF_CENTS - 5)).toBe("wrong");

    // Exactly *on* a boundary, through the aligner, the answer is whichever way
    // IEEE-754 rounded `(midi + cents/100 + transposition - targetMidi) * 100`
    // — building 30 cents that way lands about 3e-13 short of it. So the
    // assertion here is the honest one: the boundary separates two verdicts, a
    // cent either side is decisive (above), and nothing is allowed to depend on
    // which side an exact boundary value falls. The pure function is where the
    // rule itself is pinned.
    // Two notes deviated by exactly opposite amounts, so the attempt's own
    // reference is zero by symmetry and the residual reaching `verdictForCents`
    // is the injected one — to within the float error this is about.
    const onBoundary = (cents: number): string => {
      const alignment = alignAttempt(
        whistled([60 + cents / 100, 67 - cents / 100]),
        melody([60, 67]),
      );
      expect(alignment.offsetCents).toBeCloseTo(0, 9);
      return alignment.slots[0].verdict;
    };
    expect(["clean", "off"]).toContain(onBoundary(CLEAN_CENTS));
    expect(["clean", "off"]).toContain(onBoundary(-CLEAN_CENTS));
    expect(["off", "wrong"]).toContain(onBoundary(OFF_CENTS));
    expect(["off", "wrong"]).toContain(onBoundary(-OFF_CENTS));
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
    expect(nothing).toEqual({
      transposition: 0,
      offsetCents: 0,
      cost: 0,
      slots: [],
      extras: [],
    });
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
 * The register prior, which is the difference between a diagnosis and its exact
 * opposite.
 *
 * A cracked octave and a chosen register look identical to a symmetric cost
 * function: half the notes fit here, half fit there, and whichever half the
 * search reached first became the reference. Every case below has an
 * unambiguous truth — the app played the melody at a pitch it chose — and the
 * failure mode is not "slightly worse feedback", it is telling a beginner the
 * notes they got right were the wrong ones.
 */
describe("the register the melody played in", () => {
  /** `count` notes from `from` cracked an octave up; everything else exact. */
  function cracked(
    target: readonly TargetNote[],
    from: number,
    count: number,
  ): AttemptNote[] {
    return target.map((note, i) => ({
      midi: note.midi + (i >= from && i < from + count ? 12 : 0),
      centsOffset: 0,
      durationSec: note.durSec,
    }));
  }

  it("marks the cracked half wrong, not the half that was right", () => {
    // Four notes, the first two an octave up. Evenly split, so the cost is
    // identical in both registers and only the prior can tell them apart.
    const target = melody([84, 87, 85, 88]);
    const first = alignAttempt(cracked(target, 0, 2), target);
    expect(first.transposition).toBe(0);
    expect(verdicts(first)).toEqual(["wrong", "wrong", "clean", "clean"]);

    const second = alignAttempt(cracked(target, 2, 2), target);
    expect(second.transposition).toBe(0);
    expect(verdicts(second)).toEqual(["clean", "clean", "wrong", "wrong"]);
  });

  it("holds when the crack is the majority of the melody", () => {
    // Für Elise, last five of nine cracked. Cost alone prefers the crack — it
    // is four wrong notes there against five here — and the app would report
    // the four notes that were *right* as an octave low.
    const target = BUNDLED_MELODIES[4].notes;
    const alignment = alignAttempt(cracked(target, 4, 5), target);
    expect(alignment.transposition).toBe(0);
    expect(verdicts(alignment)).toEqual([
      "clean",
      "clean",
      "clean",
      "clean",
      "wrong",
      "wrong",
      "wrong",
      "wrong",
      "wrong",
    ]);
  });

  it("never invents a register from a contiguous crack, over every bundled melody", () => {
    // The sweep the adversarial review ran: every melody, every run length up
    // to just over half of it, at every position — 365 attempts whose truth is
    // "in the register that played, with k cracked notes". 40 of them used to
    // report a register the user was never in.
    const wrong: string[] = [];
    let cases = 0;
    for (const bundled of BUNDLED_MELODIES) {
      const target = bundled.notes;
      for (let count = 1; count <= Math.floor(target.length / 2) + 1; count++) {
        for (let from = 0; from + count <= target.length; from++) {
          const alignment = alignAttempt(cracked(target, from, count), target);
          cases++;
          if (alignment.transposition !== 0) {
            wrong.push(`${bundled.id} ${from}..${from + count - 1}: T=${alignment.transposition}`);
          }
        }
      }
    }
    expect(cases).toBe(365);
    expect(wrong.length, wrong.slice(0, 5).join(" | ")).toBe(0);
  });

  it("still forgives a whole melody echoed in another register", () => {
    // The prior is a tie-breaker, not a wall. A melody genuinely sung an octave
    // or a fifth up — flubs and all — is still one register error and not
    // twelve wrong notes.
    const target = melody(PHRASE);
    for (const shift of [12, -12, 7, -7]) {
      const clean = alignAttempt(whistled(PHRASE.map((midi) => midi + shift)), target);
      expect(clean.transposition, `${shift} st`).toBe(-shift);

      // ...and with a third of it flubbed by a semitone, which is what a real
      // echo of a phrase in a new register looks like.
      const flubbed = PHRASE.map((midi, i) => midi + shift + (i === 1 || i === 4 ? 1 : 0));
      const messy = alignAttempt(whistled(flubbed), target);
      expect(messy.transposition, `${shift} st, flubbed`).toBe(-shift);
      expect(countVerdicts(messy).wrong, `${shift} st, flubbed`).toBe(2);
    }
  });

  it("reads a short attempt as the melody's opening, in the register that played", () => {
    // Somebody who gets three notes in and stops. Without a preference for the
    // front, `k` notes against `m` slots tie across every placement, and the
    // aligner used to scatter them mid-melody with a transposition invented to
    // make them fit.
    for (const target of [melody([60, 62, 64, 65, 67, 69, 71, 72]), BUNDLED_MELODIES[0].notes]) {
      for (let kept = 1; kept <= 6; kept++) {
        const attempt = target.slice(0, kept).map((note) => ({
          midi: note.midi,
          centsOffset: 0,
          durationSec: note.durSec,
        }));
        const alignment = alignAttempt(attempt, target);
        const label = `${target.length} slots, first ${kept}`;
        expect(alignment.transposition, label).toBe(0);
        expect(
          alignment.slots.map((slot) => slot.attemptIndex),
          label,
        ).toEqual(target.map((_, i) => (i < kept ? i : null)));
      }
    }
  });

  it("puts one answered note at the slot it answers, not one that ties", () => {
    // A single note against three: the pitch says which slot, and where the
    // pitch says nothing the opening wins.
    const target = melody([60, 62, 64]);
    expect(verdicts(alignAttempt(whistled([60]), target))).toEqual([
      "clean",
      "missing",
      "missing",
    ]);
    expect(alignAttempt(whistled([60]), target).transposition).toBe(0);
    expect(verdicts(alignAttempt(whistled([62]), target))).toEqual([
      "missing",
      "clean",
      "missing",
    ]);
  });
});

describe("rhythm as the tie-breaker of last resort", () => {
  const sameNote = (durations: readonly number[]): AttemptNote[] =>
    durations.map((durationSec) => ({ midi: 60, centsOffset: 0, durationSec }));
  const beats = (durations: readonly number[]): TargetNote[] =>
    durations.map((durSec) => ({ midi: 60, durSec }));

  /**
   * Every drop of every pattern, checked against the *duration* of the slot
   * that was actually dropped rather than its index — two slots of the same
   * length are genuinely indistinguishable and the engine is not asked to
   * guess between them.
   *
   * Normalising each side by its own median used to misattribute 8 of these 35,
   * because the two medians are taken over different lists the moment a note is
   * missing. Both sides now ride on one tempo estimate.
   */
  it("names a slot of the right length, whichever repeat went missing", () => {
    const patterns = [
      [1.0, 0.25, 0.25],
      [0.25, 0.25, 1.0],
      [1.0, 1.0, 0.25],
      [0.25, 0.9, 0.5, 0.25],
      [1.0, 0.5, 0.25, 0.25],
      [0.5, 0.5, 0.5, 2.0],
      [2.0, 0.5, 0.5, 0.5],
      [1.0, 0.25, 0.25, 0.25, 0.25],
      [0.25, 0.25, 0.25, 0.25, 1.0],
    ];
    const wrong: string[] = [];
    let cases = 0;
    for (const pattern of patterns) {
      for (let dropped = 0; dropped < pattern.length; dropped++) {
        const alignment = alignAttempt(
          sameNote(pattern.filter((_, i) => i !== dropped)),
          beats(pattern),
        );
        const reported = alignment.slots.findIndex((slot) => slot.verdict === "missing");
        cases++;
        if (countVerdicts(alignment).missing !== 1 || pattern[reported] !== pattern[dropped]) {
          wrong.push(`${JSON.stringify(pattern)} drop ${dropped} -> ${reported}`);
        }
      }
    }
    expect(cases).toBe(35);
    expect(wrong.length, wrong.join(" | ")).toBe(0);
  });

  it("says the same thing however fast the echo was", () => {
    // The tempo invariance the common scale has to keep: the same shape, three
    // times as slow, is the same answer.
    for (const scale of [0.5, 1, 2, 3]) {
      const alignment = alignAttempt(
        sameNote([1.0 * scale, 0.25 * scale]),
        beats([1.0, 0.25, 0.25]),
      );
      const reported = alignment.slots.findIndex((slot) => slot.verdict === "missing");
      expect([1, 2], `scale ${scale}`).toContain(reported);
    }
  });

  /**
   * A budget, not just a per-pair bound. At 0.02 a pair, a hundred and twenty
   * pairs of mismatched durations were worth more than the two gaps it takes to
   * slide the whole melody by one slot — so the tie-breaker bought itself a
   * missing note and an extra one, which is precisely the cascade the cost
   * design forbids. Recorded targets have no length limit of their own.
   */
  it("cannot buy a gap by accumulating over a long melody", () => {
    for (const length of [64, 120, 200]) {
      const target: TargetNote[] = Array.from({ length }, (_, i) => ({
        midi: 60,
        durSec: i % 2 === 0 ? 0.2 : 1.2,
      }));
      // The same pitches, with the durations shifted by one, so every diagonal
      // pairing pays the full tie-break.
      const attempt: AttemptNote[] = Array.from({ length }, (_, i) => ({
        midi: 60,
        centsOffset: 0,
        durationSec: i % 2 === 0 ? 1.2 : 0.2,
      }));
      const counts = countVerdicts(alignAttempt(attempt, target));
      expect(counts, `n=${length}`).toEqual({
        clean: length,
        off: 0,
        wrong: 0,
        missing: 0,
        extra: 0,
      });
    }
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
    /** Perturbations that were still their injected kind after the attempt's
     *  own reference came off them. */
    let survived = 0;
    let perturbed = 0;
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
      if (kind !== "clean") perturbed++;

      const alignment = alignAttempt(
        whistled(target.map((midi, i) => midi + shift + deviation[i] / 100)),
        melody(target),
      );
      // Residuals — and therefore verdicts — are measured around the attempt's
      // own reference, so the ground truth is the deviation that went in *minus*
      // the reference that came back. Two things are asserted rather than one:
      // that the reference cannot run away on a wobbly attempt, and that the
      // residual is exactly the injected deviation once it is taken off.
      const reference = alignment.offsetCents;
      const expected = target.map((_, i) => verdictForCents(deviation[i] - reference));
      if (kind !== "clean" && expected[slot] === kind) survived++;

      const problems: string[] = [];
      if (alignment.transposition !== -shift) {
        problems.push(`register ${alignment.transposition} want ${-shift}`);
      }
      // The wobble injected below is ±15 cents and an off note pulls a little
      // further, so this is the bound on an honest reference — not on a
      // runaway one.
      if (Math.abs(reference) > 25) problems.push(`reference ${reference}`);
      if (verdicts(alignment).join(",") !== expected.join(",")) {
        problems.push(`verdicts ${verdicts(alignment).join(",")} want ${expected.join(",")}`);
      }
      if (alignment.extras.length > 0) problems.push(`${alignment.extras.length} extras`);
      for (let i = 0; i < target.length; i++) {
        const residual = alignment.slots[i].residualCents;
        if (residual === null || Math.abs(residual + reference - deviation[i]) > 1e-6) {
          problems.push(`residual[${i}] ${residual} want ${deviation[i] - reference}`);
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
    // The injected perturbation is measured around the attempt's own reference
    // like everything else, so one that was thrown in a couple of cents past a
    // boundary can legitimately come back on the other side of it. Measured:
    // 262 of 266 survive, and a budget is the honest way to say that.
    expect(survived / perturbed).toBeGreaterThan(0.97);
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
