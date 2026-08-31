/**
 * The echo drills: hold a note, echo a phrase.
 *
 * Recall (T3) asks a question about a *melody* — do you remember it, and can
 * you produce it? These two ask questions about the whistle itself, and they
 * split the failure the recall screen can only report as one number:
 *
 * - **Hold a note** is pure production. The app plays one tone, the user holds
 *   it back, and the two numbers that come out — how far off the middle of the
 *   held note sat, and how much it wandered — are the difference between an aim
 *   problem and a breath problem. Nothing here is about memory: the reference
 *   was playing seconds ago and there is one note to remember.
 * - **Echo a phrase** is interval knowledge. Three to six notes, generated
 *   rather than chosen, so there is nothing to have practised and nothing to
 *   have half-remembered from last week — what comes back is what the ear and
 *   the mouth can do with an interval they have just heard.
 *
 * Both are ear-first in the strong sense: the prompt is a sound, and this module
 * never produces a note name for anything the user has not already whistled.
 *
 * ## The adaptive phrase generator
 *
 * The second drill is the one that reads the practice history. `stats.ts` keeps
 * an EWMA per *directed* interval — a rising minor 3rd and a falling one are
 * different skills — and {@link weakestIntervals} ranks them. The generator
 * turns that ranking into a *bias*, not a filter: every step keeps a base
 * weight, and a weak one is multiplied up. Three reasons it is a bias:
 *
 * 1. With no history at all (the first session, and every session until the
 *    numbers mean anything) the multipliers are all 1 and the generator is
 *    exactly the plain random walk. The fallback is not a branch, it is what the
 *    formula degenerates to — which is why there is no second code path to keep
 *    honest.
 * 2. A drill that only ever played the three worst intervals would stop being an
 *    ear test and become a memory test for those three.
 * 3. Weakness is measured, and measurements move. Over-sampling an interval is
 *    what *changes* its EWMA, so the bias has to be gentle enough that the
 *    statistic can climb back out.
 *
 * Pure: no DOM, no storage, no `src/audio`, no `src/dsp`. Every random choice
 * comes from an injected {@link Rng}, so a phrase is reproducible from a seed
 * and the bias can be measured in a test instead of eyeballed.
 */

import { OFF_CENTS, type Alignment, type TargetNote } from "./align.js";
import { distanceText, type PlayableNote, type TrailPoint } from "./recall.js";
import { isUsableRange, type WhistleRange } from "./range.js";
import {
  intervalWeakness,
  weakestIntervals,
  type HoldTally,
  type PracticeStats,
} from "./stats.js";

/* ── Randomness you can reproduce ─────────────────────────────────────── */

/** A source of numbers in `[0, 1)`. `Math.random` satisfies it; so does a seed. */
export type Rng = () => number;

/**
 * mulberry32: eleven lines, a full 2^32 period, and good enough statistics for
 * choosing between fourteen weighted options.
 *
 * Hand-rolled because the alternative is a dependency, and this repo has one
 * runtime dependency on purpose. The reason it exists at all is testability: a
 * generator whose output cannot be reproduced can only be checked by eye, and
 * "does the adaptive mode actually over-sample weak intervals?" is a question
 * about a distribution over hundreds of phrases.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick from `weights` in proportion. Exactly one {@link Rng} call, which is
 *  what makes a phrase's length and its content independent of each other. */
function weightedPick(weights: readonly number[], rng: Rng): number {
  let total = 0;
  for (const weight of weights) total += Math.max(0, weight);
  if (!(total > 0)) return 0;
  let threshold = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    threshold -= Math.max(0, weights[i]);
    // `<= 0` rather than `< 0`: a run of zero weights after the pick must not
    // let the loop fall off the end and return the last index by accident.
    if (threshold <= 0) return i;
  }
  return weights.length - 1;
}

/* ── Where the drills live ────────────────────────────────────────────── */

/**
 * The register a drill uses when the range has never been measured.
 *
 * F♯5–F♯6, an octave centred on C6 — where a whistle actually sits. The pitch
 * search starts at 400 Hz and whistling runs to about 4 kHz, and a beginner's
 * comfortable octave is near the bottom of that. It is a guess, and the app says
 * so on screen rather than pretending it measured something.
 */
export const DEFAULT_DRILL_RANGE: WhistleRange = { lowMidi: 78, highMidi: 90 };

