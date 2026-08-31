/**
 * Microphone capture: the browser half of the pipeline.
 *
 * The design rule is that this module produces *samples* and nothing else
 * interesting. It records raw PCM, feeds a `PitchTracker` for the live readout,
 * and on stop hands one contiguous `Float32Array` to `transcribe()` — the same
 * function the Node harness calls. Live and offline therefore cannot disagree
 * about what was whistled, which is the property that makes a bad transcription
 * on a phone reproducible on a laptop.
 *
 * Browser-only by definition; nothing here may leak into `src/dsp`.
 */

import { DEFAULT_CONFIG, PitchTracker, type PitchFrame } from "../dsp/index.js";

/** Hard cap on a take. 60 s of float32 at 48 kHz is ~11.5 MB — comfortable on
 *  a phone, and long enough for any melody you can whistle in one breath run. */
export const MAX_RECORD_SEC = 60;

/**
 * Live metrics for the hot path, refreshed as blocks arrive.
 *
 * Read this from a rAF loop; do **not** route it through the store. See the
 * hot/cold note in `src/ui/state.ts`.
 */
export interface LiveStatus {
  /** Newest frame, whatever its quality; `null` before the first one. */
  frame: PitchFrame | null;
  /** Newest frame that looks like an actual tone, for the note readout. */
  voiced: PitchFrame | null;
  /** Something clipped in the last couple of seconds — "too loud". */
  clipped: boolean;
  /** Seconds of audio captured so far. */
  elapsedSec: number;
}

/**
 * Display-only voicing gate for the live readout.
 *
 * Deliberately looser and dumber than the real thing: the authoritative
 * decision about which frames are notes is made by segmentation, on stop, with
 * an adaptive noise floor and hysteresis. A live meter only has to be
 * responsive and roughly right — and it must not pretend to be the transcript,
 * because when the two disagree the transcript is the one that is correct.
 */
const LIVE_MIN_CLARITY = 0.5;

/** How long a clipped frame keeps the "too loud" hint on screen. */
const CLIP_HOLD_SEC = 2;

/*
 * Module-level node references. Holding these is not tidiness — WebKit has a
 * long-standing bug where a MediaStreamAudioSourceNode (and the worklet hanging
 * off it) can be garbage-collected while still connected, and the graph simply
 * goes silent with no error anywhere. Keeping every node reachable from a
 * module scope is the standard workaround.
 */
let audioCtx: AudioContext | null = null;
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let worklet: AudioWorkletNode | null = null;
let sink: GainNode | null = null;

let tracker: PitchTracker | null = null;
let blocks: Float32Array[] = [];
let totalSamples = 0;
let maxSamples = Infinity;
let recording = false;
let wakeLock: WakeLockSentinel | null = null;
let visibilityHooked = false;

/** The hot buffer. Appended to ~94×/s; read directly by the rAF loop. */
const liveFrames: PitchFrame[] = [];
let lastVoiced: PitchFrame | null = null;
let lastClippedSec = -Infinity;

/** An expected failure with a message that can go straight on screen. */
export class CaptureError extends Error {}

/**
 * Thrown when a start was overtaken by a stop or by another start.
 *
 * This is not a hypothetical: a user who taps Record and then Stop while the
 * permission prompt is still up leaves a `getUserMedia` promise in flight that
 * resolves *after* everything has been torn down. Without a generation check it
 * would happily build a graph nobody is watching and leave the microphone
 * indicator burning until the tab is closed.
 */
export class CaptureAborted extends Error {}

/** Bumped by every start and every teardown; a start whose generation is stale
 *  by the time an await resolves knows it has been overtaken. */
let session = 0;

export function isRecording(): boolean {
  return recording;
}

/** The live frame buffer. Read-only by contract; never copied, never cleared
 *  while a take is running. */
export function getLiveFrames(): readonly PitchFrame[] {
  return liveFrames;
}

export function getLiveStatus(): LiveStatus {
  const frame = liveFrames.length > 0 ? liveFrames[liveFrames.length - 1] : null;
  const now = frame?.tSec ?? 0;
  return {
    frame,
    voiced: lastVoiced,
    clipped: now - lastClippedSec < CLIP_HOLD_SEC,
    elapsedSec: audioCtx ? totalSamples / audioCtx.sampleRate : 0,
  };
}

