import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignAttempt } from "../src/practice/align.js";
import {
  formatTargetDuration,
  makeTarget,
  newTargetId,
  parseTarget,
  targetDurationSec,
  targetSummary,
  type PracticeTarget,
} from "../src/practice/target.js";

/**
 * The target library, and everything that can go wrong between it and
 * `localStorage`.
 *
 * No jsdom: the store touches exactly one global, so stubbing that directly is
 * smaller and more honest about what is being simulated than pulling in a DOM —
 * the same call the transcribe store's tests make.
 *
 * The failures worth catching here are the quiet ones. A storage that throws on
 * read (every private browsing mode does) must land on an empty library rather
 * than on a mode that cannot be opened. A storage that is full must say so out
 * loud and leave the previous document intact, because the alternative — a
 * half-written library — loses recordings nobody can make again. And a document
 * written by a future version of this app must be left alone rather than
 * half-read and written back over.
 */

const KEY = "whistle-notes:practice:v1";
const STATS_KEY = "whistle-notes:practice-stats:v1";

interface FakeStorage extends Storage {
  /** Reject every write from here on, the way a full quota does. */
  jam(): void;
  /** What is actually stored, bypassing any jam. */
  peek(key: string): string | null;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map(Object.entries(initial));
  let jammed = false;
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => {
      if (jammed) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    jam: () => {
      jammed = true;
    },
    peek: (key: string) => map.get(key) ?? null,
  };
}

type Store = typeof import("../src/practice/store.js");

let storage: FakeStorage;

async function loadStore(initial: Record<string, string> = {}): Promise<Store> {
  vi.resetModules();
  storage = fakeStorage(initial);
  vi.stubGlobal("localStorage", storage);
  return import("../src/practice/store.js");
}

function target(name: string, midis: readonly number[], createdAt: number): PracticeTarget {
  return { ...makeTarget(name, "recorded", midis.map((midi) => ({ midi, durationSec: 0.4 })), createdAt) };
}

/** A library document as the store writes one. */
function libraryDoc(targets: PracticeTarget[], range: unknown = null): string {
  return JSON.stringify({ version: 1, targets, range });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the target model", () => {
  it("summarises a target by its shape, never by its notes", () => {
    // Ear-first, as a property of the data the library row is built from: a row
    // that spelled out "C6 E6 G6" would turn choosing a melody into reading it.
    const summary = targetSummary(target("Tron", [84, 88, 91], 1));
    expect(summary.name).toBe("Tron");
    expect(summary.noteCount).toBe(3);
    expect(summary.detail).toBe("3 notes · 1.2 s · Recorded");
    for (const name of ["C6", "E6", "G6", "84", "88", "91"]) {
      expect(summary.detail).not.toContain(name);
    }
  });

  it("counts one note as a note", () => {
    expect(targetSummary(target("One", [84], 1)).detail).toMatch(/^1 note ·/);
  });

  it("measures length as the notes' own durations", () => {
    expect(targetDurationSec({ notes: [{ midi: 84, durSec: 0.5 }, { midi: 86, durSec: 1 }] }))
      .toBeCloseTo(1.5, 9);
    expect(formatTargetDuration(4.25)).toBe("4.3 s");
    expect(formatTargetDuration(0)).toBe("0.0 s");
    expect(formatTargetDuration(-1)).toBe("0.0 s");
    // Phrases are seconds; a target long enough to need a clock reads as one.
    expect(formatTargetDuration(75)).toBe("1:15");
  });

  it("gives every target a distinct id", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTargetId()));
    expect(ids.size).toBe(200);
  });

  it("rounds pitches on the way in, because a target is not a transcription", () => {
    const made = makeTarget("t", "recorded", [{ midi: 84.4, durationSec: 0.3 }], 5);
    expect(made.notes).toEqual([{ midi: 84, durSec: 0.3 }]);
    expect(made.createdAt).toBe(5);
  });

  describe("reading one back out of storage", () => {
    const good = target("Tron", [84, 88], 7);

    it("round-trips a target it wrote", () => {
      expect(parseTarget(JSON.parse(JSON.stringify(good)))).toEqual(good);
    });

    it("refuses anything it cannot use", () => {
      for (const bad of [
        null,
        undefined,
        7,
        "target",
        [],
        {},
        { ...good, id: 1 },
        { ...good, id: "" },
        { ...good, name: null },
        { ...good, source: "hummed" },
        { ...good, notes: "many" },
        { ...good, notes: [] },
        { ...good, notes: [{ durSec: 1 }] },
        { ...good, notes: [{ midi: "84", durSec: 1 }] },
        { ...good, notes: [{ midi: Number.NaN, durSec: 1 }] },
      ]) {
        expect(parseTarget(bad), JSON.stringify(bad) ?? "undefined").toBeNull();
      }
    });

    it("repairs what it can rather than throwing the target away", () => {
      // A missing duration costs a rhythm tie-break; a missing target costs a
      // recording. The two are not close.
      const patched = parseTarget({ ...good, createdAt: "soon", notes: [{ midi: 84 }] });
      expect(patched?.notes).toEqual([{ midi: 84, durSec: 0 }]);
      expect(patched?.createdAt).toBe(0);
    });
  });
});

