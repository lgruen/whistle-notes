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
import { BUNDLED_MELODIES } from "../practice/bundled.js";
import { chordWarning, melodySummary, type MidiMelody } from "../practice/midi.js";
import { isUsableRange, rangeSpanSemitones, type WhistleRange } from "../practice/range.js";
import {
  canShiftDraft,
  draftNoteCount,
  draftNotes,
  formatTargetDuration,
  targetSummary,
  type PracticeTarget,
  type TargetDraft,
} from "../practice/target.js";
import type { PracticeState, RangeStep } from "../practice/store.js";
import type { Phase } from "./state.js";

export interface PracticeElements {
  library: HTMLElement;
  targetList: HTMLElement;
  /** Shown instead of the list when there is nothing in it. */
  empty: HTMLElement;
  rangeSummary: HTMLElement;
  rangeButton: HTMLButtonElement;
  /** "Record one" — and "Stop", while it is running. */
  addRecord: HTMLButtonElement;
  /** The label wrapping {@link addMidiInput}; hidden rather than disabled,
   *  because a `<label>` has no disabled state to respect. */
  addMidiLabel: HTMLElement;
  addMidiInput: HTMLInputElement;
  /** Where the built-in melodies' buttons are written. */
  starters: HTMLElement;

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

  draft: HTMLElement;
  draftBack: HTMLButtonElement;
  draftHint: HTMLElement;
  draftNotes: HTMLElement;
  draftMeta: HTMLElement;
  /** One extra sentence about where this melody came from — the chord warning
   *  on an imported part. Hidden when there is nothing to say. */
  draftNote: HTMLElement;
  draftTrimStart: HTMLButtonElement;
  draftTrimEnd: HTMLButtonElement;
  draftReset: HTMLButtonElement;
  draftLower: HTMLButtonElement;
  draftHigher: HTMLButtonElement;
  draftName: HTMLInputElement;
  draftSave: HTMLButtonElement;

  midi: HTMLElement;
  midiBack: HTMLButtonElement;
  midiTitle: HTMLElement;
  midiHint: HTMLElement;
  midiList: HTMLElement;

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

  /** Start a take that will become a target. */
  onRecordTarget(): void;
  onMidiFile(file: File): void;
  /** Add one of the built-in melodies, by id. */
  onAddBundled(id: string): void;
  /** Pick one part out of the MIDI file on screen, by id. */
  onPickMelody(id: string): void;
  onCloseMidi(): void;

