/**
 * The controls: the thumb-zone Record button, Play, the octave toggle and the
 * message line.
 *
 * Two rules are encoded here rather than left to the caller:
 *
 * 1. **Recording and playback are mutually exclusive.** Echo cancellation is
 *    switched off on purpose (it eats whistles), so a phone playing the synth
 *    into its own open microphone would transcribe itself. Disabling one button
 *    while the other is active is the whole fix, and it is a v1 limitation
 *    rather than a bug to fix later.
 * 2. **The tap handler stays synchronous.** `onRecord` is invoked directly from
 *    the `click` listener with nothing awaited first, because the audio context
 *    it creates only unlocks inside the gesture. See `audio/capture.ts`.
 * 3. **Import survives every microphone failure.** It is hidden only while the
 *    microphone or the analyser is actually busy — never in the error phase,
 *    which is precisely where a user whose microphone was denied, missing or
 *    hijacked ends up. Without that, "no microphone" would be a dead end.
 * 4. **The status line is two lines.** See {@link statusLines}.
 * 5. **The mode tabs lose to a running take.** Both modes drive the same
 *    capture module, so switching mid-record would abandon an open microphone
 *    with nothing on screen that gets back to a Stop. The store refuses it
 *    (`setMode`); this file is where that refusal becomes visible, as a
 *    disabled tab rather than a tap that does nothing.
 */

import { OCTAVE_SHIFTS } from "../notes/format.js";
// Type-only, deliberately. A value import from `state.js` would make every
// importer of this module instantiate the store — which reads `localStorage`
// at module scope — as a side effect of wanting a button.
import type { AppState, Mode } from "./state.js";

export interface ControlElements {
  record: HTMLButtonElement;
  play: HTMLButtonElement;
  /** The label wrapping {@link importInput}; hidden, not disabled, because a
   *  `<label>` has no disabled state to respect. */
  importLabel: HTMLElement;
  importInput: HTMLInputElement;
  /** "Save recording (.wav)" — the debug export. */
  save: HTMLButtonElement;
  /** Container of the octave buttons, each carrying `data-transpose`. */
  transpose: HTMLElement;
  /** Container of the mode tabs, each carrying `data-mode`. */
  modes: HTMLElement;
  message: HTMLElement;
}

export interface ControlHandlers {
  onMode(mode: Mode): void;
  onRecord(): void;
  onStopRecord(): void;
  onPlay(): void;
  onStopPlay(): void;
  onImport(file: File): void;
  onSave(): void;
  onTranspose(shift: number): void;
}

export interface Controls {
  render(state: AppState): void;
}

/**
 * The status area, as the lines it should show, in order.
 *
 * This used to be `state.message || state.warning`, and that single `||` was
 * the most expensive character in the app. The two fields answer different
 * questions — the message says *what happened*, the warning says *why it might
 * have* — and the case where both are set is precisely the case where the
 * warning matters most:
 *
 * - "No notes found" + "this browser kept noise suppression on" — the plan's
 *   number-one device risk, and the only line that explains an empty result on
 *   a phone that gated the whistle out.
 * - "No notes found" + "that file is 4:12 long; only the first 60 seconds were
 *   transcribed" — the melody is probably in the part that was cut.
 * - "No notes found" + "recording was interrupted".
 *
 * In every one of those the app knew the answer, wrote it into `warning`, and
 * then hid it behind a message that sent the user off to whistle louder.
 *
 * Message first, warning second: what, then why. The empty-result message is
 * shortened when a warning is present (see `emptyResultMessage` in `state.ts`)
 * so the advice does not contradict the explanation underneath it.
 */
export function statusLines(state: Pick<AppState, "message" | "warning">): readonly string[] {
  const lines: string[] = [];
  if (state.message) lines.push(state.message);
  if (state.warning) lines.push(state.warning);
  return lines;
}

