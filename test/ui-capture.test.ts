import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    return { noiseSuppression: false, echoCancellation: false, autoGainControl: false };
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

class FakeGain extends FakeNode {
  gain = { value: 1 };
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

  createGain(): FakeGain {
    return new FakeGain();
  }

  createMediaStreamSource(): FakeNode {
    return new FakeNode();
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
    capture.setCaptureHandlers({ onLimitReached: () => limits.push(1), onInterrupted: () => {} });

    // A take that runs into the cap.
    await capture.startRecording();
    feed(CAP_SEC);
    expect(capture.getLiveStatus().elapsedSec).toBe(CAP_SEC);
    expect(capture.stopRecording().samples.length).toBe(CAP_SEC * SAMPLE_RATE);

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
    expect(capture.stopRecording().samples.length).toBe(SAMPLE_RATE);
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
    expect(capture.stopRecording().samples.length).toBe(SAMPLE_RATE);
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
    capture.setCaptureHandlers({ onLimitReached: () => limitCalls++, onInterrupted: () => {} });

    // A hidden tab gets no animation frames at all — but it keeps getting
    // audio. There is deliberately no rAF anywhere in this test.
    vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "hidden" });
    await capture.startRecording();

    feed(CAP_SEC);
    const framesAtCap = capture.getLiveFrames().length;
    expect(framesAtCap).toBeGreaterThan(100);
    expect(limitCalls).toBe(1);

    // Two more minutes arrive. Before the fix this kept appending samples,
    // kept running a full FFT per hop on audio nobody would ever hear, and
    // grew the frame buffer without bound.
    feed(2 * CAP_SEC);
    expect(capture.getLiveFrames()).toHaveLength(framesAtCap);
    expect(capture.getLiveStatus().elapsedSec).toBe(CAP_SEC);
    expect(limitCalls).toBe(1);

    expect(capture.stopRecording().samples.length).toBe(CAP_SEC * SAMPLE_RATE);
  });

  it("can stop the take from inside the audio callback", async () => {
    const capture = await loadCapture();
    let captured: Float32Array | null = null;
    capture.setCaptureHandlers({
      // Exactly what main.ts does: the same finish path a tap on Stop takes.
      onLimitReached: () => {
        captured = capture.stopRecording().samples;
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
    capture.setCaptureHandlers({
      onLimitReached: () => {},
      onInterrupted: (message) => interruptions.push(message),
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
    expect(capture.stopRecording().samples.length).toBe(SAMPLE_RATE);
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
