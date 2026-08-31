import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note, PitchFrame } from "../src/dsp/index.js";

/**
 * `src/main.ts`, driven through its own wiring.
 *
 * Every other test in this project takes a pure function and checks its
 * arithmetic. That is where the bugs usually are — except in this file, which
 * has almost no arithmetic in it and is nothing but *routing*: one microphone,
 * one phase machine, one transcription path, and seven different things the
 * result might be for. Nothing here is visible in a screenshot and none of it
 * is reachable from a unit test of any module, because the bug is never inside
 * a module. It is in which module gets called.
 *
 * Three shapes of failure, all of them live in the shipped code before this
 * file existed:
 *
 * 1. **A stale intent.** The take's purpose was read off a module variable two
 *    frames after it was set, so the first imported file after any practice
 *    take was routed by that take: it overwrote the measured range, or wrote a
 *    practice-history row about a melody nobody whistled, or vanished into a
 *    screen that was not showing.
 * 2. **A second take over a running one.** There is one microphone, so starting
 *    another does not start another — it re-points the new intent onto the
 *    audio already being captured. The library and the detail screen left every
 *    way in enabled while an exercise opened from them was recording.
 * 3. **A result that arrives after the world moved.** The MIDI read is
 *    asynchronous and what it produces navigates, so a file read while the user
 *    walks away used to drag them back to a screen about it.
 *
 * ## How it is driven
 *
 * The real `main.ts` is imported, so the wiring under test is the wiring that
 * ships. What is faked is everything underneath it: the DOM it looks up by id,
 * the two modules that own hardware (`audio/capture`, `audio/synth`), the file
 * decoder, and `transcribe` itself — mocked so a take can produce exactly the
 * notes a case needs, in a test that runs in milliseconds. Everything in
 * between — the intent routing, the store calls, the phase gates, the view's
 * disabled rules — is real.
 */

/* ── The fake DOM ─────────────────────────────────────────────────────── */

type Listener = (event: unknown) => void;

/**
 * One element, with the handful of properties the views actually touch.
 *
 * Deliberately not jsdom: this project's tests run in a plain node environment
 * and stub what they need, which keeps what is being simulated visible. The
 * views set text, `hidden`, `disabled`, `dataset` and `innerHTML`, and read
 * back `dataset` and attributes; nothing here needs layout, and `getContext`
 * returning `null` is what makes every canvas painter bail out at its first
 * line rather than needing a fake 2D context.
 */
