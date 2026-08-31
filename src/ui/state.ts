/**
 * The whole application state, in about twenty lines: module-level state, a
 * set of listeners, and one patch function that notifies them.
 *
 * ## The hot/cold split (the reason this file stays this small)
 *
 * A whistle produces ~94 pitch frames per second and the live readout has to
 * follow it without visible lag. Pushing that through a store — copying an
 * object, notifying every view, re-rendering chips and an SVG staff 94 times a
 * second — would drop frames on a phone for no benefit at all, because none of
 * those views change while a note is being held.
 *
 * So there are two paths, and the boundary is deliberate:
 *
 * - **Hot** (never touches this file): the live note readout, the cents bar and
 *   the growing piano-roll trail. A `requestAnimationFrame` loop reads the
 *   frame buffer that `src/audio/capture.ts` keeps as a plain module array and
 *   writes straight into one text node and one canvas.
 * - **Cold** (goes through `setState`): phase transitions, the finished
 *   transcription, the transpose toggle, playback highlighting. Handfuls of
 *   updates per session, each of which genuinely changes what every view shows.
 *
 * If you ever find yourself calling `setState` from inside a rAF loop, the
 * split has been broken.
 */

import type { Note, PitchFrame } from "../dsp/index.js";
import { OCTAVE_SHIFTS, suggestOctaveShift } from "../notes/format.js";

/**
 * `idle → recording → analyzing → result | error`, and back to `recording`
 * from any of them. `analyzing` exists as its own phase purely so the UI can
 * paint "listening back…" *before* the synchronous transcription blocks the
 * main thread — without it, a two-second analysis looks like a frozen app.
 */
export type Phase = "idle" | "recording" | "analyzing" | "result" | "error";

export interface AppState {
  phase: Phase;
  /** The transcription. Always **true** pitch — see `transpose`. */
  notes: readonly Note[];
  /** Every analysis frame behind those notes; the piano roll draws them as the
   *  continuous trail under the quantised rectangles. */
  frames: readonly PitchFrame[];
  /** Display octave shift, one of {@link OCTAVE_SHIFTS}. Applied at render and
   *  playback time only; `notes` is never rewritten. */
  transpose: number;
  /** Whether the synth is running. Distinct from `playingIndex !== null`
   *  because playback passes through rests, and the Stop button must not
   *  flicker back to Play in the gaps. */
  playing: boolean;
  /** Index into `notes` of the note currently sounding, for the synchronised
   *  chip/rectangle/notehead highlight. */
  playingIndex: number | null;
  /** User-facing status or error line. */
  message: string;
  /** A non-fatal warning that outlives a single frame, e.g. the browser
   *  refusing to switch its noise suppression off. */
  warning: string | null;
  /** Global tuning bias the segmenter took out of this take, in cents. Positive
   *  means the whistler ran sharp of A440. Surfaced in the result view when it
   *  is big enough to be worth knowing about. */
  tuningOffsetCents: number;
  /** Whether the audio behind this result is a *live* take still held in
   *  memory, i.e. whether there is anything for the `.wav` debug export to
   *  save. False after an import: the user already has that file. */
  hasRecording: boolean;
}

const TRANSPOSE_KEY = "whistle-notes:transpose";

/** The stored octave preference, or `null` when there isn't a usable one.
 *  localStorage throws outright in some privacy modes, so every access is
 *  wrapped: a missing preference must never take the app down with it. */
function loadTranspose(): number | null {
  try {
    const raw = localStorage.getItem(TRANSPOSE_KEY);
    if (raw === null) return null;
    const stored = Number(raw);
    return OCTAVE_SHIFTS.includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

const restoredTranspose = loadTranspose();

let state: AppState = {
  phase: "idle",
  notes: [],
  frames: [],
  transpose: restoredTranspose ?? 0,
  playing: false,
  playingIndex: null,
  message: "",
  warning: null,
  tuningOffsetCents: 0,
  hasRecording: false,
};

/**
 * Whether the user has ever explicitly chosen an octave — this session, or a
 * previous one. It gates the auto-default: guessing an octave for someone who
 * already told us what they want would be the app arguing with its user.
 *
 * A restored preference counts as chosen, which is the entire point of storing
 * it. Treating it as un-chosen would let `suggestOctaveShift` overwrite it on
 * the first result of every session, and the persistence would be a no-op that
 * only *looked* like a feature.
 */
let transposeChosen = restoredTranspose !== null;

type Listener = (state: AppState) => void;
const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

/** Merge a patch and notify. The only way state ever changes. */
export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/** Subscribe; returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record an explicit transpose choice: remember it for the rest of the session
 * so the auto-default stops overriding it, and persist it so the next visit
 * starts where this one left off.
 */
export function setTranspose(shift: number): void {
  transposeChosen = true;
  try {
    localStorage.setItem(TRANSPOSE_KEY, String(shift));
  } catch {
    // Persistence is a nicety; the toggle still works for this session.
  }
  setState({ transpose: shift });
}

/**
 * Enter the `result` phase with a finished transcription.
 *
 * The octave default lives here rather than in a view because it is a decision
 * about the *result*, not about how one widget draws it. Whistling sits one to
 * two octaves above the treble staff, so showing true pitch would bury a
 * beginner under ledger lines; `suggestOctaveShift` picks the shift that lands
 * the melody's median nearest the middle line.
 */
export function applyResult(
  notes: readonly Note[],
  frames: readonly PitchFrame[],
  tuningOffsetCents = 0,
): void {
  const transpose = transposeChosen
    ? state.transpose
    : suggestOctaveShift(notes.map((note) => note.midi));
  setState({
    phase: "result",
    notes,
    frames,
    transpose,
    playing: false,
    playingIndex: null,
    message: notes.length === 0 ? "No notes found — try whistling louder or closer." : "",
    tuningOffsetCents,
  });
}
