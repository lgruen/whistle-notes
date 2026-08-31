import { registerSW } from "virtual:pwa-register";
import FFT from "fft.js";
import "./app.css";
import { transcribe, midiToName, type Note } from "./dsp/index.js";
import {
  CaptureAborted,
  CaptureError,
  MAX_RECORD_SEC,
  getLiveFrames,
  getLiveStatus,
  isRecording,
  processingWarning,
  setCaptureHandlers,
  startRecording,
  stopRecording,
  type CapturedAudio,
} from "./audio/capture.js";
import { AudioFileError, decodeAudioFile } from "./audio/decode.js";
import { isPlaying, startPlayback, stopPlayback } from "./audio/synth.js";
import { downloadWav, takeFilename } from "./audio/wav-export.js";
import { a4FromOffsetCents, transposeMidi } from "./notes/format.js";
import { bundledMelody } from "./practice/bundled.js";
import {
  MAX_MELODY_NOTES,
  MAX_MIDI_BYTES,
  MidiError,
  chordWarning,
  midiMelodies,
  parseMidi,
  type MidiMelody,
} from "./practice/midi.js";
import { representativeMidi } from "./practice/range.js";
import {
  addTarget,
  beginDraft,
  beginRangeStep,
  beginTargetTake,
  captureRangeEnd,
  discardDraft,
  editDraft,
  endRangeStep,
  endTargetTake,
  getPracticeState,
  removeTarget,
  saveDraft,
  selectTarget,
  setPracticeMessage,
  showLibrary,
  showMidiPicker,
  showRangeCheck,
  subscribePractice,
  type RangeStep,
} from "./practice/store.js";
import {
  cleanTargetName,
  defaultTargetName,
  makeDraft,
  resetDraftTrim,
  shiftDraft,
  targetFromNotes,
  trimDraft,
  trimDraftTo,
  type TargetDraft,
} from "./practice/target.js";
import { createControls } from "./ui/controls.js";
import { createDebugView } from "./ui/debug.js";
import { createLiveView, formatClock } from "./ui/live.js";
import { highlightNoteList, initNoteList, renderNoteList } from "./ui/notelist.js";
import {
  drawPianoRoll,
  invalidateRollSize,
  resetRollRange,
  setRollRedraw,
} from "./ui/pianoroll.js";
import { createPracticeView } from "./ui/practice.js";
import { highlightStaff, renderStaff } from "./ui/staff.js";
import {
  applyResult,
  getState,
  setMode,
  setState,
  setTranspose,
  setVoice,
  subscribe,
  type AppState,
} from "./ui/state.js";
import { createUpdatePolicy, type UpdateTrigger } from "./ui/sw-update.js";
import { invalidatePalette } from "./ui/theme.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

const canvas = element<HTMLCanvasElement>("roll");
const noteListElement = element("notelist");
const staffElement = element("staff");
const tuningElement = element("tuning");

const live = createLiveView({
  note: element("live-note"),
  needle: element("live-needle"),
  level: element("live-level"),
  hint: element("live-hint"),
  time: element("live-time"),
});

const debug = createDebugView({
  panel: element<HTMLDetailsElement>("debug"),
  audio: element("debug-audio"),
  live: element("debug-live"),
  result: element("debug-result"),
  build: element("debug-build"),
});

initNoteList(noteListElement);

const controls = createControls(
  {
    record: element<HTMLButtonElement>("record"),
    play: element<HTMLButtonElement>("play"),
    voice: element<HTMLButtonElement>("voice"),
    importLabel: element("import"),
    importInput: element<HTMLInputElement>("import-input"),
    save: element<HTMLButtonElement>("save-wav"),
    transpose: element("transpose"),
    modes: element("modes"),
    message: element("message"),
  },
  {
    onMode: switchMode,
    onRecord: beginRecording,
    onStopRecord: finishRecording,
    onPlay: beginPlayback,
    onStopPlay: stopPlayback,
    // Unlike the octave, this deliberately leaves a running playback alone:
    // the notes are still the right notes, only the colour changes, and it
    // lands on the next tap of Play. See `setVoice`.
    onVoice: setVoice,
    onImport: beginImport,
    onSave: saveRecording,
    onTranspose: (shift) => {
      // The synth schedules pitches up front, so a transposed melody cannot be
      // changed mid-flight; stopping is honest and instant.
      if (isPlaying()) stopPlayback();
      setTranspose(shift);
    },
  },
);

