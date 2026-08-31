/**
 * Practice mode's screens: the target library, a target's detail page, and the
 * range check.
 *
 * ## Ear-first, as a rendering rule
 *
 * Nothing on these screens is a written prompt for anything the user is about
 * to whistle. The library lists a target's *name*, how many notes it has and
 * how long it is — never its pitches — because a row reading "C E G E C" turns
 * choosing a melody into sight-reading it, and sight-reading is the one skill
 * this mode is explicitly not asking for. Note names appear in exactly one
 * place, the measured range readout, and there they are a passive label about
 * something already whistled rather than an instruction about something that
 * has not been.
 *
 * The same rule governs the copy: "whistle a note that feels comfortably low"
 * asks for a feeling, not for a pitch. There is no version of this screen that
 * says "whistle an A4".
 *
 * ## Shape
 *
 * Same split as the rest of `src/ui`: the arithmetic and the sentences are pure
 * functions, exported and tested; the DOM work is a thin `render` over
 * pre-existing elements from `index.html`. The target list is the one thing
 * built from strings, for the same reason `notelist.ts` does it — it changes
 * once per library change, and a dozen lines of string building beat any amount
 * of incremental patching.
 */

import { midiToName } from "../notes/format.js";
import { isUsableRange, rangeSpanSemitones, type WhistleRange } from "../practice/range.js";
import { targetSummary, type PracticeTarget } from "../practice/target.js";
import type { PracticeState, RangeStep } from "../practice/store.js";
import type { Phase } from "./state.js";

export interface PracticeElements {
  library: HTMLElement;
  targetList: HTMLElement;
  /** Shown instead of the list when there is nothing in it. */
  empty: HTMLElement;
  rangeSummary: HTMLElement;
  rangeButton: HTMLButtonElement;

  detail: HTMLElement;
  detailName: HTMLElement;
  detailMeta: HTMLElement;
  /** Where {@link EXERCISES_COMING} goes. */
  detailNext: HTMLElement;
  detailBack: HTMLButtonElement;
  detailDelete: HTMLButtonElement;

  range: HTMLElement;
  rangeHint: HTMLElement;
  /** The same sentence as {@link PracticeElements.rangeSummary}, on the range
   *  screen — where it is the *result* of the two takes just made. */
  rangeCurrent: HTMLElement;
  rangeLow: HTMLButtonElement;
  rangeHigh: HTMLButtonElement;
  rangeDone: HTMLButtonElement;

  message: HTMLElement;
}

export interface PracticeHandlers {
  onSelect(id: string): void;
  onBack(): void;
  onDelete(id: string): void;
  onOpenRange(): void;
  /** Start capturing one end of the range. */
  onCaptureRange(step: RangeStep): void;
  /** Stop the take that is running. */
  onStopCapture(): void;
  onCloseRange(): void;
}

export interface PracticeView {
  render(state: PracticeState, phase: Phase): void;
}

/**
 * The range, as the one sentence a whistler can act on.
 *
 * Note names *and* a span in octaves, because they answer different questions:
 * the names say where to look on a piano, and "about two octaves" is the part
 * that tells you whether the measurement went well. A range under an octave
 * usually means one of the two takes caught a squeak rather than a comfortable
 * note, so the sentence says so instead of quietly using it.
 */
export function rangeSummaryText(range: WhistleRange | null): string {
  if (!isUsableRange(range)) {
    return "Not measured yet — targets will play at their own pitch.";
  }
  const span = rangeSpanSemitones(range);
  const octaves = span / 12;
  const size =
    octaves >= 0.95
      ? `about ${octaves < 1.45 ? "an octave" : `${octaves.toFixed(1)} octaves`}`
      : `${Math.round(span)} semitones`;
  const doubt = span < 12 ? " — that is narrow; measure it again if it felt wrong." : "";
  return `${midiToName(range.lowMidi)} to ${midiToName(range.highMidi)}, ${size}.${doubt}`;
}

/** What to ask for next, in the range check. */
export function rangeStepHint(range: WhistleRange | null, step: RangeStep | null): string {
  if (step === "low") return "Whistling… hold a note that feels comfortably low, then tap Stop.";
  if (step === "high") return "Whistling… hold a note that feels comfortably high, then tap Stop.";
  return isUsableRange(range)
    ? "Whistle each end again any time — the app keeps the most recent pair."
    : "Two short takes: one note that feels comfortably low, one that feels comfortably high. No particular note — whatever is easy.";
}

/**
 * What the detail screen says a target is for.
 *
 * A placeholder, and honest about being one: the exercises land in T3 and T4.
 * Describing them in terms of what the *user* does rather than what the app
 * implements keeps the promise checkable, and keeps it ear-first.
 */
export const EXERCISES_COMING =
  "Exercises are on their way: hear this melody, then whistle it back from memory " +
  "and see which notes drifted — plus short echo drills built from the notes you " +
  "keep missing. Nothing to read: the app plays, you answer.";

/** Escape anything that goes into a string-built row. A target's name is the
 *  user's own text, and it goes straight into `innerHTML`. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One library row: a name, and what shape the melody is. Exported so both
 * halves of it can be tested — that the user's own text cannot become markup,
 * and that a row never spells out a note.
 */
