/**
 * Practice mode's state, and the only thing in this feature that touches
 * storage.
 *
 * The shape follows `src/ui/state.ts` exactly — module state, a `Set` of
 * listeners, one patch function — for the same reason it works there: practice
 * state changes a handful of times per session (open a screen, save a target,
 * finish an attempt), never on a hot path. There is no hot path in practice
 * mode that this store is on; the live pitch readout during an attempt is the
 * transcribe store's rAF loop, untouched.
 *
 * It is a *second* store rather than more fields on the first because the two
 * have different lifetimes. `AppState` is about the take on screen right now
 * and is thrown away on the next tap; this is a library and a history that
 * outlive the session, the tab and the app version. Merging them would put a
 * practice history behind every `setState` call in the transcription path.
 *
 * ## Persistence, and the two ways it goes wrong
 *
 * Two keys, both versioned:
 *
 * - `whistle-notes:practice:v1` — the target library and the measured range.
 *   Written when the user changes something, which is rarely.
 * - `whistle-notes:practice-stats:v1` — the attempt history. Written after
 *   every attempt, which is often.
 *
 * Separate keys because a failure to write one must not take the other with
 * it: a full storage quota reached by a growing history should not be able to
 * lose the library it is a history *of*.
 *
 * **Reading** is wrapped in `try`/`catch` from end to end, per this codebase's
 * convention (see `loadTranspose` in `src/ui/state.ts`): `localStorage` throws
 * outright in some privacy modes, and a practice library nobody can read must
 * never be a practice mode nobody can open.
 *
 * **Writing** cannot corrupt. Each key holds one complete JSON document written
 * with one `setItem`, which is atomic — a rejected write leaves the previous
 * document exactly as it was, so the worst case is a session's work that is not
 * remembered, never a library that comes back half-eaten. When that happens the
 * store says so on screen through `storageError` rather than swallowing it: the
 * in-memory state is still correct and still usable, and the user deserves to
 * know before they close the tab that it is not going to survive.
 */

import type { Alignment, TargetNote } from "./align.js";
import { isUsableRange, rangeFromEnds, type WhistleRange } from "./range.js";
import { parseTarget, type PracticeTarget } from "./target.js";
import {
  emptyStats,
  forgetTarget,
  recordAttempt,
  statsFromJson,
  statsToJson,
  type PracticeStats,
} from "./stats.js";

const LIBRARY_KEY = "whistle-notes:practice:v1";
const STATS_KEY = "whistle-notes:practice-stats:v1";
const LIBRARY_VERSION = 1;

/**
 * Which practice screen is showing.
 *
 * A tiny amount of routing, in the store rather than in the view, because the
 * app has to be able to leave a screen from outside it — finishing a range take
 * lands back on the library, and deleting the selected target cannot leave a
 * detail screen pointing at nothing.
 */
export type PracticeScreen = "library" | "target" | "range";

/** Which end of the range the user is being asked for, during the check. */
export type RangeStep = "low" | "high";

/**
 * The ends captured so far in the range check.
 *
 * A range needs two takes and the user makes them one at a time, so there is a
 * moment where one end is known and the other is not — and that is not yet a
 * range. Seeded from the stored range when the check opens, which is what makes
 * "just re-do the high one" work without asking for the low one again.
 *
 * Never persisted: a half-finished measurement is not worth remembering, and
 * once it *is* finished it becomes `range`, which is.
 */
export interface RangeDraft {
  low: number | null;
  high: number | null;
}

export interface PracticeState {
  screen: PracticeScreen;
  /** Newest first. */
  targets: readonly PracticeTarget[];
  selectedId: string | null;
  /** The measured comfortable register, or `null` if never measured. */
  range: WhistleRange | null;
  stats: PracticeStats;
  /** The end being captured right now, or `null` when not capturing. */
  rangeStep: RangeStep | null;
  rangeDraft: RangeDraft;
  /** Progress or feedback for the screen on show. */
  message: string;
  /** Set when a write was refused. Visible, and never cleared silently. */
  storageError: string | null;
}

