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
import {
  holdHistoryText,
  holdScoreText,
  holdTakeaway,
  isDefaultRange,
  type HoldScore,
} from "../practice/drill.js";
import { followModel } from "../practice/follow.js";
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
import type {
  EchoSession,
  PracticeState,
  RangeStep,
  RecallAttempt,
} from "../practice/store.js";
import type { Voice } from "../audio/synth.js";
import { VOICE_LABELS, otherVoice } from "./controls.js";
import { drawDiffOverlay } from "./diffroll.js";
import { drawFollowRoll } from "./followroll.js";
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

  /* The two echo drills, which need no melody and no library. */
  drillHold: HTMLButtonElement;
  drillEcho: HTMLButtonElement;
  /** The nudge towards the range check, when the drills are running on a
   *  guessed register. Hidden once there is a measurement. */
  drillNote: HTMLElement;

  /** The playback voice, again. The transcriber's toggle lives in a dock this
   *  mode hides, and everything here is something the app plays *at* you. */
  voice: HTMLButtonElement;

  detail: HTMLElement;
  detailName: HTMLElement;
  detailMeta: HTMLElement;
  /** Where {@link TARGET_EXERCISES} goes. */
  detailNext: HTMLElement;
  /** Starts the recall exercise on this melody. */
  detailPractice: HTMLButtonElement;
  /** Starts the follow-along warm-up on it. */
  detailFollow: HTMLButtonElement;
  /** The nudge towards the range check, when this melody is about to be played
   *  at whatever pitch it was written at. Hidden once there is a measurement. */
  detailRange: HTMLElement;
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

  /* The hold drill: hear one note, hold it back, read two numbers. One screen
     throughout — unlike recall, the feedback here is *live*, so there is no
     before-and-after to split. */
  hold: HTMLElement;
  holdBack: HTMLButtonElement;
  holdHint: HTMLElement;
  /** "Hear it" — and "Stop", while the reference is sounding. */
  holdPlay: HTMLButtonElement;
  /** The big signed readout, written by `ui/holdmeter.ts` at frame rate. */
  holdCents: HTMLElement;
  /** The sled the needle rides on; centred on the reference, not on a
   *  semitone. */
  holdNeedle: HTMLElement;
  /** The meter's own line: "hold it there…", "too loud". */
  holdMeterHint: HTMLElement;
  /** "Hold it" — and "Stop", while the take is running. */
  holdWhistle: HTMLButtonElement;
  /** The score, as a sentence. Hidden until there is one. */
  holdScore: HTMLElement;
  holdTakeaway: HTMLElement;
  /** The running averages, once there are enough holds to mean anything. */
  holdTrend: HTMLElement;
  /** The two ways on: the same note again, or a new one. */
  holdAgain: HTMLButtonElement;
  holdNext: HTMLButtonElement;

  /* The phrase-echo drill, before the attempt. Shares the result screen with
     recall — see `resultOwner` — because a diff of a whistled phrase against
     the phrase that played is the same picture either way. */
  echo: HTMLElement;
  echoBack: HTMLButtonElement;
  echoHint: HTMLElement;
  echoMeta: HTMLElement;
  echoListen: HTMLButtonElement;
  echoListens: HTMLElement;
  echoWhistle: HTMLButtonElement;

  /* The follow-along warm-up: the only screen where the microphone and the
     speaker run at once. Nothing is scored — see `practice/follow.ts`. */
  follow: HTMLElement;
  followBack: HTMLButtonElement;
  followName: HTMLElement;
  followHint: HTMLElement;
  followCanvas: HTMLCanvasElement;
  /** "Start" — and "Stop", while it is running. */
  followStart: HTMLButtonElement;

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

  /* The drills. Both open from the library and neither needs a target. */
  onOpenHold(): void;
  onOpenEcho(): void;
  /** Play the reference note. */
  onHoldPlay(): void;
  /** Start the hold take. */
  onHoldAttempt(): void;
  /** The same note again. */
  onHoldAgain(): void;
  /** A different note. */
  onHoldNext(): void;
  /** Play the phrase. */
  onEchoListen(): void;
  /** Start the echo take. */
  onEchoAttempt(): void;
  /** The same phrase again. */
  onEchoRetry(): void;
  /** A new phrase, at whatever length the ramp has reached. */
  onEchoNext(): void;
  /** Leave either drill. */
  onCloseDrill(): void;
  /** Switch the playback voice. The same preference the dock's toggle sets. */
  onVoice(voice: Voice): void;

  /* Follow along. */
  onFollow(id: string): void;
  onFollowStart(): void;
  onFollowStop(): void;
  onCloseFollow(): void;

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
  /**
   * `playing` is the synth's own state, and it is needed for the same reason
   * `phase` is: the Listen button must never offer to stop a playback that has
   * already ended, and the two facts are owned by different modules.
   *
   * `voice` comes from the same place for the same reason — it is a preference
   * shared with the transcriber, owned by `ui/state.ts`, and this mode only
   * needs to show which one is on.
   */
  render(state: PracticeState, phase: Phase, playing?: boolean, voice?: Voice): void;
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
 * Describes the exercises in terms of what the *user* does rather than what the
 * app implements, which keeps the promise checkable and keeps it ear-first.
 */