export function targetRowHtml(target: PracticeTarget): string {
  const summary = targetSummary(target);
  return (
    `<button type="button" class="target" data-target="${escapeHtml(target.id)}">` +
    `<span class="target-name">${escapeHtml(summary.name)}</span>` +
    `<span class="target-detail">${escapeHtml(summary.detail)}</span>` +
    `</button>`
  );
}

export function createPracticeView(
  elements: PracticeElements,
  handlers: PracticeHandlers,
): PracticeView {
  /**
   * Which target the delete button is armed for.
   *
   * Two taps rather than a `confirm()`: the native dialog is suppressed
   * outright in some installed-PWA contexts, and losing a recorded target to a
   * mis-tap is exactly the kind of thing that cannot be undone here. Armed per
   * target id, so navigating away disarms it by construction.
   */
  let armedDelete: string | null = null;

  // Delegated, because the list is rebuilt on every library change.
  elements.targetList.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-target]");
    const id = button?.getAttribute("data-target");
    if (id) handlers.onSelect(id);
  });

  elements.detailBack.addEventListener("click", () => handlers.onBack());

  elements.detailDelete.addEventListener("click", () => {
    const id = elements.detailDelete.getAttribute("data-target");
    if (!id) return;
    if (armedDelete !== id) {
      armedDelete = id;
      elements.detailDelete.textContent = "Tap again to delete";
      elements.detailDelete.classList.add("is-armed");
      return;
    }
    armedDelete = null;
    handlers.onDelete(id);
  });

  elements.rangeButton.addEventListener("click", () => handlers.onOpenRange());
  elements.rangeDone.addEventListener("click", () => handlers.onCloseRange());
  elements.rangeLow.addEventListener("click", () => {
    if (elements.rangeLow.dataset.running === "true") handlers.onStopCapture();
    else handlers.onCaptureRange("low");
  });
  elements.rangeHigh.addEventListener("click", () => {
    if (elements.rangeHigh.dataset.running === "true") handlers.onStopCapture();
    else handlers.onCaptureRange("high");
  });

  // Written once: it is a fixed sentence, and keeping it in TypeScript rather
  // than in `index.html` is what lets a test hold the ear-first promise to it.
  elements.detailNext.textContent = EXERCISES_COMING;

  let renderedTargets: readonly PracticeTarget[] | null = null;

  return {
    render(state, phase) {
      elements.library.hidden = state.screen !== "library";
      elements.detail.hidden = state.screen !== "target";
      elements.range.hidden = state.screen !== "range";

      if (state.targets !== renderedTargets) {
        renderedTargets = state.targets;
        elements.targetList.innerHTML = state.targets.map(targetRowHtml).join("");
      }
      elements.targetList.hidden = state.targets.length === 0;
      elements.empty.hidden = state.targets.length > 0;
      const summaryText = rangeSummaryText(state.range);
      elements.rangeSummary.textContent = summaryText;
      elements.rangeCurrent.textContent = summaryText;
      elements.rangeButton.textContent = isUsableRange(state.range)
        ? "Measure your range again"
        : "Measure your whistling range";

      const selected = state.targets.find((target) => target.id === state.selectedId) ?? null;
      if (selected) {
        const summary = targetSummary(selected);
        elements.detailName.textContent = summary.name;
        elements.detailMeta.textContent = summary.detail;
        elements.detailDelete.setAttribute("data-target", selected.id);
      }
      // Recomputed from scratch rather than reset on a transition: the arming
      // happens in a click handler that does not re-render, so this has to be
      // idempotent — and "still armed" is only true while the screen is still
      // showing the target it was armed for.
      const armed = armedDelete !== null && armedDelete === state.selectedId;
      if (!armed) armedDelete = null;
      elements.detailDelete.textContent = armed ? "Tap again to delete" : "Delete";
      elements.detailDelete.classList.toggle("is-armed", armed);

      // A take is running when the phase says so *and* this screen started it.
      // Both conditions: the phase is shared with the transcriber, and a stale
      // `rangeStep` must never leave a button reading "Stop" over a microphone
      // that is already closed.
      const capturing = state.rangeStep !== null && phase === "recording";
      const analysing = state.rangeStep !== null && phase === "analyzing";
      for (const [button, step] of [
        [elements.rangeLow, "low"],
        [elements.rangeHigh, "high"],
      ] as const) {
        const running = capturing && state.rangeStep === step;
        const done = state.rangeDraft[step] !== null;
        button.dataset.running = String(running);
        button.classList.toggle("is-recording", running);
        button.classList.toggle("is-done", !running && done);
        // "A low note", not "a note below A5": the instruction is about how it
        // feels to whistle, and naming a pitch would be asking someone to find
        // it first. The tick is the only feedback needed here — the note that
        // was heard is in the summary line underneath.
        button.textContent = running
          ? "Stop"
          : `${step === "low" ? "Low note" : "High note"}${done ? " ✓" : ""}`;
        // Only the take that is running stays tappable, so there is exactly one
        // way out of a running take and it is the button that started it.
        button.disabled = analysing || (capturing && !running);
      }
      elements.rangeHint.textContent = rangeStepHint(state.range, state.rangeStep);
      elements.rangeDone.disabled = capturing || analysing;

      const lines = [state.message, state.storageError].filter(
        (line): line is string => !!line,
      );
      elements.message.textContent = lines.join(" ");
      elements.message.hidden = lines.length === 0;
      elements.message.classList.toggle("is-error", state.storageError !== null);
    },
  };
}