export function createControls(
  elements: ControlElements,
  handlers: ControlHandlers,
): Controls {
  let phase: AppState["phase"] = "idle";
  let playing = false;

  // Two lines inside the one message element, built once. `ownerDocument`
  // rather than the global `document` so this module keeps depending on the
  // elements it was handed and nothing else.
  const doc = elements.message.ownerDocument;
  const messageLine = doc.createElement("span");
  const warningLine = doc.createElement("span");
  warningLine.className = "warning";
  elements.message.replaceChildren(messageLine, warningLine);

  elements.record.addEventListener("click", () => {
    if (phase === "recording") handlers.onStopRecord();
    else if (phase !== "analyzing") handlers.onRecord();
  });

  elements.play.addEventListener("click", () => {
    if (playing) handlers.onStopPlay();
    else handlers.onPlay();
  });

  elements.importInput.addEventListener("change", () => {
    const file = elements.importInput.files?.[0];
    // Cleared *before* the handler runs, not after: an input that still holds
    // the file fires no `change` when the same file is picked again, and
    // re-importing the take you just imported is exactly what you do while
    // chasing a bad transcription.
    elements.importInput.value = "";
    if (file) handlers.onImport(file);
  });

  elements.save.addEventListener("click", () => handlers.onSave());

  // One listener on the group instead of three on the buttons: the toggle is
  // rendered once in the HTML and never rebuilt, but delegation keeps the
  // wiring true even if it ever is.
  elements.transpose.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest("[data-transpose]");
    if (!target) return;
    const shift = Number(target.getAttribute("data-transpose"));
    if (OCTAVE_SHIFTS.includes(shift)) handlers.onTranspose(shift);
  });

  // Unlike the octave toggle, this needs no membership check of its own: the
  // attribute is a string we wrote in `index.html` rather than a number parsed
  // out of one, and `setMode` rejects anything it does not recognise anyway.
  elements.modes.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest("[data-mode]");
    const mode = target?.getAttribute("data-mode");
    if (mode) handlers.onMode(mode as Mode);
  });

  return {
    render(state) {
      phase = state.phase;
      playing = state.playing;

      const recordingNow = state.phase === "recording";

      // The tabs first: everything below them describes the transcriber, and
      // in practice mode most of it is not on screen to describe.
      const busyWithAudio = recordingNow || state.phase === "analyzing";
      for (const button of elements.modes.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
        const active = button.getAttribute("data-mode") === state.mode;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
        button.disabled = busyWithAudio && !active;
      }

      // The octave toggle transposes the *transcript*, and in practice mode
      // there is no transcript on screen for it to be about. It is the one
      // transcriber control that lives outside the switched view, so it is the
      // one this function has to hide by hand; the dock goes with the mode in
      // the stylesheet, and everything else is inside `#transcribe-view`.
      elements.transpose.hidden = state.mode !== "transcribe";
      if (state.mode !== "transcribe") {
        // Practice mode carries its own buttons inside its own screens,
        // because its actions are per-screen ("whistle a comfortably low
        // note") rather than global the way Record and Import are. Nothing
        // below this line is on screen, so nothing below it needs deciding.
        elements.importInput.disabled = true;
        return;
      }
      elements.record.textContent = recordingNow ? "Stop" : "Record";
      elements.record.classList.toggle("is-recording", recordingNow);
      elements.record.disabled = state.phase === "analyzing" || state.playing;

      const playable = state.phase === "result" && state.notes.length > 0;
      elements.play.textContent = state.playing ? "Stop" : "Play";
      elements.play.disabled = !playable && !state.playing;
      elements.play.hidden = !playable && !state.playing;

      // `busyWithAudio` means the microphone is open or the analyser is
      // running; every other phase — including `error` — can accept a file.
      elements.importLabel.hidden = busyWithAudio;
      elements.importInput.disabled = busyWithAudio;

      // Only offered for a live take: an imported file is already a file, and
      // handing it back would be a button that achieves nothing.
      //
      // `error` counts as well as `result`, and that is the whole point of the
      // export. A take that crashed the segmenter is the single most valuable
      // recording this app will ever hold — it is the one nobody can reproduce
      // from a description — and hiding Save behind a successful transcription
      // threw away exactly the takes worth keeping.
      const savable = state.phase === "result" || state.phase === "error";
      elements.save.hidden = !(savable && state.hasRecording);

      for (const button of elements.transpose.querySelectorAll<HTMLElement>("[data-transpose]")) {
        const active = Number(button.getAttribute("data-transpose")) === state.transpose;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      }

      // Both lines, never one instead of the other. See `statusLines`.
      elements.message.hidden = statusLines(state).length === 0;
      messageLine.textContent = state.message;
      messageLine.hidden = state.message === "";
      warningLine.textContent = state.warning ?? "";
      warningLine.hidden = state.warning === null || state.warning === "";
      // Only the message is an error; the warning stays a warning even on the
      // error screen, so the class goes on the container and the stylesheet
      // exempts `.warning`.
      elements.message.classList.toggle("is-error", state.phase === "error");
    },
  };
}
