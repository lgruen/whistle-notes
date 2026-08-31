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

import { formatCents, midiToName } from "../notes/format.js";
import { BUNDLED_MELODIES } from "../practice/bundled.js";
import { chordWarning, melodySummary, type MidiMelody } from "../practice/midi.js";
import { isUsableRange, rangeSpanSemitones, type WhistleRange } from "../practice/range.js";
import {
  listenCountText,
  ordinal,
  overlayModel,
  scoreText,
  takeawayText,
  transpositionText,
  verdictChips,
  type OverlayModel,
  type VerdictChip,
} from "../practice/recall.js";
import {
  slotTrouble,
  troubleSpots,
  type AttemptRecord,
  type TargetTally,
} from "../practice/stats.js";
import {
  canShiftDraft,
  draftNoteCount,
  draftNotes,
  formatTargetDuration,
  targetSummary,
  type PracticeTarget,
  type TargetDraft,
} from "../practice/target.js";
import type { PracticeState, RangeStep, RecallAttempt } from "../practice/store.js";
import { drawDiffOverlay } from "./diffroll.js";
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
  /** Starts the recall exercise on this melody. */
  detailPractice: HTMLButtonElement;
  /** The whole history block; hidden until there is an attempt in it. */
  detailHistory: HTMLElement;
  /** One bar per slot, tinted by how often it has gone wrong. */
  detailHeat: HTMLElement;
  /** The one sentence about the worst of them, or nothing. */
  detailTrouble: HTMLElement;
  /** The recent attempts, newest first, as verdict strips. */
  detailAttempts: HTMLElement;
  detailBack: HTMLButtonElement;
  detailDelete: HTMLButtonElement;

  /* The recall exercise: one screen before the attempt, one after it. Two
     elements rather than one with a swapped body, because the ear-first rule is
     a claim about the *first* of them and a test can only hold the app to it if
     it is a thing of its own. */
  recall: HTMLElement;
  recallBack: HTMLButtonElement;
  recallName: HTMLElement;
  recallHint: HTMLElement;
  /** "Listen" — and "Stop", while the melody is playing. */
  recallListen: HTMLButtonElement;
  recallListens: HTMLElement;
  /** "Whistle it" — and "Stop", while the attempt is running. */
  recallWhistle: HTMLButtonElement;

  result: HTMLElement;
  /** The back arrow at the top; the same action as {@link resultDone}, because
   *  there is exactly one way out of a finished attempt and it should be
   *  wherever the thumb happens to be. */
  resultBack: HTMLButtonElement;
  resultCanvas: HTMLCanvasElement;
  resultStrip: HTMLElement;
  resultSummary: HTMLElement;
  resultTakeaway: HTMLElement;
  resultRetry: HTMLButtonElement;
  resultDone: HTMLButtonElement;

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

  /** Open the recall exercise on the selected melody. */
  onPractice(id: string): void;
  /** Play the target. Optional and unlimited — see the recall screen note. */
  onListen(): void;
  /** Stop a playback that is running. */
  onStopListen(): void;
  /** Start the attempt take. */
  onAttempt(): void;
  /** Another go at the same melody. */
  onRetry(): void;
  /** Leave the exercise. */
  onCloseRecall(): void;

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
  /** `playing` is the synth's own state, and it is needed for the same reason
   *  `phase` is: the Listen button must never offer to stop a playback that has
   *  already ended, and the two facts are owned by different modules. */
  render(state: PracticeState, phase: Phase, playing?: boolean): void;
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
 * Describes the exercise in terms of what the *user* does rather than what the
 * app implements, which keeps the promise checkable and keeps it ear-first. The
 * second sentence is still a promise: the echo drills land in T4.
 */
export const EXERCISES_COMING =
  "Hear this melody, then whistle it back from memory and see which notes " +
  "drifted. Short echo drills built from the notes you keep missing are still " +
  "to come. Nothing to read: the app plays, you answer.";

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

/* ── Recall: before the attempt ───────────────────────────────────────── */

/**
 * The whole instruction, and the hardest copy in the app to keep honest.
 *
 * It has to make three things true at once. Listening is **optional and
 * unlimited** — the difficulty knob is the user's own, and one listen is a
 * memory exercise where five is an ear exercise, both worth doing. Nothing is
 * *read*: no pitch, no name, no staff, because the moment the melody is on
 * screen as text this stops being the exercise it claims to be. And the register
 * is explicitly forgiven up front, so a beginner who echoes it high does not
 * spend the attempt worrying about it.
 */
