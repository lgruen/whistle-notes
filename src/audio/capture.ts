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

/**
 * `track.getSettings()`, read once at acquisition time.
 *
 * Read *when the track is opened*, not when somebody asks: a stopped track's
 * settings are not guaranteed to survive `stop()`, and the two places that want
 * them — the "noise suppression is on" warning and the debug panel — both run
 * after the take has ended in the common case. A Record→Stop fast enough that
 * `getUserMedia` resolves after the stop used to lose the warning entirely,
 * which is precisely the take where it mattered most.
 *
 * Deliberately outlives {@link teardown} so the debug panel can still answer
 * "what did this device actually give us?" while the result is on screen; it is
 * cleared at the start of the next take, not at the end of this one.
 */
let trackSettings: MediaTrackSettings | null = null;
/** Sample rate of the most recent take's context; see {@link trackSettings}
 *  for why this survives teardown. */
let lastSampleRate: number | null = null;

let tracker: PitchTracker | null = null;
let blocks: Float32Array[] = [];
let totalSamples = 0;
let maxSamples = Infinity;
let recording = false;
let wakeLock: WakeLockSentinel | null = null;
let visibilityHooked = false;
/** One take ends once. Guards the cap and the interruption path against each
 *  other and against re-entry from a second audio block. */
let endSignalled = false;

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

/**
 * How a take can end without anybody tapping Stop.
 *
 * Both of these are decided inside the audio callback or an audio-session
 * event, which is precisely where the animation loop that normally drives the
 * UI is *not* running: a backgrounded tab gets no `requestAnimationFrame`, and
 * a suspended context gets no frames at all. Handing the app a callback keeps
 * the ending on one code path — whatever ends the take, `main.ts` runs the same
 * stop-and-transcribe it runs for a tap.
 */
export interface CaptureHandlers {
  /** {@link MAX_RECORD_SEC} was reached. The module has already stopped keeping
   *  audio; the handler is expected to call {@link stopRecording}. */
  onLimitReached(): void;
  /** The take cannot continue — the audio session was interrupted or the
   *  microphone went away. Carries a line for the screen. */
  onInterrupted(message: string): void;
}

let handlers: Partial<CaptureHandlers> = {};

/** Install the end-of-take callbacks. Call once, at start-up. */
export function setCaptureHandlers(next: Partial<CaptureHandlers>): void {
  handlers = next;
}

/**
 * End this take exactly once, whatever noticed first.
 *
 * The microphone is released *here*, before the handler is called and whether
 * or not it does anything, and that ordering is the point. This is the one path
 * where the module decides a take is over without being asked, so it is also
 * the one path where a handler that declines to act — `main.ts` returns early
 * if the phase disagrees — would leave the microphone open, the recording
 * indicator lit and `recording` true, with no tap anywhere in the UI that gets
 * back to a `stopRecording()`. Owning the release removes that dependency: the
 * handler decides what to *show*, never whether the hardware is freed.
 *
 * If the handler really does nothing, the take is closed out entirely rather
 * than left half-open. That loses the audio, which is the honest cost: the
 * alternative is a module that says it is recording through a microphone it no
 * longer holds. The handler is therefore expected to call
 * {@link stopRecording} *synchronously* if it wants the samples.
 */
function signalEnd(reason: "limit" | "interrupted", message: string): void {
  if (!recording || endSignalled) return;
  endSignalled = true;
  // Just the tracks: the context, the blocks and the sample rate all have to
  // survive for `stopRecording()` to hand back what was captured.
  for (const track of stream?.getTracks() ?? []) track.stop();
  try {
    if (reason === "limit") handlers.onLimitReached?.();
    else handlers.onInterrupted?.(message);
  } finally {
    if (recording) void teardown();
  }
}

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
    // Clamped: a block that straddles the cap overshoots it by up to 128
    // samples, and a clock that reads 1:00 while the cap is 1:00 is the honest
    // answer either way.
    elapsedSec: audioCtx ? Math.min(totalSamples, maxSamples) / audioCtx.sampleRate : 0,
  };
}

/**
 * Forget everything the previous take accumulated.
 *
 * Called **synchronously** at the top of {@link startRecording}, before the
 * context is published and before anything is awaited. This ordering is
 * load-bearing: the caller starts its animation loop the moment the tap handler
 * returns, and that loop reads {@link getLiveStatus} while `getUserMedia` is
 * still showing a permission prompt. Leave the previous take's counters in
 * place and the mildest symptom is the old trail flashing on screen — while a
 * previous take that reached the 60 s cap would make the new one stop itself on
 * its very first frame, hand `transcribe()` a minute of zeroes, and go on doing
 * that for every subsequent tap until the page is reloaded.
 */