class FakeElement {
  hidden = false;
  disabled = false;
  className = "";
  textContent = "";
  innerHTML = "";
  value = "";
  files: unknown[] | null = null;
  clientWidth = 0;
  clientHeight = 0;
  readonly dataset: Record<string, string> = {};
  readonly style = {
    properties: new Map<string, string>(),
    setProperty(name: string, value: string): void {
      this.properties.set(name, value);
    },
    removeProperty(name: string): void {
      this.properties.delete(name);
    },
    getPropertyValue(name: string): string {
      return this.properties.get(name) ?? "";
    },
  };
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  /** The views build a couple of spans of their own; `ownerDocument` is how
   *  they reach a factory without importing one. */
  get ownerDocument(): { createElement: (tag: string) => FakeElement } {
    return { createElement: (tag: string): FakeElement => new FakeElement(tag) };
  }
  readonly children: FakeElement[] = [];
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  append(...kids: FakeElement[]): void {
    this.children.push(...kids);
  }
  replaceChildren(...kids: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  remove(): void {}
  readonly classList = {
    add: (): void => undefined,
    remove: (): void => undefined,
    toggle: (): void => undefined,
    contains: (): boolean => false,
  };

  constructor(readonly id: string) {}

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(): void {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  closest(): FakeElement | null {
    return null;
  }
  getContext(): null {
    return null;
  }

  /** Dispatch, with an optional event object for the delegated handlers. */
  fire(type: string, event: unknown = { target: this }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** A tap. Refused when the element is disabled, exactly as a browser refuses
   *  it — which is the whole point of half the assertions below. */
  click(): void {
    if (this.disabled) return;
    this.fire("click");
  }
}

const elements = new Map<string, FakeElement>();

function el(id: string): FakeElement {
  const found = elements.get(id) ?? new FakeElement(id);
  elements.set(id, found);
  return found;
}

/** A click on a delegated list, as if it landed on the row carrying `attr`. */
function clickRow(list: FakeElement, attr: string, value: string): void {
  const row = new FakeElement("row");
  row.setAttribute(attr, value);
  list.fire("click", { target: { closest: (selector: string): FakeElement | null =>
    selector === `[${attr}]` ? row : null } });
}

/* ── The fake platform ────────────────────────────────────────────────── */

/** Animation frames, run one generation at a time: the loops re-register
 *  themselves, so draining until empty would never return. */
let frames: (() => void)[] = [];

async function flush(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    const due = frames;
    frames = [];
    for (const frame of due) frame();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const storage = new Map<string, string>();

function installGlobals(): void {
  elements.clear();
  frames = [];
  storage.clear();
  vi.stubGlobal("document", {
    getElementById: (id: string): FakeElement => el(id),
    body: { dataset: {} as Record<string, string> },
    addEventListener: (): void => undefined,
    visibilityState: "visible",
  });
  vi.stubGlobal("window", {
    addEventListener: (): void => undefined,
    devicePixelRatio: 1,
    location: { reload: (): void => undefined },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void): number => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (): void => undefined);
  vi.stubGlobal("localStorage", {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
  });
}

/* ── The mocked modules ───────────────────────────────────────────────── */

vi.mock("virtual:pwa-register", () => ({
  registerSW: () => () => Promise.resolve(),
}));

/** What the microphone is pretending to do. */
const mic = {
  recording: false,
  /** Set to a `CaptureError` message to make the next start fail. */
  failWith: null as string | null,
  /** Set to `false` to make a take come back with no audio at all. */
  audio: true as boolean,
  handlers: null as { onLimitReached(): void; onInterrupted(message: string): void } | null,
};

vi.mock("../src/audio/capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/audio/capture.js")>();
  return {
    ...actual,
    isRecording: (): boolean => mic.recording,
    startRecording: (): Promise<void> => {
      if (mic.recording) {
        return Promise.reject(new actual.CaptureError("A take is already running."));
      }
      if (mic.failWith !== null) return Promise.reject(new actual.CaptureError(mic.failWith));
      mic.recording = true;
      return Promise.resolve();
    },
    stopRecording: (): { samples: Float32Array; sampleRate: number } | null => {
      mic.recording = false;
      return mic.audio ? { samples: new Float32Array(8000), sampleRate: 8000 } : null;
    },
    getLiveFrames: (): PitchFrame[] => [],
    getLiveStatus: () => ({ elapsedSec: 0, level: 0, voiced: null, frame: null }),
    processingWarning: (): string | null => null,
    setCaptureHandlers: (handlers: typeof mic.handlers): void => {
      mic.handlers = handlers;
    },
  };
});

vi.mock("../src/audio/synth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/audio/synth.js")>();
  return {
    ...actual,
    isPlaying: (): boolean => false,
    // Started, and over by the next microtask. A prompt that never ends would
    // leave `playing` true forever, and every screen in practice mode disables
    // its microphone button while the speaker is busy — which is the rule, and
    // would make every take below impossible to start.
    startPlayback: (_notes: unknown, _transpose: unknown, handlers: { onEnd?: () => void }) => {
      queueMicrotask(() => handlers?.onEnd?.());
      return true;
    },
    startPlaybackOverMicrophone: (_notes: unknown, handlers: { onEnd?: () => void }) => {
      queueMicrotask(() => handlers?.onEnd?.());
      return true;
    },
    stopPlayback: (): void => undefined,
  };
});

/** What `transcribe` will say about the next take. */
let heard: { notes: Note[]; tuningOffsetCents: number } = { notes: [], tuningOffsetCents: 0 };