/* ── Practice mode ────────────────────────────────────────────────────
 *
 * A second store and a second view, switched by the header tabs. The two modes
 * share the app store's `phase` and therefore the microphone: `capture.ts` is a
 * singleton, and routing every take through the same phase machine is what
 * makes it impossible for the two halves of the app to open it at once.
 */

const transcribeView = element("transcribe-view");
const practiceView = element("practice-view");

const practice = createPracticeView(
  {
    library: element("practice-library"),
    targetList: element("practice-targets"),
    empty: element("practice-empty"),
    rangeSummary: element("practice-range-summary"),
    rangeButton: element<HTMLButtonElement>("practice-range-open"),
    addRecord: element<HTMLButtonElement>("practice-add-record"),
    addMidiLabel: element("practice-add-midi"),
    addMidiInput: element<HTMLInputElement>("practice-add-midi-input"),
    starters: element("practice-starters"),
    detail: element("practice-target"),
    detailName: element("practice-target-name"),
    detailMeta: element("practice-target-meta"),
    detailNext: element("practice-target-next"),
    detailBack: element<HTMLButtonElement>("practice-back"),
    detailDelete: element<HTMLButtonElement>("practice-delete"),
    range: element("practice-range"),
    rangeHint: element("practice-range-hint"),
    rangeCurrent: element("practice-range-current"),
    rangeLow: element<HTMLButtonElement>("practice-range-low"),
    rangeHigh: element<HTMLButtonElement>("practice-range-high"),
    rangeDone: element<HTMLButtonElement>("practice-range-done"),
    draft: element("practice-draft"),
    draftBack: element<HTMLButtonElement>("practice-draft-back"),
    draftHint: element("practice-draft-hint"),
    draftNotes: element("practice-draft-notes"),
    draftMeta: element("practice-draft-meta"),
    draftNote: element("practice-draft-note"),
    draftTrimStart: element<HTMLButtonElement>("practice-draft-trim-start"),
    draftTrimEnd: element<HTMLButtonElement>("practice-draft-trim-end"),
    draftReset: element<HTMLButtonElement>("practice-draft-reset"),
    draftLower: element<HTMLButtonElement>("practice-draft-lower"),
    draftHigher: element<HTMLButtonElement>("practice-draft-higher"),
    draftName: element<HTMLInputElement>("practice-draft-name"),
    draftSave: element<HTMLButtonElement>("practice-draft-save"),
    midi: element("practice-midi"),
    midiBack: element<HTMLButtonElement>("practice-midi-back"),
    midiTitle: element("practice-midi-title"),
    midiHint: element("practice-midi-hint"),
    midiList: element("practice-midi-tracks"),
    message: element("practice-message"),
  },
  {
    onSelect: selectTarget,
    onBack: () => showLibrary(),
    onDelete: removeTarget,
    onOpenRange: showRangeCheck,
    onCaptureRange: (step) => {
      // Recording first, and marking the screen second. iOS only unlocks an
      // AudioContext created in the synchronous part of a gesture handler, and
      // `beginRecording` is where that happens — so nothing goes in front of
      // it, not even a render. See `audio/capture.ts`.
      beginRecording(step);
      beginRangeStep(step);
    },
    onStopCapture: finishRecording,
    onCloseRange: () => showLibrary(),

    // Same ordering rule as the range take: the microphone first, the screen
    // second, nothing awaited in between.
    onRecordTarget: () => {
      beginRecording("target");
      beginTargetTake();
    },
    onMidiFile: importMidiFile,
    onAddBundled: addBundledTarget,
    onPickMelody: pickMidiMelody,
    onCloseMidi: () => showLibrary(),

    onTrimDraft: (end) => reviseDraft((draft) => trimDraft(draft, end)),
    onTrimDraftTo: (index) => reviseDraft((draft) => trimDraftTo(draft, index)),
    onResetTrim: () => reviseDraft(resetDraftTrim),
    onShiftDraft: (delta) => reviseDraft((draft) => shiftDraft(draft, delta)),
    onRenameDraft: (name) => reviseDraft((draft) => ({ ...draft, name })),
    // The fallback only bites if the field was cleared: a target has to be
    // called *something*, because its name is the only thing the library shows.
    onSaveDraft: () => saveDraft(defaultTargetName()),
    onDiscardDraft: () => discardDraft(),
  },
);

/** Apply an edit to whatever draft is on screen. */
function reviseDraft(change: (draft: TargetDraft) => TargetDraft): void {
  const draft = getPracticeState().draft;
  if (draft) editDraft(change(draft));
}