export const RECALL_HINT_FIRST =
  "Tap Listen as many times as you like — then whistle it back from memory. " +
  "Whatever register is comfortable is fine; the app works out the rest.";

/** After at least one listen: the same rule, without repeating the lesson. */
export const RECALL_HINT_HEARD =
  "Listen again as often as you like, or whistle it back whenever you are ready.";

export function recallHint(listens: number): string {
  return listens === 0 ? RECALL_HINT_FIRST : RECALL_HINT_HEARD;
}

/** "Listen" the first time, "Listen again" after — and "Stop" while it plays. */
export function listenLabel(listens: number, playing: boolean): string {
  if (playing) return "Stop";
  return listens === 0 ? "Listen" : "Listen again";
}

/* ── Recall: the verdict strip ────────────────────────────────────────── */

/** What one chip shows: a big mark, a small line under it, and the sentence a
 *  screen reader gets instead of the two. */
export interface ChipText {
  mark: string;
  sub: string;
  label: string;
}

/**
 * One chip's two lines, and its accessible name.
 *
 * The mark answers "what happened here?" in as few characters as fit on a phone.
 * The sub-line is the note's **position in the melody**, on every chip that has
 * one — including the wrong and missed ones, which is not obvious and is the
 * whole reason this is a function worth testing: the summary underneath says
 * "the 5th note came out a semitone sharp", and a strip that dropped the number
 * from exactly the chips it was talking about would leave the reader counting.
 * The verdict is carried by the mark and the colour instead, and spelled out in
 * full in the accessible name where neither of those is available.
 *
 * Note names appear on exactly two of the five: the note you whistled instead,
 * and the note you added. Never the note that was wanted — see the ear-first
 * note in `practice/recall.ts`.
 */
export function chipText(chip: VerdictChip): ChipText {
  const position = chip.position === null ? "" : String(chip.position);
  const at = chip.position === null ? "Extra note" : `Note ${chip.position}`;
  const cents = formatCents(chip.cents ?? 0);
  const name = chip.nameMidi === null ? null : midiToName(chip.nameMidi);
  switch (chip.outcome) {
    case "clean":
      return { mark: "✓", sub: position, label: `${at}: clean` };
    case "off":
      return {
        mark: `${cents}¢`,
        sub: position,
        label: `${at}: ${Math.abs(Math.round(chip.cents ?? 0))} cents ${
          (chip.cents ?? 0) > 0 ? "sharp" : "flat"
        }`,
      };
    case "wrong":
      return {
        mark: name ?? "?",
        sub: position,
        label: `${at}: wrong${name ? `, you whistled ${name}` : ""}`,
      };
    case "missing":
      return { mark: "—", sub: position, label: `${at}: missed` };
    default:
      return { mark: name ?? "+", sub: "extra", label: `${at}${name ? `: ${name}` : ""}` };
  }
}

/**
 * The strip, as buttons.
 *
 * Buttons because they are the pointer into the overlay: tapping one frames its
 * slot on the canvas, which is what makes a strip of sixty-four chips navigable
 * on a phone at all. `data-recall-i` is the item's index in the overlay model,
 * not its slot — an extra note has no slot to be identified by.
 */
export function verdictStripHtml(chips: readonly VerdictChip[]): string {
  return chips
    .map((chip) => {
      const { mark, sub, label } = chipText(chip);
      return (
        `<button type="button" class="vchip is-${chip.outcome}" data-recall-i="${chip.index}"` +
        ` aria-label="${escapeHtml(label)}">` +
        `<span class="vchip-mark" aria-hidden="true">${escapeHtml(mark)}</span>` +
        `<span class="vchip-sub" aria-hidden="true">${escapeHtml(sub)}</span>` +
        `</button>`
      );
    })
    .join("");
}

/* ── The target's history ─────────────────────────────────────────────── */

/** How many past attempts the detail screen shows. The store keeps twenty; a
 *  phone screen can show a handful before it stops being a glance. */
export const HISTORY_ROWS = 6;

/**
 * One past attempt, as a row of coloured cells — the result screen's strip,
 * shrunk to a line.
 *
 * Deliberately unlabelled and unnamed. What it is for is the *shape*: six rows
 * with the same cell red is a trouble spot, six rows with a different cell red
 * each time is a person having ordinary bad luck, and those two want completely
 * different practice. No amount of summary statistics shows that as fast as six
 * lines of colour do.
 */
export function attemptRowHtml(attempt: AttemptRecord): string {
  const clean = attempt.verdicts.filter((verdict) => verdict === "clean").length;
  const cells = attempt.verdicts
    .map((verdict) => `<span class="vcell is-${verdict}"></span>`)
    .join("");
  return (
    `<div class="attempt">` +
    `<span class="attempt-strip">${cells}</span>` +
    `<span class="attempt-score">${clean}/${attempt.verdicts.length}</span>` +
    `</div>`
  );
}

