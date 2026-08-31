/**
 * The diagnosis engine: what actually happened when someone whistled a melody
 * back at us.
 *
 * Practice mode is ear-first — the app plays, the user echoes — so the only
 * thing it ever has to work with is two note sequences that are *supposed* to
 * be the same melody and usually are not, in one of five interesting ways: a
 * note held a little flat, a note that was simply the wrong note, a note left
 * out, a note added, or the whole thing whistled in a completely different
 * register. Telling those apart is the entire feature. "You got 7 of 10" is
 * worthless feedback; "the third note was 45 cents flat and the fifth was a
 * semitone low, every time you have tried it" is a practice plan.
 *
 * Pure TypeScript, no DOM, no storage, no `src/dsp` import — the attempt's note
 * shape is structurally what `Note` already is, so `alignAttempt(result.notes,
 * target.notes)` type-checks with no adapter while this module stays testable
 * as arithmetic.
 *
 * ## Why alignment, and why transposition-invariant
 *
 * A whistle sits one to two octaves above where melodies are written, and
 * nobody echoes a phrase in the key it was played in — a beginner reproduces
 * the *shape*, in whatever register their mouth is comfortable in that minute.
 * Comparing absolute pitches would therefore mark every single note wrong on an
 * otherwise perfect attempt. So the whole attempt is shifted by one integer
 * number of semitones, chosen to make it fit best, and everything downstream is
 * measured relative to that choice. A melody echoed a fourth too high with one
 * bad note comes back as one bad note, which is the truth.
 *
 * Alignment (rather than zipping the two lists together) exists for the same
 * reason: a single dropped note shifts every later note by one slot, and a
 * position-by-position comparison would report ten failures where there was
 * one. Needleman–Wunsch with insert/delete/substitute is the standard answer
 * and it is a dozen lines.
 *
 * ## The cost design (this is the load-bearing part)
 *
 * Three constants decide everything, and the relationships between them matter
 * far more than the values:
 *
 * - {@link GAP_COST} = 1 — leaving a target slot unsung (`missing`), or singing
 *   a note that answers to no slot (`extra`).
 * - {@link SUB_MAX_COST} = 1.5 — the *most* a substitution can ever cost,
 *   however far apart the two pitches are.
 * - The free radius, 30 cents, inside which a substitution costs nothing at
 *   all: that is the same boundary as the `clean` verdict, so an ordinary
 *   wobbly-but-right attempt has literally zero cost and aligns 1:1 by
 *   construction.
 *
 * **`SUB_MAX_COST < 2 × GAP_COST` is the anti-cascade guarantee.** Pairing two
 * notes always costs less than throwing both away (`missing` + `extra` = 2),
 * whatever they are — an octave apart, a tritone apart, anything. So the
 * aligner can never answer "you missed a note *and* added one" where the honest
 * answer is "you sang one wrong note". That failure is the one that makes a
 * diff view useless, because it turns one mistake into two and pushes the
 * error's location off by a slot. The inequality is a theorem here, not a hope,
 * and `test/practice-align.test.ts` sweeps it directly.
 *
 * The same inequality has a second consequence worth knowing: a *garbage*
 * attempt still aligns note-to-note rather than collapsing into "everything
 * missing, everything extra", because n substitutions at ≤1.5 always beat 2n
 * gaps at 1. The verdicts then say `wrong` n times, which is what actually
 * happened.
 *
 * Saturation at two semitones is what makes that bound reachable: past a whole
 * tone, "wrong note" is already the whole story and how wrong stops carrying
 * information the aligner can use. It is also what makes the one-note-in-the-
 * wrong-octave case come out as a single `wrong` slot with a +1200 cent
 * residual instead of a missing/extra pair.
 *
 * Going the other way, `GAP_COST` has to be small enough that a genuinely
 * dropped note is cheaper to admit (1) than to paper over by shifting every
 * later note onto the wrong slot (roughly 0.6 per slot for a melody in
 * whole-tone steps, so any two remaining slots already outvote it). One gap,
 * not a cascade, in both directions.
 *
 * ## The two priors: the app already chose the register
 *
 * Cost alone leaves the transposition search *symmetric*, and symmetry is
 * wrong here. The melody was played at a pitch the app itself picked
 * (`range.ts` moves every target into the whistler's register before it
 * sounds), so "the register it played in" is not one hypothesis among
 * twenty-nine — it is the null hypothesis, and every other one is a claim that
 * the user moved.
 *
 * Without a prior the aligner reads a beginner's most ordinary failure exactly
 * backwards. Whistle six notes, crack the first three an octave: at `T = 0`
 * three notes are wrong, at `T = −12` the *other* three are, the two cost the
 * same, and the tie went to whichever the sweep happened to reach first. The
 * verdicts then come out inverted — the half that was right is marked wrong —
 * and the interval ledger learns the inverse of what happened.
 *
 * So two small, strictly-bounded terms:
 *
 * - {@link transpositionPrior} — a per-pairing surcharge on moving off the
 *   played register, rising with the distance and saturating at an octave
 *   ({@link TRANSPOSE_PRIOR_MAX} = 0.25). Per *pairing* rather than per
 *   attempt, because that is the shape of the evidence: every note that fits
 *   better in another register is one more vote for it, so a whole melody
 *   echoed an octave up still wins its register by 6:1 while a bare majority
 *   of cracked notes does not. The bound keeps the anti-cascade inequality
 *   intact — `SUB_MAX_COST + TRANSPOSE_PRIOR_MAX + DURATION_TIEBREAK_COST` is
 *   1.77, still under `2 × GAP_COST`.
 *
 *   Where it lands, exactly: with `p` per note at an octave, a bimodal attempt
 *   is read as an octave echo once the fraction sitting an octave away passes
 *   `(SUB_MAX_COST + p) / (2 × SUB_MAX_COST)` ≈ 58%. Under that it is a crack
 *   in the register that played; over it, a register the user chose and then
 *   flubbed. Something has to be the line, and this one is a statement rather
 *   than an accident of iteration order.
 *
 * - {@link EARLY_GAP_COST} — a sliver added to every unsung slot *except* the
 *   ones after the last note whistled. An attempt that stops half way through
 *   leaves its gaps at the **end**; almost nobody skips the opening and then
 *   sings the rest. Without it, three notes offered to a thirteen-note melody
 *   with repeated pitches tie across a dozen placements and land somewhere in
 *   the middle, with a fictitious transposition to go with them. It is tiny
 *   (0.001 per skipped slot, at most 0.06 across a 64-note melody) because it
 *   only ever has to break a tie: real duration evidence about *which* repeat
 *   went missing is an order of magnitude larger and still wins.
 *
 * ## Rhythm
 *
 * Timing never fails a note — verdicts come from pitch alone. Duration enters
 * only as a tie-breaker worth at most {@link DURATION_TIEBREAK_COST} = 0.02 per
 * pair, three orders below the pitch costs. What it buys is the genuinely
 * ambiguous case: three identical repeated notes with one of them dropped is a
 * tie on pitch, and rhythm is the only evidence left about *which* one went
 * missing.
 *
 * Two things have to be true of it, and neither is free:
 *
 * 1. **One tempo, not two.** Both sides are put on the *same* scale — see
 *    {@link tempoScale} — rather than each being normalised by its own median.
 *    Normalising separately means the same physical note reads as 4.0 on one
 *    side and 1.6 on the other the moment a note is missing, because the two
 *    medians are taken over different lists; the tie-break then points at the
 *    wrong slot in about a quarter of the drops it is supposed to explain. A
 *    common scale keeps the tempo invariance (a slow echo of a fast phrase
 *    still costs nothing) and makes the comparison mean what it says.
 * 2. **A total budget, not just a per-pair one.** 0.02 per pair is negligible
 *    against 2 × GAP_COST until there are a hundred pairs, at which point the
 *    accumulated 2.4 is worth more than opening a missing/extra pair and
 *    sliding the whole melody by one slot — which is exactly the cascade the
 *    cost design exists to forbid. So the per-pair cost is scaled down past
 *    {@link DURATION_TIEBREAK_PAIRS} notes, holding the total under 1.28
 *    however long the melody is.
 *
 * ## The whistler's own reference (and why the DSP's correction is undone)
 *
 * **Decision, 2026-09-01.** The aligner is fed the *uncorrected* pitches — the
 * caller undoes the segmenter's global tuning correction with
 * {@link undoTuningCorrection} first — and estimates its own continuous
 * {@link Alignment.offsetCents} over the pairs it made. Verdicts, residuals and
 * everything the ledger learns are measured around that reference.
 *
 * Two things went wrong when recall consumed the corrected notes instead.
 *
 * *It could not see the thing it was measuring.* `src/dsp` takes each take's
 * global tuning bias out before rounding to note names, which is what rescues a
 * consistently-sharp whistler from coin-flip note names. Handed the result, the
 * aligner sees residuals near zero for somebody who is 45 cents sharp on every
 * note, and reports a flawless attempt. The hold drill deliberately bypasses
 * that correction for exactly this reason (`scoreHold`'s docblock carries the
 * argument), and the two exercises then said different things about one
 * whistle.
 *
 * *And it was a cliff.* The DSP's correction is gated on a concentration
 * threshold, and below it switches off outright. So a whistler 45 cents sharp
 * with ±20 cents of jitter scored seven notes clean, and the same whistler at
 * ±30 scored two clean, five off and one wrong, with 48-cent residuals. Nothing
 * about the whistling changed by a factor of six; a threshold was crossed.
 *
 * So: no gate, no cliff. {@link referenceOffset} is the mean of the paired
 * residuals, weighted by a taper that runs from 1 at dead-on to 0 at
 * {@link OFF_CENTS}. The taper is the continuous form of the rule `stats.ts`
 * already states in words — *a wrong note's residual is not about aim* — and it
 * is what keeps the estimate honest in both directions: a note an octave out,
 * or a semitone out, weighs nothing rather than dragging the reference a
 * twelfth of the way to itself, and a note that drifts across the boundary
 * changes the answer by nothing at all, because its weight is already zero when
 * it gets there. A whistler consistently sharp comes through whole; a scattered
 * one is pulled gently back towards the register that played, which is the
 * right direction to be wrong in.
 *
 * The division of labour that falls out of it: **recall scores shape, and the
 * deviation around the whistler's own reference; the hold drill scores absolute
 * aim.** That split is the honest one — a single held note has no shape to be
 * scored, and a melody's worth of notes is what turns "you ran forty cents
 * sharp" from one reading into a fact — and both exercises put the number into
 * words through the same `distanceText`.
 */