/* ── Target sources ───────────────────────────────────────────────────
 *
 * Three ways in, one landing point. A recorded take arrives through the same
 * capture-and-transcribe path as everything else in the app; a MIDI file is
 * parsed on the spot; a built-in melody is already data. The first two stop at
 * a draft so the user can trim, move and name; the third is already a finished
 * melody and skips it.
 */

/** One of the melodies this build ships with. Already trimmed, already named,
 *  and at its written pitch — so there is nothing to draft. */
function addBundledTarget(id: string): void {
  const melody = bundledMelody(id);
  if (!melody) return;
  addTarget(targetFromNotes(melody.name, "bundled", melody.notes));
  setPracticeMessage(`Added “${melody.name}”.`);
}

/** The file's own name, without its extension, as the default target name. */
function midiFileLabel(fileName: string): string {
  return cleanTargetName(fileName.replace(/\.[^.]+$/, ""), "MIDI melody");
}

/**
 * Read a MIDI file and offer what is in it.
 *
 * Everything platform-shaped is here — the `File`, its bytes — and the parse
 * itself is pure and lives in `practice/midi.ts`, which is what lets it be
 * tested against byte fixtures built in the test file rather than against `.mid`
 * files committed to a public repo.
 *
 * A file with exactly one part skips the picker: choosing from a list of one is
 * a tap that asks a question with no answer.
 */
function importMidiFile(file: File): void {
  if (file.size > MAX_MIDI_BYTES) {
    setPracticeMessage("That file is far larger than any melody needs to be.");
    return;
  }
  void file.arrayBuffer().then(
    (bytes) => {
      let melodies: MidiMelody[];
      try {
        melodies = midiMelodies(parseMidi(new Uint8Array(bytes)));
      } catch (error) {
        console.error("[midi] could not read the file", error);
        setPracticeMessage(
          error instanceof MidiError
            ? error.message
            : "That file could not be read as a MIDI file.",
        );
        return;
      }
      if (melodies.length === 0) {
        setPracticeMessage("There are no notes in that MIDI file.");
        return;
      }
      const label = midiFileLabel(file.name);
      if (melodies.length === 1) {
        openMelodyDraft(melodies[0], label);
        return;
      }
      showMidiPicker({ fileName: label, melodies });
    },
    (error: unknown) => {
      console.error("[midi] could not open the file", error);
      setPracticeMessage("That file could not be opened on this device.");
    },
  );
}

/** One part of the MIDI file on screen, chosen from the picker. */
function pickMidiMelody(id: string): void {
  const pick = getPracticeState().midi;
  const melody = pick?.melodies.find((candidate) => candidate.id === id);
  if (!pick || !melody) return;
  openMelodyDraft(melody, `${pick.fileName} · ${melody.name}`);
}

/** Everything the import had to decide *for* the user goes on the draft screen
 *  as a sentence, so a melody that lost notes says so before it is saved. */
function openMelodyDraft(melody: MidiMelody, name: string): void {
  const notes: string[] = [];
  const chords = chordWarning(melody);
  if (chords) notes.push(chords);
  if (melody.truncated) notes.push(`Only the first ${MAX_MELODY_NOTES} notes were kept.`);
  beginDraft(makeDraft("midi", cleanTargetName(name, "MIDI melody"), melody.notes, notes.join(" ")));
}

function renderPractice(): void {
  practice.render(getPracticeState(), getState().phase);
}

subscribePractice(renderPractice);

/** Leave a mode. Playback is stopped on the way out: the synth is playing the
 *  transcript, and a transcript that is no longer on screen has no business
 *  still making noise. */
function switchMode(mode: AppState["mode"]): void {
  if (getState().mode === mode) return;
  if (isPlaying()) stopPlayback();
  setMode(mode);
}

/* ── Rendering (cold path) ────────────────────────────────────────────
 *
 * Every state change re-renders, but the two expensive views — the chip list
 * and the SVG staff — are rebuilt only when their *content* changed. Playback
 * moves the highlight several times a second, and rebuilding an SVG at that
 * rate to move one fill colour would be silly.
 */

let renderedNotes: readonly Note[] | null = null;
let renderedTranspose = NaN;

/**
 * Below this, saying anything would be noise: ±10 cents is inside the wobble of
 * a good whistle and well inside the rounding margin, so the correction changed
 * nothing anybody can hear.
 */
const TUNING_NOTICE_CENTS = 10;

/**
 * "Your whistle ran sharp, and here is the A that implies."
 *
 * The segmenter measures each take's global tuning bias and takes it out before
 * rounding — that is what rescues a consistently-40-cents-sharp whistler from
 * coin-flip note names. Silently correcting someone's pitch and never
 * mentioning it would be the app knowing something about the user that it
 * refuses to tell them, so when the correction is big enough to matter it is
 * reported in the reference every musician already owns: the frequency of A.
 */