/** The last few attempts, newest first. */
export function historyHtml(tally: TargetTally, rows: number = HISTORY_ROWS): string {
  return tally.history.slice(0, rows).map(attemptRowHtml).join("");
}

/**
 * The heat row: one bar per slot, opacity by how much trouble it is.
 *
 * Opacity rather than a colour ramp because the ramp would need a legend, and a
 * legend is a thing to read. A slot that is fine is a faint mark; a slot that
 * keeps going wrong is a solid one; the sentence underneath names it.
 */
export function heatRowHtml(tally: TargetTally): string {
  return slotTrouble(tally)
    .map((trouble) => {
      const opacity = (0.1 + 0.9 * Math.min(1, Math.max(0, trouble))).toFixed(2);
      return `<span class="heat" style="opacity:${opacity}"></span>`;
    })
    .join("");
}

/**
 * The one sentence about the worst slot — or nothing at all.
 *
 * Nothing at all is the common and correct answer, and it is the point of the
 * whole history: everybody flubs a note once, and an app that announced a
 * trouble spot after a single bad attempt would be reporting noise. It takes two
 * failures at the same slot before this says a word.
 */
export function troubleText(tally: TargetTally): string {
  const worst = troubleSpots(tally)[0];
  if (!worst) return "";
  const what = worst.missing > worst.wrong ? "gone missing" : "come out wrong";
  return (
    `The ${ordinal(worst.slot + 1)} note has ${what} in ${worst.bad} of ` +
    `${worst.attempts} attempts — that one is worth a few goes on its own.`
  );
}