/**
 * Start recording.
 *
 * ## Gesture ordering — load-bearing, do not reorder
 *
 * iOS only unlocks an `AudioContext` that is created **and** resumed inside the
 * synchronous part of a user-gesture handler. An `async` function still runs
 * synchronously up to its first `await`, so the context is built in the first
 * few lines here, *before* `getUserMedia` is awaited. Construct it afterwards
 * and it stays `suspended` forever: no error, no frames, a graph that is simply
 * dead — the classic "works on Android, silent on iPhone" bug.
 *
 * The same applies one level up: whoever calls this must call it as the first
 * statement of the tap handler, with no `await` before it.
 */
export async function startRecording(): Promise<void> {
  if (recording) return;
  const mine = ++session;

  if (typeof AudioContext === "undefined") {
    throw new CaptureError("This browser has no Web Audio support.");
  }

  const ctx = new AudioContext();
  // Not awaited: the *call* has to happen inside the gesture, the promise does
  // not have to settle there.
  void ctx.resume();
  audioCtx = ctx;

  if (!ctx.audioWorklet) {
    await teardown();
    throw new CaptureError(
      "This browser has no AudioWorklet support, which this app needs to record.",
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    await teardown();
    throw new CaptureError(
      "No microphone API available. This usually means the page is not on https:// or localhost.",
    );
  }

  let opened: MediaStream;
  try {
    opened = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Bare booleans, not `{ exact: false }`: these are *ideal* constraints.
        // A device that cannot switch its processing off should still give us a
        // microphone — a degraded signal beats a hard failure, and the warning
        // below tells the user what happened.
        //
        // Noise suppression is the dangerous one: speech NS models a sustained
        // pure tone as stationary noise and gates the whistle out entirely.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (err) {
    await teardown();
    throw new CaptureError(micErrorMessage(err));
  }
  if (mine !== session) throw await abandon(ctx, opened);

  try {
    // `import.meta.env.BASE_URL` keeps this working under the Pages subpath,
    // under `vite preview`, and in dev. The worklet is plain JS in public/ so
    // it never enters the module graph; Workbox precaches it via the `js` glob.
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-recorder.worklet.js`);
  } catch {
    await abandon(ctx, opened);
    throw new CaptureError("Could not load the audio recorder module. Try reloading the page.");
  }
  if (mine !== session) throw await abandon(ctx, opened);

  stream = opened;
  liveFrames.length = 0;
  lastVoiced = null;
  lastClippedSec = -Infinity;
  blocks = [];
  totalSamples = 0;
  maxSamples = Math.ceil(MAX_RECORD_SEC * ctx.sampleRate);
  // The pipeline is rate-agnostic and reads whatever the device gave us; iOS
  // ignores a sampleRate constraint anyway, so asking for one only invites a
  // resampler into the path.
  tracker = new PitchTracker(ctx.sampleRate, DEFAULT_CONFIG);

  source = ctx.createMediaStreamSource(stream);
  worklet = new AudioWorkletNode(ctx, "pcm-recorder");
  // Silent sink. Safari only pulls a graph that reaches the destination, so an
  // unconnected worklet never runs; a gain of 0 keeps the pull without feeding
  // the microphone back into the room.
  sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(worklet).connect(sink).connect(ctx.destination);

  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const block = event.data;
    if (!tracker) return;

    if (totalSamples < maxSamples) {
      blocks.push(block);
      totalSamples += block.length;
    }

    // `PitchTracker` is chunk-size independent, so 128-sample blocks produce
    // exactly the frames the offline pass will produce from the whole buffer.
    for (const frame of tracker.push(block)) {
      liveFrames.push(frame);
      if (frame.clipped) lastClippedSec = frame.tSec;
      if (frame.hz !== null && frame.clarity >= LIVE_MIN_CLARITY) lastVoiced = frame;
    }
  };

  recording = true;
  void requestWakeLock();
  hookVisibility();
}

/**
 * Whether the browser actually granted the raw-signal constraints, as a
 * user-facing warning, or `null` when everything is off as asked.
 *
 * Constraints are requests, not commands — some Android builds and every iOS
 * voice-processing path can quietly keep their DSP on. When that happens the
 * whistle gets gated out and the transcript is empty for reasons that look
 * nothing like a microphone problem, so it is worth a line on screen.
 */
export function processingWarning(): string | null {
  const track = stream?.getAudioTracks()[0];
  if (!track) return null;
  const settings = track.getSettings();
  // Also on the console: `getSettings()` is the only honest answer to "did the
  // constraints take?", and it is the first thing to check on a device.
  console.info("[capture] track settings", settings);

  const on: string[] = [];
  if (settings.noiseSuppression) on.push("noise suppression");
  if (settings.echoCancellation) on.push("echo cancellation");
  if (settings.autoGainControl) on.push("auto gain");
  if (on.length === 0) return null;
  return `Heads up: this browser kept ${on.join(" + ")} on. It may eat a steady whistle.`;
}

/**
 * Stop recording and return everything captured, as one buffer.
 *
 * Synchronous on purpose: the caller needs the samples in hand to switch to the
 * `analyzing` phase and let the browser paint before the transcription blocks
 * the main thread.
 */
export function stopRecording(): { samples: Float32Array; sampleRate: number } {
  const sampleRate = audioCtx?.sampleRate ?? 48000;
  recording = false;

  // Tracks first and immediately: this is what turns off the recording
  // indicator, releases the audio session, and stops draining the battery. It
  // also has to happen before playback, or iOS keeps routing output to the
  // earpiece.
  for (const track of stream?.getTracks() ?? []) track.stop();

  const total = Math.min(totalSamples, maxSamples);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const block of blocks) {
    if (offset >= total) break;
    const take = Math.min(block.length, total - offset);
    samples.set(take === block.length ? block : block.subarray(0, take), offset);
    offset += take;
  }
  blocks = [];

  void teardown();
  return { samples, sampleRate };
}

/** Release what a start opened but will never use, and say why it stopped. */
async function abandon(ctx: AudioContext, opened: MediaStream): Promise<CaptureAborted> {
  for (const track of opened.getTracks()) track.stop();
  // Only disown the module reference if it is still ours — a newer start may
  // already have published its own context over the top of it.
  if (audioCtx === ctx) audioCtx = null;
  if (ctx.state !== "closed") await ctx.close().catch(() => undefined);
  return new CaptureAborted("recording start was overtaken");
}

/** Release every audio resource. Safe to call twice. */
async function teardown(): Promise<void> {
  recording = false;
  // Invalidate any start still waiting on a permission prompt.
  session++;
  if (worklet) worklet.port.onmessage = null;
  for (const node of [source, worklet, sink]) node?.disconnect();
  for (const track of stream?.getTracks() ?? []) track.stop();

  const ctx = audioCtx;
  source = null;
  worklet = null;
  sink = null;
  stream = null;
  tracker = null;
  audioCtx = null;

  await releaseWakeLock();
  // Closing rather than suspending: an open input context is what makes iOS
  // route later playback to the earpiece, and the next take builds a fresh
  // context inside its own gesture anyway.
  if (ctx && ctx.state !== "closed") await ctx.close().catch(() => undefined);
}

/** Turn a getUserMedia rejection into something a human can act on. */
function micErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone blocked. Allow the microphone for this site, then tap Record again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone found on this device.";
    case "NotReadableError":
      return "The microphone is busy — another app or tab may be using it.";
    default:
      return `Could not open the microphone${name ? ` (${name})` : ""}.`;
  }
}

/*
 * Wake lock. Whistling at a phone means not touching it, and a screen that
 * sleeps mid-take takes the recording with it on some platforms. Entirely
 * best-effort: unsupported browsers, denied requests and a lock lost to a
 * backgrounded tab all just mean the screen may dim.
 */
async function requestWakeLock(): Promise<void> {
  try {
    if (!("wakeLock" in navigator)) return;
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock(): Promise<void> {
  const lock = wakeLock;
  wakeLock = null;
  try {
    await lock?.release();
  } catch {
    // Already gone — the platform released it when the tab was hidden.
  }
}

/** The lock is dropped whenever the page is hidden and is never restored
 *  automatically, so re-ask on the way back in. Registered once, lazily, so
 *  importing this module never touches the DOM. */
function hookVisibility(): void {
  if (visibilityHooked) return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && recording && !wakeLock) {
      void requestWakeLock();
    }
  });
}