function renderTuning(state: AppState): void {
  const cents = state.tuningOffsetCents;
  const show =
    state.phase === "result" && state.notes.length > 0 && Math.abs(cents) >= TUNING_NOTICE_CENTS;
  tuningElement.hidden = !show;
  // `formatCents` already carries the sign, so "+38 cents (sharp)" said it
  // twice. The word is the half a non-technical reader actually parses, so the
  // magnitude goes in bare and the direction is spelled out.
  tuningElement.textContent = show
    ? `Whistle ran ${Math.abs(Math.round(cents))} cents ${cents > 0 ? "sharp" : "flat"} — ` +
      `snapped to A = ${Math.round(a4FromOffsetCents(cents))} Hz.`
    : "";
}

/**
 * Draw the finished plot for the state as it stands.
 *
 * While a take is running the roll belongs to the animation loop, so every cold
 * caller has to check that first — three of them did, in three copies. One
 * function, one check.
 */
function redrawRoll(): void {
  const state = getState();
  if (state.phase === "recording") return;
  drawPianoRoll(canvas, {
    frames: state.frames,
    notes: state.notes,
    transpose: state.transpose,
    playingIndex: state.playingIndex,
    live: false,
    tuningOffsetCents: state.tuningOffsetCents,
  });
}

// A finished plot is drawn once and then left alone, so a canvas that changes
// size afterwards would show a stale, browser-stretched bitmap until the next
// state change. See `setRollRedraw` in ui/pianoroll.ts.
setRollRedraw(redrawRoll);

let renderedMode: AppState["mode"] | null = null;

function render(state: AppState): void {
  const modeChanged = state.mode !== renderedMode;
  renderedMode = state.mode;

  // `data-mode` is what the stylesheet uses to take the dock — and the space
  // the body reserves for it — away in practice mode.
  document.body.dataset.mode = state.mode;
  transcribeView.hidden = state.mode !== "transcribe";
  practiceView.hidden = state.mode !== "practice";

  controls.render(state);
  renderPractice();

  if (state.mode !== "transcribe") return;

  if (modeChanged) {
    // Everything in this view was laid out at zero size while it was hidden,
    // so nothing below can be trusted to be still valid: the canvas's cached
    // size is stale, and the staff's viewBox was measured against no width at
    // all. Forcing both is a handful of milliseconds, once per tab tap.
    invalidateRollSize();
    renderedNotes = null;
    renderedTranspose = NaN;
  }

  renderTuning(state);
  debug.render(state);

  if (state.notes !== renderedNotes || state.transpose !== renderedTranspose) {
    renderedNotes = state.notes;
    renderedTranspose = state.transpose;
    renderNoteList(noteListElement, state.notes, state.transpose);
    renderStaff(state.notes, staffElement, state.transpose, state.playingIndex);
  } else {
    highlightNoteList(noteListElement, state.playingIndex);
    highlightStaff(staffElement, state.playingIndex);
  }

  // While recording, the readout and the roll belong to the animation loop —
  // touching them from here would fight it.
  if (state.phase === "recording") return;

  redrawRoll();

  const playing = state.playingIndex === null ? null : state.notes[state.playingIndex];
  switch (state.phase) {
    case "analyzing":
      live.show("…", "Listening back…");
      break;
    case "result":
      live.show(
        playing ? midiToName(transposeMidi(playing.midi, state.transpose)) : "—",
        state.notes.length > 0
          ? `${state.notes.length} note${state.notes.length === 1 ? "" : "s"} — tap Play to hear them.`
          : "Nothing tonal in that take.",
      );
      break;
    case "error":
      // Never a dead end: whatever went wrong with the microphone — denied,
      // missing, insecure context, no AudioWorklet — a file still goes through
      // the same pipeline, so the way out is on screen next to the way in.
      live.show("—", "Tap Record to try again, or import an audio file.");
      break;
    default:
      live.show("—", "Tap Record and whistle a melody.");
  }
}

subscribe(render);

/* ── The hot path ─────────────────────────────────────────────────────
 *
 * One rAF loop, alive only while the microphone is open. It reads the frame
 * buffer that `capture.ts` fills directly and writes to one text node and one
 * canvas. Nothing here calls setState — see the note at the top of state.ts.
 */

let loopHandle = 0;

