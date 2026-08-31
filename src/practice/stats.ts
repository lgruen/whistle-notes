/**
 * What the practice history remembers, and the two questions it answers.
 *
 * One attempt tells you almost nothing: everybody flubs a note. The value is in
 * the second and the twentieth attempt, and specifically in two aggregates that
 * are aggregated along *different* axes:
 *
 * 1. **Per directed interval.** A whistler's weaknesses are intervallic, not
 *    positional — the v1 measurements on this user found 4ths, 5ths and octaves
 *    dead on and 3rds, 6ths and 7ths wobbly, and that pattern is a property of
 *    the person, not of any one melody. Keyed by the *signed* semitone step in
 *    the target (a rising minor third and a falling one are genuinely different
 *    skills), it is what lets T4's drill selection over-sample the intervals
 *    that are actually weak instead of drilling everything equally.
 * 2. **Per slot of one target.** "Bar three has beaten me nine times out of
 *    ten" is a different fact from "my rising sixths are shaky", and it is the
 *    one that makes a trouble-spot heatmap over the piano roll worth drawing.
 *
 * Two more distinctions the schema keeps apart on purpose, because collapsing
 * them is how a practice app ends up giving useless advice:
 *
 * - **Production error vs. wrong note.** The cents EWMA averages only slots
 *   that came out as the right note (`clean`/`off`); a wrong note's residual
 *   can be 1200 cents and would swamp the average with a number that is not
 *   about aim at all. The wrong-note rate is its own EWMA. Wobbly-but-right is
 *   a mouth problem; consistently-the-wrong-note is a memory or interval
 *   problem, and they want different exercises.
 * - **Wrong vs. missing.** A slot never sung is a recall failure, not an
 *   aiming failure, so it is counted and never folded into either EWMA. A
 *   caller that wants to treat them together can: the raw counts are all here.
 *
 * Pure: no storage, no DOM. Persisting the JSON this module produces is
 * `store.ts`'s job, and every update returns a new object so the store can
 * treat practice stats the way `src/ui/state.ts` treats everything else.
 */

import { OFF_CENTS, type Alignment, type TargetNote } from "./align.js";

/**
 * EWMA weight on the newest observation.
 *
 * 0.25 gives a half-life of about 2.4 observations and an effective memory of
 * seven or eight — deliberately short. This number exists to answer "is this
 * interval a problem *today*", and an average that still remembers last month's
 * first attempt would keep recommending drills for something already fixed.
 * The lifetime counts sitting next to it are the long memory.
 */
export const EWMA_ALPHA = 0.25;

export interface IntervalStat {
  /** Signed semitone step in the target, from the previous slot to this one. */
  interval: number;
  /** Slots that produced *a* pitch: `clean` + `off` + `wrong`. */
  observations: number;
  clean: number;
  off: number;
  wrong: number;
  /** Slots at this interval that were never sung. Not in `observations`. */
  missing: number;
  /** EWMA of |residual cents| over `clean` and `off` slots only. */
  absCentsEwma: number;
  /** How many observations back that EWMA; 0 means it is not yet meaningful. */
  centsObservations: number;
  /** EWMA of "that came out as a different note", 0..1, over `observations`. */
  wrongRateEwma: number;
}

export interface SlotTally {
  clean: number;
  off: number;
  wrong: number;
  missing: number;
}

export interface TargetTally {
  /** Attempts folded in. */
  attempts: number;
  /** One entry per target slot, in order. */
  slots: SlotTally[];
  /** Notes sung that answered to no slot, across all attempts. */
  extras: number;
  /** Epoch milliseconds of the most recent attempt. */
  updatedAt: number;
}

export interface PracticeStats {
  intervals: ReadonlyMap<number, IntervalStat>;
  targets: ReadonlyMap<string, TargetTally>;
}

export function emptyStats(): PracticeStats {
  return { intervals: new Map(), targets: new Map() };
}

function emptyInterval(interval: number): IntervalStat {
  return {
    interval,
    observations: 0,
    clean: 0,
    off: 0,
    wrong: 0,
    missing: 0,
    absCentsEwma: 0,
    centsObservations: 0,
    wrongRateEwma: 0,
  };
}

function emptySlot(): SlotTally {
  return { clean: 0, off: 0, wrong: 0, missing: 0 };
}

/**
 * Fold a new observation in. The first one *sets* the average rather than
 * blending towards it from zero — starting at zero would claim a perfect first
 * attempt the user never made, and would take half a dozen observations to work
 * its way out of.
 */
function ewma(previous: number, count: number, value: number): number {
  return count === 0 ? value : previous + EWMA_ALPHA * (value - previous);
}