describe("the library", () => {
  it("starts empty, and says so without a stored document", async () => {
    const store = await loadStore();
    expect(store.getPracticeState().targets).toEqual([]);
    expect(store.getPracticeState().range).toBeNull();
    expect(store.getPracticeState().screen).toBe("library");
    expect(store.getPracticeState().storageError).toBeNull();
  });

  it("keeps the newest target first and persists the lot", async () => {
    const store = await loadStore();
    store.addTarget(target("older", [84], 100));
    store.addTarget(target("newer", [86], 200));
    expect(store.getPracticeState().targets.map((t) => t.name)).toEqual(["newer", "older"]);

    const reloaded = await loadStore({ [KEY]: storage.peek(KEY) ?? "" });
    expect(reloaded.getPracticeState().targets.map((t) => t.name)).toEqual(["newer", "older"]);
  });

  it("selects a target it has, and ignores one it does not", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);

    store.selectTarget("nope");
    expect(store.getPracticeState().screen).toBe("library");

    store.selectTarget(saved.id);
    expect(store.getPracticeState().screen).toBe("target");
    expect(store.selectedTarget()?.name).toBe("Tron");

    store.showLibrary();
    expect(store.getPracticeState().selectedId).toBeNull();
    expect(store.selectedTarget()).toBeNull();
  });

  it("cannot leave a detail screen pointing at a target that was deleted", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.selectTarget(saved.id);
    store.removeTarget(saved.id);
    expect(store.getPracticeState().screen).toBe("library");
    expect(store.getPracticeState().selectedId).toBeNull();
    expect(store.getPracticeState().targets).toEqual([]);
    expect(storage.peek(KEY)).toContain('"targets":[]');
  });

  it("forgets a deleted target's history but not what it taught the whistler", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86, 88], 1);
    store.addTarget(saved);
    store.recordPracticeAttempt(
      saved.id,
      saved.notes,
      alignAttempt(
        saved.notes.map((note) => ({ midi: note.midi, centsOffset: -45, durationSec: 0.4 })),
        saved.notes,
      ),
      9,
    );
    expect(store.getPracticeState().stats.targets.has(saved.id)).toBe(true);

    store.removeTarget(saved.id);
    expect(store.getPracticeState().stats.targets.has(saved.id)).toBe(false);
    // The rising whole-tone step is about the person, and survives.
    expect(store.getPracticeState().stats.intervals.get(2)?.absCentsEwma).toBeCloseTo(45, 6);
  });

  it("persists an attempt so a history outlives the session", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.recordPracticeAttempt(
      saved.id,
      saved.notes,
      alignAttempt(
        saved.notes.map((note) => ({ midi: note.midi, centsOffset: 0, durationSec: 0.4 })),
        saved.notes,
      ),
      9,
    );

    const reloaded = await loadStore({
      [KEY]: storage.peek(KEY) ?? "",
      [STATS_KEY]: storage.peek(STATS_KEY) ?? "",
    });
    expect(reloaded.getPracticeState().stats.targets.get(saved.id)?.attempts).toBe(1);
    expect(reloaded.getPracticeState().stats.intervals.get(2)?.clean).toBe(1);
  });
});