/** One note as whistled. Structurally a subset of `src/dsp`'s `Note`. */
export interface AttemptNote {
  midi: number;
  /** Measured cents relative to `midi`, in [-50, +50). Used rather than
   *  discarded: rounding an attempt to semitones before measuring how far off
   *  it was would throw away exactly the number this engine reports. */
  centsOffset: number;
  durationSec: number;
}

/** One slot of a target melody. The practice target model builds on this. */
export interface TargetNote {
  midi: number;
  durSec: number;
}

/**
 * What happened at one target slot.
 *
 * - `clean` — sung, within {@link CLEAN_CENTS} of the target.
 * - `off` — sung, recognisably the right note, between {@link CLEAN_CENTS} and
 *   {@link OFF_CENTS} away. A production problem: the note was known and the
 *   mouth missed it.
 * - `wrong` — sung, but {@link OFF_CENTS} or further away. A different note
 *   came out; which one is reported in `heardMidi`.
 * - `missing` — the slot was never sung at all.
 */
export type Verdict = "clean" | "off" | "wrong" | "missing";

export interface SlotResult {
  /** Index into the target. */
  slot: number;
  /** The target's own MIDI number, untransposed. */
  targetMidi: number;
  verdict: Verdict;
  /** Index into the attempt, or `null` for `missing`. */
  attemptIndex: number | null;
  /**
   * The note that actually came out, expressed in the target's register (i.e.
   * with the chosen transposition already applied), or `null` for `missing`.
   * For a `wrong` verdict this is the answer to "so what did I sing instead?".
   *
   * It is the *nearest* semitone to what was produced, so an `off` slot more
   * than 50 cents out names the neighbour rather than the target — which is
   * exactly the situation the `off` verdict describes and `verdict`, not this
   * field, is what says which note was being aimed at.
   */
  heardMidi: number | null;
  /**
   * Signed cents from the target: positive is sharp. `null` for `missing`.
   *
   * Not clamped, and deliberately so — an attempt that was the right note in
   * the wrong octave lands here as ±1200, which is a distinguishable and
   * useful thing for a view to say out loud.
   */
  residualCents: number | null;
}