/**
 * Record one attempt at one target.
 *
 * Returns a new {@link PracticeStats}; the input is untouched.
 *
 * `target` is passed alongside the alignment because the alignment carries the
 * target's pitches but not the fact that two adjacent slots are a rising fourth
 * apart — the intervals are a property of the melody, and re-deriving them here
 * keeps the alignment shape free of anything only the statistics care about.
 */
export function recordAttempt(
  stats: PracticeStats,
  targetId: string,
  target: readonly TargetNote[],
  alignment: Alignment,
  at: number = Date.now(),
): PracticeStats {
  const intervals = new Map(stats.intervals);
  const targets = new Map(stats.targets);

  for (const slot of alignment.slots) {
    // Slot 0 arrives from nowhere: there is no interval into the first note of
    // a melody, so it contributes to the per-slot tally and nothing else.
    if (slot.slot === 0 || slot.slot >= target.length) continue;
    const interval = target[slot.slot].midi - target[slot.slot - 1].midi;
    const previous = intervals.get(interval) ?? emptyInterval(interval);
    const next: IntervalStat = { ...previous };

    if (slot.verdict === "missing") {
      next.missing++;
    } else {
      next.wrongRateEwma = ewma(
        previous.wrongRateEwma,
        previous.observations,
        slot.verdict === "wrong" ? 1 : 0,
      );
      next.observations++;
      if (slot.verdict === "wrong") {
        next.wrong++;
      } else {
        // `clean` and `off` are the two ways of hitting the right note, and
        // only they say anything about aim.
        next[slot.verdict]++;
        next.absCentsEwma = ewma(
          previous.absCentsEwma,
          previous.centsObservations,
          Math.abs(slot.residualCents ?? 0),
        );
        next.centsObservations++;
      }
    }
    intervals.set(interval, next);
  }

  const existing = targets.get(targetId);
  // A target whose note count changed is not the target this history was about
  // — slot 4 of a seven-note melody and slot 4 of a five-note one are different
  // places. Starting over is the only honest answer; silently padding or
  // truncating would leave a heatmap pointing at the wrong bar.
  const reusable = existing && existing.slots.length === target.length ? existing : null;
  const slots = reusable
    ? reusable.slots.map((tally) => ({ ...tally }))
    : target.map(() => emptySlot());
  for (const slot of alignment.slots) {
    if (slot.slot < slots.length) slots[slot.slot][slot.verdict]++;
  }

  targets.set(targetId, {
    attempts: (reusable?.attempts ?? 0) + 1,
    slots,
    extras: (reusable?.extras ?? 0) + alignment.extras.length,
    updatedAt: at,
  });

  return { intervals, targets };
}

/** Drop everything remembered about one target — for when it is deleted. */
export function forgetTarget(stats: PracticeStats, targetId: string): PracticeStats {
  if (!stats.targets.has(targetId)) return stats;
  const targets = new Map(stats.targets);
  targets.delete(targetId);
  // The interval statistics deliberately survive: they are about the whistler,
  // not about the melody that happened to reveal them.
  return { intervals: stats.intervals, targets };
}

/**
 * Per-slot trouble, 0..1, for a heatmap.
 *
 * The weights are a display heuristic, not a measurement, and they encode one
 * judgement: a wrong note is a full failure, a slot never sung is nearly as bad
 * (a recall failure still means you do not have that bar), and an off-pitch
 * note is worth a visible tint but not an alarm — being 40 cents flat is the
 * normal condition of a beginner's whistle, and colouring it like a mistake
 * would leave the whole picture red and say nothing.
 */
export function slotTrouble(tally: TargetTally): number[] {
  return tally.slots.map((slot) => {
    const total = slot.clean + slot.off + slot.wrong + slot.missing;
    if (total === 0) return 0;
    const score = (slot.wrong + 0.7 * slot.missing + 0.35 * slot.off) / total;
    return Math.min(1, score);
  });
}

/**
 * How badly one interval is going, 0..1.5-ish, for drill selection.
 *
 * A wrong note counts for a full point; aim contributes at most half a point,
 * scaled by {@link OFF_CENTS} because that is where being off-pitch stops being
 * off-pitch and becomes a wrong note — i.e. the natural unit of "as bad as a
 * production error can get before it is something else".
 */
export function intervalWeakness(stat: IntervalStat): number {
  const aim = stat.centsObservations > 0 ? Math.min(1, stat.absCentsEwma / OFF_CENTS) : 0;
  return stat.wrongRateEwma + 0.5 * aim;
}

export interface WeakestOptions {
  limit?: number;
  /** Below this many observations an interval is noise, not a weakness. */
  minObservations?: number;
}

