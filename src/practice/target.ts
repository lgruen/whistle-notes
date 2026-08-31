/**
 * A practice target: a melody the app can play at you and then listen for.
 *
 * Deliberately thinner than `src/dsp`'s `Note`. A target is not a
 * transcription and must not carry one around — it has no `startSec`, no
 * `confidence`, no frame metrics, because none of those survive the round trip
 * through localStorage in any meaningful way and none of them mean anything
 * about a melody that arrived as a MIDI file or as a bundled tune. Pitch and
 * rough length is the whole contract, and it is the same contract for all three
 * sources (T2), which is what keeps the exercises from having to know where a
 * target came from.
 *
 * ## Ear-first
 *
 * Practice mode's one hard rule is that no exercise ever presents a written or
 * named prompt: the app plays, the user echoes, and note and interval names
 * appear only as passive labels *after* an attempt. That is why a target's
 * summary is its name, its length and where it came from, and never its notes.
 * A library row that listed "C E G E C" would turn choosing a target into
 * sight-reading it, which is precisely the skill this user does not have and
 * the mode is not trying to teach.
 *
 * Pure: no storage, no DOM.
 */

import type { TargetNote } from "./align.js";

export type { TargetNote };

/**
 * Where a target came from. Shown as a badge, because it changes what a bad
 * attempt means: a recorded target carries the user's own transcription errors,
 * and "the app is wrong" is a live possibility for it in a way it is not for a
 * bundled melody.
 */
export type TargetSource = "recorded" | "midi" | "bundled";

export const TARGET_SOURCES: readonly TargetSource[] = ["recorded", "midi", "bundled"];

export const TARGET_SOURCE_LABELS: Record<TargetSource, string> = {
  recorded: "Recorded",
  midi: "MIDI",
  bundled: "Built in",
};

export interface PracticeTarget {
  id: string;
  /** The user's own name for it. Never rendered as markup. */
  name: string;
  source: TargetSource;
  notes: TargetNote[];
  /** Epoch milliseconds. Sorts the library, newest first. */
  createdAt: number;
}

export function isTargetSource(value: unknown): value is TargetSource {
  return typeof value === "string" && (TARGET_SOURCES as readonly string[]).includes(value);
}

/**
 * A collision-resistant-enough id.
 *
 * Not `crypto.randomUUID`: it is missing on older Android WebViews and on
 * anything served over plain http, which is exactly the port-forwarded dev loop
 * this project uses on a phone. The time prefix also makes a stored library
 * readable by eye, which matters when the debugging tool is Chrome's
 * localStorage panel.
 */
export function newTargetId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Total length of the melody, in seconds. */
export function targetDurationSec(target: Pick<PracticeTarget, "notes">): number {
  let total = 0;
  for (const note of target.notes) total += note.durSec;
  return total;
}

/**
 * A duration a human reads at a glance.
 *
 * Seconds with one decimal below a minute rather than `0:04`, because targets
 * are phrases and "0:04" reads like a stopwatch rather than like a length.
 */
export function formatTargetDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0.0 s";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export interface TargetSummary {
  name: string;
  /** "5 notes · 2.1 s · Recorded" — everything a library row says, and nothing
   *  that would turn choosing a target into reading one. */
  detail: string;
  noteCount: number;
  durationText: string;
  sourceLabel: string;
}

export function targetSummary(target: PracticeTarget): TargetSummary {
  const noteCount = target.notes.length;
  const durationText = formatTargetDuration(targetDurationSec(target));
  const sourceLabel = TARGET_SOURCE_LABELS[target.source];
  return {
    name: target.name,
    noteCount,
    durationText,
    sourceLabel,
    detail: `${noteCount} note${noteCount === 1 ? "" : "s"} · ${durationText} · ${sourceLabel}`,
  };
}

/**
 * Build a target from anything that has notes.
 *
 * Takes the `Note` shape `src/dsp` produces (structurally — no import, so this
 * module stays free of the DSP contract) and keeps only what a target is.
 */
export function makeTarget(
  name: string,
  source: TargetSource,
  notes: readonly { midi: number; durationSec: number }[],
  createdAt: number = Date.now(),
): PracticeTarget {
  return targetFromNotes(
    name,
    source,
    notes.map((note) => ({ midi: note.midi, durSec: note.durationSec })),
    createdAt,
  );
}