/** A whistled note that answers to no target slot. */
export interface ExtraNote {
  attemptIndex: number;
  /** As produced, in the target's register. */
  heardMidi: number;
  /** The last target slot before this note; `-1` when it came before the
   *  first. An extra always sits *between* slots, which is where a view has to
   *  draw it. */
  afterSlot: number;
}

export interface Alignment {
  /** Semitones added to every attempt note to make it line up with the target;
   *  the register the attempt was whistled in, relative to the target's. */
  transposition: number;
  /**
   * The whistler's own reference for this attempt, in cents: positive means
   * they ran sharp of what played, all the way through.
   *
   * Subtracted from every pitch before the verdicts are decided, so `clean`
   * means "the right note relative to where this person was singing" rather
   * than "the right note relative to A = 440". `0` when there is nothing to
   * measure it from. See the reference note in the module docblock for why this
   * exists and why it is continuous.
   */
  offsetCents: number;
  /**
   * Total alignment cost at that transposition — and **around
   * {@link offsetCents}**, not around A = 440.
   *
   * The final pass is run with the reference already applied (see the second
   * `fill` in {@link alignAttempt}), so every distance this sums up is measured
   * from where the whistler was actually singing. What that makes it is a
   * measure of **shape alone**: an attempt a uniform 45 cents sharp scores ~0,
   * exactly as a dead-on one does, because taking the reference out is the
   * whole point of having one.
   *
   * So nothing may read this as "how in tune was it" — it cannot answer that,
   * and it will answer *well* for a take that was consistently half a semitone
   * off. Tuning is `offsetCents`, and only `offsetCents`.
   *
   * Comparable across attempts at the same target, meaningless across different
   * targets.
   */
  cost: number;
  /** One entry per target slot, in order. */
  slots: SlotResult[];
  extras: ExtraNote[];
}