vi.mock("../src/dsp/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dsp/index.js")>();
  return {
    ...actual,
    transcribe: () => ({
      notes: heard.notes,
      frames: [] as PitchFrame[],
      sampleRate: 8000,
      tuningOffsetCents: heard.tuningOffsetCents,
    }),
  };
});

/** What `decodeAudioFile` will hand back for an imported file. */
vi.mock("../src/audio/decode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/audio/decode.js")>();
  return {
    ...actual,
    decodeAudioFile: () =>
      Promise.resolve({
        samples: new Float32Array(8000),
        sampleRate: 8000,
        truncated: false,
        sourceDurationSec: 1,
      }),
  };
});

/* ── Building takes ───────────────────────────────────────────────────── */

/** Notes as the segmenter would report them, laid end to end. */
function notes(midis: readonly number[], durationSec = 0.5): Note[] {
  let cursor = 0;
  return midis.map((midi) => {
    const note: Note = {
      midi,
      noteName: "",
      centsOffset: 0,
      startSec: cursor,
      endSec: cursor + durationSec,
      durationSec,
      pitchHz: 440,
      confidence: 1,
      gapBeforeSec: 0,
      flags: {},
    };
    cursor += durationSec + 0.1;
    return note;
  });
}

async function loadApp() {
  vi.resetModules();
  mic.recording = false;
  mic.failWith = null;
  mic.audio = true;
  mic.handlers = null;
  heard = { notes: [], tuningOffsetCents: 0 };
  await import("../src/main.js");
  const store = await import("../src/practice/store.js");
  const state = await import("../src/ui/state.js");
  await flush();
  return { store, state };
}

/**
 * Run one whole take: tap the button that starts it, tap it again to stop, and
 * let the analysis land. Every practice take in the app is exactly this shape,
 * which is the point — one path, and an intent that says where the notes go.
 */
async function take(button: FakeElement, produced: Note[]): Promise<void> {
  heard = { notes: produced, tuningOffsetCents: 0 };
  button.click();
  await flush();
  expect(button.dataset.running, `${button.id} should be running`).toBe("true");
  button.click();
  await flush();
}

beforeEach(installGlobals);
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── The intents ──────────────────────────────────────────────────────── */

