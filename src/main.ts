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
  processingWarning,
  startRecording,
  stopRecording,
} from "./audio/capture.js";
import { isPlaying, startPlayback, stopPlayback } from "./audio/synth.js";
import { transposeMidi } from "./notes/format.js";
import { createControls } from "./ui/controls.js";
import { createLiveView } from "./ui/live.js";
import { highlightNoteList, initNoteList, renderNoteList } from "./ui/notelist.js";
import { drawPianoRoll, resetRollRange } from "./ui/pianoroll.js";
import { highlightStaff, renderStaff } from "./ui/staff.js";
import {
  applyResult,
  getState,
  setState,
  setTranspose,
  subscribe,
  type AppState,
} from "./ui/state.js";
import { invalidatePalette } from "./ui/theme.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

const canvas = element<HTMLCanvasElement>("roll");
const noteListElement = element("notelist");
const staffElement = element("staff");

const live = createLiveView({
  note: element("live-note"),
  needle: element("live-needle"),
  level: element("live-level"),
  hint: element("live-hint"),
  time: element("live-time"),
});

initNoteList(noteListElement);

const controls = createControls(
  {
    record: element<HTMLButtonElement>("record"),
    play: element<HTMLButtonElement>("play"),
    transpose: element("transpose"),
    message: element("message"),
  },
  {
    onRecord: beginRecording,
    onStopRecord: finishRecording,
    onPlay: beginPlayback,
    onStopPlay: stopPlayback,
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

function render(state: AppState): void {
  controls.render(state);

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

  drawPianoRoll(canvas, {
    frames: state.frames,
    notes: state.notes,
    transpose: state.transpose,
    playingIndex: state.playingIndex,
    live: false,
  });

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
      live.show("—", "Tap Record to try again.");
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
  drawPianoRoll(canvas, {
    frames: getLiveFrames(),
    notes: [],
    transpose,
    playingIndex: null,
    live: true,
  });

  // The 60 s cap is enforced here rather than in the capture module so that
  // stopping goes through exactly the same path as tapping Stop.
  if (status.elapsedSec >= MAX_RECORD_SEC) finishRecording();
}

function stopLoop(): void {
  if (loopHandle) cancelAnimationFrame(loopHandle);
  loopHandle = 0;
}

/* ── Transitions ──────────────────────────────────────────────────────── */

/**
 * Called straight from the Record tap, with nothing awaited first: the audio
 * context inside `startRecording` only unlocks inside the gesture, and an
 * `await` before it would end the gesture. See `audio/capture.ts`.
 */
function beginRecording(): void {
  stopPlayback();
  resetRollRange();

  const started = startRecording();

  setState({
    phase: "recording",
    notes: [],
    frames: [],
    playing: false,
    playingIndex: null,
    message: "",
    warning: null,
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

function finishRecording(): void {
  if (getState().phase !== "recording") return;
  stopLoop();

  const { samples, sampleRate } = stopRecording();
  setState({ phase: "analyzing", message: "" });

  // Paint first, analyse second. `transcribe` is synchronous and can take a
  // noticeable moment on a phone for a full minute of audio; without yielding
  // to the browser here, the "listening back…" state never reaches the screen
  // and the app looks frozen instead of busy. rAF gets us to just before a
  // paint, and the timeout puts the work in the task *after* it.
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const result = transcribe(samples, sampleRate);
        applyResult(result.notes, result.frames);
      } catch (error) {
        console.error("[transcribe] failed", error);
        setState({ phase: "error", message: "Something went wrong analysing that take." });
      }
    }, 0);
  });
}

function beginPlayback(): void {
  const state = getState();
  if (state.notes.length === 0) return;

  startPlayback(state.notes, state.transpose, {
    onIndex: (index) => setState({ playingIndex: index }),
    onEnd: () => setState({ playing: false, playingIndex: null }),
  });
  // After `startPlayback`, which internally stops any previous run and would
  // otherwise clear the flag we just set.
  setState({ playing: true, playingIndex: null });
}

/* ── Environment ──────────────────────────────────────────────────────── */

window.addEventListener("resize", () => {
  // The staff's viewBox is measured in CSS pixels and the canvas backing store
  // is sized in device pixels, so both need to hear about an orientation
  // change; the palette cache might also be stale after a theme switch.
  invalidatePalette();
  const state = getState();
  renderStaff(state.notes, staffElement, state.transpose, state.playingIndex);
  if (state.phase !== "recording") {
    drawPianoRoll(canvas, {
      frames: state.frames,
      notes: state.notes,
      transpose: state.transpose,
      playingIndex: state.playingIndex,
      live: false,
    });
  }
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
 * Service-worker staleness defence. `autoUpdate` + `immediate: true` installs
 * and activates a new worker as soon as one is found, but the browser only
 * *looks* on navigation — which an installed PWA resumed from the background
 * may not do for days. Re-checking whenever the app comes to the foreground is
 * what turns "deployed" into "actually running on the phone"; the build stamp
 * in the footer is how you confirm it did.
 */
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void registration.update();
    });
  },
});