export const TARGET_EXERCISES =
  "Hear this melody, then whistle it back from memory and see which notes " +
  "drifted — or warm up by whistling along with it, with nothing counted. " +
  "Nothing to read: the app plays, you answer.";

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

/* ── The drills ───────────────────────────────────────────────────────── */

/**
 * The nudge towards the range check, or nothing.
 *
 * Shown rather than enforced. Requiring a measurement before the first drill
 * would put a two-take setup step between a new user and the first thing in this
 * mode that works without a library — and the default register is a perfectly
 * good guess for most people. So the drills run, and the screen says what it is
 * assuming.
 */
export const DRILL_RANGE_NUDGE =
  "These will play in a middle register until you measure where you actually " +
  "whistle — it takes two short takes.";

export function drillRangeNote(range: WhistleRange | null): string {
  return isDefaultRange(range) ? DRILL_RANGE_NUDGE : "";
}

/**
 * The same nudge, on a melody that is about to be played at its written pitch.
 *
 * Worth saying *here* rather than only on the library's range card, because
 * this is the screen where it is about to matter: an unmeasured whistler gets a
 * melody in whatever register it was written in, which for a MIDI import is
 * often somewhere nobody can whistle at all — and then every attempt comes back
 * as a register error the app introduced.
 */
export const TARGET_RANGE_NUDGE =
  "This will play at the pitch it was written at until you measure where you " +
  "actually whistle — it takes two short takes.";

export function targetRangeNote(range: WhistleRange | null): string {
  return isDefaultRange(range) ? TARGET_RANGE_NUDGE : "";
}

/**
 * The hold drill's instruction, before and after the reference has been heard.
 *
 * The second sentence of the first one is the entire exercise: the bar is
 * centred on *the note that played*, not on the nearest note to whatever comes
 * out, which is what makes it a target rather than a tuner.
 */
export const HOLD_HINT_FIRST =
  "Tap Hear it, listen, then whistle that note back and hold it. The bar shows " +
  "how far off you are while you hold — steady beats close.";

/** After at least one play: the same rule without the lesson. */
export const HOLD_HINT_HEARD =
  "Whistle it back and hold it steady. Hear it again first if you like.";

export function holdHint(plays: number): string {
  return plays === 0 ? HOLD_HINT_FIRST : HOLD_HINT_HEARD;
}

/** "Hear it" the first time, "Hear it again" after — "Stop" while it sounds. */
export function holdPlayLabel(plays: number, playing: boolean): string {
  if (playing) return "Stop";
  return plays === 0 ? "Hear it" : "Hear it again";
}

