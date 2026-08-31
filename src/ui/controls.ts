/**
 * The controls: the thumb-zone Record button, the octave toggle and the
 * message line.
 *
 * One rule is encoded here rather than left to the caller: **the tap handler
 * stays synchronous**. `onRecord` is invoked directly from the `click` listener
 * with nothing awaited first, because the audio context it creates only unlocks
 * inside the gesture. See `audio/capture.ts`.
 */

import { OCTAVE_SHIFTS } from "../notes/format.js";
import type { AppState } from "./state.js";

export interface ControlElements {
  record: HTMLButtonElement;
  /** Container of the octave buttons, each carrying `data-transpose`. */
  transpose: HTMLElement;
  message: HTMLElement;
}

export interface ControlHandlers {
  onRecord(): void;
  onStopRecord(): void;
  onTranspose(shift: number): void;
}

export interface Controls {
  render(state: AppState): void;
}

export function createControls(elements: ControlElements, handlers: ControlHandlers): Controls {
  let phase: AppState["phase"] = "idle";

  elements.record.addEventListener("click", () => {
    if (phase === "recording") handlers.onStopRecord();
    else if (phase !== "analyzing") handlers.onRecord();
  });

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

      const recordingNow = state.phase === "recording";
      elements.record.textContent = recordingNow ? "Stop" : "Record";
      elements.record.classList.toggle("is-recording", recordingNow);
      elements.record.disabled = state.phase === "analyzing";

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