describe("where a take's notes end up", () => {
  it("routes a range check to the range, and nothing else", async () => {
    const { store, state } = await loadApp();
    el("practice-range-open").click();
    await flush();

    await take(el("practice-range-low"), notes([84]));
    expect(store.getPracticeState().rangeDraft.low).toBe(84);
    await take(el("practice-range-high"), notes([96]));

    const practice = store.getPracticeState();
    expect(practice.range).toEqual({ lowMidi: 84, highMidi: 96 });
    // A range take is still a take, so the transcriber's own screen is left
    // clean rather than holding a one-note "transcription" of it.
    expect(state.getState().phase).toBe("idle");
    expect(state.getState().notes).toEqual([]);
  });

  it("routes a recorded target to a draft, capped at what anyone can practise", async () => {
    const { store } = await loadApp();
    await take(el("practice-add-record"), notes([84, 86, 88]));
    expect(store.getPracticeState().screen).toBe("draft");
    expect(store.getPracticeState().draft?.notes).toHaveLength(3);
    expect(store.getPracticeState().draft?.note).toBe("");
  });

  it("cuts a recorded target that is longer than anyone can practise", async () => {
    // The ceiling an import has had since T2, which a take had not: a minute of
    // whistling is an ordinary way to arrive at three hundred notes nobody can
    // trim and the aligner sweeps twenty-nine times per attempt.
    const { store } = await loadApp();
    await take(
      el("practice-add-record"),
      notes(Array.from({ length: 80 }, (_, i) => 84 + (i % 5))),
    );
    const draft = store.getPracticeState().draft;
    expect(draft?.notes).toHaveLength(64);
    expect(draft?.note).toMatch(/first 64 notes/);
  });

  it("routes a recall attempt to the exercise, the history and the ledger", async () => {
    const { store } = await loadApp();
    clickRow(el("practice-starters"), "data-bundled", "mary");
    await flush();
    const target = store.getPracticeState().targets[0];
    clickRow(el("practice-targets"), "data-target", target.id);
    await flush();
    el("practice-target-practice").click();
    await flush();

    const played = store.getPracticeState().recall!.notes;
    await take(el("practice-recall-whistle"), notes(played.map((note) => note.midi)));

    const practice = store.getPracticeState();
    expect(practice.recall?.attempt).not.toBeNull();
    expect(practice.stats.targets.get(target.id)?.attempts).toBe(1);
    expect(practice.stats.intervals.size).toBeGreaterThan(0);
  });

  it("routes a hold to the drill's score and nowhere near a target", async () => {
    const { store } = await loadApp();
    el("practice-drill-hold").click();
    await flush();
    el("practice-hold-play").click();
    await flush();

    // No frames, so there is nothing steady to score — which is itself the
    // hold arm running rather than some other one, and it says so on the
    // drill's own screen.
    await take(el("practice-hold-whistle"), notes([84]));
    const practice = store.getPracticeState();
    expect(practice.screen).toBe("hold");
    expect(practice.hold?.recording).toBe(false);
    expect(practice.message).toMatch(/nothing steady/i);
    expect(practice.targets).toEqual([]);
  });

  it("routes an echo to the drill's ledger and to no target's history", async () => {
    const { store } = await loadApp();
    el("practice-drill-echo").click();
    await flush();
    const phrase = store.getPracticeState().echo!.phrase;
    await take(el("practice-echo-whistle"), notes(phrase.map((note) => note.midi)));

    const practice = store.getPracticeState();
    expect(practice.echo?.attempt).not.toBeNull();
    expect(practice.stats.intervals.size).toBeGreaterThan(0);
    // A generated phrase has no identity to accumulate a slot history against.
    expect(practice.stats.targets.size).toBe(0);
  });

  it("drops a warm-up's audio instead of analysing it", async () => {
    const { store, state } = await loadApp();
    clickRow(el("practice-starters"), "data-bundled", "twinkle");
    await flush();
    clickRow(el("practice-targets"), "data-target", store.getPracticeState().targets[0].id);
    await flush();
    el("practice-target-follow").click();
    await flush();

    heard = { notes: notes([84, 86]), tuningOffsetCents: 0 };
    el("practice-follow-start").click();
    await flush();
    expect(store.getPracticeState().follow?.running).toBe(true);

    el("practice-follow-start").click();
    await flush();
    // Nothing scored, nothing stored, and back to idle without passing through
    // `analyzing` — the samples never reach the transcriber.
    expect(state.getState().phase).toBe("idle");
    expect(store.getPracticeState().stats.intervals.size).toBe(0);
    expect(store.getPracticeState().follow?.running).toBe(false);
  });
});

/* ── The stale intent ─────────────────────────────────────────────────── */

describe("an imported file", () => {
  it("is transcribed, whatever the last take through the microphone was for", async () => {
    const { store, state } = await loadApp();
    // A range take first, so the module's idea of "what is this for" is set to
    // something that is emphatically not a transcription.
    el("practice-range-open").click();
    await flush();
    await take(el("practice-range-low"), notes([84]));
    expect(store.getPracticeState().rangeDraft.low).toBe(84);

    const before = JSON.stringify(store.getPracticeState().rangeDraft);
    heard = { notes: notes([60, 62, 64]), tuningOffsetCents: 0 };
    const input = el("import-input");
    input.files = [{ name: "take.wav", size: 1000 }];
    input.fire("change");
    await flush();

    // The transcriber has it...
    expect(state.getState().phase).toBe("result");
    expect(state.getState().notes.map((note) => note.midi)).toEqual([60, 62, 64]);
    // ...and practice mode has not heard about it. This is the whole finding:
    // the file used to be routed by the *previous* take's intent, which meant
    // the measured range quietly became whatever was in the file.
    expect(JSON.stringify(store.getPracticeState().rangeDraft)).toBe(before);
    expect(store.getPracticeState().range).toBeNull();
  });

  it("does not write practice history after a scored attempt", async () => {
    const { store, state } = await loadApp();
    clickRow(el("practice-starters"), "data-bundled", "mary");
    await flush();
    const target = store.getPracticeState().targets[0];
    clickRow(el("practice-targets"), "data-target", target.id);
    await flush();
    el("practice-target-practice").click();
    await flush();
    const played = store.getPracticeState().recall!.notes;
    await take(el("practice-recall-whistle"), notes(played.map((note) => note.midi)));
    const attempts = store.getPracticeState().stats.targets.get(target.id)!.attempts;

    heard = { notes: notes([60, 62]), tuningOffsetCents: 0 };
    const input = el("import-input");
    input.files = [{ name: "take.wav", size: 1000 }];
    input.fire("change");
    await flush();

    expect(state.getState().phase).toBe("result");
    expect(store.getPracticeState().stats.targets.get(target.id)!.attempts).toBe(attempts);
  });
});