function loop(): void {
  loopHandle = requestAnimationFrame(loop);
  const status = getLiveStatus();
  const transpose = getState().transpose;

  live.tick(status, transpose, MAX_RECORD_SEC);
  debug.tick(status);
  drawPianoRoll(canvas, {
    frames: getLiveFrames(),
    notes: [],
    transpose,
    playingIndex: null,
    live: true,
  });

  // Backstop only. The cap is enforced authoritatively inside the audio
  // callback (see `capture.ts`), because this loop does not run at all while
  // the tab is hidden — and a hidden tab is exactly when a forgotten take would
  // otherwise keep the microphone open. Both routes call `finishRecording`,
  // which is idempotent by phase.
  if (status.elapsedSec >= MAX_RECORD_SEC) finishRecording();
}

function stopLoop(): void {
  if (loopHandle) cancelAnimationFrame(loopHandle);
  loopHandle = 0;
}

/* ── Transitions ──────────────────────────────────────────────────────── */

/** The audio behind the result on screen, when it came from the microphone.
 *  Kept only so the `.wav` debug export has something to hand over. */
let lastTake: CapturedAudio | null = null;

/**
 * What the take now running is *for*.
 *
 * Both modes record through the same module and the same phase machine, so the
 * one thing that differs — where the notes go afterwards — is carried here
 * rather than by duplicating the start/stop/transcribe path. Read once when the
 * analysis is scheduled, so a mode switch mid-analysis cannot redirect a take
 * that is already in flight.
 */
type TakeIntent = "transcribe" | RangeStep | "target";
let takeIntent: TakeIntent = "transcribe";

/**
 * A practice take that ended badly, told to whichever screen started it.
 *
 * The transcriber's message line is not on screen in practice mode, so every
 * failure has to be routed by intent rather than dropped into `AppState`. Both
 * store calls also clear the flag the screen uses to decide whether a take is
 * running, which is what stops a failed take leaving a Stop button behind.
 */
function practiceTakeFailed(intent: Exclude<TakeIntent, "transcribe">, message: string): void {
  if (intent === "target") endTargetTake(message);
  else endRangeStep(message);
}

/**
 * Called straight from the Record tap, with nothing awaited first: the audio
 * context inside `startRecording` only unlocks inside the gesture, and an
 * `await` before it would end the gesture. See `audio/capture.ts`.
 *
 * A range take clears the transcript on screen exactly like any other
 * recording, because it *is* one: this app has one microphone and one take at a
 * time, and pretending otherwise would mean two views disagreeing about which
 * audio the app is holding.
 */
function beginRecording(intent: TakeIntent = "transcribe"): void {
  takeIntent = intent;
  stopPlayback();
  resetRollRange();
  lastTake = null;

  const started = startRecording();

  setState({
    phase: "recording",
    notes: [],
    frames: [],
    playing: false,
    playingIndex: null,
    message: "",
    warning: null,
    hasRecording: false,
  });
  live.show("—", "Listening…");
  stopLoop();
  // The loop's only job is to paint the live readout and the growing roll, and
  // in practice mode neither is on screen. Skipping it costs nothing: the
  // 60 s cap it also watches is enforced authoritatively inside the audio
  // callback, which is why the loop can call itself a backstop.
  if (intent === "transcribe") loopHandle = requestAnimationFrame(loop);

  void started.then(
    () => setState({ warning: processingWarning() }),
    (error: unknown) => {
      // A start that was overtaken by a Stop has already cleaned itself up and
      // must not overwrite whatever the app is doing now.
      if (error instanceof CaptureAborted) return;
      stopLoop();
      if (intent !== "transcribe") {
        // The transcriber's error phase is a screen practice mode is not
        // showing, so the news has to go where the user is looking.
        setState({ phase: "idle", warning: null });
        practiceTakeFailed(
          intent,
          error instanceof CaptureError
            ? error.message
            : "Could not start recording on this device.",
        );
        return;
      }
      setState({
        phase: "error",
        message:
          error instanceof CaptureError
            ? error.message
            : "Could not start recording on this device.",
      });
    },
  );
}

/*
 * A take can also end without anybody tapping Stop: the 60 s cap is enforced
 * inside the audio callback (the animation loop above is a backstop, and it is
 * not running at all in a hidden tab), and an interrupted audio session or a
 * revoked microphone ends it too. Both come back here so that every ending goes
 * through the same stop-and-transcribe as a tap.
 */
