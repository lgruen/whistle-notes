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
 */

import { OCTAVE_SHIFTS } from "../notes/format.js";
import type { AppState } from "./state.js";

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
  message: HTMLElement;
}

export interface ControlHandlers {
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

export function createControls(
  elements: ControlElements,
  handlers: ControlHandlers,
): Controls {
  let phase: AppState["phase"] = "idle";
  let playing = false;

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

  return {
    render(state) {
      phase = state.phase;
      playing = state.playing;

      const recordingNow = state.phase === "recording";
      elements.record.textContent = recordingNow ? "Stop" : "Record";
      elements.record.classList.toggle("is-recording", recordingNow);
      elements.record.disabled = state.phase === "analyzing" || state.playing;

      const playable = state.phase === "result" && state.notes.length > 0;
      elements.play.textContent = state.playing ? "Stop" : "Play";
      elements.play.disabled = !playable && !state.playing;
      elements.play.hidden = !playable && !state.playing;

      // Busy means the microphone is open or the analyser is running; every
      // other phase — including `error` — can accept a file.
      const busy = recordingNow || state.phase === "analyzing";
      elements.importLabel.hidden = busy;
      elements.importInput.disabled = busy;

      // Only offered for a live take: an imported file is already a file, and
      // handing it back would be a button that achieves nothing.
      elements.save.hidden = !(state.phase === "result" && state.hasRecording);

      for (const button of elements.transpose.querySelectorAll<HTMLElement>("[data-transpose]")) {
        const active = Number(button.getAttribute("data-transpose")) === state.transpose;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      }

      const text = state.message || state.warning || "";
      elements.message.textContent = text;
      elements.message.hidden = text === "";
      elements.message.classList.toggle("is-error", state.phase === "error");
    },
  };
}