/**
 * What the drill says about a hold, in two lines: the measurement, then the one
 * thing worth doing about it.
 *
 * Both come from `practice/drill.ts` rather than being written here, because
 * they are claims about numbers rather than about layout — and because the
 * boundary between "12 cents sharp" and "dead on" is the kind of judgement that
 * belongs next to the arithmetic that produced it.
 */
export function holdResultLines(score: HoldScore): { score: string; takeaway: string } {
  return { score: holdScoreText(score), takeaway: holdTakeaway(score) };
}

/**
 * The echo drill's instruction.
 *
 * "Made up on the spot" is load-bearing copy, not colour: it tells the user that
 * there is nothing here to have practised or half-remembered, which is exactly
 * what makes a wrong note in this drill mean something different from a wrong
 * note in recall.
 */
export const ECHO_HINT_FIRST =
  "A short phrase, made up on the spot. Listen, then whistle it straight back. " +
  "Whatever register is comfortable is fine.";

export const ECHO_HINT_HEARD =
  "Listen again as often as you like, then whistle it straight back.";

export function echoHint(listens: number): string {
  return listens === 0 ? ECHO_HINT_FIRST : ECHO_HINT_HEARD;
}

/**
 * How long the phrase is, and nothing else about it.
 *
 * A note count is not a prompt — it says how much there is to hold on to, the
 * way the library says a melody is five notes long, and it is the one number
 * that makes the difficulty ramp visible as something the user is climbing.
 */
export function echoMetaText(echo: EchoSession): string {
  const count = echo.phrase.length;
  return `${count} note${count === 1 ? "" : "s"}.`;
}

/* ── Follow along ─────────────────────────────────────────────────────── */

/**
 * The warm-up's whole instruction, including the honest part.
 *
 * The second sentence exists because the app cannot hide what it is doing: echo
 * cancellation is off everywhere in this project (it eats whistles), so with the
 * speaker and the microphone both open the trail really will pick up the synth.
 * Saying so costs one line and turns a confusing artefact into an expected one —
 * and points at the fix, which is headphones.
 */
export const FOLLOW_HINT =
  "Just whistle along — nothing is counted and nothing is kept. Your own line " +
  "is drawn over the melody as you go.";

export const FOLLOW_ECHO_NOTE =
  "The microphone hears the speaker too, so the line may trace the melody a " +
  "little on its own. Headphones fix that.";