  onTrimDraft(end: "start" | "end"): void;
  /** Cut the nearer end of the kept range back to one note, by index. */
  onTrimDraftTo(index: number): void;
  onResetTrim(): void;
  /** Move the whole draft by whole octaves. */
  onShiftDraft(delta: number): void;
  onRenameDraft(name: string): void;
  onSaveDraft(): void;
  onDiscardDraft(): void;
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

/* ── Making a target ──────────────────────────────────────────────────── */

/**
 * Where the ear-first rule stops, and why it stops exactly here.
 *
 * The draft screen names the notes it is showing. Everywhere else in practice
 * mode does not, and the difference is not a lapse: **a draft is a transcript
 * under review; a target is a melody you are going to be asked for.**
 *
 * A recorded draft is the app reporting what it just heard, which is the only
 * moment the user can catch the app being wrong — the scoop into the first note
 * that became a note of its own, or the octave error the pitch detector makes on
 * the deepest piano keys, where the fundamental is quieter than its own
 * harmonics. Hiding that would leave the trim and move controls with nothing to
 * aim at, and would hide the one limitation the hint warns about. It is the same
 * licence the range readout already takes: a name about something already
 * played is a label, not a prompt.
 *
 * The moment Save is tapped it becomes a target, and from there the library, the
 * detail screen and every exercise say only its name, its length and where it
 * came from.
 */
export const DRAFT_HINT_RECORDED =
  "This is what the app heard. Tap a note to cut the nearer end back to it, and " +
  "move the whole thing up or down to put it where you like. Notes missing? The " +
  "app only listens to the top half of a piano — play those ones further up the " +
  "keyboard and record it again.";

/** The same screen, for a melody that arrived from a file rather than a
 *  microphone: nothing was *heard*, so there is nothing to doubt. */
export const DRAFT_HINT_IMPORTED =
  "Tap a note to cut the nearer end back to it, keeping just the phrase you " +
  "want. Move the whole thing up or down if you like, then give it a name.";

export function draftHint(draft: TargetDraft): string {
  return draft.source === "recorded" ? DRAFT_HINT_RECORDED : DRAFT_HINT_IMPORTED;
}

/** "9 notes · 5.4 s · 2 dropped" — the shape of what Save would keep. */
export function draftMetaText(draft: TargetDraft): string {
  const kept = draftNoteCount(draft);
  const length = draftNotes(draft).reduce((total, note) => total + note.durSec, 0);
  const dropped = draft.notes.length - kept;
  return (
    `${kept} note${kept === 1 ? "" : "s"} · ${formatTargetDuration(length)}` +
    (dropped > 0 ? ` · ${dropped} dropped` : "")
  );
}

/**
 * The draft's notes, as chips — and as the trim control itself.
 *
 * Buttons rather than spans, because tapping one cuts the nearer end of the
 * kept range back to it (see `trimDraftTo`); the Drop buttons underneath are
 * the fine adjustment. Trimmed notes stay on screen, greyed, rather than
 * disappearing: seeing what is about to go is the whole feedback loop, it is
 * what makes "Keep all" a visible undo rather than a leap of faith, and a
 * dropped chip has to remain tappable for the gesture to work in both
 * directions.
 */
export function draftChipsHtml(draft: TargetDraft): string {
  return draft.notes
    .map((note, index) => {
      const kept = index >= draft.keepFrom && index < draft.keepTo;
      const name = midiToName(note.midi + 12 * draft.octaveShift);
      return (
        `<button type="button" class="chip${kept ? "" : " is-dropped"}" data-i="${index}">` +
        `<span class="chip-name">${name}</span>` +
        `</button>`
      );
    })
    .join("");
}

/** One built-in melody's button. Its name is data in this repo, not user text,
 *  but it goes through the same escape as everything else. */
export function starterRowHtml(melody: { id: string; name: string }): string {
  return (
    `<button type="button" class="starter" data-bundled="${escapeHtml(melody.id)}">` +
    `${escapeHtml(melody.name)}</button>`
  );
}

/**
 * One row of the MIDI part picker.
 *
 * Name, size, and — when it matters — the fact that this part is not a single
 * line and the app took the top note of each chord. That warning belongs here
 * rather than after the choice: it is the reason to pick a different part.
 */
export function midiRowHtml(melody: MidiMelody): string {
  const warning = chordWarning(melody);
  return (
    `<button type="button" class="target" data-melody="${escapeHtml(melody.id)}">` +
    `<span class="target-name">${escapeHtml(melody.name)}</span>` +
    `<span class="target-detail">${escapeHtml(melodySummary(melody))}</span>` +
    (warning ? `<span class="target-detail">${escapeHtml(warning)}</span>` : "") +
    `</button>`
  );
}

/** What the part picker says at the top. */
export function midiHintText(count: number): string {
  if (count === 0) return "There are no notes in that file.";
  if (count === 1) return "One part in that file. Tap it to trim it and name it.";
  return `${count} parts in that file — tap the one that carries the tune.`;
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

  // The same running/stop rule the range buttons use, for the same reason:
  // there is one microphone, so the button that opened it is the only way out.
  elements.addRecord.addEventListener("click", () => {
    if (elements.addRecord.dataset.running === "true") handlers.onStopCapture();
    else handlers.onRecordTarget();
  });

  elements.addMidiInput.addEventListener("change", () => {
    const file = elements.addMidiInput.files?.[0];
    // Cleared before the handler runs: an input still holding a file fires no
    // `change` when the same file is picked again, and re-importing the file
    // you just imported is exactly what you do after picking the wrong part.
    elements.addMidiInput.value = "";
    if (file) handlers.onMidiFile(file);
  });

  // Written once and delegated, like the target list: the built-in melodies are
  // a constant of this build.
  elements.starters.innerHTML = BUNDLED_MELODIES.map(starterRowHtml).join("");
  elements.starters.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-bundled]")
      ?.getAttribute("data-bundled");
    if (id) handlers.onAddBundled(id);
  });

  elements.midiList.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-melody]")
      ?.getAttribute("data-melody");
    if (id) handlers.onPickMelody(id);
  });
  elements.midiBack.addEventListener("click", () => handlers.onCloseMidi());

  // Delegated, because the chips are rebuilt from a string on every edit.
  elements.draftNotes.addEventListener("click", (event) => {
    const index = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-i]")
      ?.getAttribute("data-i");
    if (index !== null && index !== undefined) handlers.onTrimDraftTo(Number(index));
  });

  elements.draftBack.addEventListener("click", () => handlers.onDiscardDraft());
  elements.draftTrimStart.addEventListener("click", () => handlers.onTrimDraft("start"));
  elements.draftTrimEnd.addEventListener("click", () => handlers.onTrimDraft("end"));
  elements.draftReset.addEventListener("click", () => handlers.onResetTrim());
  elements.draftLower.addEventListener("click", () => handlers.onShiftDraft(-1));
  elements.draftHigher.addEventListener("click", () => handlers.onShiftDraft(1));
  elements.draftSave.addEventListener("click", () => handlers.onSaveDraft());
  elements.draftName.addEventListener("input", () => {
    handlers.onRenameDraft(elements.draftName.value);
  });
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
  let renderedMelodies: readonly MidiMelody[] | null = null;
  /** What the chips on screen were built from. Rebuilding thirty spans on every
   *  keystroke in the name field would be silly. */
  let renderedChips = "";

  return {
    render(state, phase) {
      elements.library.hidden = state.screen !== "library";
      elements.detail.hidden = state.screen !== "target";
      elements.range.hidden = state.screen !== "range";
      elements.draft.hidden = state.screen !== "draft";
      elements.midi.hidden = state.screen !== "midi";

      // A take that is going to become a target. Both conditions, for the same
      // reason the range buttons check both: `recordingTarget` is practice
      // state and `phase` belongs to the transcriber, and a stale flag must
      // never leave a Stop button over a closed microphone.
      const recordingDraft = state.recordingTarget && phase === "recording";
      const analysingDraft = state.recordingTarget && phase === "analyzing";
      elements.addRecord.dataset.running = String(recordingDraft);
      elements.addRecord.classList.toggle("is-recording", recordingDraft);
      elements.addRecord.textContent = recordingDraft ? "Stop" : "Record one";
      elements.addRecord.disabled = analysingDraft;
      // A file picked mid-take would land on a draft screen the running
      // microphone is about to replace.
      elements.addMidiLabel.hidden = recordingDraft || analysingDraft;
      elements.addMidiInput.disabled = recordingDraft || analysingDraft;

      if (state.draft) {
        const draft = state.draft;
        elements.draftHint.textContent = draftHint(draft);
        const chips = draftChipsHtml(draft);
        if (chips !== renderedChips) {
          renderedChips = chips;
          elements.draftNotes.innerHTML = chips;
        }
        elements.draftMeta.textContent = draftMetaText(draft);
        elements.draftNote.textContent = draft.note;
        elements.draftNote.hidden = draft.note === "";
        // Never down to nothing: a target with no notes is not a melody, and
        // the buttons say so by stopping rather than by explaining.
        const only = draftNoteCount(draft) <= 1;
        elements.draftTrimStart.disabled = only;
        elements.draftTrimEnd.disabled = only;
        elements.draftReset.disabled =
          draft.keepFrom === 0 && draft.keepTo === draft.notes.length;
        elements.draftLower.disabled = !canShiftDraft(draft, -1);
        elements.draftHigher.disabled = !canShiftDraft(draft, 1);
        // Only when it actually differs: writing the value back on every render
        // would move the caret to the end mid-word on some browsers.
        if (elements.draftName.value !== draft.name) elements.draftName.value = draft.name;
      }

      const melodies = state.midi?.melodies ?? null;
      if (melodies !== renderedMelodies) {
        renderedMelodies = melodies;
        elements.midiList.innerHTML = melodies ? melodies.map(midiRowHtml).join("") : "";
      }
      if (state.midi) {
        elements.midiTitle.textContent = state.midi.fileName;
        elements.midiHint.textContent = midiHintText(state.midi.melodies.length);
      }

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