/** "6 attempts · 4 of 5 clean last time" — the history block's own heading. */
export function historyMetaText(tally: TargetTally): string {
  const attempts = `${tally.attempts} attempt${tally.attempts === 1 ? "" : "s"}`;
  const last = tally.history[0];
  if (!last) return attempts;
  const clean = last.verdicts.filter((verdict) => verdict === "clean").length;
  return `${attempts} · ${clean} of ${last.verdicts.length} clean last time`;
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

  elements.detailPractice.addEventListener("click", () => {
    const id = elements.detailPractice.getAttribute("data-target");
    if (id) handlers.onPractice(id);
  });

  elements.rangeButton.addEventListener("click", () => handlers.onOpenRange());
  elements.rangeDone.addEventListener("click", () => handlers.onCloseRange());

  /* ── The recall exercise ────────────────────────────────────────────
   *
   * The same running/stop rule as everywhere else in this file: whichever
   * button opened the microphone (or the speaker) is the only way out of it.
   */
  elements.recallBack.addEventListener("click", () => handlers.onCloseRecall());
  elements.resultBack.addEventListener("click", () => handlers.onCloseRecall());
  elements.resultDone.addEventListener("click", () => handlers.onCloseRecall());
  elements.resultRetry.addEventListener("click", () => handlers.onRetry());

  elements.recallListen.addEventListener("click", () => {
    if (elements.recallListen.dataset.running === "true") handlers.onStopListen();
    else handlers.onListen();
  });

  elements.recallWhistle.addEventListener("click", () => {
    if (elements.recallWhistle.dataset.running === "true") handlers.onStopCapture();
    else handlers.onAttempt();
  });

  /**
   * Which chip is being asked about.
   *
   * View state, not store state: it is a pointer at something already on
   * screen, it means nothing to any other module, and it dies with the screen.
   * Putting it in the store would make every tap on a chip a state change that
   * re-renders the library.
   */
  let highlighted: number | null = null;
  /** The overlay the strip and the canvas were built from. */
  let overlay: OverlayModel | null = null;

  const drawOverlay = (): void => {
    const model = overlay;
    const attempt = renderedAttempt;
    if (!model || !attempt) return;
    drawDiffOverlay(elements.resultCanvas, { model, trail: attempt.trail, highlight: highlighted });
  };

  elements.resultStrip.addEventListener("click", (event) => {
    const raw = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-recall-i]")
      ?.getAttribute("data-recall-i");
    if (raw === null || raw === undefined) return;
    const index = Number(raw);
    // Tapping the chip that is already framed clears it, so there is a way back
    // to the whole picture that is not "tap something else".
    highlighted = highlighted === index ? null : index;
    for (const chip of elements.resultStrip.querySelectorAll<HTMLElement>("[data-recall-i]")) {
      chip.classList.toggle(
        "is-picked",
        highlighted !== null && Number(chip.getAttribute("data-recall-i")) === highlighted,
      );
    }
    drawOverlay();
  });

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
  /** The attempt the result screen is showing. Identity, not equality: the
   *  store hands out a new object per attempt and never edits one. */
  let renderedAttempt: RecallAttempt | null = null;
  /** What the chips on screen were built from. Rebuilding thirty spans on every
   *  keystroke in the name field would be silly. */
  let renderedChips = "";

  return {
    render(state, phase, playing = false) {
      const recall = state.screen === "recall" ? state.recall : null;
      elements.library.hidden = state.screen !== "library";
      elements.detail.hidden = state.screen !== "target";
      elements.range.hidden = state.screen !== "range";
      elements.draft.hidden = state.screen !== "draft";
      elements.midi.hidden = state.screen !== "midi";
      // One `screen`, two elements: before the attempt and after it. The first
      // one is where the ear-first rule has to hold, and keeping it a separate
      // element is what lets a test say so.
      elements.recall.hidden = !recall || recall.attempt !== null;
      elements.result.hidden = !recall || recall.attempt === null;

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
        elements.detailPractice.setAttribute("data-target", selected.id);

        // The history block, which is also the answer to "is this melody
        // getting easier?". Absent until there is something in it: an empty
        // heatmap is a row of grey boxes that says nothing at all.
        const tally = state.stats.targets.get(selected.id) ?? null;
        elements.detailHistory.hidden = !tally || tally.attempts === 0;
        if (tally && tally.attempts > 0) {
          elements.detailMeta.textContent = `${summary.detail} · ${historyMetaText(tally)}`;
          elements.detailHeat.innerHTML = heatRowHtml(tally);
          const trouble = troubleText(tally);
          elements.detailTrouble.textContent = trouble;
          elements.detailTrouble.hidden = trouble === "";
          elements.detailAttempts.innerHTML = historyHtml(tally);
        }
      }

      if (recall) {
        const target = state.targets.find((t) => t.id === recall.targetId) ?? null;
        // A take is running when the phase says so *and* this screen started
        // it, exactly as the range and record buttons decide it: `recording` is
        // practice state, `phase` belongs to the transcriber, and a stale flag
        // must never leave a Stop button over a closed microphone.
        const attempting = recall.recording && phase === "recording";
        const analysing = recall.recording && phase === "analyzing";

        elements.recallName.textContent = target?.name ?? "";
        elements.recallHint.textContent = recallHint(recall.listens);
        const heard = listenCountText(recall.listens);
        elements.recallListens.textContent = heard;
        elements.recallListens.hidden = heard === "";

        elements.recallListen.dataset.running = String(playing);
        elements.recallListen.classList.toggle("is-playing", playing);
        elements.recallListen.textContent = listenLabel(recall.listens, playing);
        elements.recallListen.disabled = attempting || analysing;

        elements.recallWhistle.dataset.running = String(attempting);
        elements.recallWhistle.classList.toggle("is-recording", attempting);
        elements.recallWhistle.textContent = attempting ? "Stop" : "Whistle it";
        // Playback and the microphone are mutually exclusive throughout this
        // app — echo cancellation is off, so a phone recording its own speaker
        // would transcribe the melody it just played. Same rule as the dock's
        // Record button.
        elements.recallWhistle.disabled = analysing || playing;
        // The same rule the range check's Done button follows: while a take is
        // running there is exactly one way out of this screen and it is the
        // button that started it. Leaving mid-take would walk away from an open
        // microphone with nothing on screen that gets back to a Stop.
        elements.recallBack.disabled = attempting || analysing;

        if (recall.attempt && recall.attempt !== renderedAttempt) {
          renderedAttempt = recall.attempt;
          highlighted = null;
          overlay = overlayModel({
            alignment: recall.attempt.alignment,
            attempt: recall.attempt.notes,
            trail: recall.attempt.trail,
          });
          elements.resultStrip.innerHTML = verdictStripHtml(verdictChips(overlay));
          elements.resultSummary.textContent =
            `${scoreText(recall.attempt.alignment)}. ` +
            transpositionText(recall.attempt.alignment.transposition);
          elements.resultTakeaway.textContent = takeawayText(recall.attempt.alignment);
        }
        // Every render, not only on a new attempt: the canvas is sized by the
        // stylesheet, so a rotation or a tab switch leaves the last bitmap
        // stretched until something redraws it.
        if (recall.attempt) drawOverlay();
      } else {
        renderedAttempt = null;
        overlay = null;
        highlighted = null;
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