function resetTakeState(): void {
  liveFrames.length = 0;
  lastVoiced = null;
  lastClippedSec = -Infinity;
  blocks = [];
  totalSamples = 0;
  maxSamples = Infinity;
  endSignalled = false;
  tracker = null;
  // The *previous* take's answer to "did the constraints take?" must not be
  // reported against this one — a device can hand out a differently-configured
  // track on every acquisition.
  trackSettings = null;
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

  // Before the context is published, before the first await: see resetTakeState.
  resetTakeState();

  if (typeof AudioContext === "undefined") {
    throw new CaptureError("This browser has no Web Audio support.");
  }

  const ctx = new AudioContext();
  // Not awaited: the *call* has to happen inside the gesture, the promise does
  // not have to settle there. The rejection is swallowed rather than left
  // floating — Safari rejects `resume()` outright when it disagrees about the
  // gesture, and an unhandled rejection there is noise, not news.
  ctx.resume().catch(() => undefined);
  audioCtx = ctx;
  maxSamples = Math.ceil(MAX_RECORD_SEC * ctx.sampleRate);

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
    // A *stale* failure must behave exactly like a stale success: quietly. The
    // prompt this rejection belongs to was abandoned when the user tapped Stop
    // or tapped Record again, and a live granted session may be running on the
    // other side of it. Tearing down globally here would kill that session, and
    // throwing a `CaptureError` would put "Microphone blocked" on screen over a
    // recording that is working perfectly.
    if (mine !== session) throw await abandonContext(ctx);
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
    const overtaken = await abandon(ctx, opened);
    if (mine !== session) throw overtaken;
    throw new CaptureError("Could not load the audio recorder module. Try reloading the page.");
  }
  if (mine !== session) throw await abandon(ctx, opened);

  stream = opened;
  // Snapshot what the device actually granted, now, while the track is live.
  // See `trackSettings`: everything that reads this runs after the take.
  trackSettings = opened.getAudioTracks()[0]?.getSettings() ?? null;
  lastSampleRate = ctx.sampleRate;
  // Also on the console: `getSettings()` is the only honest answer to "did the
  // constraints take?", and it is the first thing to check on a device.
  console.info("[capture] track settings", trackSettings, "at", ctx.sampleRate, "Hz");

  // The pipeline is rate-agnostic and reads whatever the device gave us; iOS
  // ignores a sampleRate constraint anyway, so asking for one only invites a
  // resampler into the path.
  tracker = new PitchTracker(ctx.sampleRate, DEFAULT_CONFIG);

  /*
   * From here on the microphone is open, so every failure has to give it back.
   * `new AudioWorkletNode` throws for real — an `InvalidStateError` whenever
   * the processor name is not registered, which is what a half-updated
   * service-worker cache produces — and without this the tracks and the context
   * would leak one per attempt, with the recording indicator burning until the
   * tab is closed.
   */
  try {
    source = ctx.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(ctx, "pcm-recorder");
    // Silent sink. Safari only pulls a graph that reaches the destination, so
    // an unconnected worklet never runs; a gain of 0 keeps the pull without
    // feeding the microphone back into the room.
    sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(worklet).connect(sink).connect(ctx.destination);

    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const block = event.data;
      // Past the cap the take is over: no more audio is kept and — just as
      // importantly — no more FFTs are run on audio nobody will ever hear.
      if (!recording || !tracker || totalSamples >= maxSamples) return;

      blocks.push(block);
      totalSamples += block.length;

      // `PitchTracker` is chunk-size independent, so 128-sample blocks produce
      // exactly the frames the offline pass will produce from the whole buffer.
      for (const frame of tracker.push(block)) {
        liveFrames.push(frame);
        if (frame.clipped) lastClippedSec = frame.tSec;
        if (frame.hz !== null && frame.clarity >= LIVE_MIN_CLARITY) lastVoiced = frame;
      }

      /*
       * The cap is enforced *here*, in the audio callback, rather than only in
       * the animation loop that watches the clock. A hidden tab gets no
       * animation frames but keeps getting audio, so a rAF-only cap means a
       * backgrounded take runs the microphone, the analyser and an unbounded
       * frame buffer for as long as the phone is in a pocket.
       */
      if (totalSamples >= maxSamples) signalEnd("limit", "");
    };

    ctx.addEventListener("statechange", onContextStateChange);
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", onTrackEnded);
  } catch (error) {
    console.error("[capture] could not build the audio graph", error);
    await teardown();
    throw new CaptureError("Could not start the audio pipeline on this device. Try reloading.");
  }

  recording = true;
  void requestWakeLock();
  hookVisibility();

  /**
   * An interrupted audio session — a phone call, a route change, iOS deciding
   * the app has been in the background long enough — suspends the context. The
   * graph then stops pulling with no error anywhere: no frames, no samples, and
   * a UI that says "recording" forever. Try to bring it back; if the microphone
   * itself is gone there is nothing to come back to, so end the take on what we
   * have rather than pretending.
   */
  function onContextStateChange(): void {
    if (!recording || audioCtx !== ctx || ctx.state === "running") return;
    void ctx
      .resume()
      .catch(() => undefined)
      .then(() => {
        if (!recording || audioCtx !== ctx || ctx.state === "running") return;
        const track = stream?.getAudioTracks()[0];
        if (!track || track.readyState === "ended" || track.muted) {
          signalEnd("interrupted", "Recording was interrupted — here is what was captured.");
        }
      });
  }

  /** The microphone was revoked, unplugged or taken by another app. */
  function onTrackEnded(): void {
    if (!recording || audioCtx !== ctx) return;
    signalEnd("interrupted", "The microphone stopped — here is what was captured.");
  }
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
  const settings = trackSettings;
  if (!settings) return null;

  const on: string[] = [];
  if (settings.noiseSuppression) on.push("noise suppression");
  if (settings.echoCancellation) on.push("echo cancellation");
  if (settings.autoGainControl) on.push("auto gain");
  if (on.length === 0) return null;
  return `Heads up: this browser kept ${on.join(" + ")} on. It may eat a steady whistle.`;
}

