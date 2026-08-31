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
import { highlightStaff, renderStaff } from "./ui/staff.js";
import {
  applyResult,
  getState,
  setState,
  setTranspose,
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
    importLabel: element("import"),
    importInput: element<HTMLInputElement>("import-input"),
    save: element<HTMLButtonElement>("save-wav"),
    transpose: element("transpose"),
    message: element("message"),
  },
  {
    onRecord: beginRecording,
    onStopRecord: finishRecording,
    onPlay: beginPlayback,
    onStopPlay: stopPlayback,
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

function render(state: AppState): void {
  controls.render(state);
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
 * Called straight from the Record tap, with nothing awaited first: the audio
 * context inside `startRecording` only unlocks inside the gesture, and an
 * `await` before it would end the gesture. See `audio/capture.ts`.
 */
function beginRecording(): void {
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
  loopHandle = requestAnimationFrame(loop);

  void started.then(
    () => setState({ warning: processingWarning() }),
    (error: unknown) => {
      // A start that was overtaken by a Stop has already cleaned itself up and
      // must not overwrite whatever the app is doing now.
      if (error instanceof CaptureAborted) return;
      stopLoop();
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
    finishRecording();
    // Not `message`: `finishRecording` clears that, and `applyResult` sets it
    // again. The warning line survives both and is where non-fatal news goes.
    setState({ warning: message });
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
    return;
  }
  // Held so the debug export has something to save. One take at a time: at the
  // 60 s cap that is ~11.5 MB, and it is dropped the moment the next one
  // starts.
  lastTake = take;
  setState({ phase: "analyzing", message: "", hasRecording: true });
  analyze(take, "that take");
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
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const result = transcribe(audio.samples, audio.sampleRate);
        applyResult(result.notes, result.frames, result.tuningOffsetCents);
      } catch (error) {
        console.error("[transcribe] failed", error);
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
  const started = startPlayback(state.notes, state.transpose, {
    onIndex: (index) => setState({ playingIndex: index }),
    onEnd: () => setState({ playing: false, playingIndex: null }),
  });
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