/**
 * The same thing, from notes that are already in the target's own shape.
 *
 * Which is every source that did not come out of the transcriber: a MIDI file
 * and a bundled melody both arrive as `{midi, durSec}` and have no business
 * being dressed up as `Note`s just to be undressed again one line later.
 */
export function targetFromNotes(
  name: string,
  source: TargetSource,
  notes: readonly TargetNote[],
  createdAt: number = Date.now(),
): PracticeTarget {
  return {
    id: newTargetId(),
    name,
    source,
    notes: notes.map((note) => ({ midi: Math.round(note.midi), durSec: note.durSec })),
    createdAt,
  };
}

/* ── Drafts ───────────────────────────────────────────────────────────── */

/**
 * A target that is being made, before it is one.
 *
 * Every source needs the same three decisions before its notes are worth
 * keeping, and none of them can be made for the user:
 *
 * - **Where the melody starts and stops.** A whistled take begins with the
 *   scoop of finding the first note and ends with whatever the breath did on
 *   the way out; a MIDI part begins with a count-in as often as not.
 * - **Which register it belongs in.** The transcriber reports true pitch, and
 *   true pitch from a piano's lower half is where the pitch detector is least
 *   sure of the octave (a low string's fundamental is quieter than its
 *   harmonics, so the octave above can win the peak). Moving the whole melody
 *   is the fix, and it is one the user can *hear* is right.
 * - **What it is called**, which is the only thing the library will show.
 *
 * Kept as the untouched notes plus a kept range, never as a shortened array:
 * trimming has to be undoable, and an over-trimmed target is otherwise a
 * recording nobody can make again.
 */
export interface TargetDraft {
  source: TargetSource;
  name: string;
  /** As heard or as imported. Never edited — {@link draftNotes} applies the
   *  edits on the way out. */
  notes: readonly TargetNote[];
  /** First kept note. */
  keepFrom: number;
  /** One past the last kept note. */
  keepTo: number;
  /** Whole octaves the melody has been moved by. */
  octaveShift: number;
  /** One more sentence the screen should show — a chord warning, say. */
  note: string;
}

/** How far a draft may be moved. Four octaves is past both ends of a piano
 *  from anywhere a melody starts; the bound exists so the buttons stop. */
const MAX_DRAFT_SHIFT = 3;

export function makeDraft(
  source: TargetSource,
  name: string,
  notes: readonly TargetNote[],
  note = "",
): TargetDraft {
  return {
    source,
    name,
    notes: notes.map((n) => ({ midi: Math.round(n.midi), durSec: n.durSec })),
    keepFrom: 0,
    keepTo: notes.length,
    octaveShift: 0,
    note,
  };
}

/** The melody as it would be saved: trimmed, and moved. */
export function draftNotes(draft: TargetDraft): TargetNote[] {
  return draft.notes
    .slice(draft.keepFrom, draft.keepTo)
    .map((note) => ({ midi: note.midi + 12 * draft.octaveShift, durSec: note.durSec }));
}

/**
 * Drop one note from an end.
 *
 * One at a time, and never the last one. Two buttons and a Reset beat any
 * cleverer gesture here: a whistled take needs one or two notes off the front
 * and maybe one off the back, the chips show exactly what is about to go, and
 * there is no drag, no long-press and no way to end up with a target of nothing
 * by accident.
 */
export function trimDraft(draft: TargetDraft, end: "start" | "end"): TargetDraft {
  if (draft.keepTo - draft.keepFrom <= 1) return draft;
  return end === "start"
    ? { ...draft, keepFrom: draft.keepFrom + 1 }
    : { ...draft, keepTo: draft.keepTo - 1 };
}

/**
 * Cut the nearer end back to one note — or push it back out to one.
 *
 * The Drop buttons are right for a whistled take, which needs one note off the
 * front and maybe one off the back. They are useless for an import: a real MIDI
 * file's melody track runs to hundreds of notes, and the phrase worth practising
 * is the first eight of them. Sixty taps is not a trim control.
 *
 * So a note is also a tap target, and the rule is the one a video trimmer uses:
 * whichever end of the kept range is nearer moves to the note you tapped. That
 * makes it a *cut* when the note is inside the kept range and a *restore* when
 * it is outside, which is the same gesture in both directions and needs no
 * second control to undo it.
 */