export interface AlignOptions {
  /**
   * Half-width of the transposition search, in semitones, around the median
   * difference between the two sequences. The default covers a register
   * mismatch of well over an octave in either direction on top of a centring
   * guess that is already right whenever the attempt resembles the target at
   * all; widening it costs one DP pass per extra semitone and buys nothing but
   * the chance of an absurd "you were nineteen semitones flat" answer.
   */
  searchSemitones?: number;
}

/** Below this, a note is the note. Also the free radius of the cost function. */
export const CLEAN_CENTS = 30;
/** At or beyond this, it is a different note. */
export const OFF_CENTS = 70;

/** Cost of one unsung slot, or one unaccounted-for note. */
export const GAP_COST = 1;
/** Ceiling on the cost of pairing two notes, however far apart. Strictly below
 *  `2 * GAP_COST` — see the anti-cascade note in the module docblock. */
export const SUB_MAX_COST = 1.5;
/** Most a duration mismatch can add to one pairing. */
export const DURATION_TIEBREAK_COST = 0.02;

/**
 * Most the register prior can add to one pairing, reached at an octave.
 *
 * Small enough that `SUB_MAX_COST + TRANSPOSE_PRIOR_MAX + DURATION_TIEBREAK_COST
 * < 2 * GAP_COST` still holds — the anti-cascade guarantee is not negotiable —
 * and large enough that a bare majority of octave-cracked notes cannot make the
 * crack the reference. See the prior note in the module docblock for where
 * those two bounds put it.
 */
export const TRANSPOSE_PRIOR_MAX = 0.25;
/** Distance at which the register prior saturates. Past an octave, "a different
 *  register" is already the whole story, exactly as past a whole tone "a
 *  different note" is. */
const TRANSPOSE_PRIOR_SEMITONES = 12;

/** Added to a slot skipped while the attempt still had notes to come — see the
 *  prior note in the module docblock. A tie-breaker, three orders below
 *  `GAP_COST`, so an unfinished attempt leaves its gaps at the end. */
export const EARLY_GAP_COST = 0.001;

/** Pairs past which the duration tie-break is scaled down, so its total stays
 *  bounded however long the melody is. 64 is `MAX_MELODY_NOTES`: the longest a
 *  target is allowed to be, and therefore the length at which the tie-break is
 *  still worth its full 0.02. */
const DURATION_TIEBREAK_PAIRS = 64;

/**
 * Paired slots needed before the attempt is allowed a reference of its own.
 *
 * Two, because one note is a pitch rather than a reference: taking a single
 * note's own residual as the reference would report every one-note attempt as
 * dead on, which is a tautology and not a measurement.
 */
const MIN_REFERENCE_NOTES = 2;

/**
 * Backstop on {@link referenceOffset}.
 *
 * A whistler more than half a semitone out is absorbed by the *transposition*
 * instead — the search would rather move a semitone than pay for every note
 * being 60 cents away — so in practice the estimate lives well inside this. It
 * is here so that a target with a pathological shape cannot hand the screen a
 * reference nobody could have whistled.
 */
const MAX_REFERENCE_CENTS = 60;

/** Pitch distance at which the substitution cost saturates, in semitones. */
const SUB_SATURATION_SEMITONES = 2;
const SUB_FREE_SEMITONES = CLEAN_CENTS / 100;
const DEFAULT_SEARCH_SEMITONES = 14;

/** Ties in floating-point cost are real (a whole melody of exact zeros), so
 *  comparisons need a margin or the tie-break order stops being deterministic. */
const EPSILON = 1e-9;

/**
 * What it costs to call a whistled note an attempt at a target note, given the
 * distance between them in semitones.
 *
 * Zero inside the `clean` radius, rising linearly, flat from a whole tone
 * onwards. Exported so the anti-cascade inequality can be swept in a test
 * rather than merely asserted in a comment.
 */
