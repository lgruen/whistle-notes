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
 * ## Rhythm
 *
 * Timing never fails a note — verdicts come from pitch alone. Duration enters
 * only as a tie-breaker worth at most {@link DURATION_TIEBREAK_COST} = 0.02 per
 * pair, three orders below the pitch costs and far below the 0.5 of headroom in
 * the anti-cascade inequality, and only after both sequences have been
 * normalised by their own median duration so a slow echo of a fast phrase costs
 * nothing. What it buys is the genuinely ambiguous case: three identical
 * repeated notes with one of them dropped is a tie on pitch, and rhythm is the
 * only evidence left about *which* one went missing.
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
  /** Total alignment cost at that transposition. Comparable across attempts at
   *  the same target, meaningless across different targets. */
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

/** The verdict for a slot that *was* sung, from its signed residual. */
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

/**
 * Durations as multiples of their own sequence's median, so the two sides can
 * be compared without either one's tempo mattering. `NaN` wherever there is
 * nothing to normalise by, which {@link durationCost} then ignores.
 */
function relativeDurations(durations: readonly number[]): number[] {
  const usable = durations.filter((d) => Number.isFinite(d) && d > 0);
  const scale = median(usable);
  return durations.map((d) => (d > 0 ? d / scale : NaN));
}

function durationCost(attemptRelative: number, targetRelative: number): number {
  if (!(attemptRelative > 0) || !(targetRelative > 0)) return 0;
  const ratio = Math.abs(Math.log2(attemptRelative / targetRelative));
  return DURATION_TIEBREAK_COST * Math.min(1, ratio);
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
  const attemptRelative = relativeDurations(attempt.map((note) => note.durationSec));
  const targetRelative = relativeDurations(target.map((note) => note.durSec));

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
  let bestCost = Infinity;
  let bestTransposition = centre;
  let bestBack: Uint8Array | null = null;

  // Candidates ordered by distance from the centring guess, so a tie — two
  // registers that fit equally well, which happens with short symmetric
  // phrases — resolves to the more plausible one rather than to whichever came
  // first in an arbitrary sweep.
  for (const transposition of candidates(centre, radius)) {
    dp[0] = 0;
    for (let j = 1; j <= m; j++) {
      dp[j] = j * GAP_COST;
      back[j] = CONSUME_TARGET;
    }
    for (let i = 1; i <= n; i++) {
      dp[i * width] = i * GAP_COST;
      back[i * width] = CONSUME_ATTEMPT;
      for (let j = 1; j <= m; j++) {
        const distance = pitches[i - 1] + transposition - target[j - 1].midi;
        // Diagonal first, and only replaced on a *strict* improvement: on a tie
        // the aligner pairs notes up rather than dropping them, which is the
        // same preference the cost constants encode.
        let best =
          dp[(i - 1) * width + (j - 1)] +
          substitutionCost(distance) +
          durationCost(attemptRelative[i - 1], targetRelative[j - 1]);
        let code = DIAGONAL;

        const skipAttempt = dp[(i - 1) * width + j] + GAP_COST;
        if (skipAttempt < best - EPSILON) {
          best = skipAttempt;
          code = CONSUME_ATTEMPT;
        }
        const skipTarget = dp[i * width + (j - 1)] + GAP_COST;
        if (skipTarget < best - EPSILON) {
          best = skipTarget;
          code = CONSUME_TARGET;
        }

        dp[i * width + j] = best;
        back[i * width + j] = code;
      }
    }

    const cost = dp[n * width + m];
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
  if (!bestBack) return { transposition: 0, cost: 0, slots: [], extras: [] };

  return traceback(bestBack, width, n, m, pitches, target, bestTransposition, bestCost);
}

/** The transposition search order: the centring guess, then outwards. */
function candidates(centre: number, radius: number): number[] {
  const out = [centre];
  for (let d = 1; d <= radius; d++) out.push(centre - d, centre + d);
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
  cost: number,
): Alignment {
  const slots = new Array<SlotResult>(m);
  const extras: ExtraNote[] = [];

  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const code = back[i * width + j];
    if (code === DIAGONAL && i > 0 && j > 0) {
      const heard = pitches[i - 1] + transposition;
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
        heardMidi: Math.round(pitches[i - 1] + transposition),
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
  return { transposition, cost, slots, extras };
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