describe("the range check", () => {
  it("is not a range until both ends are in", async () => {
    const store = await loadStore();
    store.showRangeCheck();
    expect(store.captureRangeEnd("low", 84)).toBe(false);
    expect(store.getPracticeState().range).toBeNull();
    expect(store.getPracticeState().rangeDraft).toEqual({ low: 84, high: null });
    // ...and the button that started the take is no longer running.
    expect(store.getPracticeState().rangeStep).toBeNull();

    expect(store.captureRangeEnd("high", 96)).toBe(true);
    expect(store.getPracticeState().range).toEqual({ lowMidi: 84, highMidi: 96 });
  });

  it("sorts the ends when the takes come out backwards", async () => {
    const store = await loadStore();
    store.captureRangeEnd("low", 96);
    store.captureRangeEnd("high", 84);
    expect(store.getPracticeState().range).toEqual({ lowMidi: 84, highMidi: 96 });
  });

  it("lets one end be re-measured without asking for the other again", async () => {
    const store = await loadStore();
    store.captureRangeEnd("low", 84);
    store.captureRangeEnd("high", 96);

    store.showLibrary();
    store.showRangeCheck();
    // Seeded from the stored range, so a single take finishes the job.
    expect(store.getPracticeState().rangeDraft).toEqual({ low: 84, high: 96 });
    expect(store.captureRangeEnd("high", 99)).toBe(true);
    expect(store.getPracticeState().range).toEqual({ lowMidi: 84, highMidi: 99 });
  });

  it("survives a reload, which is the entire point of measuring it", async () => {
    const store = await loadStore();
    store.captureRangeEnd("low", 84);
    store.captureRangeEnd("high", 96);
    const reloaded = await loadStore({ [KEY]: storage.peek(KEY) ?? "" });
    expect(reloaded.getPracticeState().range).toEqual({ lowMidi: 84, highMidi: 96 });
    expect(reloaded.getPracticeState().rangeDraft).toEqual({ low: 84, high: 96 });
  });

  it("can be thrown away", async () => {
    const store = await loadStore();
    store.captureRangeEnd("low", 84);
    store.captureRangeEnd("high", 96);
    store.setRange(null);
    expect(store.getPracticeState().range).toBeNull();
    expect(store.getPracticeState().rangeDraft).toEqual({ low: null, high: null });
  });
});

describe("storage that will not cooperate", () => {
  it("opens on an empty library when reading throws, as private modes do", async () => {
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const store: Store = await import("../src/practice/store.js");
    expect(store.getPracticeState().targets).toEqual([]);
    expect(store.getPracticeState().stats.intervals.size).toBe(0);
    // ...and the mode still works, it just does not remember.
    expect(() => store.addTarget(target("t", [84], 1))).not.toThrow();
    expect(store.getPracticeState().targets).toHaveLength(1);
    expect(store.getPracticeState().storageError).not.toBeNull();
  });

  it("says so when a write is refused, and keeps what was already stored", async () => {
    const store = await loadStore();
    const first = target("kept", [84], 100);
    store.addTarget(first);
    const before = storage.peek(KEY);

    storage.jam();
    store.addTarget(target("lost", [86], 200));

    // The session is still correct and still usable...
    expect(store.getPracticeState().targets.map((t) => t.name)).toEqual(["lost", "kept"]);
    // ...it just is not going to survive, and the user is told before they
    // find out the hard way.
    expect(store.getPracticeState().storageError).toBe(store.STORAGE_ERROR_MESSAGE);
    // One `setItem` of one complete document is atomic, so a refusal cannot
    // leave a half-eaten library behind.
    expect(storage.peek(KEY)).toBe(before);
    expect(parseTarget(JSON.parse(storage.peek(KEY) ?? "{}").targets[0])?.name).toBe("kept");

    store.clearStorageError();
    expect(store.getPracticeState().storageError).toBeNull();
  });

  it("ignores a document written by a version it does not understand", async () => {
    const doc = JSON.parse(libraryDoc([target("t", [84], 1)])) as Record<string, unknown>;
    const store = await loadStore({ [KEY]: JSON.stringify({ ...doc, version: 2 }) });
    expect(store.getPracticeState().targets).toEqual([]);
  });

  it("never lets one bad row cost the whole library", async () => {
    const good = target("good", [84], 200);
    const store = await loadStore({
      [KEY]: JSON.stringify({
        version: 1,
        targets: [{ id: "x", name: "broken" }, good, null],
        range: { lowMidi: 84, highMidi: 96 },
      }),
    });
    expect(store.getPracticeState().targets.map((t) => t.name)).toEqual(["good"]);
    expect(store.getPracticeState().range).toEqual({ lowMidi: 84, highMidi: 96 });
  });

  it("shrugs off anything else a storage slot can hold", async () => {
    for (const junk of [
      "",
      "not json",
      "null",
      "[]",
      '{"version":1}',
      '{"version":1,"targets":"lots","range":"wide"}',
      '{"version":1,"targets":[],"range":{"lowMidi":96,"highMidi":84}}',
    ]) {
      const store = await loadStore({ [KEY]: junk, [STATS_KEY]: junk });
      expect(store.getPracticeState().targets, junk).toEqual([]);
      expect(store.getPracticeState().range, junk).toBeNull();
      expect(store.getPracticeState().stats.intervals.size, junk).toBe(0);
    }
  });
});