/* ── One way out of a running take ────────────────────────────────────── */

describe("while a take is running", () => {
  /** Start a hold take from the library and leave it running. */
  async function running() {
    const app = await loadApp();
    el("practice-drill-hold").click();
    await flush();
    el("practice-hold-play").click();
    await flush();
    el("practice-hold-whistle").click();
    await flush();
    expect(app.state.getState().phase).toBe("recording");
    // Back to the library, which the drill screen's own Back is not allowed to
    // do mid-take — so this is the app being put in the state a *second*
    // screen would find it in.
    return app;
  }

  it("shuts every way off the library", async () => {
    const { store } = await running();
    store.showLibrary();
    await flush();

    for (const id of [
      "practice-range-open",
      "practice-drill-hold",
      "practice-drill-echo",
      "practice-add-record",
    ]) {
      expect(el(id).disabled, id).toBe(true);
    }
    // The file inputs are shut too: a melody arriving mid-take would land on a
    // draft screen the running microphone is about to replace.
    expect(el("practice-add-midi-input").disabled).toBe(true);
    expect(el("import-input").disabled).toBe(true);

    // ...and the delegated lists refuse a tap even though their rows are
    // written from a string and cannot be relied on to carry `disabled`.
    clickRow(el("practice-starters"), "data-bundled", "mary");
    clickRow(el("practice-targets"), "data-target", "anything");
    await flush();
    expect(store.getPracticeState().targets).toEqual([]);
    expect(store.getPracticeState().screen).toBe("library");
  });

  it("shuts every way off a target's detail screen", async () => {
    const { store } = await loadApp();
    clickRow(el("practice-starters"), "data-bundled", "mary");
    await flush();
    clickRow(el("practice-targets"), "data-target", store.getPracticeState().targets[0].id);
    await flush();
    expect(store.getPracticeState().screen).toBe("target");

    el("practice-drill-hold").click();
    await flush();
    el("practice-hold-play").click();
    await flush();
    el("practice-hold-whistle").click();
    await flush();
    store.selectTarget(store.getPracticeState().targets[0].id);
    await flush();

    for (const id of [
      "practice-target-practice",
      "practice-target-follow",
      "practice-back",
      "practice-delete",
    ]) {
      expect(el(id).disabled, id).toBe(true);
    }
  });

  it("refuses a second take rather than re-pointing the first", async () => {
    const { store, state } = await running();
    // The take now running is the hold drill's. Reach past the disabled button
    // and ask for a target take anyway, the way a stale render or a second
    // window would: the audio in flight must not be re-labelled, and the
    // screen that did not get a take must not think it did.
    const before = state.getState().phase;

    el("practice-add-record").disabled = false;
    el("practice-add-record").click();
    await flush();

    expect(state.getState().phase).toBe(before);
    expect(store.getPracticeState().recordingTarget).toBe(false);
    // The hold is still the take that is running, and still the one with a Stop.
    expect(store.getPracticeState().hold?.recording).toBe(true);
    expect(el("practice-hold-whistle").dataset.running).toBe("true");
  });

  it("still lets the take that is running be stopped", async () => {
    const { store, state } = await running();
    heard = { notes: notes([84]), tuningOffsetCents: 0 };
    el("practice-hold-whistle").click();
    await flush();
    expect(state.getState().phase).toBe("idle");
    expect(store.getPracticeState().hold?.recording).toBe(false);
  });
});

