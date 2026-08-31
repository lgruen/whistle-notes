/**
 * The transcript: one chip per note, plus a plain-text line to copy out.
 *
 * Rendered by rebuilding `innerHTML` wholesale. That is not laziness — the list
 * changes exactly once per transcription (and once per octave toggle), and a
 * dozen lines of string building are far easier to hold in your head than any
 * amount of incremental DOM patching. The one thing that *does* change often —
 * the playback highlight — is a class toggle, and has its own function.
 */

import { DEFAULT_CONFIG, durationClasses, hasRestBefore, midiToName, type Note } from "../dsp/index.js";
import { formatCents, transposeMidi } from "../notes/format.js";

/*
 * "How long was that note, roughly?" and "is there a rest before it?" are both
 * answered by `src/dsp` — `durationClasses()` and `hasRestBefore()`. This module
 * used to reimplement both, with a different long-note ratio (1.7 vs 1.5) and a
 * different boundary condition on the rest gap, which meant the chips and the
 * staff could disagree with the segmenter about the take they were describing.
 * One definition, in the module that owns the notes; the UI only paints it.
 *
 * `durationClasses` wants a mutable array, so the readonly view is copied.
 * The list is rebuilt once per transcription, so the copy is free.
 */
function classesFor(notes: readonly Note[]): ReturnType<typeof durationClasses> {
  return durationClasses([...notes]);
}

/**
 * The paste-friendly line: note names separated by spaces, rests by a slash.
 *
 * This is the artefact that actually gets used away from the app — pasted into
 * a notes app next to the piano — so it stays plain ASCII with no decoration.
 */
export function sequenceText(notes: readonly Note[], transpose: number): string {
  const parts: string[] = [];
  for (const note of notes) {
    if (parts.length > 0 && hasRestBefore(note, DEFAULT_CONFIG)) parts.push("/");
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

  const lengths = classesFor(notes);
  const chips: string[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (i > 0 && hasRestBefore(note, DEFAULT_CONFIG)) {
      chips.push(`<span class="chip-rest" aria-label="rest">/</span>`);
    }
    const name = midiToName(transposeMidi(note.midi, transpose));
    const length = lengths[i];
    // The measurement behind the chip, for anyone who wants to know why a note
    // was rounded the way it was. Numbers only — nothing here can be markup.
    const detail = `${note.pitchHz.toFixed(1)} Hz, ${formatCents(note.centsOffset)} cents, ${note.durationSec.toFixed(2)} s`;
    chips.push(
      `<span class="chip chip-${length}" data-i="${i}" title="${detail}">` +
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
