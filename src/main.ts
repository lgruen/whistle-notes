import { registerSW } from "virtual:pwa-register";
import FFT from "fft.js";
import "./app.css";
import {
  hzToMidiFloat,
  midiToName,
  transcribe,
  type Note,
  type PitchFrame,
} from "./dsp/index.js";
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
import {
  PLAYBACK_LEAD_SEC,
  isPlaying,
  startPlayback,
  startPlaybackOverMicrophone,
  stopPlayback,
  voiceReleaseSec,
  type PlayableNote,
} from "./audio/synth.js";
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
import { targetPlayback, type TrailPoint } from "./practice/recall.js";
import { alignAttempt, undoTuningCorrection } from "./practice/align.js";
import { holdPlayback, scoreHold, HOLD_REFERENCE_SEC } from "./practice/drill.js";
import { appendFollowPoint, followDone, followGapSec, followModel } from "./practice/follow.js";
import {
  addTarget,
  beginDraft,
  beginMidiRead,
  beginEcho,
  beginEchoTake,
  beginFollow,
  beginHold,
  beginHoldTake,
  beginRangeStep,
  beginRecall,
  beginRecallTake,
  beginTargetTake,
  captureRangeEnd,
  closeDrill,
  closeFollow,
  closeRecall,
  countEchoListen,
  countHoldPlay,
  countRecallListen,
  discardDraft,
  editDraft,
  endMidiRead,
  endEchoTake,
  endHoldTake,
  endRangeStep,
  endRecallTake,
  endTargetTake,
  finishEchoAttempt,
  finishHold,
  finishRecallAttempt,
  getPracticeState,
  nextEcho,
  nextHold,
  removeTarget,
  retryEcho,
  retryHold,
  retryRecall,
  saveDraft,
  selectTarget,
  setFollowRunning,
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
import { trailFromFrames } from "./ui/diffroll.js";
import { drawFollowRoll } from "./ui/followroll.js";
import { createHoldMeter } from "./ui/holdmeter.js";
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

/**
 * The two practice widgets on the hot path.
 *
 * Both are driven from animation loops with the microphone open and neither goes
 * anywhere near a store — the same hot/cold split the transcriber's live readout
 * follows, for the same reason (see the note at the top of `ui/state.ts`). They
 * are built here rather than inside the practice view because the view's
 * `render` is the cold path and must not be able to reach them.
 */
const holdMeter = createHoldMeter({
  cents: element("practice-hold-cents"),
  needle: element("practice-hold-needle"),
  hint: element("practice-hold-meter-hint"),
});
const followCanvas = element<HTMLCanvasElement>("practice-follow-roll");

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
    drillHold: element<HTMLButtonElement>("practice-drill-hold"),
    drillEcho: element<HTMLButtonElement>("practice-drill-echo"),
    drillNote: element("practice-drill-note"),
    voice: element<HTMLButtonElement>("practice-voice"),
    detail: element("practice-target"),
    detailName: element("practice-target-name"),
    detailMeta: element("practice-target-meta"),
    detailNext: element("practice-target-next"),
    detailPractice: element<HTMLButtonElement>("practice-target-practice"),
    detailFollow: element<HTMLButtonElement>("practice-target-follow"),
    detailRange: element("practice-target-range"),
    detailHistory: element("practice-target-history"),
    detailHeat: element("practice-target-heat"),
    detailTrouble: element("practice-target-trouble"),
    detailAttempts: element("practice-target-attempts"),
    detailBack: element<HTMLButtonElement>("practice-back"),
    detailDelete: element<HTMLButtonElement>("practice-delete"),
    recall: element("practice-recall"),
    recallBack: element<HTMLButtonElement>("practice-recall-back"),
    recallName: element("practice-recall-name"),
    recallHint: element("practice-recall-hint"),
    recallListen: element<HTMLButtonElement>("practice-recall-listen"),
    recallListens: element("practice-recall-listens"),
    recallWhistle: element<HTMLButtonElement>("practice-recall-whistle"),
    hold: element("practice-hold"),
    holdBack: element<HTMLButtonElement>("practice-hold-back"),
    holdHint: element("practice-hold-hint"),
    holdPlay: element<HTMLButtonElement>("practice-hold-play"),
    holdCents: element("practice-hold-cents"),
    holdNeedle: element("practice-hold-needle"),
    holdMeterHint: element("practice-hold-meter-hint"),
    holdWhistle: element<HTMLButtonElement>("practice-hold-whistle"),
    holdScore: element("practice-hold-score"),
    holdTakeaway: element("practice-hold-takeaway"),
    holdTrend: element("practice-hold-trend"),
    holdAgain: element<HTMLButtonElement>("practice-hold-again"),
    holdNext: element<HTMLButtonElement>("practice-hold-next"),
    echo: element("practice-echo"),
    echoBack: element<HTMLButtonElement>("practice-echo-back"),
    echoHint: element("practice-echo-hint"),
    echoMeta: element("practice-echo-meta"),
    echoListen: element<HTMLButtonElement>("practice-echo-listen"),
    echoListens: element("practice-echo-listens"),
    echoWhistle: element<HTMLButtonElement>("practice-echo-whistle"),
    follow: element("practice-follow"),
    followBack: element<HTMLButtonElement>("practice-follow-back"),
    followName: element("practice-follow-name"),
    followHint: element("practice-follow-hint"),
    followCanvas: element<HTMLCanvasElement>("practice-follow-roll"),
    followStart: element<HTMLButtonElement>("practice-follow-start"),
    result: element("practice-result"),
    resultBack: element<HTMLButtonElement>("practice-result-done"),
    resultCanvas: element<HTMLCanvasElement>("practice-result-roll"),
    resultStrip: element("practice-result-strip"),
    resultSummary: element("practice-result-summary"),
    resultTakeaway: element("practice-result-takeaway"),
    resultRetry: element<HTMLButtonElement>("practice-result-retry"),
    resultDone: element<HTMLButtonElement>("practice-result-close"),
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
      // it, not even a render. See `audio/capture.ts`. Its answer is whether a
      // take actually started: a screen that marks itself as recording when
      // one did not leaves a Stop button over somebody else's microphone.
      if (beginRecording(step)) beginRangeStep(step);
    },
    onStopCapture: finishRecording,
    onCloseRange: () => showLibrary(),

    // Same ordering rule as the range take: the microphone first, the screen
    // second, nothing awaited in between.
    onRecordTarget: () => {
      if (beginRecording("target")) beginTargetTake();
    },
    onMidiFile: importMidiFile,
    onAddBundled: addBundledTarget,
    onPickMelody: pickMidiMelody,
    onCloseMidi: () => showLibrary(),

    onPractice: beginRecall,
    onListen: listenToTarget,
    onStopListen: stopPlayback,
    // The microphone first, the screen second, nothing awaited in between —
    // the same iOS gesture rule the other two takes follow.
    onAttempt: () => {
      if (beginRecording("attempt")) beginRecallTake();
    },
    onRetry: retryRecall,
    onCloseRecall: () => {
      // The melody is still sounding if they left mid-listen, and a target
      // playing over a screen that is no longer about it is a bug the user
      // hears rather than sees.
      stopPlayback();
      closeRecall();
    },

    /* ── The drills ───────────────────────────────────────────────────
     *
     * Same three rules as every other exercise: the microphone opens first and
     * the screen is told second (the iOS gesture rule), the button that opened
     * it is the only way out of it, and leaving a screen silences whatever it
     * started.
     */
    onOpenHold: () => beginHold(),
    onOpenEcho: () => beginEcho(),
    onHoldPlay: playHoldReference,
    onHoldAttempt: () => {
      if (beginRecording("hold")) beginHoldTake();
    },
    onHoldAgain: retryHold,
    onHoldNext: () => {
      stopPlayback();
      nextHold();
    },
    onEchoListen: listenToPhrase,
    onEchoAttempt: () => {
      if (beginRecording("echo")) beginEchoTake();
    },
    onEchoRetry: retryEcho,
    onEchoNext: () => {
      stopPlayback();
      nextEcho();
    },
    onCloseDrill: () => {
      stopPlayback();
      closeDrill();
    },
    // The same store call the dock's toggle makes, and with the same rule: a
    // running playback is left alone, because it is the right notes in a
    // different colour. See `setVoice`.
    onVoice: setVoice,

    onFollow: beginFollow,
    onFollowStart: startFollowAlong,
    onFollowStop: stopFollowAlong,
    onCloseFollow: () => {
      stopFollowAlong();
      closeFollow();
    },

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
/**
 * Which MIDI read is the current one.
 *
 * The read is asynchronous and what it produces *navigates* — to the part
 * picker, or straight into a draft — so a result that arrives after the user
 * has gone somewhere else must be dropped rather than dragging them back. It is
 * the only path in the app that can move the screen without a tap, and it was
 * also the only way `recordingTarget` could be cleared out from under a running
 * take.
 */