/** How wide a range the phrase walk will use, however wide the measurement was.
 *  Two octaves is more than any three-note phrase needs, and a range that came
 *  back absurdly wide (one squeaked take at each end) would otherwise send the
 *  walk somewhere nobody can whistle. */
const MAX_DRILL_SPAN = 24;
/** ...and the floor. A range narrower than this cannot hold a phrase with a
 *  leap in it, so the drill widens it symmetrically rather than refusing. */
const MIN_DRILL_SPAN = 12;

/**
 * The register these drills play in.
 *
 * The measured range when there is one, clamped to something a drill can use,
 * and the default otherwise. Clamping around the *centre* keeps whatever the
 * measurement got right — where this whistler lives — while dropping whatever
 * it got wrong about how far they can stretch.
 */
export function drillRange(range: WhistleRange | null | undefined): WhistleRange {
  if (!isUsableRange(range)) return { ...DEFAULT_DRILL_RANGE };
  const centre = (range.lowMidi + range.highMidi) / 2;
  const span = Math.min(
    MAX_DRILL_SPAN,
    Math.max(MIN_DRILL_SPAN, range.highMidi - range.lowMidi),
  );
  return {
    lowMidi: Math.round(centre - span / 2),
    highMidi: Math.round(centre + span / 2),
  };
}

/** Whether a drill is running on a guess rather than on a measurement — the one
 *  fact the screen turns into a nudge towards the range check. */
export function isDefaultRange(range: WhistleRange | null | undefined): boolean {
  return !isUsableRange(range);
}

/* ── Drill one: hold a note ───────────────────────────────────────────── */

/**
 * How long the reference tone sounds.
 *
 * Long enough to be *heard* rather than identified — a 300 ms blip is a pitch
 * you match from its memory, and this drill is meant to give the ear something
 * to sit inside — and short enough that the loop stays a loop. The user then
 * holds it back into silence, which is deliberate: the microphone has no echo
 * cancellation, so a reference still sounding would be measured as part of the
 * take.
 */
export const HOLD_REFERENCE_SEC = 2.5;

/** The reference as the synth wants it. One note, one entry. */
export function holdPlayback(midi: number, seconds = HOLD_REFERENCE_SEC): PlayableNote[] {
  return [{ midi, startSec: 0, endSec: seconds, durationSec: seconds }];
}

/**
 * A note to hold, inside the drill register.
 *
 * Kept a semitone off both ends so the answer is never "whistle as high as you
 * possibly can", and never the same note twice running — repeating it would
 * turn the drill into one long note with a gap in it, and the point of a new
 * reference is that the ear has to move.
 */
export function holdReference(
  range: WhistleRange,
  rng: Rng,
  previous: number | null = null,
): number {
  const low = Math.ceil(range.lowMidi) + 1;
  const high = Math.floor(range.highMidi) - 1;
  if (!(high > low)) return Math.round((range.lowMidi + range.highMidi) / 2);
  const span = high - low + 1;
  const pick = low + Math.floor(rng() * span);
  if (pick !== previous) return pick;
  // One nudge rather than a loop: with a dozen candidates a retry that could
  // collide again is a loop with no bound, and stepping one semitone is a new
  // note by any measure.
  return pick + 1 <= high ? pick + 1 : pick - 1;
}

/**
 * What a held note actually did.
 *
 * Two numbers, and they answer different questions. `medianCents` is *aim*: the
 * middle of the note, signed, relative to what was played. `wobbleCents` is
 * *steadiness*: half the interquartile range of the same frames, which is the
 * width the pitch wandered over while it was being held.
 *
 * Median and IQR rather than mean and standard deviation, for the reason
 * everything else in this codebase prefers them: one cracked frame where the
 * breath ran out would move a mean by tens of cents and a standard deviation by
 * hundreds, and neither number would then be about the held note at all.
 */
export interface HoldScore {
  /** Signed cents from the reference: positive is sharp. */
  medianCents: number;
  /** Half the interquartile range of the scored frames, in cents. */
  wobbleCents: number;
  /** How long the scored stretch lasted. */
  steadySec: number;
  /** How many frames it was measured from. */
  frames: number;
}

/** A gap this long ends the held note; the same value `ui/diffroll.ts` uses to
 *  break the trail, and for the same reason — silence is not an interpolation. */
const HOLD_BREAK_SEC = 0.08;

