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
import {
  drillRange,
  echoPhrase,
  echoRampText,
  echoSucceeded,
  holdReference,
  nextEchoLength,
  ECHO_MIN_NOTES,
  type HoldScore,
  type Rng,
} from "./drill.js";
import type { MidiMelody } from "./midi.js";
import type { HeardNote, TrailPoint } from "./recall.js";
import {
  isUsableRange,
  rangeFromEnds,
  transposeIntoRange,
  type WhistleRange,
} from "./range.js";
import {
  draftTarget,
  parseTarget,
  type PracticeTarget,
  type TargetDraft,
} from "./target.js";
import {
  emptyStats,
  forgetTarget,
  recordAttempt,
  recordDrillAttempt,
  recordHold,
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
export type PracticeScreen =
  | "library"
  | "target"
  | "range"
  | "draft"
  | "midi"
  | "recall"
  | "hold"
  | "echo"
  | "follow";

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

/**
 * A MIDI file that has been read but not yet chosen from.
 *
 * Held in the store rather than in the view because picking a part is a screen
 * of its own, and because the file is gone by then — the `File` object belongs
 * to an input that has already been cleared, so whatever the parse produced is
 * all there will ever be.
 */
export interface MidiPick {
  /** What the file was called, as the default name for whatever is picked. */
  fileName: string;
  melodies: readonly MidiMelody[];
}

/**
 * What came back from one attempt, and everything the result screen draws.
 *
 * Held together rather than as three fields because they are only ever true of
 * each other: the alignment is *of* those notes, and the trail is the
 * measurement underneath them. Splitting them would make a half-updated result
 * — a new alignment against an old trail — representable, and it would be
 * representable at exactly the moment the user is looking at it.
 */
export interface RecallAttempt {
  /** As whistled, with the times the segmenter gave each note. */
  notes: readonly HeardNote[];
  /** The continuous pitch measurement under those notes. */
  trail: readonly TrailPoint[];
  alignment: Alignment;
}

/**
 * One run through the recall exercise: listen, whistle, look.
 *
 * Never persisted, for the reason drafts are not: it is a moment, not a
 * possession. The history it produces *is* persisted, in the stats.
 *
 * `notes` is the melody **as played** — already moved into the whistler's
 * register — and it is captured once when the screen opens rather than
 * recomputed. Everything downstream (the synth, the aligner, the interval
 * statistics) has to agree about which notes were in the air, and a range
 * measured again mid-session must not be able to change the answer to what the
 * user just heard.
 */
export interface RecallSession {
  targetId: string;
  notes: readonly TargetNote[];
  /** How many times the melody has been played this session. No cap, and no
   *  judgement: see `listenCountText` in `recall.ts`. */
  listens: number;
  /** Whether the take now running is this exercise's attempt. */
  recording: boolean;
  /** The finished attempt, or `null` before one has been made. */
  attempt: RecallAttempt | null;
}

/**
 * One round of the hold drill: hear a note, hold it, see the two numbers.
 *
 * The reference is chosen once and kept here for the same reason the recall
 * session keeps its transposed melody: the synth, the live needle and the score
 * all have to agree about which note was in the air, and re-rolling it — or
 * re-deriving it from a range measured again in between — would leave the needle
 * centred on a note the user never heard.
 */
export interface HoldSession {
  /** The note being held, already in the whistler's register. */
  referenceMidi: number;
  /** How many times it has been played this round. Uncapped, like recall's
   *  listen count, and for the same reason. */
  plays: number;
  /** Whether the take now running is this drill's hold. */
  recording: boolean;
  /** The finished score, or `null` before one has been made. */
  score: HoldScore | null;
}

/**
 * One round of the phrase-echo drill.
 *
 * `phrase` is generated, not chosen, and it is the only copy: it is what the
 * synth plays, what the aligner scores against, and what the interval ledger
 * reads its steps from — the same three-way agreement `RecallSession` needs, for
 * the same reason.
 *
 * `length` is the *ramp's* current setting rather than `phrase.length`, because
 * they differ for exactly one render: after an attempt the ramp has moved but
 * the phrase on screen is still the one that was whistled.
 */
export interface EchoSession {
  phrase: readonly TargetNote[];
  /** How long the *next* phrase will be, 3–6. */
  length: number;
  listens: number;
  recording: boolean;
  attempt: RecallAttempt | null;
  /** What the ramp did after the last attempt, for the line on screen. */
  ramp: string;
}

/**
 * The warm-up: a melody scrolling past while the user whistles along.
 *
 * The only place in the app where the microphone and the speaker are open at
 * once. Nothing is scored and nothing is stored — see `practice/follow.ts` for
 * why that is what makes it safe to do at all.
 */
export interface FollowSession {
  targetId: string;
  /** The melody as it will be played: already in the whistler's register. */
  notes: readonly TargetNote[];
  /** Whether the melody is running right now. */
  running: boolean;
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
  /**
   * The target being made right now, or `null`.
   *
   * Never persisted, deliberately: a half-made target is a decision in
   * progress, and restoring one on the next launch would confront the user with
   * a screen full of notes they no longer remember recording. The cost is
   * honest — a take is lost if the app is closed mid-draft — and the fix is to
   * save first and rename later, which the library allows.
   */
  draft: TargetDraft | null;
  /** A parsed MIDI file waiting to be picked from, or `null`. */
  midi: MidiPick | null;
  /** The recall exercise now running, or `null`. */
  recall: RecallSession | null;
  /** The hold drill now running, or `null`. */
  hold: HoldSession | null;
  /** The phrase-echo drill now running, or `null`. */
  echo: EchoSession | null;
  /** The follow-along warm-up now running, or `null`. */
  follow: FollowSession | null;
  /** Whether a take is being recorded *into a draft* (rather than for the
   *  range check). Cleared the moment the notes arrive. */
  recordingTarget: boolean;
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
  draft: null,
  midi: null,
  recall: null,
  hold: null,
  echo: null,
  follow: null,
  recordingTarget: false,
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
  setPracticeState({
    screen: "library",
    selectedId: null,
    rangeStep: null,
    // Leaving for the library ends every half-finished thing: an abandoned
    // draft and a picked-but-unchosen file are both about a screen that is no
    // longer showing, and keeping either would make the next tap on "record a
    // target" land in the middle of the last one.
    draft: null,
    midi: null,
    recall: null,
    hold: null,
    echo: null,
    follow: null,
    recordingTarget: false,
    message,
  });
}

export function selectTarget(id: string, message = ""): void {
  if (!state.targets.some((target) => target.id === id)) return;
  setPracticeState({
    screen: "target",
    selectedId: id,
    rangeStep: null,
    // An exercise belongs to the screen it is on; walking back to the melody
    // ends it, so the next "Practice this" starts from a clean listen count
    // rather than from someone else's half-finished attempt.
    recall: null,
    hold: null,
    echo: null,
    follow: null,
    message,
  });
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

/* ── Making one ───────────────────────────────────────────────────────── */

/**
 * Mark that the take now running is going to become a target.
 *
 * Separate from `rangeStep` because the two takes mean different things and end
 * in different places, and because the screen has to be able to say which one
 * is happening. Set before the notes exist and cleared when they arrive, so the
 * button that started it is the button that stops it.
 */
export function beginTargetTake(): void {
  setPracticeState({ recordingTarget: true, message: "" });
}

/** The take is over and it did not become a draft. Says why, and puts the
 *  button that started it back to how it was. */
export function endTargetTake(message = ""): void {
  setPracticeState({ recordingTarget: false, message });
}

/** Open the draft screen on a melody that has just arrived. */
export function beginDraft(draft: TargetDraft): void {
  setPracticeState({ screen: "draft", draft, recordingTarget: false, message: "" });
}

/** Replace the draft with an edited copy. Every trim, shift and keystroke. */
export function editDraft(draft: TargetDraft): void {
  if (state.draft === null) return;
  setPracticeState({ draft });
}

/**
 * Leave the draft without saving.
 *
 * Back to the part picker when the draft came from one — picking the wrong
 * part of a MIDI file is the normal mistake, and making the user find the file
 * again to fix it would be gratuitous.
 */
export function discardDraft(message = ""): void {
  if (state.midi) {
    setPracticeState({ screen: "midi", draft: null, message });
    return;
  }
  showLibrary(message);
}

/** Show the parts of a MIDI file that has just been read. */
export function showMidiPicker(pick: MidiPick): void {
  setPracticeState({ screen: "midi", midi: pick, draft: null, message: "" });
}

/**
 * Save the draft on screen, and land back in the library.
 *
 * Goes through {@link addTarget} like every other source rather than writing
 * the library itself: one landing point is what keeps the persistence, the
 * sorting and the storage-error reporting from having a second copy that drifts.
 */
export function saveDraft(fallbackName: string, createdAt: number = Date.now()): void {
  const draft = state.draft;
  if (draft === null) return;
  const target = draftTarget(draft, fallbackName, createdAt);
  addTarget(target);
  setPracticeState({
    screen: "library",
    selectedId: null,
    draft: null,
    midi: null,
    recordingTarget: false,
    message: `Saved “${target.name}”.`,
  });
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
    // An exercise about a melody that no longer exists has nothing to play and
    // nothing to score.
    recall: state.recall?.targetId === id ? null : state.recall,
    follow: state.follow?.targetId === id ? null : state.follow,
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

/* ── Recall ───────────────────────────────────────────────────────────── */

/**
 * Open the recall exercise on a target.
 *
 * The melody is moved into the whistler's register **here, once**, and the
 * result is what the synth plays and what the aligner scores against. That is
 * the single most load-bearing line of the exercise: score against the written
 * pitch while playing the transposed one and every attempt comes back an octave
 * wrong, with the aligner dutifully explaining a register error the app itself
 * introduced.
 */
export function beginRecall(targetId: string): void {
  const target = state.targets.find((candidate) => candidate.id === targetId);
  if (!target) return;
  setPracticeState({
    screen: "recall",
    selectedId: targetId,
    recall: {
      targetId,
      notes: transposeIntoRange(target.notes, state.range),
      listens: 0,
      recording: false,
      attempt: null,
    },
    message: "",
  });
}

/** Count one play-through. The screen says how many; nothing gates on it. */
export function countRecallListen(): void {
  const recall = state.recall;
  if (!recall) return;
  setPracticeState({ recall: { ...recall, listens: recall.listens + 1 }, message: "" });
}

/** Mark that the take now running is this exercise's attempt. Set before the
 *  notes exist and cleared when they arrive, so the button that started it is
 *  the button that stops it — the same rule the other two takes follow. */
export function beginRecallTake(): void {
  const recall = state.recall;
  if (!recall) return;
  setPracticeState({ recall: { ...recall, recording: true }, message: "" });
}

/** The attempt ended without producing one. Says why, and puts the button back. */
export function endRecallTake(message = ""): void {
  const recall = state.recall;
  if (!recall) return;
  setPracticeState({ recall: { ...recall, recording: false }, message });
}

/**
 * An attempt arrived: score it, remember it, and show it.
 *
 * One patch, on purpose. The statistics and the result on screen are two views
 * of the same event, and a state where the heatmap has heard about an attempt
 * the diff overlay has not — or the reverse — is one the user can see.
 */
export function finishRecallAttempt(
  attempt: RecallAttempt,
  at: number = Date.now(),
): void {
  const recall = state.recall;
  if (!recall) return;
  setPracticeState({
    recall: { ...recall, recording: false, attempt },
    message: "",
    ...foldAttempt(recall.targetId, recall.notes, attempt.alignment, at),
  });
}

/** Back to the listen screen for another go at the same melody. The listen
 *  count survives: it is about this sitting, not about this attempt. */
export function retryRecall(): void {
  const recall = state.recall;
  if (!recall) return;
  setPracticeState({ recall: { ...recall, recording: false, attempt: null }, message: "" });
}

/** Leave the exercise, back to the melody it was about. */
export function closeRecall(): void {
  if (state.recall) selectTarget(state.recall.targetId);
  else showLibrary();
}

/* ── Drill one: hold a note ───────────────────────────────────────────── */

/**
 * Open the hold drill on a fresh reference note.
 *
 * The register is worked out here, once, from whatever the range check knows —
 * or from the default when it knows nothing. `rng` is a parameter with a default
 * for the same reason `at` is throughout this file: the store is where the
 * impure defaults live, and a test that wants a reproducible drill should not
 * have to stub a global to get one.
 */
export function beginHold(rng: Rng = Math.random): void {
  setPracticeState({
    screen: "hold",
    hold: {
      referenceMidi: holdReference(drillRange(state.range), rng),
      plays: 0,
      recording: false,
      score: null,
    },
    message: "",
  });
}

/** Count one play of the reference. Nothing gates on it. */
export function countHoldPlay(): void {
  const hold = state.hold;
  if (!hold) return;
  setPracticeState({ hold: { ...hold, plays: hold.plays + 1 }, message: "" });
}

/** Mark that the take now running is this drill's hold — the same
 *  set-before-the-notes-exist rule every other take in the app follows. */
export function beginHoldTake(): void {
  const hold = state.hold;
  if (!hold) return;
  setPracticeState({ hold: { ...hold, recording: true }, message: "" });
}

/** The hold ended without producing a score. Says why, and puts the button back. */
export function endHoldTake(message = ""): void {
  const hold = state.hold;
  if (!hold) return;
  setPracticeState({ hold: { ...hold, recording: false }, message });
}

/** A scored hold: show it, remember the two numbers, persist. */
export function finishHold(score: HoldScore, at: number = Date.now()): void {
  const hold = state.hold;
  if (!hold) return;
  const stats = recordHold(state.stats, score.medianCents, score.wobbleCents, at);
  setPracticeState({
    hold: { ...hold, recording: false, score },
    stats,
    storageError: persistStats(stats),
    message: "",
  });
}

/** Another go at the same note. The play count survives: it is about this
 *  sitting with this reference, not about this attempt at it. */
export function retryHold(): void {
  const hold = state.hold;
  if (!hold) return;
  setPracticeState({ hold: { ...hold, recording: false, score: null }, message: "" });
}

/** A different note, and a clean slate to hear it against. */
export function nextHold(rng: Rng = Math.random): void {
  const hold = state.hold;
  if (!hold) return;
  setPracticeState({
    hold: {
      referenceMidi: holdReference(drillRange(state.range), rng, hold.referenceMidi),
      plays: 0,
      recording: false,
      score: null,
    },
    message: "",
  });
}

/* ── Drill two: echo a phrase ─────────────────────────────────────────── */

/** A phrase of the given length, generated against the whistler's register and
 *  biased by everything the history knows. One place, so the opening phrase and
 *  every later one are made the same way. */
function makeEchoPhrase(length: number, rng: Rng): TargetNote[] {
  return echoPhrase(rng, { length, range: state.range, stats: state.stats });
}

/** Open the echo drill at the shortest phrase. Difficulty is earned, not
 *  remembered: a session that starts where the last one ended would open with
 *  six notes for someone who has not whistled since Tuesday. */
export function beginEcho(rng: Rng = Math.random): void {
  setPracticeState({
    screen: "echo",
    echo: {
      phrase: makeEchoPhrase(ECHO_MIN_NOTES, rng),
      length: ECHO_MIN_NOTES,
      listens: 0,
      recording: false,
      attempt: null,
      ramp: "",
    },
    message: "",
  });
}

export function countEchoListen(): void {
  const echo = state.echo;
  if (!echo) return;
  setPracticeState({ echo: { ...echo, listens: echo.listens + 1 }, message: "" });
}

export function beginEchoTake(): void {
  const echo = state.echo;
  if (!echo) return;
  setPracticeState({ echo: { ...echo, recording: true }, message: "" });
}

export function endEchoTake(message = ""): void {
  const echo = state.echo;
  if (!echo) return;
  setPracticeState({ echo: { ...echo, recording: false }, message });
}

/**
 * An echo arrived: score it, fold its intervals into the shared ledger, and
 * move the ramp.
 *
 * One patch, exactly as `finishRecallAttempt` is one patch, and for the same
 * reason: the ramp, the statistics and the picture on screen are three views of
 * one event.
 *
 * The ledger is the *interval* one, and only that — see `recordDrillAttempt`.
 * A generated phrase has no identity to accumulate a slot history against.
 */
export function finishEchoAttempt(attempt: RecallAttempt): void {
  const echo = state.echo;
  if (!echo) return;
  const success = echoSucceeded(attempt.alignment);
  const length = nextEchoLength(echo.length, success);
  const stats = recordDrillAttempt(state.stats, echo.phrase, attempt.alignment);
  setPracticeState({
    echo: {
      ...echo,
      recording: false,
      attempt,
      length,
      ramp: echoRampText(echo.length, length),
    },
    stats,
    storageError: persistStats(stats),
    message: "",
  });
}

/** The same phrase again — for when the ear got it and the mouth did not. */
export function retryEcho(): void {
  const echo = state.echo;
  if (!echo) return;
  setPracticeState({
    echo: { ...echo, recording: false, attempt: null, listens: 0, ramp: "" },
    message: "",
  });
}

/** A new phrase at whatever length the ramp has arrived at. */
export function nextEcho(rng: Rng = Math.random): void {
  const echo = state.echo;
  if (!echo) return;
  setPracticeState({
    echo: {
      phrase: makeEchoPhrase(echo.length, rng),
      length: echo.length,
      listens: 0,
      recording: false,
      attempt: null,
      ramp: "",
    },
    message: "",
  });
}

/** Leave either drill, back to the library it was started from. */
export function closeDrill(): void {
  showLibrary();
}

/* ── Follow along ─────────────────────────────────────────────────────── */

/**
 * Open the warm-up on a target.
 *
 * The melody is moved into the whistler's register here, once, exactly as
 * `beginRecall` does — nothing is scored, but the user still has to be able to
 * whistle what they are hearing.
 */
export function beginFollow(targetId: string): void {
  const target = state.targets.find((candidate) => candidate.id === targetId);
  if (!target) return;
  setPracticeState({
    screen: "follow",
    selectedId: targetId,
    follow: {
      targetId,
      notes: transposeIntoRange(target.notes, state.range),
      running: false,
    },
    message: "",
  });
}

/** The melody is playing and the microphone is open, or it is not. The one flag
 *  the screen uses to decide whether the only enabled button is Stop. */
export function setFollowRunning(running: boolean): void {
  const follow = state.follow;
  if (!follow || follow.running === running) return;
  setPracticeState({ follow: { ...follow, running }, message: "" });
}

/** Leave the warm-up, back to the melody it was about. */
export function closeFollow(): void {
  if (state.follow) selectTarget(state.follow.targetId);
  else showLibrary();
}

/* ── The history ──────────────────────────────────────────────────────── */

/**
 * Fold one attempt into the statistics and work out whether it stuck.
 *
 * Returns a patch rather than applying one, so a caller with more to say in the
 * same breath — {@link finishRecallAttempt} — can say it in one render.
 */
function foldAttempt(
  targetId: string,
  notes: readonly TargetNote[],
  alignment: Alignment,
  at: number,
): Pick<PracticeState, "stats" | "storageError"> {
  const stats = recordAttempt(state.stats, targetId, notes, alignment, at);
  return { stats, storageError: persistStats(stats) };
}

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
  setPracticeState(foldAttempt(targetId, notes, alignment, at));
}