export function substitutionCost(distanceSemitones: number): number {
  const distance = Math.abs(distanceSemitones);
  if (!(distance > SUB_FREE_SEMITONES)) return 0;
  const climb =
    (distance - SUB_FREE_SEMITONES) / (SUB_SATURATION_SEMITONES - SUB_FREE_SEMITONES);
  return SUB_MAX_COST * Math.min(1, climb);
}

/**
 * What it costs to claim the attempt was sung in a different register from the
 * one the melody played in.
 *
 * Zero at the played register, rising linearly, flat from an octave onwards.
 * Charged **per pairing**, so the evidence and the prior scale together — see
 * the prior note in the module docblock.
 *
 * Exported for the same reason {@link substitutionCost} is: the inequality that
 * keeps it a tie-breaker rather than a wall is worth sweeping in a test.
 */
export function transpositionPrior(transposition: number): number {
  const distance = Math.min(Math.abs(transposition), TRANSPOSE_PRIOR_SEMITONES);
  return (TRANSPOSE_PRIOR_MAX * distance) / TRANSPOSE_PRIOR_SEMITONES;
}

/**
 * The verdict for a slot that *was* sung, from its signed residual.
 *
 * The boundaries are half-open and exact — `verdictForCents(30)` is `off`, not
 * `clean`. Reaching them exactly *through* the aligner is another matter: a
 * residual is `(midi + cents/100 + transposition - targetMidi) * 100`, and
 * building 30 cents that way lands about 3e-13 below it. That is IEEE-754, not
 * a rule, so the tests either call this function directly or stay a cent clear
 * of the boundary on either side. Nothing downstream should depend on which way
 * an exact boundary value falls.
 */