/**
 * What the device actually gave us, for the debug panel.
 *
 * This is the on-device answer to the risk the plan flags but cannot settle
 * from a laptop: a platform that ignores the raw-signal constraints gates the
 * whistle out and produces an empty transcript that looks nothing like a
 * microphone problem. Values survive the end of a take on purpose — they are
 * read while the *result* is on screen.
 */
export interface CaptureInfo {
  /** Sample rate of the last take's context, or `null` before the first one.
   *  The pipeline is rate-agnostic, so this is diagnostic, not a setting. */
  sampleRate: number | null;
  /** `track.getSettings()` as snapshotted at acquisition. */
  settings: MediaTrackSettings | null;
}

export function getCaptureInfo(): CaptureInfo {
  return { sampleRate: lastSampleRate, settings: trackSettings };
}

/** Audio ready for `transcribe()`. The same shape a decoded file produces, so
 *  the two input paths converge on one line in `main.ts`. */
export interface CapturedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Stop recording and return everything captured — or `null` if nothing was.
 *
 * Synchronous on purpose: the caller needs the samples in hand to switch to the
 * `analyzing` phase and let the browser paint before the transcription blocks
 * the main thread.
 *
 * ## The `null` case, and why it is not an error
 *
 * Stop is also how a *pending* start is abandoned — tap Record, then tap Stop
 * while the permission prompt is still up. There is no take, but there is still
 * work to do: the teardown below is what invalidates the in-flight start (via
 * the generation counter) so it cannot build a graph nobody is watching.
 *
 * So the teardown always runs and the return value is honest: it used to hand
 * back an empty `Float32Array` at a *guessed* 48 kHz, which the caller then
 * transcribed into a confident "no notes found" — a made-up answer about audio
 * that never existed. `null` says what actually happened.
 *
 * A take that *did* start but captured no blocks at all comes back `null` for
 * the same reason. That is the shape of the WebKit failure this module's header
 * warns about — a graph that is wired up correctly and simply never pulls — and
 * an empty buffer would launder it into "no notes found", plus a 44-byte WAV if
 * the user then tapped Save. There is nothing to analyse and nothing to save,
 * so there is nothing to hand back.
 */
export function stopRecording(): CapturedAudio | null {
  const wasRecording = recording;
  const sampleRate = audioCtx?.sampleRate ?? null;
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
  /*
   * Three separate questions, and they really can disagree — the tempting
   * simplification here reintroduces a bug that was already fixed once.
   *
   * `wasRecording` is false and `sampleRate` is *set* on the Stop-during-the-
   * permission-prompt path: `startRecording` publishes `audioCtx` in its first
   * few lines, before the first `await`, because iOS only unlocks a context
   * created inside the gesture. So by the time Stop is tapped there is a
   * context to read a rate off and no take behind it. Collapsing the two
   * conditions would hand that case back an empty buffer at a real-looking
   * sample rate, which is exactly what the docblock above says must not happen.
   *
   * `total === 0` is the third: a take that ran but was never fed a block.
   */
  if (!wasRecording || sampleRate === null || total === 0) return null;
  return { samples, sampleRate };
}

/** Release what a start opened but will never use, and say why it stopped. */
async function abandon(ctx: AudioContext, opened: MediaStream): Promise<CaptureAborted> {
  for (const track of opened.getTracks()) track.stop();
  return abandonContext(ctx);
}

/** The same, for a start that never got as far as a stream. */
async function abandonContext(ctx: AudioContext): Promise<CaptureAborted> {
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
