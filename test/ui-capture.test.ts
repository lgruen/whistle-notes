import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { midiToHz, midiToName, type Note } from "../src/dsp/index.js";

/**
 * The capture module's *lifecycle*, tested with a fake Web Audio stack.
 *
 * Everything else in this project is tested as arithmetic, because arithmetic
 * is where the interesting bugs usually are. Not here. Every bug this file
 * guards against is a **sequencing** bug — state left over from the previous
 * take, a promise that resolves after the world moved on, a resource acquired
 * on a path that then throws, a cap enforced in a loop that stops running when
 * the tab is hidden. None of them are visible in a screenshot, none of them
 * reproduce reliably by hand, and every one of them was live in the shipped
 * code until it was reproduced exactly like this.
 *
 * No jsdom: the module touches a handful of globals and nothing else, so
 * stubbing those directly is both smaller and more honest about what is being
 * simulated. The fake sample rate is 8 kHz rather than 48 kHz for one reason —
 * a 60 s take then costs ~900 FFTs instead of ~5600, and the arithmetic under
 * test (samples, caps, seconds) is identical either way.
 */

type Listener = () => void;
type Rejecter = (reason: unknown) => void;

const SAMPLE_RATE = 8000;
const CAP_SEC = 60;

/** Every microphone track the fake platform currently considers live. The
 *  whole point of several tests below is that this ends up empty. */
const openTracks = new Set<FakeTrack>();

/** What the fake platform claims it granted. Constraints are requests, not
 *  commands, so a device is free to hand back a track with its voice
 *  processing still on — which is the case worth warning about. */
let grantedSettings: Record<string, boolean> = {
  noiseSuppression: false,
  echoCancellation: false,
  autoGainControl: false,
};

class FakeTrack {
  readyState: "live" | "ended" = "live";
  muted = false;
  private readonly listeners: Listener[] = [];

  stop(): void {
    // `stop()` is the app releasing the microphone; per spec it does *not*
    // fire `ended`, which is reserved for the platform taking it away.
    this.readyState = "ended";
    openTracks.delete(this);
  }

  getSettings(): Record<string, boolean> {
    // A stopped track is not obliged to remember anything, and this one does
    // not: the settings have to be snapshotted while the track is live.
    return this.readyState === "ended" ? {} : { ...grantedSettings };
  }

  addEventListener(_type: string, listener: Listener): void {
    this.listeners.push(listener);
  }

  removeEventListener(): void {}