/** "Start" — and "Stop", while it is running. */
export function followLabel(running: boolean): string {
  return running ? "Stop" : "Start";
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

  elements.detailFollow.addEventListener("click", () => {
    const id = elements.detailFollow.getAttribute("data-target");
    if (id) handlers.onFollow(id);
  });

  elements.rangeButton.addEventListener("click", () => handlers.onOpenRange());
  elements.rangeDone.addEventListener("click", () => handlers.onCloseRange());

  /* ── The recall exercise ────────────────────────────────────────────
   *
   * The same running/stop rule as everywhere else in this file: whichever
   * button opened the microphone (or the speaker) is the only way out of it.
   */
  elements.recallBack.addEventListener("click", () => handlers.onCloseRecall());

  elements.recallListen.addEventListener("click", () => {
    if (elements.recallListen.dataset.running === "true") handlers.onStopListen();
    else handlers.onListen();
  });

  elements.recallWhistle.addEventListener("click", () => {
    if (elements.recallWhistle.dataset.running === "true") handlers.onStopCapture();
    else handlers.onAttempt();
  });

  /* ── The drills ─────────────────────────────────────────────────────
   *
   * Same running/stop rule as everywhere else: whichever button opened the
   * microphone (or the speaker) is the only way out of it.
   */
  elements.drillHold.addEventListener("click", () => handlers.onOpenHold());
  elements.drillEcho.addEventListener("click", () => handlers.onOpenEcho());

  // Reads the voice off the button rather than off a closure variable, so the
  // control cannot disagree with what it is showing.
  elements.voice.addEventListener("click", () => {
    handlers.onVoice(otherVoice(elements.voice.dataset.voice === "supersaw" ? "supersaw" : "clean"));
  });

  elements.holdBack.addEventListener("click", () => handlers.onCloseDrill());
  elements.holdPlay.addEventListener("click", () => {
    if (elements.holdPlay.dataset.running === "true") handlers.onStopListen();
    else handlers.onHoldPlay();
  });
  elements.holdWhistle.addEventListener("click", () => {
    if (elements.holdWhistle.dataset.running === "true") handlers.onStopCapture();
    else handlers.onHoldAttempt();
  });
  elements.holdAgain.addEventListener("click", () => handlers.onHoldAgain());
  elements.holdNext.addEventListener("click", () => handlers.onHoldNext());

  elements.echoBack.addEventListener("click", () => handlers.onCloseDrill());
  elements.echoListen.addEventListener("click", () => {
    if (elements.echoListen.dataset.running === "true") handlers.onStopListen();
    else handlers.onEchoListen();
  });
  elements.echoWhistle.addEventListener("click", () => {
    if (elements.echoWhistle.dataset.running === "true") handlers.onStopCapture();
    else handlers.onEchoAttempt();
  });

  elements.followBack.addEventListener("click", () => handlers.onCloseFollow());
  elements.followStart.addEventListener("click", () => {
    if (elements.followStart.dataset.running === "true") handlers.onFollowStop();
    else handlers.onFollowStart();
  });

  /**
   * Which exercise the result screen is showing.
   *
   * One screen, two sources: a diff of what you whistled against what played is
   * the same picture whether the melody came out of the library or out of the
   * phrase generator, and duplicating the canvas, the strip, the chip
   * highlighting and the sentences would be two of everything to keep in step.
   * What differs is only where the three buttons go, so that is the only thing
   * this indirection carries.
   */
  let resultOwner: "recall" | "echo" | null = null;

  elements.resultBack.addEventListener("click", () => {
    if (resultOwner === "echo") handlers.onCloseDrill();
    else handlers.onCloseRecall();
  });
  elements.resultDone.addEventListener("click", () => {
    if (resultOwner === "echo") handlers.onEchoNext();
    else handlers.onCloseRecall();
  });
  elements.resultRetry.addEventListener("click", () => {
    if (resultOwner === "echo") handlers.onEchoRetry();
    else handlers.onRetry();
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

  // Written once: fixed sentences, and keeping them in TypeScript rather than
  // in `index.html` is what lets a test hold the ear-first promise to them.
  elements.detailNext.textContent = TARGET_EXERCISES;
  elements.followHint.textContent = `${FOLLOW_HINT} ${FOLLOW_ECHO_NOTE}`;

  let renderedTargets: readonly PracticeTarget[] | null = null;
  let renderedMelodies: readonly MidiMelody[] | null = null;
  /** The attempt the result screen is showing. Identity, not equality: the
   *  store hands out a new object per attempt and never edits one. */
  let renderedAttempt: RecallAttempt | null = null;
  /** What the chips on screen were built from. Rebuilding thirty spans on every
   *  keystroke in the name field would be silly. */
  let renderedChips = "";

  return {
    render(state, phase, playing = false, voice = "clean") {
      const recall = state.screen === "recall" ? state.recall : null;
      const echo = state.screen === "echo" ? state.echo : null;
      const hold = state.screen === "hold" ? state.hold : null;
      const follow = state.screen === "follow" ? state.follow : null;
      // The attempt the shared result screen is showing, and whose exercise it
      // belongs to. Recall first only because a screen can only be one of them.
      const shown = recall?.attempt ?? echo?.attempt ?? null;
      resultOwner = recall?.attempt ? "recall" : echo?.attempt ? "echo" : null;

      elements.library.hidden = state.screen !== "library";
      elements.detail.hidden = state.screen !== "target";
      elements.range.hidden = state.screen !== "range";
      elements.draft.hidden = state.screen !== "draft";
      elements.midi.hidden = state.screen !== "midi";
      elements.hold.hidden = hold === null;
      elements.follow.hidden = follow === null;
      // One `screen`, two elements: before the attempt and after it. The first
      // one is where the ear-first rule has to hold, and keeping it a separate
      // element is what lets a test say so. The echo drill splits the same way,
      // and shares the second half.
      elements.recall.hidden = !recall || recall.attempt !== null;
      elements.echo.hidden = !echo || echo.attempt !== null;
      elements.result.hidden = shown === null;

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

      // The drills need no melody, so their card is a fixture of the library —
      // but they do need a register, and this is where the app admits it is
      // guessing at one.
      const drillNote = drillRangeNote(state.range);
      elements.drillNote.textContent = drillNote;
      elements.drillNote.hidden = drillNote === "";

      // One preference, two places to set it: the dock's toggle is in a bar
      // this mode hides, and everything in here is something the app plays at
      // you. `data-voice` is what the click handler reads back, so the control
      // and its label cannot drift apart.
      elements.voice.dataset.voice = voice;
      elements.voice.textContent = VOICE_LABELS[voice];
      elements.voice.classList.toggle("is-supersaw", voice === "supersaw");
      elements.voice.setAttribute(
        "aria-label",
        `Playback sound: ${VOICE_LABELS[voice]}. Tap to switch.`,
      );

      const selected = state.targets.find((target) => target.id === state.selectedId) ?? null;
      if (selected) {
        const summary = targetSummary(selected);
        elements.detailName.textContent = summary.name;
        elements.detailMeta.textContent = summary.detail;
        elements.detailDelete.setAttribute("data-target", selected.id);
        elements.detailPractice.setAttribute("data-target", selected.id);
        elements.detailFollow.setAttribute("data-target", selected.id);
        const detailNote = targetRangeNote(state.range);
        elements.detailRange.textContent = detailNote;
        elements.detailRange.hidden = detailNote === "";

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
      }

      /* ── The hold drill ────────────────────────────────────────────────
       *
       * One screen, because the feedback is live: there is no "before" to keep
       * clean of the answer, since the answer is a bar that moves while you
       * whistle. The score underneath appears when the take ends and is
       * replaced, not added to, by the next one.
       */
      if (hold) {
        const holding = hold.recording && phase === "recording";
        const analysing = hold.recording && phase === "analyzing";

        elements.holdHint.textContent = holdHint(hold.plays);
        elements.holdPlay.dataset.running = String(playing);
        elements.holdPlay.classList.toggle("is-playing", playing);
        elements.holdPlay.textContent = holdPlayLabel(hold.plays, playing);
        elements.holdPlay.disabled = holding || analysing;

        elements.holdWhistle.dataset.running = String(holding);
        elements.holdWhistle.classList.toggle("is-recording", holding);
        elements.holdWhistle.textContent = holding ? "Stop" : "Hold it";
        // The reference has to have *stopped* before the take starts: there is
        // no echo cancellation anywhere in this app, so a note still sounding
        // would be measured as part of the hold.
        // ...and not before the reference has been heard at all: a needle
        // centred on a note nobody played is not a drill, it is a tuner
        // pointed at a secret.
        elements.holdWhistle.disabled = analysing || playing || hold.plays === 0;
        elements.holdBack.disabled = holding || analysing;

        const lines = hold.score ? holdResultLines(hold.score) : null;
        elements.holdScore.textContent = lines?.score ?? "";
        elements.holdScore.hidden = lines === null;
        elements.holdTakeaway.textContent = lines?.takeaway ?? "";
        elements.holdTakeaway.hidden = lines === null;
        const trend = holdHistoryText(state.stats.holds);
        elements.holdTrend.textContent = trend;
        elements.holdTrend.hidden = trend === "";
        // Both ways on appear only once there is something to move on *from*,
        // so the screen before the first hold is one instruction and two
        // buttons.
        elements.holdAgain.hidden = lines === null;
        elements.holdNext.hidden = lines === null;
        elements.holdAgain.disabled = holding || analysing;
        elements.holdNext.disabled = holding || analysing;
      }

      /* ── The echo drill ────────────────────────────────────────────── */
      if (echo) {
        const attempting = echo.recording && phase === "recording";
        const analysing = echo.recording && phase === "analyzing";

        elements.echoHint.textContent = echoHint(echo.listens);
        elements.echoMeta.textContent = echoMetaText(echo);
        const heard = listenCountText(echo.listens);
        elements.echoListens.textContent = heard;
        elements.echoListens.hidden = heard === "";

        elements.echoListen.dataset.running = String(playing);
        elements.echoListen.classList.toggle("is-playing", playing);
        elements.echoListen.textContent = listenLabel(echo.listens, playing);
        elements.echoListen.disabled = attempting || analysing;

        elements.echoWhistle.dataset.running = String(attempting);
        elements.echoWhistle.classList.toggle("is-recording", attempting);
        elements.echoWhistle.textContent = attempting ? "Stop" : "Whistle it back";
        elements.echoWhistle.disabled = analysing || playing;
        elements.echoBack.disabled = attempting || analysing;
      }

      /* ── Follow along ──────────────────────────────────────────────────
       *
       * The only screen that leaves the microphone open next to the speaker,
       * and the only one with nothing to score. While it runs, Stop is the one
       * enabled control — the same rule every take in this app follows, and
       * here it also has to stop the melody.
       */
      if (follow) {
        const target = state.targets.find((t) => t.id === follow.targetId) ?? null;
        elements.followName.textContent = target?.name ?? "";
        elements.followStart.dataset.running = String(follow.running);
        elements.followStart.classList.toggle("is-recording", follow.running);
        elements.followStart.textContent = followLabel(follow.running);
        elements.followBack.disabled = follow.running;
        // While it runs the animation loop owns this canvas; between runs it is
        // drawn once from here, so the melody is on screen before Start is
        // tapped and stays there after it finishes.
        if (!follow.running) {
          drawFollowRoll(elements.followCanvas, {
            model: followModel(follow.notes),
            trail: [],
            elapsedSec: null,
          });
        }
      }

      /* ── The shared result screen ─────────────────────────────────── */
      if (shown) {
        if (shown !== renderedAttempt) {
          renderedAttempt = shown;
          highlighted = null;
          overlay = overlayModel({
            alignment: shown.alignment,
            attempt: shown.notes,
            trail: shown.trail,
          });
          elements.resultStrip.innerHTML = verdictStripHtml(verdictChips(overlay));
          elements.resultSummary.textContent =
            `${scoreText(shown.alignment)}. ` + transpositionText(shown.alignment.transposition);
          // The drill adds what the ramp just did. Not *instead* of the
          // takeaway — which jump went wrong is the whole point of a three-note
          // phrase — but after it, so a phrase getting longer reads as progress
          // rather than as the app being erratic.
          elements.resultTakeaway.textContent = [
            takeawayText(shown.alignment),
            resultOwner === "echo" ? echo?.ramp ?? "" : "",
          ]
            .filter((line) => line !== "")
            .join(" ");
          elements.resultRetry.textContent =
            resultOwner === "echo" ? "Same one again" : "Try again";
          elements.resultDone.textContent = resultOwner === "echo" ? "Next one" : "Done";
        }
        // Every render, not only on a new attempt: the canvas is sized by the
        // stylesheet, so a rotation or a tab switch leaves the last bitmap
        // stretched until something redraws it.
        drawOverlay();
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