export function trimDraftTo(draft: TargetDraft, index: number): TargetDraft {
  if (!Number.isInteger(index) || index < 0 || index >= draft.notes.length) return draft;
  // Midpoint of the kept range, so "nearer" is measured against what is on
  // screen as kept rather than against the whole take.
  const middle = (draft.keepFrom + draft.keepTo - 1) / 2;
  return index <= middle
    ? { ...draft, keepFrom: index, keepTo: Math.max(draft.keepTo, index + 1) }
    : { ...draft, keepTo: index + 1, keepFrom: Math.min(draft.keepFrom, index) };
}

/** Put every note back. The undo for every trim above. */
export function resetDraftTrim(draft: TargetDraft): TargetDraft {
  return { ...draft, keepFrom: 0, keepTo: draft.notes.length };
}

/** Move the whole melody by an octave, within {@link MAX_DRAFT_SHIFT}. */
export function shiftDraft(draft: TargetDraft, delta: number): TargetDraft {
  const octaveShift = Math.max(
    -MAX_DRAFT_SHIFT,
    Math.min(MAX_DRAFT_SHIFT, draft.octaveShift + delta),
  );
  return octaveShift === draft.octaveShift ? draft : { ...draft, octaveShift };
}

export function canShiftDraft(draft: TargetDraft, delta: number): boolean {
  return Math.abs(draft.octaveShift + delta) <= MAX_DRAFT_SHIFT;
}

/** How many notes a draft would save. */
export function draftNoteCount(draft: TargetDraft): number {
  return Math.max(0, draft.keepTo - draft.keepFrom);
}

/** The longest name worth keeping. Longer than a library row can show anyway,
 *  and short enough that a paste accident cannot fill the storage. */
const MAX_NAME_LENGTH = 60;

/**
 * The name as it will be stored: trimmed, bounded, and never empty.
 *
 * Never empty because a nameless row in the library is a row you cannot choose
 * — and the name is deliberately the *only* thing that identifies a target,
 * since spelling out its notes is what the ear-first rule forbids.
 */
export function cleanTargetName(name: string, fallback: string): string {
  const cleaned = name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return cleaned === "" ? fallback : cleaned;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * What a freshly recorded target is called until the user says otherwise.
 *
 * Hand-formatted rather than `toLocaleString`, for the reason the rest of this
 * module avoids the platform: the same target must be named the same thing in a
 * test, in Node and on a phone whose locale is anyone's guess. Date and time
 * both, because the answer to "which one was that?" is nearly always "the one
 * from just now" and two takes a minute apart are the normal case.
 */
export function defaultTargetName(at: number = Date.now()): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `Recorded ${date.getDate()} ${MONTHS[date.getMonth()]}, ${hh}:${mm}`;
}

/** Finish a draft. The name is cleaned here rather than at the keystroke, so
 *  the field stays exactly what the user typed while they are typing it. */
export function draftTarget(
  draft: TargetDraft,
  fallbackName: string,
  createdAt: number = Date.now(),
): PracticeTarget {
  return targetFromNotes(
    cleanTargetName(draft.name, fallbackName),
    draft.source,
    draftNotes(draft),
    createdAt,
  );
}

/**
 * Read one target back out of storage, or `null`.
 *
 * Every field is checked, because this data has been through `JSON.parse` on a
 * string another version of this app wrote — and because a target with a
 * `notes` array full of `undefined` would not fail here, it would fail three
 * screens later inside the aligner with a stack trace nobody can act on.
 */
export function parseTarget(raw: unknown): PracticeTarget | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id === "") return null;
  if (typeof value.name !== "string") return null;
  if (!isTargetSource(value.source)) return null;
  if (!Array.isArray(value.notes)) return null;

  const notes: TargetNote[] = [];
  for (const entry of value.notes) {
    if (typeof entry !== "object" || entry === null) return null;
    const note = entry as Record<string, unknown>;
    if (typeof note.midi !== "number" || !Number.isFinite(note.midi)) return null;
    const durSec = typeof note.durSec === "number" && note.durSec > 0 ? note.durSec : 0;
    notes.push({ midi: Math.round(note.midi), durSec });
  }
  // A target with no notes is not a melody; it would show up in the library as
  // a row that can never be played or scored.
  if (notes.length === 0) return null;

  return {
    id: value.id,
    name: value.name,
    source: value.source,
    notes,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : 0,
  };
}