setCaptureHandlers({
  onLimitReached: finishRecording,
  onInterrupted(message) {
    if (getState().phase !== "recording") return;
    // Read before finishing: whatever is on the warning line at this moment is
    // the processing warning, `finishRecording` clears it on the empty-take
    // path, and this handler used to overwrite it on the other one. It is the
    // single most useful line there is when a take comes back empty on a
    // phone, and an interruption is no reason to throw it away.
    const processing = getState().warning;
    const intent = takeIntent;
    finishRecording();

    if (intent !== "transcribe") {
      // The transcriber's status line is not on screen in practice mode, so
      // the news goes to the screen that is. When there *is* audio the
      // analysis that follows will report on it and this stays quiet rather
      // than writing a line the result immediately replaces.
      if (!getState().hasRecording) {
        practiceTakeFailed(intent, "That take was interrupted before any audio arrived.");
      }
      return;
    }

    // `hasRecording` is the honest question, and the two answers need
    // different sentences. A take that captured nothing lands on idle with no
    // notes, no playback and nothing to save — telling that user "here is what
    // was captured" points at an empty screen. It is also exactly the shape of
    // the WebKit silent-graph failure, so it is the case where being precise
    // about what happened matters most.
    if (!getState().hasRecording) {
      // A message, not a warning: this is *what happened*, and `applyResult`
      // never runs on this path to overwrite it.
      setState({
        message: "Recording was interrupted before any audio was captured.",
        warning: processing,
      });
      return;
    }
    // Not `message`: `finishRecording` clears that, and `applyResult` sets it
    // again. The warning line survives both and is where non-fatal news goes.
    setState({ warning: processing ? `${message} ${processing}` : message });
  },
});

function finishRecording(): void {
  if (getState().phase !== "recording") return;
  stopLoop();

  const take = stopRecording();
  if (!take) {
    // Stop tapped while the permission prompt was still up: the take never
    // started, so there is nothing to analyse. Saying so and going back to idle
    // beats transcribing an empty buffer into a confident "no notes found"
    // about audio that was never recorded.
    setState({ phase: "idle", message: "", warning: null });
    if (takeIntent !== "transcribe") {
      practiceTakeFailed(takeIntent, "That take captured no audio.");
    }
    return;
  }
  // Held so the debug export has something to save. One take at a time: at the
  // 60 s cap that is ~11.5 MB, and it is dropped the moment the next one
  // starts.
  lastTake = take;
  setState({ phase: "analyzing", message: "", hasRecording: true });
  analyze(take, TAKE_SUBJECTS[takeIntent]);
}

/** What a failed analysis is *about*, per intent — the one word that makes an
 *  error message land on the thing the user was actually doing. */
const TAKE_SUBJECTS: Record<TakeIntent, string> = {
  transcribe: "that take",
  low: "that note",
  high: "that note",
  target: "that melody",
};

/**
 * Turn a take into a target the user can then trim, move and name.
 *
 * The pipeline is the transcriber's, unchanged, and that is what makes this
 * work for a piano as well as for a whistle: `transcribe()` reports the closest
 * note to whatever tone it heard, and a piano is a great deal more in tune than
 * a whistle is. The one place it is unreliable is the bottom of the keyboard,
 * where a string's fundamental can be quieter than its own harmonics and the
 * octave above wins the spectral peak — which is exactly what the draft screen's
 * move buttons are for, and what its hint warns about.
 */
function applyTargetTake(notes: readonly Note[]): void {
  // Back to `idle` rather than `result`, for the reason `applyRangeTake` gives:
  // practice mode is not showing a transcript, and leaving one behind would
  // mean finding it on the other tab later.
  setState({ phase: "idle", notes: [], frames: [], playingIndex: null, message: "" });

  if (notes.length === 0) {
    endTargetTake("Nothing tonal in that one — try it again a little louder.");
    return;
  }
  beginDraft(
    makeDraft(
      "recorded",
      defaultTargetName(),
      notes.map((note) => ({ midi: note.midi, durSec: note.durationSec })),
    ),
  );
}

/**
 * Turn one short "hold a comfortable note" take into half a range.
 *
 * The pipeline is the transcriber's, unchanged — same `transcribe()`, same
 * segmentation, same everything — because a note held for two seconds is
 * exactly the case it is best at, and building a second, simpler pitch path for
 * it would be a second thing to keep honest for no gain.
 */
function applyRangeTake(step: RangeStep, notes: readonly Note[]): void {
  // Back to `idle` rather than `result`: practice mode is not showing a
  // transcript, and leaving the app in `result` would mean switching back to
  // the transcriber to find a one-note "transcription" of a range check.
  setState({ phase: "idle", notes: [], frames: [], playingIndex: null, message: "" });

  const midi = representativeMidi(notes);
  if (midi === null) {
    endRangeStep("Nothing tonal in that one — hold a single steady note and try again.");
    return;
  }
  const complete = captureRangeEnd(step, midi);
  setPracticeMessage(
    complete
      ? `Heard ${midiToName(midi)}.`
      : `Heard ${midiToName(midi)} — now the other end.`,
  );
}

