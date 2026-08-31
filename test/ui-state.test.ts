import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { midiToHz, midiToName, type Note } from "../src/dsp/index.js";

/**
 * The store's two decisions.
 *
 * Everything else in `state.ts` is a spread and a `Set` of listeners, but two
 * things in there are judgment calls about the *user*: which octave to show a
 * result in, and whether the app is allowed to make that choice. Both are
 * invisible until they are wrong, and one of them was — a restored preference
 * was overwritten by the auto-suggestion on the first result of every session,
 * which made the persistence a no-op that still looked like a feature.
 */

function note(midi: number, startSec: number, durationSec: number): Note {
  return {
    midi,
    noteName: midiToName(midi),
    centsOffset: 0,
    startSec,
    endSec: startSec + durationSec,
    durationSec,
    pitchHz: midiToHz(midi),
    confidence: 0.9,
    gapBeforeSec: 0,
    flags: {},
  };
}

/** Whistling lives up here, which is why the auto-suggestion exists at all. */
const WHISTLED = [note(96, 0, 0.3), note(98, 0.4, 0.3), note(100, 0.8, 0.3)];

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

type Store = typeof import("../src/ui/state.js");

async function loadStore(stored?: Record<string, string>): Promise<Store> {
  vi.resetModules();
  vi.stubGlobal("localStorage", fakeStorage(stored));
  return import("../src/ui/state.js");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the octave default", () => {
  it("is chosen for a user who has never expressed a preference", async () => {
    const store = await loadStore();
    expect(store.getState().transpose).toBe(0);
    store.applyResult(WHISTLED, []);
    // Whistled notes are two octaves above where a beginner can read them.
    expect(store.getState().transpose).toBe(-2);
  });

  it("respects a preference restored from a previous session", async () => {
    const store = await loadStore({ "whistle-notes:transpose": "0" });
    expect(store.getState().transpose).toBe(0);
    store.applyResult(WHISTLED, []);
    // The auto-suggestion would say -2 here. It does not get a vote: the user
    // already answered this question, last time.
    expect(store.getState().transpose).toBe(0);
  });

  it("remembers an explicit choice for the rest of the session", async () => {
    const store = await loadStore();
    store.setTranspose(-1);
    store.applyResult(WHISTLED, []);
    expect(store.getState().transpose).toBe(-1);
  });

  it("ignores a stored value that is not one of the offered shifts", async () => {
    const store = await loadStore({ "whistle-notes:transpose": "-7" });
    expect(store.getState().transpose).toBe(0);
    store.applyResult(WHISTLED, []);
    expect(store.getState().transpose).toBe(-2);
  });

  it("survives a localStorage that throws, as private modes do", async () => {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const store: Store = await import("../src/ui/state.js");
    expect(store.getState().transpose).toBe(0);
    // No preference could be read, so the app is free to choose.
    store.applyResult(WHISTLED, []);
    expect(store.getState().transpose).toBe(-2);
    expect(() => store.setTranspose(-1)).not.toThrow();
  });
});

describe("the take's tuning offset", () => {
  it("reaches the state, so the result view can mention it", async () => {
    const store = await loadStore();
    expect(store.getState().tuningOffsetCents).toBe(0);
    store.applyResult(WHISTLED, [], 38);
    expect(store.getState().tuningOffsetCents).toBe(38);
    // ...and does not linger into the next take.
    store.applyResult(WHISTLED, []);
    expect(store.getState().tuningOffsetCents).toBe(0);
  });
});