/** Below this there is no held note to score, only an attempt at one. */
export const MIN_HOLD_SEC = 0.7;

/**
 * Fraction of the held stretch dropped from the front.
 *
 * A whistle scoops into its note: the first tenth of a second is a glide, and
 * including it would report a hold as flat when what actually happened was an
 * approach. The same 25% the segmenter trims off the start of a long note, for
 * the same reason and with the same argument behind it.
 */
const HOLD_TRIM_FRACTION = 0.25;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Score one hold take.
 *
 * `null` when there is nothing to score — a take with no sustained tone in it is
 * not a bad hold, it is a take the app could not hear, and reporting "held 400
 * cents flat" about a cough would be inventing a measurement.
 *
 * ## The trail must be uncorrected
 *
 * `points` has to come from the take's **raw** frames, with the segmenter's
 * global tuning offset *not* applied — `trailFromFrames(frames, 0)`. That
 * correction exists to rescue a consistently-sharp whistler from coin-flip note
 * names, and it works by measuring exactly the bias this drill is trying to
 * report. Apply it here and a user who holds every note 40 cents sharp is told
 * they are dead on, by a machine that quietly moved the target to meet them.
 */
export function scoreHold(
  points: readonly TrailPoint[],
  referenceMidi: number,
  minSec: number = MIN_HOLD_SEC,
): HoldScore | null {
  // The longest continuously-voiced stretch, which for a take that is one held
  // note is the note — and for a take with a cough at the start is still the
  // note.
  let best: TrailPoint[] = [];
  let run: TrailPoint[] = [];
  let previous = -Infinity;
  const span = (points: readonly TrailPoint[]): number =>
    points.length === 0 ? 0 : points[points.length - 1].tSec - points[0].tSec;
  for (const point of points) {
    if (point.tSec - previous > HOLD_BREAK_SEC) {
      if (span(run) > span(best)) best = run;
      run = [];
    }
    run.push(point);
    previous = point.tSec;
  }
  if (span(run) > span(best)) best = run;

  const steadySec = span(best);
  if (steadySec < minSec || best.length < 3) return null;

  const scored = best.slice(Math.floor(best.length * HOLD_TRIM_FRACTION));
  const cents = scored.map((point) => (point.midi - referenceMidi) * 100);
  const sorted = [...cents].sort((a, b) => a - b);
  return {
    medianCents: quantile(sorted, 0.5),
    wobbleCents: (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / 2,
    steadySec: scored[scored.length - 1].tSec - scored[0].tSec,
    frames: scored.length,
  };
}

/** Inside this, "dead on" is the truer report than a number: a beginner's
 *  whistle does not resolve to five cents, and neither does a phone speaker. */
const HOLD_DEAD_ON_CENTS = 10;

/**
 * The score, in one plain sentence.
 *
 * "Held 12 cents sharp, wobble ±18 cents" — a direction, a distance, and a
 * width, with no grade attached. The two numbers are separate on purpose:
 * someone who is 40 cents flat but rock steady has a completely different thing
 * to practise from someone whose median is perfect and whose pitch is swinging
 * ±60, and a single "accuracy" score would hide exactly that.
 */
export function holdScoreText(score: HoldScore): string {
  const aim =
    Math.abs(score.medianCents) < HOLD_DEAD_ON_CENTS
      ? "Held it dead on"
      : `Held it ${distanceText(score.medianCents)}`;
  return `${aim}, wobble ±${Math.round(score.wobbleCents)} cents.`;
}

/** Above this the note wandered more than it sat still, whatever its median. */
const WOBBLY_CENTS = 25;

/**
 * The one thing worth doing something about, or a word that it went well.
 *
 * Steadiness first when both are bad: a note that is swinging has no stable
 * pitch for an aim correction to be applied *to*, so "hold it longer and
 * calmer" is the instruction that has to land first.
 */
export function holdTakeaway(score: HoldScore): string {
  if (score.wobbleCents >= WOBBLY_CENTS) {
    return "That one wandered while you held it — a slower, steadier breath is the fix, before the aim.";
  }
  if (Math.abs(score.medianCents) >= OFF_CENTS) {
    return "Steady, but sitting away from what played — listen to it again and lean the other way.";
  }
  if (Math.abs(score.medianCents) >= HOLD_DEAD_ON_CENTS) {
    return "Steady and close. That is what a good one feels like.";
  }
  return "Steady and right on it. Nothing to fix.";
}

/** Below this there is no trend, only two holds. Saying "on average" about a
 *  single measurement would dress one breath up as a habit. */
const HOLD_TREND_MIN = 3;

/**
 * The running averages, or nothing at all.
 *
 * Deliberately about the *habit* rather than the last go, because that is the
 * only thing these two numbers are good for: one hold 20 cents sharp is a hold,
 * and eight of them 20 cents sharp is something to do about your mouth.
 */
export function holdHistoryText(holds: HoldTally | null | undefined): string {
  if (!holds || holds.count < HOLD_TREND_MIN) return "";
  const aim =
    Math.abs(holds.offsetEwma) < HOLD_DEAD_ON_CENTS
      ? "sitting right on it"
      : `running ${distanceText(holds.offsetEwma)}`;
  return `Lately: ${aim}, wobble ±${Math.round(holds.wobbleEwma)} cents.`;
}

/* ── Drill two: echo a phrase ─────────────────────────────────────────── */

export const ECHO_MIN_NOTES = 3;
export const ECHO_MAX_NOTES = 6;

/**
 * How long each note of a generated phrase lasts.
 *
 * Every note the same length, deliberately. This drill is about intervals, and
 * a rhythm would give the user a second thing to reproduce and the aligner a
 * second thing to be confused by. Half a second is slow enough to hear the
 * interval and fast enough that six notes are still one phrase.
 */
export const ECHO_NOTE_SEC = 0.5;

/**
 * The steps a phrase is built from, and how likely each is before the history
 * has anything to say.
 *
 * The plan asked for "mostly 1–4 semitones, occasional 5–7". The third tier is
 * a deliberate extension: the measured profile this whole mode was built around
 * is *3rds, 6ths and 7ths are wobbly*, and a 6th is nine semitones — a generator
 * that stopped at seven could never once drill the thing it exists to drill. So
 * wide leaps are rare rather than absent, and the adaptive bias below is what
 * makes them common when they are the problem.
 *
 * Weights are relative, and the resulting mix with no history is roughly
 * 67% steps, 20% fourths-and-fifths, 13% sixths-and-up.
 */
const STEP_WEIGHTS: readonly { maxSemitones: number; weight: number }[] = [
  { maxSemitones: 4, weight: 1 },
  { maxSemitones: 7, weight: 0.4 },
  { maxSemitones: 12, weight: 0.15 },
];

/** Widest leap a phrase will ever contain. */
const MAX_STEP = 12;

/**
 * How hard the history pushes.
 *
 * {@link intervalWeakness} tops out around 1.5, so a maximally weak interval
 * ends up 1 + 3 × 1.5 = 5.5 times its base weight — enough that a weak 6th is
 * drilled about as often as an ordinary step, and not so much that the drill
 * collapses onto three intervals. See the module header for why this is a bias
 * rather than a filter.
 */
const ADAPT_GAIN = 3;

/**
 * How much evidence an interval needs before it is allowed to steer the drill.
 *
 * Higher than `weakestIntervals`' own default of 3, because the cost of being
 * wrong is different here: a misleading line on a statistics screen is a bad
 * sentence, while a drill that has decided your rising 4th is a weakness after
 * two unlucky attempts will keep asking for it for a week.
 */
export const ECHO_MIN_OBSERVATIONS = 5;

function baseWeight(semitones: number): number {
  const magnitude = Math.abs(semitones);
  for (const tier of STEP_WEIGHTS) {
    if (magnitude <= tier.maxSemitones) return tier.weight;
  }
  return 0;
}

/** Every candidate step, in a fixed order so a seed means one phrase. */
const CANDIDATE_STEPS: readonly number[] = (() => {
  const steps: number[] = [];
  for (let s = -MAX_STEP; s <= MAX_STEP; s++) if (s !== 0) steps.push(s);
  return steps;
})();

export interface PhraseOptions {
  /** Notes in the phrase; clamped to {@link ECHO_MIN_NOTES}…{@link ECHO_MAX_NOTES}. */
  length?: number;
  /** Where the phrase may go. Defaults to {@link DEFAULT_DRILL_RANGE}. */
  range?: WhistleRange | null;
  /** The history. Omit — or pass one with nothing in it yet — and the generator
   *  is exactly a plain random walk. */
  stats?: PracticeStats | null;
  minObservations?: number;
  noteSec?: number;
}

/**
 * The per-step weights this phrase will be drawn from, given the history.
 *
 * Exported because it is the honest place to test the claim the drill makes:
 * "weak intervals come up more often" is a statement about *these numbers*, and
 * checking it here is exact where checking it through sampled phrases is
 * statistical. Indexed to match {@link CANDIDATE_STEPS}.
 */
export function stepWeights(
  stats: PracticeStats | null | undefined,
  minObservations: number = ECHO_MIN_OBSERVATIONS,
): Map<number, number> {
  const weights = new Map<number, number>();
  for (const step of CANDIDATE_STEPS) weights.set(step, baseWeight(step));
  if (!stats) return weights;

  for (const stat of weakestIntervals(stats, { minObservations })) {
    const base = weights.get(stat.interval);
    // An interval outside the candidate set — an octave and a half, say, from a
    // melody in the library — has nothing to bias. Silently ignored rather than
    // added: a phrase generator that can produce a leap no drill was designed
    // around is a worse answer than not drilling it.
    if (base === undefined) continue;
    weights.set(stat.interval, base * (1 + ADAPT_GAIN * intervalWeakness(stat)));
  }
  return weights;
}

/**
 * One phrase: a random walk in the drill register, biased by the history.
 *
 * Determinism is by construction — the only randomness is `rng`, and it is
 * called exactly once per note. The same seed and the same options produce the
 * same phrase on any device, which is what makes the bias testable.
 */
export function echoPhrase(rng: Rng, options: PhraseOptions = {}): TargetNote[] {
  const range = drillRange(options.range ?? null);
  const length = Math.max(
    ECHO_MIN_NOTES,
    Math.min(ECHO_MAX_NOTES, Math.round(options.length ?? ECHO_MIN_NOTES)),
  );
  const durSec = options.noteSec ?? ECHO_NOTE_SEC;
  const weights = stepWeights(options.stats, options.minObservations);

  // Start in the middle third, so a phrase that walks upward and one that walks
  // downward both have somewhere to go.
  const low = Math.ceil(range.lowMidi);
  const high = Math.floor(range.highMidi);
  const inner = Math.max(1, Math.floor((high - low) / 3));
  let midi = low + Math.floor((high - low - inner) / 2) + Math.floor(rng() * (inner + 1));

  const notes: TargetNote[] = [{ midi, durSec }];
  for (let i = 1; i < length; i++) {
    // Only steps that stay inside the register, re-normalised. A walk that
    // reflected off the ends instead would turn every phrase near the top into
    // the same descending shape.
    const allowed = CANDIDATE_STEPS.map((step) => {
      const next = midi + step;
      return next >= low && next <= high ? (weights.get(step) ?? 0) : 0;
    });
    midi += CANDIDATE_STEPS[weightedPick(allowed, rng)];
    notes.push({ midi, durSec });
  }
  return notes;
}

/**
 * Whether an echo counts as got.
 *
 * Every slot the right note — `clean` or `off` — and nothing added. Deliberately
 * *not* "every slot clean": this drill is about knowing where the interval goes,
 * and demanding 30-cent accuracy from a beginner's whistle before the phrase
 * gets a note longer would mean the ramp never moved. Aim is the other drill's
 * question, and it is measured there.
 */
export function echoSucceeded(alignment: Alignment): boolean {
  if (alignment.slots.length === 0) return false;
  if (alignment.extras.length > 0) return false;
  return alignment.slots.every((slot) => slot.verdict === "clean" || slot.verdict === "off");
}

/** The next phrase's length: one longer after a success, one shorter after a
 *  miss, inside the 3–6 band. A ramp with no ceiling turns a drill into an
 *  endurance test, and one with no floor strands a beginner at six notes. */
export function nextEchoLength(length: number, success: boolean): number {
  const next = Math.round(length) + (success ? 1 : -1);
  return Math.max(ECHO_MIN_NOTES, Math.min(ECHO_MAX_NOTES, next));
}

/** What the ramp just did, said out loud — so a phrase getting longer reads as
 *  progress rather than as the app being erratic. */
export function echoRampText(previous: number, next: number): string {
  if (next > previous) return "Got it — one more note next time.";
  if (next < previous) return "Let us take one back off.";
  return "Same length again.";
}