/**
 * Import a file: the same pipeline, a different tap.
 *
 * `transcribe()` cannot tell the difference — and that is the feature. It makes
 * import an escape hatch when the microphone is unavailable, and a controlled
 * comparison when the microphone is *available but suspect*: whistle a take
 * live, whistle the same thing into the phone's voice-memo app, import it, and
 * whichever one is mush tells you whether the problem is the algorithm or the
 * platform's voice processing.
 */
function beginImport(file: File): void {
  stopPlayback();
  resetRollRange();
  // An imported file is already a file; there is nothing for the export to
  // give back that the user does not already have.
  lastTake = null;

  setState({
    phase: "analyzing",
    notes: [],
    frames: [],
    playing: false,
    playingIndex: null,
    message: "",
    warning: null,
    hasRecording: false,
  });

  void decodeAudioFile(file).then(
    (decoded) => {
      if (decoded.truncated) {
        // Truncated rather than rejected: someone importing a long recording
        // whistled a melody somewhere in it, and "file too long" helps nobody.
        setState({
          warning:
            `That file is ${formatClock(decoded.sourceDurationSec)} long — ` +
            `only the first ${MAX_RECORD_SEC} seconds were transcribed.`,
        });
      }
      analyze(decoded, "that file");
    },
    (error: unknown) => {
      console.error("[import] failed", error);
      setState({
        phase: "error",
        message:
          error instanceof AudioFileError
            ? error.message
            : "That file could not be read on this device.",
      });
    },
  );
}

/**
 * Run the transcription, off the paint path.
 *
 * `transcribe` is synchronous and can take a noticeable moment on a phone for a
 * full minute of audio; without yielding to the browser here, the "listening
 * back…" state never reaches the screen and the app looks frozen instead of
 * busy. rAF gets us to just before a paint, and the timeout puts the work in
 * the task *after* it.
 */
function analyze(audio: CapturedAudio, subject: string): void {
  // Read now, not in the callback: a mode switch or a fresh tap between the two
  // must not redirect a take that is already in flight.
  const intent = takeIntent;
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const result = transcribe(audio.samples, audio.sampleRate);
        if (intent === "transcribe") {
          applyResult(result.notes, result.frames, result.tuningOffsetCents);
        } else if (intent === "target") {
          applyTargetTake(result.notes);
        } else {
          applyRangeTake(intent, result.notes);
        }
      } catch (error) {
        console.error("[transcribe] failed", error);
        if (intent !== "transcribe") {
          setState({ phase: "idle", notes: [], frames: [] });
          practiceTakeFailed(intent, `Something went wrong listening to ${subject}. Try again.`);
          return;
        }
        // A take that crashed the segmenter is the most valuable recording this
        // app will ever hold, and it is the one nobody can whistle again. Save
        // stays on screen in the error phase (see `ui/controls.ts`), so the way
        // to turn this into a fixture is one tap away rather than gone.
        const rescuable = getState().hasRecording && lastTake !== null;
        setState({
          phase: "error",
          message:
            `Something went wrong analysing ${subject}.` +
            (rescuable ? " The audio is still here — save it before trying again." : ""),
        });
      }
    }, 0);
  });
}

/**
 * Save the take that produced the result on screen.
 *
 * A bad transcription is only reproducible if the audio behind it survives, and
 * a whistle cannot be performed twice the same way. This is what turns "it
 * heard D6 and I don't know why" into a file the offline harness can sweep.
 * Encoded and downloaded entirely on the device; nothing is uploaded anywhere.
 */
function saveRecording(): void {
  if (!lastTake) return;
  downloadWav(lastTake.samples, lastTake.sampleRate, takeFilename());
}

function beginPlayback(): void {
  const state = getState();
  if (state.notes.length === 0) return;

  // `startPlayback` enforces the recording/playback exclusion itself (see
  // `audio/synth.ts`), so a refusal has to be respected here rather than
  // assumed away: flagging `playing` against a playback that never started
  // would leave a Stop button that stops nothing.
  const started = startPlayback(
    state.notes,
    state.transpose,
    {
      onIndex: (index) => setState({ playingIndex: index }),
      onEnd: () => setState({ playing: false, playingIndex: null }),
    },
    state.voice,
  );
  if (!started) return;
  // After `startPlayback`, which internally stops any previous run and would
  // otherwise clear the flag we just set.
  setState({ playing: true, playingIndex: null });
}