let midiRead = 0;

function importMidiFile(file: File): void {
  if (file.size > MAX_MIDI_BYTES) {
    setPracticeMessage("That file is far larger than any melody needs to be.");
    return;
  }
  const mine = ++midiRead;
  beginMidiRead();

  /** Whether this read's answer is still the one the user is waiting for. */
  const wanted = (): boolean => {
    const phase = getState().phase;
    return (
      mine === midiRead &&
      getPracticeState().screen === "library" &&
      phase !== "recording" &&
      phase !== "analyzing"
    );
  };

  void file.arrayBuffer().then(
    (bytes) => {
      let melodies: MidiMelody[];
      try {
        melodies = midiMelodies(parseMidi(new Uint8Array(bytes)));
      } catch (error) {
        console.error("[midi] could not read the file", error);
        if (!wanted()) return endMidiRead();
        endMidiRead(
          error instanceof MidiError
            ? error.message
            : "That file could not be read as a MIDI file.",
        );
        return;
      }
      if (!wanted()) return endMidiRead();
      if (melodies.length === 0) {
        endMidiRead("There are no notes in that MIDI file.");
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
      if (!wanted()) return endMidiRead();
      endMidiRead("That file could not be opened on this device.");
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

/**
 * Play a prompt at the user: a melody, a generated phrase, a single reference
 * note.
 *
 * Transposed by nothing: whatever opened the exercise already moved it into the
 * whistler's register, and *that* is what the aligner will score the attempt
 * against. The octave toggle is about the *transcript* and is not even on screen
 * here.
 *
 * No note highlighting, deliberately — `onIndex` is where the transcriber lights
 * up a chip, and a light moving along a melody the user is about to be asked to
 * remember is a written prompt drawn in a different medium. The voice is the
 * stored preference; its toggle lives in the transcriber's dock, which practice
 * mode hides along with the rest of it.
 *
 * `counted` runs only if the sound actually started: `startPlayback` refuses
 * while the microphone is open, and a refusal must not leave a Stop button over
 * a silent speaker or add a listen nobody heard.
 */
function playPrompt(notes: readonly PlayableNote[], counted: () => void): void {
  const started = startPlayback(
    notes,
    0,
    {
      onIndex: () => undefined,
      onEnd: () => setState({ playing: false, playingIndex: null }),
    },
    getState().voice,
  );
  if (!started) return;
  setState({ playing: true, playingIndex: null });
  counted();
}

function listenToTarget(): void {
  const recall = getPracticeState().recall;
  if (recall) playPrompt(targetPlayback(recall.notes), countRecallListen);
}

function listenToPhrase(): void {
  const echo = getPracticeState().echo;
  if (echo) playPrompt(targetPlayback(echo.phrase), countEchoListen);
}

/** The hold drill's reference: one sustained note, then silence to hold into.
 *  Silence because there is no echo cancellation anywhere in this app — a
 *  reference still sounding would be measured as part of the hold. */
function playHoldReference(): void {
  const hold = getPracticeState().hold;
  if (hold) playPrompt(holdPlayback(hold.referenceMidi, HOLD_REFERENCE_SEC), countHoldPlay);
}

/* ── Follow along ─────────────────────────────────────────────────────
 *
 * The one place in the app where the speaker and the microphone are open at
 * once. It is allowed precisely because nothing here is transcribed, aligned or
 * stored: the take is dropped on stop, so the echo the microphone certainly
 * picks up can do no more than draw a faint line. See `practice/follow.ts` and
 * `startPlaybackOverMicrophone`.
 */

/** The melody being followed, or `null` when nothing is running. */
let followRoll: ReturnType<typeof followModel> | null = null;
let followTrail: TrailPoint[] = [];
let followHandle = 0;
/** The animation clock at the first frame of this run; `-1` until it arrives. */
let followStartMs = -1;

function startFollowAlong(): void {
  const follow = getPracticeState().follow;
  if (!follow || follow.running) return;

  // The microphone first and synchronously — the iOS gesture rule every take in
  // this app follows — and only then the melody, because `beginRecording` stops
  // any playback on its way in.
  if (!beginRecording("follow")) return;
  // The gap has to clear the release of the voice that is about to play it, or
  // two repeated short notes are one note — see `followGapSec`.
  const model = followModel(follow.notes, followGapSec(voiceReleaseSec(getState().voice)));
  const started = startPlaybackOverMicrophone(
    model.notes,
    {
      onIndex: () => undefined,
      onEnd: () => setState({ playing: false, playingIndex: null }),
    },
    getState().voice,
  );
  if (!started) {
    // Nothing to whistle along to. Give the microphone straight back rather
    // than leaving a take running behind a screen with no melody on it.
    finishRecording();
    setPracticeMessage("Could not start the melody on this device.");
    return;
  }

  followRoll = model;
  followTrail = [];
  followStartMs = -1;
  setState({ playing: true, playingIndex: null });
  setFollowRunning(true);
  followHandle = requestAnimationFrame(followLoop);
}

/** How long a reading lingers after the whistle stops — the same quarter second
 *  the live readout uses, so a held note draws one line rather than a dotted
 *  one. */
const FOLLOW_HOLD_SEC = 0.25;

/**
 * One clock, not two.
 *
 * The playhead runs on the animation clock, offset by the synth's own lead-in so
 * that a note drawn under the line is a note sounding now; each trail point is
 * placed at wherever the playhead is *at that frame*, carrying whatever pitch
 * the microphone last reported. So the trail lags by the analysis latency (a
 * 43 ms window plus a block or two) and nothing has to reconcile the capture
 * context's clock with the playback context's. Nothing here is measured, which
 * is what makes that trade honest.
 */
function followLoop(timestampMs: number): void {
  followHandle = requestAnimationFrame(followLoop);
  const model = followRoll;
  if (!model) return;
  if (followStartMs < 0) followStartMs = timestampMs;

  const elapsed = (timestampMs - followStartMs) / 1000 - PLAYBACK_LEAD_SEC;
  const status = getLiveStatus();
  const voiced = status.voiced;
  const fresh =
    voiced !== null &&
    voiced.hz !== null &&
    (status.frame?.tSec ?? 0) - voiced.tSec <= FOLLOW_HOLD_SEC;
  if (elapsed >= 0) {
    appendFollowPoint(
      followTrail,
      elapsed,
      fresh && voiced.hz !== null ? hzToMidiFloat(voiced.hz) : null,
    );
  }

  drawFollowRoll(followCanvas, {
    model,
    trail: followTrail,
    elapsedSec: Math.max(0, elapsed),
  });
  if (followDone(elapsed, model)) stopFollowAlong();
}

/**
 * Stop the line and the melody, and put the button back.
 *
 * Separate from {@link stopFollowAlong} because the take can also end without
 * anybody tapping Stop — the 60 s cap fires inside the audio callback, which is
 * exactly what happens to a warm-up left running in a backgrounded tab, where
 * this loop is not running to notice the melody finished. `finishRecording`
 * calls this on its way past, so a take that ends by itself cannot leave a Stop
 * button over a closed microphone.
 */
function endFollowRun(): void {
  if (followHandle) cancelAnimationFrame(followHandle);
  followHandle = 0;
  followRoll = null;
  stopPlayback();
  setFollowRunning(false);
}

/** End the warm-up: the line, the melody and the microphone, in that order.
 *  Idempotent, because both the natural end and every Stop come through here. */
function stopFollowAlong(): void {
  endFollowRun();
  finishRecording();
}

function renderPractice(): void {
  const state = getState();
  // Both views of "is the synth running", for the reason the update policy uses
  // both: the store is written by this module and the synth by its own
  // callbacks, and a Listen button that disagrees with either is a button that
  // stops nothing.
  practice.render(getPracticeState(), state.phase, state.playing || isPlaying(), state.voice);
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

/**
 * The hold drill's own hot loop.
 *
 * Separate from the one above rather than a branch inside it, because the two
 * paint completely different things: that one draws a growing piano roll and a
 * note *name*, this one draws a needle centred on the reference the drill just
 * played. Sharing them would mean a loop that checks which mode it is in sixty
 * times a second and touches elements that are not on screen.
 */
let holdHandle = 0;

function holdLoop(): void {
  holdHandle = requestAnimationFrame(holdLoop);
  const hold = getPracticeState().hold;
  if (hold) holdMeter.tick(getLiveStatus(), hold.referenceMidi);
}

function stopHoldLoop(): void {
  if (holdHandle) cancelAnimationFrame(holdHandle);
  holdHandle = 0;
  // Parked rather than left showing the last reading: the number under a
  // finished hold is the *score*, and a live needle frozen next to it would be
  // a second, staler answer to the same question.
  holdMeter.reset();
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
 * rather than by duplicating the start/stop/transcribe path.
 *
 * This variable answers one question and one only: **what is the microphone
 * open for right now.** It is written by `beginRecording` and read by the two
 * functions that end a running take (`finishRecording` and the interruption
 * handler), which pass it *down* as an argument from there. Nothing further
 * along reads it — {@link analyze} takes an intent parameter — because the
 * value here goes stale the moment a take finishes, and a stale intent read
 * late is not a subtle bug: it is an imported file overwriting a measured
 * range, or writing a row of practice history about a melody nobody whistled.
 */
type TakeIntent =
  | "transcribe"
  | RangeStep
  | "target"
  | "attempt"
  | "hold"
  | "echo"
  | "follow";
let takeIntent: TakeIntent = "transcribe";

/**
 * A practice take that ended badly, told to whichever screen started it.
 *
 * The transcriber's message line is not on screen in practice mode, so every
 * failure has to be routed by intent rather than dropped into `AppState`. Every
 * store call here also clears the flag the screen uses to decide whether a take
 * is running, which is what stops a failed take leaving a Stop button behind —
 * and the warm-up, which has a melody running alongside its microphone, has to
 * stop that too.
 */
function practiceTakeFailed(intent: Exclude<TakeIntent, "transcribe">, message: string): void {
  if (intent === "target") endTargetTake(message);
  else if (intent === "attempt") endRecallTake(message);
  else if (intent === "hold") endHoldTake(message);
  else if (intent === "echo") endEchoTake(message);
  else if (intent === "follow") {
    stopFollowAlong();
    setPracticeMessage(message);
  } else {
    // Named rather than left to the `else`, so `tsc` has to agree that the only
    // thing left is a range step. A seventh intent added above without an arm
    // here would otherwise be reported, silently and forever, as a failed range
    // check — on a screen that is not showing.
    const step: RangeStep = intent;
    endRangeStep(message, step);
  }
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
function beginRecording(intent: TakeIntent = "transcribe"): boolean {
  // There is one microphone, and starting a second take would not start a
  // second take: it would re-point this intent onto the audio already being
  // captured, so an echo drill's attempt could be scored against a range check.
  // Every screen disables its own way in while a take runs (and `startRecording`
  // refuses outright), which makes this the third of three answers to the same
  // question — and the only one that runs before any state is touched.
  if (isRecording() || getState().phase === "recording") return false;
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
  stopHoldLoop();
  // The transcriber's loop paints the live readout and the growing roll, and in
  // practice mode neither is on screen — except in the hold drill, which has a
  // live readout of its own and a loop to match. Skipping both costs nothing:
  // the 60 s cap they also watch is enforced authoritatively inside the audio
  // callback, which is why either can call itself a backstop.
  if (intent === "transcribe") loopHandle = requestAnimationFrame(loop);
  else if (intent === "hold") holdHandle = requestAnimationFrame(holdLoop);

  void started.then(
    () => setState({ warning: processingWarning() }),
    (error: unknown) => {
      // A start that was overtaken by a Stop has already cleaned itself up and
      // must not overwrite whatever the app is doing now.
      if (error instanceof CaptureAborted) return;
      stopLoop();
      stopHoldLoop();
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
  return true;
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

    if (intent === "follow") {
      // Its own arm, because the sentence below is about a take that produced
      // nothing to analyse — and a warm-up never has anything to analyse. The
      // melody and the roll have already been stopped by `finishRecording`.
      setPracticeMessage("That warm-up stopped early.");
      return;
    }
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
  stopHoldLoop();

  const take = stopRecording();
  // The warm-up scores nothing and stores nothing, so its audio has nowhere to
  // go. Dropped here rather than handed to `analyze`: a minute of FFTs for a
  // screen that never had a result is pure heat, and holding the samples any
  // longer than the microphone would keep ~11 MB alive for nothing.
  if (takeIntent === "follow") {
    setState({ phase: "idle", message: "", warning: null, hasRecording: false });
    // Also when the take ended by itself: see `endFollowRun`.
    endFollowRun();
    return;
  }
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
  // The intent goes with the audio, from here. See the note on `takeIntent`.
  analyze(take, takeIntent, TAKE_SUBJECTS[takeIntent]);
}

/** What a failed analysis is *about*, per intent — the one word that makes an
 *  error message land on the thing the user was actually doing. */
const TAKE_SUBJECTS: Record<TakeIntent, string> = {
  transcribe: "that take",
  low: "that note",
  high: "that note",
  target: "that melody",
  attempt: "that attempt",
  hold: "that note",
  echo: "that phrase",
  // Never reached — a warm-up take is dropped in `finishRecording` and never
  // analysed. Present because the map is exhaustive over the intents on
  // purpose: a new arm should have to say what it is about.
  follow: "that warm-up",
};

/**
 * Turn a take into a target the user can then trim, move and name.
 *
 * The pipeline is the transcriber's, unchanged, and that is what makes this
 * work for a piano as well as for a whistle: `transcribe()` reports the closest
 * note to whatever tone it heard, and a piano is a great deal more in tune than
 * a whistle is — a real piano take comes back within a couple of cents on every
 * note.
 *
 * The limit is the *register*, and it is sharper than "it gets confused down
 * there". The pitch search is band-limited from 400 Hz up (`minHz` in
 * `dsp/config.ts`; that band is also why speech and mains hum are rejected for
 * free), so a note whose fundamental is below roughly the middle of a keyboard
 * has nothing in band but its harmonics — and the voicing gate, which asks what
 * fraction of in-band energy sits under one mainlobe, then reads a
 * harmonic-rich tone as unvoiced.
 *
 * Measured on synthetic piano tones (harmonic stack, exponential decay): a
 * melody at middle C and an octave below it produces **no notes at all**; a
 * melody straddling the band edge comes back correct but with the notes under
 * it silently missing; an octave above middle C it is exact. Note the failure
 * is a *dropped* note rather than an octave-shifted one, so the draft's move
 * buttons are not the remedy — playing it further up the keyboard is, and that
 * is what the hint says. (Synthetic tones are not a piano; the real recording
 * in `test/fixtures/local` sits above the band edge and is transcribed exactly,
 * and says nothing either way about what happens below it.)
 */
function applyTargetTake(notes: readonly Note[]): void {
  // Back to `idle` rather than `result`, for the reason `applyRangeTake` gives:
  // practice mode is not showing a transcript, and leaving one behind would
  // mean finding it on the other tab later.
  setState({ phase: "idle", notes: [], frames: [], playingIndex: null, message: "" });

  if (notes.length === 0) {
    endTargetTake(
      "Nothing tonal in that one. Try it again a little louder — and if you are " +
        "at a piano, further up the keyboard: the app only listens to the top " +
        "half of one.",
    );
    return;
  }
  // The same ceiling an import gets, and for the same three reasons — a target
  // is a phrase you can hold in your head, the alignment is O(n·m), and the
  // trim controls take one tap per note. A recorded target had no limit at all,
  // which is a minute of whistling turned into a 300-note "melody" nobody can
  // trim and the aligner has to sweep 29 times per attempt.
  const kept = notes.slice(0, MAX_MELODY_NOTES);
  beginDraft(
    makeDraft(
      "recorded",
      defaultTargetName(),
      kept.map((note) => ({ midi: note.midi, durSec: note.durationSec })),
      kept.length < notes.length ? `Only the first ${MAX_MELODY_NOTES} notes were kept.` : "",
    ),
  );
}

/**
 * Score one attempt at the melody on the recall screen.
 *
 * Three things have to line up here and all three are the same melody: the
 * notes that were *played* (already moved into the whistler's register by
 * `beginRecall`), the notes the aligner scores against, and the notes the
 * statistics read their intervals from. They are one array — `recall.notes` —
 * passed to the synth, to `alignAttempt` and, through `finishRecallAttempt`, to
 * `recordAttempt`. Scoring against the written pitch while playing the
 * transposed one would report a register error the app itself introduced; and
 * because the intervals are keyed by *step* rather than by pitch, a melody
 * played an octave up still teaches the same directed-interval buckets, which
 * is what T4's drill selection reads.
 *
 * The frames come along too. They are the trail under the diff overlay, and
 * they are the only layer of that picture that can distinguish a note aimed at
 * badly from a note scooped into and never settled — which is the difference
 * between practising aim and practising patience.
 *
 * **The aligner is fed the raw pitches**, with the segmenter's global tuning
 * correction put back — and the trail is built with a zero offset to match, so
 * the notes and the line under them stay on one reference. That correction
 * exists to keep note *names* stable for a consistently sharp whistler, and
 * handing it to the aligner leaves it measuring residuals the DSP has already
 * removed: a perfect score for somebody 45 cents sharp, until the correction's
 * concentration gate stops firing and the same take suddenly scores badly. The
 * aligner estimates the reference itself, continuously — see the reference note
 * in `practice/align.ts`, which is where this decision is written down.
 */
function applyAttemptTake(notes: readonly Note[], frames: readonly PitchFrame[], tuningOffsetCents: number): void {
  // Back to `idle` with nothing kept, as every practice take does: the
  // transcriber is not on screen, and leaving an attempt in its result phase
  // would mean finding it on the other tab later.
  setState({ phase: "idle", notes: [], frames: [], playingIndex: null, message: "" });

  const recall = getPracticeState().recall;
  // The screen was left mid-analysis. Nothing to score, and nothing to say.
  if (!recall) return;

  if (notes.length === 0) {
    // No stats: an attempt the app could not hear is not evidence about the
    // whistler, and recording it would put a phantom failure in the heatmap.
    endRecallTake(
      "Nothing tonal in that one — have another go, a little louder or closer.",
    );
    return;
  }

  const heard = undoTuningCorrection(notes, tuningOffsetCents);
  finishRecallAttempt({
    notes: heard,
    trail: trailFromFrames(frames, 0),
    alignment: alignAttempt(heard, recall.notes),
  });
}

/**
 * Score one echo of a generated phrase.
 *
 * The same three-way agreement `applyAttemptTake` depends on, with the phrase in
 * place of the melody: `echo.phrase` is what the synth played, what the aligner
 * scores against, and what the interval ledger reads its steps from. The
 * *ledger* is the same one recall writes to — see `recordDrillAttempt` — which
 * is the whole point of the drill: the numbers it teaches are the numbers it
 * reads back when choosing the next phrase.
 */
function applyEchoTake(
  notes: readonly Note[],
  frames: readonly PitchFrame[],
  tuningOffsetCents: number,
): void {
  setState({ phase: "idle", notes: [], frames: [], playingIndex: null, message: "" });

  const echo = getPracticeState().echo;
  if (!echo) return;

  if (notes.length === 0) {
    // No stats, exactly as recall does it: an attempt the app could not hear is
    // not evidence about the whistler, and folding it in would teach the drill
    // that a perfectly good interval is a weakness.
    endEchoTake("Nothing tonal in that one — have another go, a little louder or closer.");
    return;
  }

  // Raw pitches and a raw trail, exactly as `applyAttemptTake` takes them: one
  // aligner, one reference, one decision — see the note there.
  const heard = undoTuningCorrection(notes, tuningOffsetCents);
  finishEchoAttempt({
    notes: heard,
    trail: trailFromFrames(frames, 0),
    alignment: alignAttempt(heard, echo.phrase),
  });
}

/**
 * Score one held note.
 *
 * Frames only: there is no melody here and no alignment to run, just one
 * sustained tone measured against the reference that played.
 *
 * **The trail is built with a zero tuning offset, and that is the load-bearing
 * line.** The segmenter measures each take's global tuning bias and takes it out
 * before rounding — which is exactly the bias this drill exists to report. Pass
 * `result.tuningOffsetCents` here and a whistler who sits 40 cents sharp on
 * every note is told they are dead on, by a machine that quietly moved the
 * target to meet them.
 */
function applyHoldTake(frames: readonly PitchFrame[]): void {
  setState({ phase: "idle", notes: [], frames: [], playingIndex: null, message: "" });

  const hold = getPracticeState().hold;
  if (!hold) return;

  const score = scoreHold(trailFromFrames(frames, 0), hold.referenceMidi);
  if (!score) {
    endHoldTake(
      "Nothing steady in that one — whistle the note back and hold it for a moment longer.",
    );
    return;
  }
  finishHold(score);
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
    endRangeStep("Nothing tonal in that one — hold a single steady note and try again.", step);
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
      // Always a transcription, whatever the last take through the microphone
      // was for. An import is a file the transcriber was handed; it is not
      // anybody's practice attempt.
      analyze(decoded, "transcribe", "that file");
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
 *
 * **`intent` is a parameter, not something read off the module.** Two frames
 * pass between the call and the work, and the whole point of an intent is to
 * say what *this* audio is for — so it travels with the audio. Reading it late
 * used to mean an imported file was routed by whatever the last take had been:
 * the first import after any practice take overwrote the measured range, or
 * wrote a row of practice history about a melody nobody whistled, or vanished
 * into a screen that was not showing.
 */
function analyze(audio: CapturedAudio, intent: TakeIntent, subject: string): void {
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const result = transcribe(audio.samples, audio.sampleRate);
        if (intent === "transcribe") {
          applyResult(result.notes, result.frames, result.tuningOffsetCents);
        } else if (intent === "target") {
          applyTargetTake(result.notes);
        } else if (intent === "attempt") {
          applyAttemptTake(result.notes, result.frames, result.tuningOffsetCents);
        } else if (intent === "echo") {
          applyEchoTake(result.notes, result.frames, result.tuningOffsetCents);
        } else if (intent === "hold") {
          applyHoldTake(result.frames);
        } else if (intent === "follow") {
          // Unreachable: a warm-up take never gets here. Explicit rather than
          // falling through to the range arm, which would take a `RangeStep`
          // this is not.
          setState({ phase: "idle", notes: [], frames: [] });
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
  // The diff overlay is a canvas too, and it is drawn once per result — so
  // without this it keeps a bitmap from the previous orientation until the next
  // state change.
  renderPractice();
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