/* ── The asynchronous MIDI read ───────────────────────────────────────── */

describe("a MIDI file read", () => {
  /** A `File` whose bytes arrive only when the test says so. */
  function pendingFile(bytes: Uint8Array) {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      file: {
        name: "tune.mid",
        size: bytes.length,
        arrayBuffer: () => gate.then(() => bytes.buffer),
      },
      release,
    };
  }

  /** The smallest real MIDI file: one note, built byte by byte. */
  function oneNote(): Uint8Array {
    const be16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
    const be32 = (n: number): number[] => [
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ];
    const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
    const chunk = (id: string, body: number[]): number[] => [
      ...ascii(id),
      ...be32(body.length),
      ...body,
    ];
    const events = [0, 0x90, 60, 64, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0];
    return new Uint8Array([
      ...chunk("MThd", [...be16(0), ...be16(1), ...be16(480)]),
      ...chunk("MTrk", events),
    ]);
  }

  it("opens a draft when the user is still where they left off", async () => {
    const { store } = await loadApp();
    const { file, release } = pendingFile(oneNote());
    const input = el("practice-add-midi-input");
    input.files = [file];
    input.fire("change");
    await flush();
    // Shut while it reads: a second file would queue a second screen behind
    // the first.
    expect(input.disabled).toBe(true);

    release();
    await flush();
    expect(store.getPracticeState().screen).toBe("draft");
    expect(store.getPracticeState().draft?.notes).toHaveLength(1);
    expect(el("practice-add-midi-input").disabled).toBe(false);
  });

  it("drops a melody that arrives after the screen has moved on", async () => {
    const { store } = await loadApp();
    const { file, release } = pendingFile(oneNote());
    const input = el("practice-add-midi-input");
    input.files = [file];
    input.fire("change");
    await flush();

    // The user walks off to the hold drill while the file is being read. The
    // read is the only thing in the app that can move the screen without a
    // tap, and dragging somebody out of a drill they just opened — or, worse,
    // clearing `recordingTarget` out from under a take — is not a thing it may
    // do.
    el("practice-drill-hold").click();
    await flush();
    store.setPracticeMessage("Hear it, then hold it back.");
    release();
    await flush();

    expect(store.getPracticeState().screen).toBe("hold");
    expect(store.getPracticeState().draft).toBeNull();
    expect(store.getPracticeState().midi).toBeNull();
    // ...and it does not clear the line the screen it landed on is showing
    // either. A read nobody is waiting for has nothing to say.
    expect(store.getPracticeState().message).toBe("Hear it, then hold it back.");
  });

  it("drops a melody that arrives while a take is running", async () => {
    const { store, state } = await loadApp();
    const { file, release } = pendingFile(oneNote());
    const input = el("practice-add-midi-input");
    input.files = [file];
    input.fire("change");
    await flush();

    el("practice-add-record").disabled = false;
    el("practice-add-record").click();
    await flush();
    expect(state.getState().phase).toBe("recording");

    release();
    await flush();
    // The draft screen would have replaced the screen holding the only Stop.
    expect(store.getPracticeState().screen).toBe("library");
    expect(store.getPracticeState().recordingTarget).toBe(true);
    expect(el("practice-add-record").dataset.running).toBe("true");
  });

  it("says what went wrong with a file it cannot read", async () => {
    const { store } = await loadApp();
    const { file, release } = pendingFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const input = el("practice-add-midi-input");
    input.files = [file];
    input.fire("change");
    release();
    await flush();
    expect(store.getPracticeState().screen).toBe("library");
    expect(store.getPracticeState().message).toMatch(/MIDI/i);
    expect(el("practice-add-midi-input").disabled).toBe(false);
  });
});
