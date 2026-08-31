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

import { VOICES, type Voice } from "../audio/synth.js";
import type { Note, PitchFrame } from "../dsp/index.js";
import { OCTAVE_SHIFTS, suggestOctaveShift } from "../notes/format.js";

/**
 * `idle → recording → analyzing → result | error`, and back to `recording`
 * from any of them. `analyzing` exists as its own phase purely so the UI can
 * paint "listening back…" *before* the synchronous transcription blocks the
 * main thread — without it, a two-second analysis looks like a frozen app.
 */
export type Phase = "idle" | "recording" | "analyzing" | "result" | "error";

/**
 * Which half of the app is on screen.
 *
 * `transcribe` is everything that existed before Practice mode and behaves
 * exactly as it did. `practice` is the trainer. They share the store because
 * they share the microphone: a range take in practice mode goes through the
 * very same `phase` machine and the very same capture module, which is what
 * stops the two from ever being able to open the microphone at once.
 */
export type Mode = "transcribe" | "practice";

export const MODES: readonly Mode[] = ["transcribe", "practice"];

export interface AppState {
  mode: Mode;
  phase: Phase;
  /** The transcription. Always **true** pitch — see `transpose`. */
  notes: readonly Note[];
  /** Every analysis frame behind those notes; the piano roll draws them as the
   *  continuous trail under the quantised rectangles. */
  frames: readonly PitchFrame[];
  /** Display octave shift, one of {@link OCTAVE_SHIFTS}. Applied at render and
   *  playback time only; `notes` is never rewritten. */
  transpose: number;
  /** Which synth plays the transcript back. Read once per playback — see
   *  {@link setVoice}. */
  voice: Voice;
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
const MODE_KEY = "whistle-notes:mode";
const VOICE_KEY = "whistle-notes:voice";

/** The mode the last visit ended in. Someone who is practising is practising
 *  across sessions, and landing them back on the transcriber every time would
 *  make the tab a chore rather than a switch. */
function loadMode(): Mode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return MODES.includes(raw as Mode) ? (raw as Mode) : "transcribe";
  } catch {
    return "transcribe";
  }
}

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

/** The stored playback voice. Validated against the synth's own list rather
 *  than trusted, for the same reason the octave is: `localStorage` is shared
 *  with every past and future version of this app, and a voice that was removed
 *  (or a hand-edited value) must degrade to the default rather than reach
 *  `voiceSpec` as an unknown string. */
function loadVoice(): Voice {
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    return VOICES.includes(raw as Voice) ? (raw as Voice) : "clean";
  } catch {
    return "clean";
  }
}

const restoredTranspose = loadTranspose();

let state: AppState = {
  mode: loadMode(),
  phase: "idle",
  notes: [],
  frames: [],
  transpose: restoredTranspose ?? 0,
  voice: loadVoice(),
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
 * Choose the playback voice, and remember it for next time.
 *
 * Deliberately does **not** stop a running playback the way the octave toggle
 * does. The two cases look alike and are not: a transposed melody is playing
 * the *wrong notes* the moment the toggle moves, so stopping is the honest
 * answer; a different voice is the same notes in a different colour, and there
 * is nothing wrong with what is currently sounding. The synth reads the voice
 * once when it builds its graph (`startPlayback`), so a switch mid-playback
 * simply lands on the next tap of Play — which is also the only way to hear the
 * two voices against each other.
 */
export function setVoice(voice: Voice): void {
  if (!VOICES.includes(voice) || state.voice === voice) return;
  try {
    localStorage.setItem(VOICE_KEY, voice);
  } catch {
    // Persistence is a nicety; the toggle still works for this session.
  }
  setState({ voice });
}

/**
 * Switch modes, and remember it for next time.
 *
 * Refuses while the microphone or the analyser is busy. Not a nicety: both
 * modes drive the same capture module, and walking away from a running take by
 * tapping a tab would leave the microphone open with nothing on screen that
 * gets back to a Stop. The tab is disabled in those phases too — this is the
 * rule, that is the affordance.
 */
export function setMode(mode: Mode): void {
  // The authority on what a mode is, so callers reading a DOM attribute do not
  // each need their own copy of the list.
  if (!MODES.includes(mode) || state.mode === mode) return;
  if (state.phase === "recording" || state.phase === "analyzing") return;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Persistence is a nicety; the switch still works for this session.
  }
  setState({ mode });
}

/**
 * What to say about a take that produced no notes.
 *
 * "Try whistling louder or closer" is the right advice for a take that was
 * simply too quiet, and the wrong advice for every empty result the app can
 * already explain: a browser that kept noise suppression on and gated the
 * whistle out, a four-minute file whose melody was past the 60 s cut, a
 * recording the platform interrupted. In those cases the explanation is
 * already sitting in `warning`, and it is shown on the line underneath — so
 * the message steps back and stops arguing with it.
 *
 * Pure and exported so the rule is pinned by a test: this is a sentence the
 * user only ever sees on their worst attempt.
 */
export function emptyResultMessage(warning: string | null): string {
  return warning ? "No notes found in that take." : "No notes found — try whistling louder or closer.";
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
    message: notes.length === 0 ? emptyResultMessage(state.warning) : "",
    tuningOffsetCents,
  });
}