type Listener = (state: PracticeState) => void;
const listeners = new Set<Listener>();

interface StoredLibrary {
  targets: PracticeTarget[];
  range: WhistleRange | null;
}

/** Everything under one `try`: a storage that throws on `getItem` (private
 *  modes do) must land on an empty library, not on a broken app. */
function loadLibrary(): StoredLibrary {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (raw === null) return { targets: [], range: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { targets: [], range: null };
    const value = parsed as Record<string, unknown>;
    // An unknown version is a document a future build wrote. Reading it with
    // this build's field names would import nonsense that then gets written
    // back over the real thing.
    if (value.version !== LIBRARY_VERSION) return { targets: [], range: null };

    const targets: PracticeTarget[] = [];
    if (Array.isArray(value.targets)) {
      for (const entry of value.targets) {
        // One unreadable target loses one target, not the library.
        const target = parseTarget(entry);
        if (target) targets.push(target);
      }
    }
    return { targets: sortTargets(targets), range: parseRange(value.range) };
  } catch {
    return { targets: [], range: null };
  }
}

function parseRange(raw: unknown): WhistleRange | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const range = { lowMidi: Number(value.lowMidi), highMidi: Number(value.highMidi) };
  return isUsableRange(range) ? range : null;
}

function loadStats(): PracticeStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw === null ? emptyStats() : statsFromJson(JSON.parse(raw));
  } catch {
    return emptyStats();
  }
}

/** Newest first: the target you just saved is the one you want to practise. */
function sortTargets(targets: readonly PracticeTarget[]): PracticeTarget[] {
  return [...targets].sort((a, b) => b.createdAt - a.createdAt);
}

const restored = loadLibrary();

let state: PracticeState = {
  screen: "library",
  targets: restored.targets,
  selectedId: null,
  range: restored.range,
  stats: loadStats(),
  rangeStep: null,
  rangeDraft: draftFrom(restored.range),
  message: "",
  storageError: null,
};

function draftFrom(range: WhistleRange | null): RangeDraft {
  return range ? { low: range.lowMidi, high: range.highMidi } : { low: null, high: null };
}

export function getPracticeState(): PracticeState {
  return state;
}

/** Merge a patch and notify. The only way practice state ever changes. */
export function setPracticeState(patch: Partial<PracticeState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/** Subscribe; returns an unsubscribe function. */
export function subscribePractice(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The one sentence the app says when storage refuses.
 *
 * Deliberately about the *consequence* rather than the cause. "QuotaExceeded"
 * is not actionable; "this will be gone when you close the app" is, and it is
 * the only thing the user can do anything about.
 */
export const STORAGE_ERROR_MESSAGE =
  "Could not save to this device's storage — practice data will be lost when the app closes.";

/**
 * Write one key. Returns whether it stuck.
 *
 * Atomic by construction: one complete document, one `setItem`. A refusal
 * leaves whatever was there before, which is why nothing here has to think
 * about rolling back.
 */
function write(key: string, document: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(document));
    return true;
  } catch {
    return false;
  }
}

function persistLibrary(next: Pick<PracticeState, "targets" | "range">): string | null {
  return write(LIBRARY_KEY, {
    version: LIBRARY_VERSION,
    targets: next.targets,
    range: next.range,
  })
    ? null
    : STORAGE_ERROR_MESSAGE;
}

function persistStats(stats: PracticeStats): string | null {
  return write(STATS_KEY, statsToJson(stats)) ? null : STORAGE_ERROR_MESSAGE;
}

/* ── Navigation ───────────────────────────────────────────────────────── */

export function showLibrary(message = ""): void {
  setPracticeState({ screen: "library", selectedId: null, rangeStep: null, message });
}

export function selectTarget(id: string): void {
  if (!state.targets.some((target) => target.id === id)) return;
  setPracticeState({ screen: "target", selectedId: id, rangeStep: null, message: "" });
}