/** The intervals worth drilling, worst first. Deterministic on ties. */
export function weakestIntervals(
  stats: PracticeStats,
  options: WeakestOptions = {},
): IntervalStat[] {
  const minObservations = options.minObservations ?? 3;
  const ranked = [...stats.intervals.values()]
    .filter((stat) => stat.observations >= minObservations)
    .sort((a, b) => {
      const byWeakness = intervalWeakness(b) - intervalWeakness(a);
      if (Math.abs(byWeakness) > 1e-12) return byWeakness;
      // More evidence first, then by interval, so the order never depends on
      // Map insertion order.
      if (b.observations !== a.observations) return b.observations - a.observations;
      return a.interval - b.interval;
    });
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}

/* ── Serialisation ────────────────────────────────────────────────────────
 *
 * A versioned, plain-JSON, self-describing shape. Field names rather than
 * tuples: the whole thing is a couple of kilobytes even after months of
 * practice, so there is nothing to win by compressing it and plenty to lose —
 * this is the one artefact a maintainer will read out of a device's
 * localStorage while working out why the app thinks someone's rising sixths are
 * fine.
 *
 * `statsFromJson` never throws and never propagates a half-read structure. The
 * data lives in a store that private-browsing modes, other tabs and older
 * versions of this app can all write to, so anything unrecognised is dropped
 * field by field and what remains is still a valid `PracticeStats`. Losing a
 * practice history is a disappointment; a crash on boot is a broken app.
 */

export const STATS_VERSION = 1;

interface IntervalJson {
  observations: number;
  clean: number;
  off: number;
  wrong: number;
  missing: number;
  absCentsEwma: number;
  centsObservations: number;
  wrongRateEwma: number;
}

interface TargetJson {
  attempts: number;
  extras: number;
  updatedAt: number;
  slots: SlotTally[];
}

export interface PracticeStatsJson {
  version: number;
  intervals: Record<string, IntervalJson>;
  targets: Record<string, TargetJson>;
}

export function statsToJson(stats: PracticeStats): PracticeStatsJson {
  const intervals: Record<string, IntervalJson> = {};
  for (const [interval, stat] of stats.intervals) {
    intervals[String(interval)] = {
      observations: stat.observations,
      clean: stat.clean,
      off: stat.off,
      wrong: stat.wrong,
      missing: stat.missing,
      absCentsEwma: stat.absCentsEwma,
      centsObservations: stat.centsObservations,
      wrongRateEwma: stat.wrongRateEwma,
    };
  }
  const targets: Record<string, TargetJson> = {};
  for (const [id, tally] of stats.targets) {
    targets[id] = {
      attempts: tally.attempts,
      extras: tally.extras,
      updatedAt: tally.updatedAt,
      slots: tally.slots.map((slot) => ({ ...slot })),
    };
  }
  return { version: STATS_VERSION, intervals, targets };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, or the fallback. Rejects strings, `NaN` and `Infinity`. */
function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A non-negative integer count, or 0. */
function count(value: unknown): number {
  const n = number(value, 0);
  return n >= 0 ? Math.floor(n) : 0;
}

export function statsFromJson(raw: unknown): PracticeStats {
  const root = record(raw);
  // An unknown version is a future format this build cannot read. Starting
  // fresh loses history; guessing at the fields would corrupt it.
  if (!root || number(root.version, -1) !== STATS_VERSION) return emptyStats();

  const intervals = new Map<number, IntervalStat>();
  for (const [key, value] of Object.entries(record(root.intervals) ?? {})) {
    const interval = Number(key);
    const entry = record(value);
    if (!Number.isInteger(interval) || !entry) continue;
    intervals.set(interval, {
      interval,
      observations: count(entry.observations),
      clean: count(entry.clean),
      off: count(entry.off),
      wrong: count(entry.wrong),
      missing: count(entry.missing),
      absCentsEwma: Math.max(0, number(entry.absCentsEwma)),
      centsObservations: count(entry.centsObservations),
      wrongRateEwma: Math.min(1, Math.max(0, number(entry.wrongRateEwma))),
    });
  }

  const targets = new Map<string, TargetTally>();
  for (const [id, value] of Object.entries(record(root.targets) ?? {})) {
    const entry = record(value);
    if (!entry || !Array.isArray(entry.slots)) continue;
    const slots = entry.slots.map((slot) => {
      const parsed = record(slot);
      return {
        clean: count(parsed?.clean),
        off: count(parsed?.off),
        wrong: count(parsed?.wrong),
        missing: count(parsed?.missing),
      };
    });
    targets.set(id, {
      attempts: count(entry.attempts),
      extras: count(entry.extras),
      updatedAt: count(entry.updatedAt),
      slots,
    });
  }

  return { intervals, targets };
}