/**
 * The same argument `test/architecture.test.ts` makes for `src/dsp`, scoped to
 * the part of `src/practice` that has to stay portable.
 *
 * `align.ts`, `stats.ts`, `range.ts` and `target.ts` are the diagnosis engine
 * and its data model, and every one of them will be wanted somewhere a DOM is
 * not: a Node harness that replays saved attempts, a fuzz that runs ten
 * thousand of them, a test that does not want to stub a global to ask what an
 * interval is. Exactly one module in the feature touches storage, and keeping
 * it that way is what makes the rest of it testable as arithmetic.
 */
describe("the practice island", () => {
  const BROWSER_ONLY = [
    "window",
    "document",
    "navigator",
    "localStorage",
    "sessionStorage",
    "AudioContext",
    "requestAnimationFrame",
    "fetch",
  ];

  /** Comments have to come out, exactly as in `test/architecture.test.ts`:
   *  this file's own prose explains *why* `localStorage` lives in one module,
   *  and a check that could not survive being described would be unusable. */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const read = async (name: string): Promise<string> => {
    const { readFileSync } = await import("node:fs");
    return code(readFileSync(new URL(`../src/practice/${name}.ts`, import.meta.url), "utf8"));
  };

  it("keeps the engine free of anything a browser has to provide", async () => {
    for (const name of ["align", "stats", "range", "target"]) {
      const source = await read(name);
      for (const token of BROWSER_ONLY) {
        expect(source, `${name}.ts uses ${token}`).not.toMatch(new RegExp(`\\b${token}\\b`));
      }
      // ...and nothing from the browser-only halves of the app, either.
      expect(source, `${name}.ts imports outside src/practice`).not.toMatch(
        /from "\.\.\/(ui|audio)\//,
      );
    }
  });

  it("keeps storage in exactly one module, which is the one being tested here", async () => {
    // Also the positive control: if the comment stripper or the token regex
    // ever stopped matching real code, the check above would pass vacuously
    // and this would be the assertion that noticed.
    expect(await read("store")).toMatch(/\blocalStorage\b/);
    expect(BROWSER_ONLY).toContain("localStorage");
    expect(code("// localStorage is mentioned here")).not.toMatch(/\blocalStorage\b/);
  });
});

describe("listeners", () => {
  it("hear every change and can stop listening", async () => {
    const store = await loadStore();
    const seen: number[] = [];
    const stop = store.subscribePractice((state) => seen.push(state.targets.length));
    store.addTarget(target("a", [84], 1));
    store.addTarget(target("b", [86], 2));
    stop();
    store.addTarget(target("c", [88], 3));
    expect(seen).toEqual([1, 2]);
  });
});