/** The selected target, or `null` — including after it was deleted. */
export function selectedTarget(): PracticeTarget | null {
  return state.targets.find((target) => target.id === state.selectedId) ?? null;
}

export function showRangeCheck(): void {
  setPracticeState({
    screen: "range",
    rangeStep: null,
    // Seeded from what is already known, so re-measuring one end does not
    // demand the other one back.
    rangeDraft: draftFrom(state.range),
    message: "",
  });
}

/** Mark which end is being captured, so the view can say what to whistle. */
export function beginRangeStep(step: RangeStep): void {
  setPracticeState({ screen: "range", rangeStep: step, message: "" });
}

export function endRangeStep(message = ""): void {
  setPracticeState({ rangeStep: null, message });
}

export function setPracticeMessage(message: string): void {
  setPracticeState({ message });
}

/** Acknowledge a storage failure. The only way the notice ever goes away. */
export function clearStorageError(): void {
  if (state.storageError !== null) setPracticeState({ storageError: null });
}

/* ── The library ──────────────────────────────────────────────────────── */

/**
 * Save a target. T2's three sources — recorded, MIDI, bundled — all land here.
 */
export function addTarget(target: PracticeTarget): void {
  const targets = sortTargets([...state.targets, target]);
  setPracticeState({
    targets,
    storageError: persistLibrary({ targets, range: state.range }),
  });
}

/**
 * Delete a target and everything remembered about it.
 *
 * The per-slot history goes with it — it is about a melody that no longer
 * exists, and an id can be reused. The per-interval statistics stay: those are
 * about the whistler, and were paid for in practice time.
 */
export function removeTarget(id: string): void {
  if (!state.targets.some((target) => target.id === id)) return;
  const targets = state.targets.filter((target) => target.id !== id);
  const stats = forgetTarget(state.stats, id);
  const libraryError = persistLibrary({ targets, range: state.range });
  const statsError = persistStats(stats);
  setPracticeState({
    targets,
    stats,
    screen: state.selectedId === id ? "library" : state.screen,
    selectedId: state.selectedId === id ? null : state.selectedId,
    storageError: libraryError ?? statsError,
  });
}

/* ── The range ────────────────────────────────────────────────────────── */

export function setRange(range: WhistleRange | null): void {
  setPracticeState({
    range,
    rangeStep: null,
    rangeDraft: draftFrom(range),
    storageError: persistLibrary({ targets: state.targets, range }),
  });
}

/**
 * Record one measured end. Returns whether the range is now complete.
 *
 * The ends are *sorted* into the range rather than trusted by their labels:
 * "whistle something low, now something high" is an instruction people get
 * backwards, and a range with its ends crossed would silently disable every
 * transposition that depends on it. The draft keeps the labels as given so the
 * screen can still say which button has been answered.
 */
export function captureRangeEnd(step: RangeStep, midi: number): boolean {
  const rangeDraft: RangeDraft = { ...state.rangeDraft, [step]: midi };
  if (rangeDraft.low === null || rangeDraft.high === null) {
    setPracticeState({ rangeDraft, rangeStep: null });
    return false;
  }
  const range = rangeFromEnds(rangeDraft.low, rangeDraft.high);
  setPracticeState({
    range,
    rangeDraft,
    rangeStep: null,
    storageError: persistLibrary({ targets: state.targets, range }),
  });
  return true;
}

/* ── The history ──────────────────────────────────────────────────────── */

/**
 * Fold one finished attempt into the history and persist it.
 *
 * The alignment is computed by the caller (it needs the target *as played*,
 * which may have been octave-shifted into the user's range), and the intervals
 * are read from the notes passed here — so a target played an octave up still
 * contributes to the same interval buckets, which is the entire reason
 * intervals are keyed by step rather than by pitch.
 */
export function recordPracticeAttempt(
  targetId: string,
  notes: readonly TargetNote[],
  alignment: Alignment,
  at: number = Date.now(),
): void {
  const stats = recordAttempt(state.stats, targetId, notes, alignment, at);
  setPracticeState({ stats, storageError: persistStats(stats) });
}