export function verdictForCents(residualCents: number): Exclude<Verdict, "missing"> {
  const distance = Math.abs(residualCents);
  if (distance < CLEAN_CENTS) return "clean";
  if (distance < OFF_CENTS) return "off";
  return "wrong";
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Mean of `log2(duration)` over the durations that are actually durations.
 *  `NaN` when there are none, which {@link tempoScale} then declines to use. */
function meanLogDuration(durations: readonly number[]): number {
  let sum = 0;
  let count = 0;
  for (const seconds of durations) {
    if (Number.isFinite(seconds) && seconds > 0) {
      sum += Math.log2(seconds);
      count++;
    }
  }
  return count === 0 ? NaN : sum / count;
}

/**
 * How much slower the attempt ran than the target, as one number — the **one**
 * scale both sides are then measured in.
 *
 * Durations are compared as log ratios, so in log space a tempo is a *level*
 * and a rhythm is the *deviation from it*. Subtracting the two mean log
 * durations therefore removes exactly the level and leaves exactly the rhythm,
 * which is what the tie-break is trying to read.
 *
 * The two estimates this replaces both fail on the case the tie-break exists
 * for. Normalising each side by its own median puts the same physical note at
 * 4.0 on one side and 1.6 on the other the moment a note goes missing, because
 * the medians are taken over different lists. Matching total lengths is worse
 * still when the *long* note is the one dropped: it stretches every surviving
 * note to cover the hole and then reports the wrong slot.
 *
 * `1` when either side has nothing to measure, which leaves
 * {@link durationCost} comparing raw seconds — and it ignores non-positive
 * durations anyway.
 */
function tempoScale(attempt: readonly number[], target: readonly number[]): number {
  const sung = meanLogDuration(attempt);
  const wanted = meanLogDuration(target);
  return Number.isFinite(sung) && Number.isFinite(wanted) ? Math.pow(2, sung - wanted) : 1;
}

/**
 * The tie-break's per-pair weight, scaled so its total is bounded.
 *
 * Past {@link DURATION_TIEBREAK_PAIRS} the per-pair cost comes down in
 * proportion, so a two-hundred-note melody spends exactly what a sixty-four
 * note one does. Without it the accumulated tie-break outgrows `2 * GAP_COST`
 * and buys a missing/extra pair — the cascade the cost design forbids.
 */
function durationWeight(pairs: number): number {
  return DURATION_TIEBREAK_COST * Math.min(1, DURATION_TIEBREAK_PAIRS / Math.max(1, pairs));
}

function durationCost(attemptSec: number, targetSec: number, weight: number): number {
  if (!(attemptSec > 0) || !(targetSec > 0)) return 0;
  const ratio = Math.abs(Math.log2(attemptSec / targetSec));
  return weight * Math.min(1, ratio);
}

/**
 * Give the pitches back the global tuning bias `src/dsp` took out of them.
 *
 * A `Note` reports `midi + centsOffset/100 = measured − tuningOffsetCents/100`;
 * adding it back and re-snapping to the nearest semitone returns the note to
 * what the microphone actually heard, which is what {@link alignAttempt} has to
 * be given. See the reference note in the module docblock for why.
 *
 * Generic in the note type so a transcription's `Note` — which carries start
 * and end times the overlay needs — survives the round trip with only its two
 * pitch fields rewritten. Which is also the caveat: a `Note`'s `noteName` and
 * `pitchHz` are *not* rewritten and still describe the corrected pitch, because
 * nothing in practice mode reads them (`AttemptNote` and `HeardNote` are the
 * fields that matter, and they are the two that move). Anything that starts
 * reading them off one of these has to be given the same treatment.
 */
export function undoTuningCorrection<T extends AttemptNote>(
  notes: readonly T[],
  tuningOffsetCents: number,
): T[] {
  if (!Number.isFinite(tuningOffsetCents) || tuningOffsetCents === 0) return [...notes];
  const shift = tuningOffsetCents / 100;
  return notes.map((note) => {
    const measured = note.midi + note.centsOffset / 100 + shift;
    const midi = Math.round(measured);
    return { ...note, midi, centsOffset: (measured - midi) * 100 };
  });
}

/**
 * How much a slot's residual says about the whistler's reference: 1 dead on,
 * 0 once it is far enough out to be a different note.
 *
 * A linear taper rather than a threshold, and that is the whole design. A hard
 * "ignore anything past 70 cents" would put a cliff back in — one note drifting
 * across it would move the reference several cents, and with it every other
 * note's verdict. Weight zero *at* the boundary means a note arriving there
 * changes nothing, whichever side of it the note lands on.
 */
function referenceWeight(residualCents: number): number {
  return Math.max(0, 1 - Math.abs(residualCents) / OFF_CENTS);
}

/**
 * The reference this attempt was whistled against, in cents.
 *
 * The tapered mean of the residuals of every slot that was actually sung — see
 * {@link referenceWeight} and the reference note in the module docblock.
 *
 * Deliberately *not* a circular mean, which was the first thing tried: it folds
 * an octave-out note onto zero for free, but it is undefined for an attempt
 * whose residuals sit at opposite ends of a semitone. One note whistled halfway
 * between two targets a semitone apart gives residuals of +50 and −50, which as
 * angles are the *same* direction — and the app would then claim a confident
 * half-semitone reference in a sign chosen by floating-point noise, turning "you
 * split the difference" into "one clean note and one wrong one".
 */
function referenceOffset(slots: readonly SlotResult[]): number {
  let weighted = 0;
  let weights = 0;
  let count = 0;
  for (const slot of slots) {
    if (slot.residualCents === null || !Number.isFinite(slot.residualCents)) continue;
    const weight = referenceWeight(slot.residualCents);
    if (weight <= 0) continue;
    weighted += weight * slot.residualCents;
    weights += weight;
    count++;
  }
  if (count < MIN_REFERENCE_NOTES || weights <= 0) return 0;

  const offset = weighted / weights;
  return Math.max(-MAX_REFERENCE_CENTS, Math.min(MAX_REFERENCE_CENTS, offset));
}

/** Back-pointer codes. */
const DIAGONAL = 1;
const CONSUME_ATTEMPT = 2;
const CONSUME_TARGET = 3;

/**
 * Align one attempt against one target.
 *
 * Runs the DP once per candidate transposition — 29 passes of an n×m table by
 * default, which for the ten-note melodies practice mode deals in is a few
 * thousand additions and not worth optimising.
 */
export function alignAttempt(
  attempt: readonly AttemptNote[],
  target: readonly TargetNote[],
  options: AlignOptions = {},
): Alignment {
  const n = attempt.length;
  const m = target.length;

  // Sub-semitone honesty: the whole point of reporting cents is that the
  // attempt is never rounded before it is measured.
  const pitches = attempt.map((note) => note.midi + note.centsOffset / 100);
  const attemptSec = attempt.map((note) => note.durationSec);
  const targetSec = target.map((note) => note.durSec);
  // One scale for both sides, and one weight for every pair. See the rhythm
  // note in the module docblock for why each of those is load-bearing.
  const scale = tempoScale(attemptSec, targetSec);
  const attemptScaled = attemptSec.map((seconds) => seconds / scale);
  const weight = durationWeight(Math.min(n, m));

  const radius = Math.max(
    0,
    Math.round(options.searchSemitones ?? DEFAULT_SEARCH_SEMITONES),
  );
  // Centring guess: how far the two sequences sit apart on average. Robust
  // (median, not mean) so one octave-cracked note cannot drag the search
  // window off the register the rest of the attempt was actually in.
  //
  // `|| 0` is not decoration: `Math.round(-0.5)` is `-0`, which would travel
  // all the way out through `transposition` and compare unequal to `0` under
  // `Object.is` — i.e. in every test that checks the attempt was in the
  // target's own register.
  const centre =
    n > 0 && m > 0
      ? Math.round(median(target.map((note) => note.midi)) - median(pitches)) || 0
      : 0;

  const width = m + 1;
  const dp = new Float64Array((n + 1) * width);
  const back = new Uint8Array((n + 1) * width);

  /**
   * Fill the table for one candidate register and return its total cost.
   * `back` is left holding this candidate's decisions, so a caller that wants
   * to keep them has to copy before filling again.
   */
  const fill = (transposition: number, referenceCents: number): number => {
    const prior = transpositionPrior(transposition);
    const shift = transposition - referenceCents / 100;
    // Every row but the last still has attempt notes to come, so a slot skipped
    // in it is a slot skipped *over* rather than never reached — the unlikely
    // kind of gap. See the prior note in the module docblock.
    const early = n > 0 ? EARLY_GAP_COST : 0;
    dp[0] = 0;
    for (let j = 1; j <= m; j++) {
      dp[j] = j * (GAP_COST + early);
      back[j] = CONSUME_TARGET;
    }
    for (let i = 1; i <= n; i++) {
      const skipCost = GAP_COST + (i < n ? EARLY_GAP_COST : 0);
      dp[i * width] = i * GAP_COST;
      back[i * width] = CONSUME_ATTEMPT;
      for (let j = 1; j <= m; j++) {
        const distance = pitches[i - 1] + shift - target[j - 1].midi;
        // Diagonal first, and only replaced on a *strict* improvement: on a tie
        // the aligner pairs notes up rather than dropping them, which is the
        // same preference the cost constants encode.
        let best =
          dp[(i - 1) * width + (j - 1)] +
          substitutionCost(distance) +
          durationCost(attemptScaled[i - 1], targetSec[j - 1], weight) +
          prior;
        let code = DIAGONAL;

        const skipAttempt = dp[(i - 1) * width + j] + GAP_COST;
        if (skipAttempt < best - EPSILON) {
          best = skipAttempt;
          code = CONSUME_ATTEMPT;
        }
        const skipTarget = dp[i * width + (j - 1)] + skipCost;
        if (skipTarget < best - EPSILON) {
          best = skipTarget;
          code = CONSUME_TARGET;
        }

        dp[i * width + j] = best;
        back[i * width + j] = code;
      }
    }
    return dp[n * width + m];
  };

  let bestCost = Infinity;
  let bestTransposition = centre;
  let bestBack: Uint8Array | null = null;

  // Candidates ordered by distance from the centring guess, so a tie — two
  // registers that fit equally well, which happens with short symmetric
  // phrases — resolves to the more plausible one rather than to whichever came
  // first in an arbitrary sweep. The prior above settles most of those ties on
  // its own; the order still decides the ones it cannot reach.
  //
  // There is one *exact* tie the prior provably cannot break, and it is worth
  // knowing where it sits. Take an `m`-note attempt with `k` notes cracked a
  // full octave and the other `m - k` in the played register, every cracked
  // note saturated (an octave is, comfortably) and every held one inside the
  // free radius. Staying costs `SUB_MAX_COST * k`; moving to the crack's octave
  // costs `SUB_MAX_COST * (m - k) + TRANSPOSE_PRIOR_MAX * m`. The difference is
  // `(12k - 7m) / 4`, so the two registers are exactly equal at `k = 7m/12` —
  // the ~58% line the prior note in the module docblock names, written as the
  // fraction it actually is. Because `k` and `m` are integers that needs
  // `12 | m`; anywhere off that grid `|12k - 7m| >= 1` and the two registers
  // differ by at least 0.25, which is eight orders above {@link EPSILON}. So
  // this is a genuine knife edge, not a numerical one, and it is reached only
  // at `m` = 12, 24, 36, … with exactly `7m/12` notes cracked.
  //
  // On it, `cost < bestCost - EPSILON` declines to switch and the answer goes
  // to whichever of the two tied registers this loop reaches first — i.e. the
  // one nearer the centring guess, with `candidates` breaking even *that* by
  // yielding `centre - d` before `centre + d`. Deterministic, and defensible
  // (the median is the robust estimate of where the attempt sat), which is why
  // this is a note and not a fix: any rule put here would be picking one of two
  // readings that the cost function itself says are equally good.
  //
  // Nothing the app generates today can reach it: the bundled melodies are 9,
  // 13, 14, 14 and 15 notes and the echo drill's phrases are 3 to 6, and no
  // multiple of 12 is in either list. An imported MIDI melody is the open edge
  // — `MAX_MELODY_NOTES` is 64, so 12, 24, 36, 48 and 60 are all reachable, and
  // a 24-note melody with 14 cracked notes lands on it exactly (verified: both
  // registers cost 21.000000000000).
  for (const transposition of candidates(centre, radius)) {
    const cost = fill(transposition, 0);
    if (cost < bestCost - EPSILON) {
      bestCost = cost;
      bestTransposition = transposition;
      bestBack = back.slice();
    }
  }

  // Unreachable — `candidates` always yields at least the centring guess, so
  // the loop always runs and always records a best, even for two empty
  // sequences (cost 0). Kept because it narrows the type, and because an
  // honest empty answer beats a non-null assertion if it ever became reachable.
  if (!bestBack) return { transposition: 0, offsetCents: 0, cost: 0, slots: [], extras: [] };

  const first = traceback(bestBack, width, n, m, pitches, target, bestTransposition, 0, bestCost);
  const offsetCents = referenceOffset(first.slots);
  if (offsetCents === 0) return first;

  // One more pass, at the register already chosen: the reference was measured
  // from that alignment, so scoring against it has to be that alignment's
  // register or the two numbers would be about different things. The pairings
  // themselves can still move — a note that read as its neighbour's flat side
  // may sit inside its own once the whistler's own centre is taken out, and
  // that is the point.
  const cost = fill(bestTransposition, offsetCents);
  return traceback(back, width, n, m, pitches, target, bestTransposition, offsetCents, cost);
}

/**
 * The transposition search order: the centring guess, then outwards — and the
 * played register itself, always.
 *
 * `0` is on the ballot whatever the window, because it is the one register the
 * app *knows* was in the air and the one {@link transpositionPrior} is measured
 * from. It costs one more pass of a table that is already cheap, and without it
 * a centring guess dragged more than `radius` semitones by a cracked attempt
 * could leave the true answer unconsidered.
 */
function candidates(centre: number, radius: number): number[] {
  const out = [centre];
  for (let d = 1; d <= radius; d++) out.push(centre - d, centre + d);
  if (!out.includes(0)) out.push(0);
  return out;
}

function traceback(
  back: Uint8Array,
  width: number,
  n: number,
  m: number,
  pitches: readonly number[],
  target: readonly TargetNote[],
  transposition: number,
  offsetCents: number,
  cost: number,
): Alignment {
  const slots = new Array<SlotResult>(m);
  const extras: ExtraNote[] = [];
  // Every pitch on the way out is in one reference: the register the aligner
  // chose, with the whistler's own centre taken off it.
  const shift = transposition - offsetCents / 100;

  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const code = back[i * width + j];
    if (code === DIAGONAL && i > 0 && j > 0) {
      const heard = pitches[i - 1] + shift;
      const residualCents = (heard - target[j - 1].midi) * 100;
      slots[j - 1] = {
        slot: j - 1,
        targetMidi: target[j - 1].midi,
        verdict: verdictForCents(residualCents),
        attemptIndex: i - 1,
        heardMidi: Math.round(heard),
        residualCents,
      };
      i--;
      j--;
    } else if (code === CONSUME_ATTEMPT && i > 0) {
      // `j - 1` is the last slot to this note's left, because the walk is
      // backwards and everything below `j` is still unassigned.
      extras.push({
        attemptIndex: i - 1,
        heardMidi: Math.round(pitches[i - 1] + shift),
        afterSlot: j - 1,
      });
      i--;
    } else {
      slots[j - 1] = {
        slot: j - 1,
        targetMidi: target[j - 1].midi,
        verdict: "missing",
        attemptIndex: null,
        heardMidi: null,
        residualCents: null,
      };
      j--;
    }
  }

  extras.reverse();
  return { transposition, offsetCents, cost, slots, extras };
}

export interface VerdictCounts {
  clean: number;
  off: number;
  wrong: number;
  missing: number;
  extra: number;
}

/** How one attempt went, in five numbers. */
export function countVerdicts(alignment: Alignment): VerdictCounts {
  const counts: VerdictCounts = { clean: 0, off: 0, wrong: 0, missing: 0, extra: 0 };
  for (const slot of alignment.slots) counts[slot.verdict]++;
  counts.extra = alignment.extras.length;
  return counts;
}