  /** The platform revoked the microphone: permission withdrawn, device
   *  unplugged, another app took the audio session. */
  endFromPlatform(): void {
    this.readyState = "ended";
    openTracks.delete(this);
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeStream {
  readonly tracks: FakeTrack[] = [new FakeTrack()];

  constructor() {
    openTracks.add(this.tracks[0]);
  }

  getTracks(): FakeTrack[] {
    return this.tracks;
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeNode {
  connect(next: FakeNode): FakeNode {
    return next;
  }
  disconnect(): void {}
}

/** One scheduled envelope point, in the order the synth wrote it. */
interface EnvelopePoint {
  kind: "set" | "ramp" | "cancel";
  value: number;
  time: number;
}

class FakeGain extends FakeNode {
  /** Enough of an `AudioParam` for the synth to schedule an envelope on it —
   *  the capture path only ever reads and writes `value`. The schedule is kept
   *  because the *shape* of a note's envelope is the thing worth asserting. */
  readonly envelope: EnvelopePoint[] = [];
  gain = {
    value: 1,
    setValueAtTime: (value: number, time: number): void => {
      this.envelope.push({ kind: "set", value, time });
    },
    linearRampToValueAtTime: (value: number, time: number): void => {
      this.envelope.push({ kind: "ramp", value, time });
    },
    cancelScheduledValues: (time: number): void => {
      this.envelope.push({ kind: "cancel", value: NaN, time });
    },
  };
}

class FakeOscillator extends FakeNode {
  type = "";
  frequency = { value: 0 };
  detune = { value: 0 };
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  start(when: number): void {
    this.startedAt = when;
  }
  stop(when: number): void {
    this.stoppedAt = when;
  }
}

class FakeBiquadFilter extends FakeNode {
  type = "";
  frequency = { value: 0 };
  Q = { value: 0 };
}

/** Whether a suspended context comes back when `resume()` is called. */
let resumeRestores = true;

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  sampleRate = SAMPLE_RATE;
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = new FakeNode();
  audioWorklet = { addModule: (): Promise<void> => Promise.resolve() };
  private readonly listeners: Listener[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  addEventListener(_type: string, listener: Listener): void {
    this.listeners.push(listener);
  }

  removeEventListener(): void {}

  resume(): Promise<void> {
    if (resumeRestores && this.state === "suspended") this.state = "running";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }

  /** Everything the synth built in this context, in creation order. */
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly filters: FakeBiquadFilter[] = [];

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createMediaStreamSource(): FakeNode {
    return new FakeNode();
  }

  createOscillator(): FakeOscillator {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }

  createBiquadFilter(): FakeBiquadFilter {
    const filter = new FakeBiquadFilter();
    this.filters.push(filter);
    return filter;
  }

  /** The audio session was interrupted — a call, a route change, iOS. */
  suspendFromPlatform(): void {
    this.state = "suspended";
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeWorkletNode extends FakeNode {
  static last: FakeWorkletNode | null = null;
  /** What a browser does when the precached worklet never registered this
   *  processor name — the realistic half-updated-cache failure. */
  static throwOnConstruct = false;

  port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };

  constructor(_ctx: unknown, name: string) {
    super();
    if (FakeWorkletNode.throwOnConstruct) {
      const error = new Error(`Unknown processor "${name}"`);
      error.name = "InvalidStateError";
      throw error;
    }
    FakeWorkletNode.last = this;
  }
}

/** How the next `getUserMedia` behaves: resolve, reject, or leave the
 *  permission prompt up (the interesting one). */
let gumMode: "grant" | "deny" | "hang" = "grant";
const pendingPrompts: { resolve: (stream: FakeStream) => void; reject: Rejecter }[] = [];

function notAllowed(): Error {
  const error = new Error("Permission denied");
  error.name = "NotAllowedError";
  return error;
}

function installGlobals(): void {
  FakeAudioContext.instances = [];
  FakeWorkletNode.last = null;
  FakeWorkletNode.throwOnConstruct = false;
  openTracks.clear();
  pendingPrompts.length = 0;
  gumMode = "grant";
  resumeRestores = true;
  grantedSettings = {
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
  };

  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<FakeStream>((resolve, reject) => {
          if (gumMode === "grant") resolve(new FakeStream());
          else if (gumMode === "deny") reject(notAllowed());
          else pendingPrompts.push({ resolve, reject });
        }),
    },
  });
}

type Capture = typeof import("../src/audio/capture.js");

/** A fresh copy of the module, since all of its state is module-level. */
async function loadCapture(): Promise<Capture> {
  vi.resetModules();
  return import("../src/audio/capture.js");
}

/** Push `seconds` of audio through the worklet port, in 0.5 s blocks — the
 *  real thing delivers small blocks, and block boundaries are where the cap
 *  arithmetic can go wrong. */
function feed(seconds: number): void {
  const port = FakeWorkletNode.last?.port;
  if (!port?.onmessage) throw new Error("no worklet is listening");
  const block = SAMPLE_RATE / 2;
  for (let sent = 0; sent < seconds * SAMPLE_RATE; sent += block) {
    // A graph that has been torn down mid-block delivers nothing further —
    // that is the platform's behaviour, not a convenience for the test.
    if (!port.onmessage) return;
    port.onmessage({ data: new Float32Array(block) });
  }
}

/** Let queued microtasks (and therefore any `.then` chain) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  installGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("starting a take", () => {
  it("clears the previous take before it publishes anything (the 60 s brick)", async () => {
    const capture = await loadCapture();
    const limits: number[] = [];
    let first: Float32Array | null = null;
    // Exactly what main.ts does: the handler finishes the take.
    capture.setCaptureHandlers({
      onLimitReached: () => {
        limits.push(1);
        first = capture.stopRecording()?.samples ?? null;
      },
      onInterrupted: () => {},
    });

    // A take that runs into the cap.
    await capture.startRecording();
    feed(CAP_SEC);
    expect(first).not.toBeNull();
    expect(first!.length).toBe(CAP_SEC * SAMPLE_RATE);

    // Now tap Record again. The animation loop starts as soon as the tap
    // handler returns and reads this *while the permission prompt is still up*.
    gumMode = "hang";
    const second = capture.startRecording();

    // Before the fix these still read 60 s and a full frame buffer, so the very
    // first animation frame stopped the take and handed `transcribe()` a minute
    // of zeroes — for this tap and every tap after it, until a page reload.
    expect(capture.getLiveStatus().elapsedSec).toBe(0);
    expect(capture.getLiveFrames()).toHaveLength(0);
    expect(capture.getLiveStatus().voiced).toBeNull();
    expect(capture.getLiveStatus().frame).toBeNull();

    pendingPrompts[0].resolve(new FakeStream());
    await second;
    feed(1);

    expect(capture.getLiveStatus().elapsedSec).toBeCloseTo(1, 6);
    expect(capture.stopRecording()?.samples.length).toBe(SAMPLE_RATE);
    expect(limits).toHaveLength(1);
  });

  it("releases the microphone when building the graph throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const capture = await loadCapture();
    FakeWorkletNode.throwOnConstruct = true;

    // One attempt per tap of a Record button that is not working. Before the
    // fix each one leaked a live track and an open context, and the phone's
    // recording indicator stayed lit until the tab was closed.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(capture.startRecording()).rejects.toBeInstanceOf(capture.CaptureError);
      expect(openTracks.size).toBe(0);
      expect(FakeAudioContext.instances.filter((ctx) => ctx.state !== "closed")).toHaveLength(0);
      expect(capture.isRecording()).toBe(false);
    }

    // ...and the module is still usable once the cause goes away.
    FakeWorkletNode.throwOnConstruct = false;
    await capture.startRecording();
    expect(capture.isRecording()).toBe(true);
    expect(openTracks.size).toBe(1);
  });

  it("reports a real denial as an error", async () => {
    const capture = await loadCapture();
    gumMode = "deny";
    await expect(capture.startRecording()).rejects.toBeInstanceOf(capture.CaptureError);
    await expect(capture.startRecording()).rejects.toThrow(/Microphone blocked/);
    expect(capture.isRecording()).toBe(false);
    expect(openTracks.size).toBe(0);
  });
});

describe("a start that was overtaken", () => {
  it("cannot tear down the take that replaced it", async () => {
    const capture = await loadCapture();

    // Tap Record: the permission prompt goes up and stays up.
    gumMode = "hang";
    const abandoned = capture.startRecording();
    // Tap Stop while it is still up.
    capture.stopRecording();

    // Tap Record again; this one is granted and starts recording for real.
    gumMode = "grant";
    await capture.startRecording();
    feed(0.5);
    const live = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
    const worklet = FakeWorkletNode.last;
    expect(capture.isRecording()).toBe(true);

    // Only now does the abandoned prompt answer — with a denial.
    pendingPrompts[0].reject(notAllowed());
    await expect(abandoned).rejects.toBeInstanceOf(capture.CaptureAborted);
    await settle();

    // A stale *failure* has to be as quiet as a stale success. Before the fix
    // it ran the global teardown — killing the live session's microphone and
    // context — and then threw a CaptureError, which put "Microphone blocked"
    // on screen over a recording that was working perfectly.
    expect(capture.isRecording()).toBe(true);
    expect(openTracks.size).toBe(1);
    expect(live.state).toBe("running");
    expect(worklet?.port.onmessage).not.toBeNull();

    // And it really is still recording, not merely flagged as such.
    feed(0.5);
    expect(capture.getLiveStatus().elapsedSec).toBeCloseTo(1, 6);
    expect(capture.stopRecording()?.samples.length).toBe(SAMPLE_RATE);
  });

  it("still closes its own context rather than leaking it", async () => {
    const capture = await loadCapture();
    gumMode = "hang";
    const abandoned = capture.startRecording();
    const orphan = FakeAudioContext.instances[0];
    capture.stopRecording();

    pendingPrompts[0].reject(notAllowed());
    await expect(abandoned).rejects.toBeInstanceOf(capture.CaptureAborted);
    expect(orphan.state).toBe("closed");
    expect(openTracks.size).toBe(0);
  });
});

describe("the 60 s cap", () => {
  it("is enforced in the audio callback, not the animation loop", async () => {
    const capture = await loadCapture();
    let limitCalls = 0;
    let captured: Float32Array | null = null;
    capture.setCaptureHandlers({
      onLimitReached: () => {
        limitCalls++;
        captured = capture.stopRecording()?.samples ?? null;
      },
      onInterrupted: () => {},
    });

    // A hidden tab gets no animation frames at all — but it keeps getting
    // audio. There is deliberately no rAF anywhere in this test.
    vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "hidden" });
    await capture.startRecording();

    // Three minutes in one uninterrupted run of audio callbacks.
    feed(3 * CAP_SEC);

    expect(limitCalls).toBe(1);
    expect(captured).not.toBeNull();
    expect(captured!.length).toBe(CAP_SEC * SAMPLE_RATE);

    // Before the fix the extra two minutes kept appending samples, kept running
    // a full FFT per hop on audio nobody would ever hear, and grew the frame
    // buffer without bound.
    const frames = capture.getLiveFrames();
    expect(frames.length).toBeGreaterThan(100);
    expect(frames[frames.length - 1].tSec).toBeLessThanOrEqual(CAP_SEC);
    expect(capture.isRecording()).toBe(false);
    expect(openTracks.size).toBe(0);
  });

  it("closes the take itself when the handler ignores the signal", async () => {
    const capture = await loadCapture();
    let limitCalls = 0;
    // `main.ts` returns early from this handler if the app's phase disagrees
    // with the capture module's. The module cannot assume the handler acts:
    // the signal is one-shot, so a dropped one used to leave the microphone
    // open, the recording indicator lit and `recording` true, with no tap in
    // the UI that reaches a `stopRecording()`.
    capture.setCaptureHandlers({ onLimitReached: () => limitCalls++, onInterrupted: () => {} });

    await capture.startRecording();
    feed(CAP_SEC);
    await settle();

    expect(limitCalls).toBe(1);
    expect(capture.isRecording()).toBe(false);
    expect(openTracks.size).toBe(0);
    expect(FakeAudioContext.instances.filter((ctx) => ctx.state !== "closed")).toHaveLength(0);

    // ...and the module is still usable, which is the part that was missing.
    await capture.startRecording();
    feed(1);
    expect(capture.stopRecording()?.samples.length).toBe(SAMPLE_RATE);
  });

  it("releases the microphone before the handler runs, not after", async () => {
    const capture = await loadCapture();
    let openWhenCalled = -1;
    capture.setCaptureHandlers({
      onLimitReached: () => {
        openWhenCalled = openTracks.size;
      },
      onInterrupted: () => {},
    });

    await capture.startRecording();
    expect(openTracks.size).toBe(1);
    feed(CAP_SEC);

    // The handler decides what to *show*; whether the hardware is freed is not
    // its call. At the cap no further audio is kept anyway, so there is nothing
    // to wait for.
    expect(openWhenCalled).toBe(0);
  });

  it("can stop the take from inside the audio callback", async () => {
    const capture = await loadCapture();
    let captured: Float32Array | null = null;
    capture.setCaptureHandlers({
      // Exactly what main.ts does: the same finish path a tap on Stop takes.
      onLimitReached: () => {
        captured = capture.stopRecording()?.samples ?? null;
      },
      onInterrupted: () => {},
    });

    await capture.startRecording();
    feed(CAP_SEC + 5);

    expect(captured).not.toBeNull();
    expect(captured!.length).toBe(CAP_SEC * SAMPLE_RATE);
    expect(capture.isRecording()).toBe(false);
    expect(openTracks.size).toBe(0);
  });
});

describe("an interrupted audio session", () => {
  it("ends the take when the context stays suspended and the mic is gone", async () => {
    const capture = await loadCapture();
    const interruptions: string[] = [];
    let rescued: Float32Array | null = null;
    capture.setCaptureHandlers({
      onLimitReached: () => {},
      // As in main.ts: an interruption still finishes the take, on whatever was
      // captured before it.
      onInterrupted: (message) => {
        interruptions.push(message);
        rescued = capture.stopRecording()?.samples ?? null;
      },
    });

    await capture.startRecording();
    feed(1);

    // A call comes in: the context is suspended and the microphone is taken.
    resumeRestores = false;
    const track = [...openTracks][0];
    track.readyState = "ended";
    FakeAudioContext.instances[0].suspendFromPlatform();
    await settle();

    // Without this the graph simply stops pulling — no frames, no error, and a
    // UI stuck on "recording" until the user gives up and reloads.
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toMatch(/interrupted/i);
    expect(rescued).not.toBeNull();
    expect(rescued!.length).toBe(SAMPLE_RATE);
  });

  it("says nothing when the context comes back", async () => {
    const capture = await loadCapture();
    const interruptions: string[] = [];
    capture.setCaptureHandlers({
      onLimitReached: () => {},
      onInterrupted: (message) => interruptions.push(message),
    });

    await capture.startRecording();
    feed(1);
    resumeRestores = true;
    FakeAudioContext.instances[0].suspendFromPlatform();
    await settle();

    expect(interruptions).toHaveLength(0);
    expect(capture.isRecording()).toBe(true);
    feed(1);
    expect(capture.getLiveStatus().elapsedSec).toBeCloseTo(2, 6);
  });

  it("ends the take when the microphone itself goes away", async () => {
    const capture = await loadCapture();
    const interruptions: string[] = [];
    capture.setCaptureHandlers({
      onLimitReached: () => {},
      onInterrupted: (message) => interruptions.push(message),
    });

    await capture.startRecording();
    feed(1);
    [...openTracks][0].endFromPlatform();
    await settle();

    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toMatch(/microphone/i);
  });
});

describe("stopping when there is no take", () => {
  it("returns null instead of inventing an empty one", async () => {
    const capture = await loadCapture();

    // Never started at all.
    expect(capture.stopRecording()).toBeNull();

    // Started, but the permission prompt is still up: this is the tap-Record-
    // then-tap-Stop path, and it is the one that used to return a zero-length
    // buffer at a *guessed* 48 kHz. The caller transcribed that into a
    // confident "no notes found" about audio that never existed.
    gumMode = "hang";
    const pending = capture.startRecording();
    expect(capture.stopRecording()).toBeNull();

    pendingPrompts[0].resolve(new FakeStream());
    await expect(pending).rejects.toBeInstanceOf(capture.CaptureAborted);
  });

  it("still releases everything, because Stop is also how a pending start is abandoned", async () => {
    const capture = await loadCapture();
    gumMode = "hang";
    const pending = capture.startRecording();
    const orphan = FakeAudioContext.instances[0];

    expect(capture.stopRecording()).toBeNull();

    // The null return says "no audio"; it must not be read as "nothing to do".
    // This teardown is what invalidates the in-flight start.
    pendingPrompts[0].resolve(new FakeStream());
    await expect(pending).rejects.toBeInstanceOf(capture.CaptureAborted);
    expect(orphan.state).toBe("closed");
    expect(openTracks.size).toBe(0);
    expect(capture.isRecording()).toBe(false);
  });

  it("returns a take exactly once", async () => {
    const capture = await loadCapture();
    await capture.startRecording();
    feed(1);

    expect(capture.stopRecording()?.samples.length).toBe(SAMPLE_RATE);
    // Idempotent by phase in the caller, and now honest here too: a second
    // stop has no take to report.
    expect(capture.stopRecording()).toBeNull();
  });

  it("returns null for a take that started but was never fed a block", async () => {
    const capture = await loadCapture();
    await capture.startRecording();
    // The graph is wired up and simply never pulls — the shape of the WebKit
    // bug this module's header warns about. An empty buffer at a real sample
    // rate would launder that into a confident "no notes found", plus a
    // 44-byte WAV if the user then tapped Save.
    expect(capture.isRecording()).toBe(true);
    expect(capture.stopRecording()).toBeNull();
    expect(openTracks.size).toBe(0);
  });
});

describe("what the device actually granted", () => {
  it("is snapshotted at acquisition, so the warning survives the take", async () => {
    const capture = await loadCapture();
    grantedSettings = {
      noiseSuppression: true,
      echoCancellation: false,
      autoGainControl: true,
    };

    await capture.startRecording();
    feed(0.5);
    expect(capture.stopRecording()?.samples.length).toBe(SAMPLE_RATE / 2);

    // Read *after* the take, which is when everything that wants it runs: the
    // warning line is set from a promise continuation, and the debug panel is
    // only ever open while a result is on screen. Reading the stream at that
    // point finds nothing — teardown dropped it — so the whistle-eating
    // noise suppression went unreported precisely when it mattered.
    expect(capture.processingWarning()).toMatch(/noise suppression \+ auto gain/);
    const info = capture.getCaptureInfo();
    expect(info.sampleRate).toBe(SAMPLE_RATE);
    expect(info.settings?.noiseSuppression).toBe(true);
    expect(info.settings?.echoCancellation).toBe(false);
  });

  it("says nothing when the constraints were honoured", async () => {
    const capture = await loadCapture();
    await capture.startRecording();
    capture.stopRecording();
    expect(capture.processingWarning()).toBeNull();
  });

  it("does not carry a previous take's answer into the next one", async () => {
    const capture = await loadCapture();
    grantedSettings = { noiseSuppression: true, echoCancellation: false, autoGainControl: false };
    await capture.startRecording();
    capture.stopRecording();
    expect(capture.processingWarning()).not.toBeNull();

    // A device can hand out a differently-configured track on every
    // acquisition, so the next take starts with no answer at all rather than
    // the last one's.
    grantedSettings = { noiseSuppression: false, echoCancellation: false, autoGainControl: false };
    gumMode = "hang";
    void capture.startRecording();
    expect(capture.processingWarning()).toBeNull();
    expect(capture.getCaptureInfo().settings).toBeNull();
  });
});

/** The synth, loaded against the same fresh capture module. */
async function loadSynth(): Promise<typeof import("../src/audio/synth.js")> {
  return import("../src/audio/synth.js");
}

function melody(): Note[] {
  return [72, 74, 76].map((midi, i) => ({
    midi,
    noteName: midiToName(midi),
    centsOffset: 0,
    startSec: i * 0.5,
    endSec: i * 0.5 + 0.4,
    durationSec: 0.4,
    pitchHz: midiToHz(midi),
    confidence: 0.9,
    gapBeforeSec: 0,
    flags: {},
  }));
}

describe("recording and playback are mutually exclusive", () => {
  it("refuses to start the synth while the microphone is open", async () => {
    const capture = await loadCapture();
    const synth = await loadSynth();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});

    await capture.startRecording();
    feed(0.5);
    const contextsBefore = FakeAudioContext.instances.length;

    // No echo cancellation (it eats whistles), so a phone playing this into
    // its own open microphone would transcribe itself. The disabled Play
    // button is presentation; this is the rule.
    const started = synth.startPlayback(melody(), 0, { onIndex: () => {}, onEnd: () => {} });

    expect(started).toBe(false);
    expect(synth.isPlaying()).toBe(false);
    // A refusal changes nothing: no context opened, and the take is untouched.
    expect(FakeAudioContext.instances).toHaveLength(contextsBefore);
    expect(capture.isRecording()).toBe(true);
    feed(0.5);
    expect(capture.stopRecording()?.samples.length).toBe(SAMPLE_RATE);
  });

  it("plays once the microphone is closed", async () => {
    const capture = await loadCapture();
    const synth = await loadSynth();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});

    await capture.startRecording();
    feed(0.5);
    capture.stopRecording();

    expect(synth.startPlayback(melody(), 0, { onIndex: () => {}, onEnd: () => {} })).toBe(true);
    expect(synth.isPlaying()).toBe(true);
    synth.stopPlayback();
    expect(synth.isPlaying()).toBe(false);
  });

  it("reports a refusal rather than lying about having started", async () => {
    const capture = await loadCapture();
    const synth = await loadSynth();
    await capture.startRecording();

    // The caller sets `playing: true` off this return value; a silent refusal
    // would leave a Stop button that stops nothing.
    expect(synth.startPlayback([], 0, { onIndex: () => {}, onEnd: () => {} })).toBe(false);
    capture.stopRecording();
    expect(synth.startPlayback([], 0, { onIndex: () => {}, onEnd: () => {} })).toBe(false);
  });
});