/* ── Environment ──────────────────────────────────────────────────────── */

window.addEventListener("resize", () => {
  // The staff's viewBox is measured in CSS pixels and the canvas backing store
  // is sized in device pixels, so both need to hear about an orientation
  // change; the palette cache might also be stale after a theme switch, and the
  // roll's cached element size definitely is.
  invalidatePalette();
  invalidateRollSize();
  const state = getState();
  renderStaff(state.notes, staffElement, state.transpose, state.playingIndex);
  redrawRoll();
});

/**
 * Third leg of the fft.js interop smoke test (vitest and tsx being the other
 * two): importing it from the entry module means `vite build` has to resolve
 * and bundle this CommonJS package for real. It reports through the message
 * line so a broken FFT backend cannot hide behind a working-looking UI.
 */
function fftPeakBin(): number {
  const N = 16;
  const cycles = 2;
  const fft = new FFT(N);
  const spectrum = fft.createComplexArray();
  fft.realTransform(
    spectrum,
    Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * cycles * i) / N)),
  );
  fft.completeSpectrum(spectrum);

  let peakBin = 0;
  let peakMag = -Infinity;
  for (let bin = 0; bin <= N / 2; bin++) {
    const mag = Math.hypot(spectrum[2 * bin], spectrum[2 * bin + 1]);
    if (mag > peakMag) {
      peakMag = mag;
      peakBin = bin;
    }
  }
  return peakBin;
}

render(getState());

if (fftPeakBin() !== 2) {
  setState({
    phase: "error",
    message: "fft.js self-check FAILED — the FFT backend is not behaving.",
  });
}

const stamp = document.getElementById("build-stamp");
if (stamp) stamp.textContent = `build ${__BUILD__}`;

/*
 * ── Service-worker updates ────────────────────────────────────────────────
 *
 * Two failure modes, pulling in opposite directions.
 *
 * *Too stale*: the browser only looks for a new worker on navigation, which an
 * installed PWA resumed from the background may not do for days. So we register
 * with `immediate: true` and re-check on every foreground; the build stamp in
 * the footer is how you confirm it worked.
 *
 * *Too eager*: `autoUpdate` mode reloads the page the instant a new worker
 * activates, which destroys a take mid-recording. `prompt` mode (see
 * `vite.config.ts`) is necessary but **not sufficient**: the plugin still owns
 * the reload, in its own `controlling` listener, and a worker claims *every*
 * client in its scope. So a second tab — or the installed window sitting behind
 * the browser — would be reloaded by a decision the first tab made, mid-take,
 * with nothing on its screen to explain it.
 *
 * Passing `onNeedReload` takes that listener over, so both halves of the
 * hand-over are ours and each client answers for itself:
 *
 *   1. `onNeedRefresh` — a worker is parked in `waiting`. Telling it to take
 *      over costs this page nothing, but it is what makes *other* clients reach
 *      step 2, so it goes through the same policy.
 *   2. `onNeedReload` — the new worker is now serving this page. The only way
 *      to run its code is `location.reload()`; by this point there is no
 *      `updateSW(true)` left to call, because the skipping already happened.
 *
 * The policy is `shouldApplyUpdate` in `ui/sw-update.ts`; if now is not a safe
 * moment the update simply waits — for the next phase change or the next
 * foreground. The honest cost of waiting at step 2 is that this page then runs
 * old JS against newly-precached assets. The only asset fetched after load is
 * `pcm-recorder.worklet.js`, at Record time, and a mismatch there already has a
 * message ("could not load the audio recorder module") rather than silence.
 */
const updates = createUpdatePolicy({
  skipWaiting() {
    void updateSW(true).catch((error: unknown) => {
      console.error("[sw] could not ask the waiting worker to take over", error);
    });
  },
  reload() {
    window.location.reload();
  },
});

function considerUpdate(trigger: UpdateTrigger): void {
  const { phase, playing } = getState();
  // Both views of "is audio running": the store is updated by the app, the two
  // audio modules by their own callbacks, and a reload must lose to either.
  updates.apply({ phase, playing: playing || isPlaying(), recording: isRecording() }, trigger);
}

// Declared after `updates` on purpose — the callbacks above only run once
// registration has resolved, which is several ticks after this line.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    updates.onWaiting();
    considerUpdate("state");
  },
  onNeedReload() {
    updates.onControlling();
    considerUpdate("state");
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      void registration.update();
      considerUpdate("foreground");
    });
  },
});

// Every phase change is a chance for a deferred update to land.
subscribe(() => considerUpdate("state"));
