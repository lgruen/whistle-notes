/**
 * The transcript: one chip per note, plus a plain-text line to copy out.
 *
 * Rendered by rebuilding `innerHTML` wholesale. That is not laziness — the list
 * changes exactly once per transcription (and once per octave toggle), and a
 * dozen lines of string building are far easier to hold in your head than any
 * amount of incremental DOM patching. The one thing that *does* change often —
 * the playback highlight — is a class toggle, and has its own function.
 */

import { DEFAULT_CONFIG, midiToName, type Note } from "../dsp/index.js";
import { transposeMidi } from "../notes/format.js";

/**
 * Rough length relative to the take's median note. v1 deliberately does not
 * transcribe rhythm — the goal is finding the notes on a keyboard — but "that
 * one was long" is cheap to show and helps a reader follow along.
 */
export type DurationClass = "short" | "medium" | "long";

const SHORT_RATIO = 0.7;
const LONG_RATIO = 1.7;

export function durationClass(durationSec: number, medianSec: number): DurationClass {
  if (!(medianSec > 0)) return "medium";
  const ratio = durationSec / medianSec;
  if (ratio < SHORT_RATIO) return "short";
  if (ratio > LONG_RATIO) return "long";
  return "medium";
}

/** Median note length, the reference every duration class is relative to. A
 *  median rather than a mean so one long held final note cannot rescale the
 *  entire transcript. */
export function medianDuration(notes: readonly Note[]): number {
  if (notes.length === 0) return 0;
  const sorted = notes.map((note) => note.durationSec).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Gap that counts as a rest in the transcript, from the segmenter's own
 *  definition so the chips and the notes agree about what a rest is. */
const REST_GAP_SEC = DEFAULT_CONFIG.segment.restGapMs / 1000;

/**
 * The paste-friendly line: note names separated by spaces, rests by a slash.
 *
 * This is the artefact that actually gets used away from the app — pasted into
 * a notes app next to the piano — so it stays plain ASCII with no decoration.
 */
export function sequenceText(notes: readonly Note[], transpose: number): string {
  const parts: string[] = [];
  for (const note of notes) {
    if (parts.length > 0 && note.gapBeforeSec >= REST_GAP_SEC) parts.push("/");
    parts.push(midiToName(transposeMidi(note.midi, transpose)));
  }
  return parts.join(" ");
}

/** Attach the delegated copy handler. Call once; survives every re-render. */
export function initNoteList(container: HTMLElement): void {
  container.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-copy]");
    if (!button) return;
    const text = button.getAttribute("data-copy") ?? "";
    void navigator.clipboard?.writeText(text).then(
      () => flash(button, "Copied"),
      () => flash(button, "Copy failed"),
    );
  });
}

function flash(button: HTMLButtonElement, message: string): void {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

export function renderNoteList(
  container: HTMLElement,
  notes: readonly Note[],
  transpose: number,
): void {
  if (notes.length === 0) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const median = medianDuration(notes);
  const chips: string[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (i > 0 && note.gapBeforeSec >= REST_GAP_SEC) {
      chips.push(`<span class="chip-rest" aria-label="rest">/</span>`);
    }
    const name = midiToName(transposeMidi(note.midi, transpose));
    const length = durationClass(note.durationSec, median);
    chips.push(
      `<span class="chip chip-${length}" data-i="${i}">` +
        `<span class="chip-name">${name}</span>` +
        `<span class="chip-len">${length}</span>` +
        `</span>`,
    );
  }

  const text = sequenceText(notes, transpose);
  container.innerHTML =
    `<div class="chips">${chips.join("")}</div>` +
    `<div class="sequence">` +
    `<code class="sequence-text">${text}</code>` +
    `<button type="button" class="copy" data-copy="${text}">Copy</button>` +
    `</div>`;
}

/** Move the playback highlight. Cheap enough to call from a rAF-driven
 *  callback; `renderNoteList` is not. */
export function highlightNoteList(container: HTMLElement, index: number | null): void {
  for (const chip of container.querySelectorAll<HTMLElement>(".chip")) {
    chip.classList.toggle("is-playing", Number(chip.dataset.i) === index);
  }
}
