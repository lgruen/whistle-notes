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
  return {
    id: newTargetId(),
    name,
    source,
    notes: notes.map((note) => ({ midi: Math.round(note.midi), durSec: note.durationSec })),
    createdAt,
  };
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