/**
 * The graph the voices actually build.
 *
 * The supersaw's spread and its gain are arithmetic, and they are tested as
 * arithmetic in `ui-display.test.ts`. What can only be seen from here is the
 * *wiring*, and it is where the interesting failures would be: seven
 * oscillators per note is seven times as many things to leave running, seven
 * times as many to forget to detune, and one shared filter that a naive
 * implementation would build once per note. The two rules the supersaw could
 * plausibly break — the click-free stop and the highlight following note
 * boundaries rather than release tails — are pinned at the bottom.
 */
describe("the playback voices", () => {
  const NOTE_COUNT = 3;

  /** The synth's rAF loop, driven by hand: nothing calls the real one under
   *  vitest, and the whole question is what the loop decides at a given
   *  reading of the audio clock. */
  let frame: (() => void) | null = null;

  function hookFrames(): void {
    frame = null;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  }

  /** Run one animation frame with the clock `elapsed` seconds past the first
   *  note. `t0` is read back off the graph rather than restated here, so the
   *  test cannot drift away from the synth's lead-in. */
  function frameAt(ctx: FakeAudioContext, elapsed: number): void {
    const t0 = ctx.oscillators[0].startedAt ?? 0;
    ctx.currentTime = t0 + elapsed;
    frame?.();
  }

  async function play(
    voice: "clean" | "supersaw",
    handlers: { onIndex?: (i: number | null) => void; onEnd?: () => void } = {},
  ): Promise<{ synth: Awaited<ReturnType<typeof loadSynth>>; ctx: FakeAudioContext }> {
    await loadCapture();
    const synth = await loadSynth();
    hookFrames();
    const started = synth.startPlayback(
      melody(),
      0,
      { onIndex: handlers.onIndex ?? ((): void => {}), onEnd: handlers.onEnd ?? ((): void => {}) },
      voice,
    );
    expect(started).toBe(true);
    // The most recent context, not the first: a test that plays twice to
    // compare the voices would otherwise be reading the earlier graph.
    return { synth, ctx: FakeAudioContext.instances[FakeAudioContext.instances.length - 1] };
  }

  it("leaves the clean voice one triangle per note, as it always was", async () => {
    const { ctx } = await play("clean");

    expect(ctx.oscillators).toHaveLength(NOTE_COUNT);
    expect(ctx.gains).toHaveLength(NOTE_COUNT);
    // Straight to the destination: the filter exists for the saws' fizz, and a
    // triangle has none to remove.
    expect(ctx.filters).toHaveLength(0);
    for (const osc of ctx.oscillators) {
      expect(osc.type).toBe("triangle");
      expect(osc.detune.value).toBe(0);
    }
    expect(ctx.oscillators.map((osc) => osc.frequency.value)).toEqual(
      [72, 74, 76].map((midi) => midiToHz(midi)),
    );
  });

  it("gives every supersaw note its own detuned stack on one envelope", async () => {
    const { ctx } = await play("supersaw");
    const synth = await loadSynth();
    const spread = synth.supersawDetuneCents();

    expect(ctx.oscillators).toHaveLength(NOTE_COUNT * spread.length);
    // One gain per *note*, not per oscillator: the stack has to open and close
    // in lockstep or Stop turns into a chord.
    expect(ctx.gains).toHaveLength(NOTE_COUNT);

    for (let note = 0; note < NOTE_COUNT; note++) {
      const stack = ctx.oscillators.slice(note * spread.length, (note + 1) * spread.length);
      expect(stack.map((osc) => osc.type)).toEqual(spread.map(() => "sawtooth"));
      expect(stack.map((osc) => osc.detune.value)).toEqual(spread);
      // The detune is the only thing that differs inside a stack; every
      // oscillator is nominally the written pitch.
      for (const osc of stack) expect(osc.frequency.value).toBe(midiToHz(72 + note * 2));
      // ...and they start together, or the attack would smear.
      for (const osc of stack) expect(osc.startedAt).toBe(stack[0].startedAt);
    }
  });

  it("builds one lowpass for the whole playback rather than one per note", async () => {
    const { ctx } = await play("supersaw");
    expect(ctx.filters).toHaveLength(1);
    expect(ctx.filters[0].type).toBe("lowpass");
    expect(ctx.filters[0].frequency.value).toBeGreaterThanOrEqual(4000);
    expect(ctx.filters[0].frequency.value).toBeLessThanOrEqual(6000);
    // Butterworth: a resonant peak near the corner would make one pitch louder
    // than its neighbour, which is exactly the judgment this synth is for.
    expect(ctx.filters[0].Q.value).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("peaks the supersaw envelope well below the clean one, since the saws sum", async () => {
    const clean = await play("clean");
    const cleanPeak = Math.max(...clean.ctx.gains[0].envelope.map((point) => point.value));
    const saw = await play("supersaw");
    const sawPeak = Math.max(...saw.ctx.gains[0].envelope.map((point) => point.value));

    // Seven detuned saws beat rather than reinforce, so their powers add: the
    // per-oscillator amplitude has to come down by √7 (plus a timbre trim) for
    // the two voices to land at the same apparent level.
    expect(sawPeak).toBeLessThan(cleanPeak / 2);
    expect(sawPeak * Math.sqrt(7)).toBeCloseTo(cleanPeak * 0.8, 10);
  });

  it("ends every note's supersaw envelope inside the note it belongs to", async () => {
    const { ctx } = await play("supersaw");
    const t0 = ctx.oscillators[0].startedAt ?? 0;
    // The melody's notes are 0.4 s long at 0.5 s spacing, i.e. comfortably
    // longer than attack+release. So the longer release is taken *out of* the
    // note rather than added to it, and playback timing is identical to the
    // clean voice's — which is what keeps the highlight honest.
    for (let note = 0; note < NOTE_COUNT; note++) {
      const envelope = ctx.gains[note].envelope;
      const last = envelope[envelope.length - 1];
      expect(last.value).toBe(0);
      expect(last.time).toBeCloseTo(t0 + note * 0.5 + 0.4, 10);
    }
  });

  it("ramps every oscillator of every note down on Stop", async () => {
    const { synth, ctx } = await play("supersaw");
    ctx.currentTime = 1;
    synth.stopPlayback();

    for (const gain of ctx.gains) {
      const tail = gain.envelope.slice(-3);
      expect(tail.map((point) => point.kind)).toEqual(["cancel", "set", "ramp"]);
      expect(tail[2].value).toBe(0);
    }
    // Every one of the twenty-one, not just the first of each stack: an
    // oscillator left running past the ramp is the click the ramp exists to
    // prevent, seven times over.
    for (const osc of ctx.oscillators) expect(osc.stoppedAt).toBeCloseTo(1.03, 10);
  });

  it("waits for the supersaw's longer tail before auto-stopping", async () => {
    // The melody sounds for 1.4 s. The clean voice's release is 30 ms and the
    // supersaw's is 150, so 1.45 s is past the end of one and inside the other
    // — closing the context there would cut the decay, which is the very click
    // the stop ramp exists to avoid.
    let cleanEnded = false;
    const clean = await play("clean", { onEnd: () => void (cleanEnded = true) });
    frameAt(clean.ctx, 1.45);
    expect(cleanEnded).toBe(true);

    let sawEnded = false;
    const saw = await play("supersaw", { onEnd: () => void (sawEnded = true) });
    frameAt(saw.ctx, 1.45);
    expect(sawEnded).toBe(false);
    frameAt(saw.ctx, 1.56);
    expect(sawEnded).toBe(true);
  });

  it("highlights on note boundaries for both voices, not on release tails", async () => {
    for (const voice of ["clean", "supersaw"] as const) {
      const seen: (number | null)[] = [];
      const { ctx } = await play(voice, { onIndex: (index) => seen.push(index) });
      // Read at the same four clock positions for both voices; the supersaw's
      // longer decay must not shift a single one of them.
      for (const elapsed of [0.05, 0.45, 0.55, 1.05]) frameAt(ctx, elapsed);
      expect(seen).toEqual([0, 1, 2]);
    }
  });
});
