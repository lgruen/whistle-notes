import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignAttempt, type TargetNote } from "../src/practice/align.js";
import {
  DEFAULT_DRILL_RANGE,
  ECHO_MIN_NOTES,
  makeRng,
} from "../src/practice/drill.js";
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

/** The directed steps of a phrase, for counting what a drill taught. */
function steps(phrase: readonly TargetNote[]): number[] {
  return phrase.slice(1).map((note, i) => note.midi - phrase[i].midi);
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

/**
 * The recall exercise's state machine — and the one line in it that everything
 * downstream depends on: the melody is moved into the whistler's register
 * *once*, and that transposed melody is what gets played, scored and counted.
 */
describe("the recall exercise", () => {
  /** A whistler who lives an octave above the middle of a keyboard. */
  const RANGE = { lowMidi: 79, highMidi: 96 };

  /** An attempt at `notes`, sung `cents` off and `shift` semitones away. */
  function attemptAt(
    notes: readonly { midi: number }[],
    shift = 0,
    cents = 0,
  ): ReturnType<typeof alignAttempt> {
    return alignAttempt(
      notes.map((note) => ({ midi: note.midi + shift, centsOffset: cents, durationSec: 0.4 })),
      notes.map((note) => ({ midi: note.midi, durSec: 0.4 })),
    );
  }

  it("moves the melody into the whistler's register, once, when the screen opens", async () => {
    const store = await loadStore();
    const saved = target("Tron", [60, 62, 64], 1);
    store.addTarget(saved);
    store.setRange(RANGE);
    store.beginRecall(saved.id);

    const recall = store.getPracticeState().recall!;
    expect(store.getPracticeState().screen).toBe("recall");
    expect(recall.notes.map((note) => note.midi)).toEqual([84, 86, 88]);
    expect(recall.listens).toBe(0);
    expect(recall.attempt).toBeNull();

    // ...and a range measured again mid-session does not change what the user
    // already heard.
    store.setRange({ lowMidi: 60, highMidi: 72 });
    expect(store.getPracticeState().recall!.notes.map((note) => note.midi)).toEqual([84, 86, 88]);
  });

  it("counts listens without a limit", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.beginRecall(saved.id);
    for (let i = 0; i < 5; i++) store.countRecallListen();
    expect(store.getPracticeState().recall!.listens).toBe(5);
  });

  it("does not open on a melody that is not there", async () => {
    const store = await loadStore();
    store.beginRecall("nonexistent");
    expect(store.getPracticeState().recall).toBeNull();
    expect(store.getPracticeState().screen).toBe("library");
  });

  it("records nothing when the attempt produced nothing", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.beginRecall(saved.id);
    store.beginRecallTake();
    expect(store.getPracticeState().recall!.recording).toBe(true);

    store.endRecallTake("Nothing tonal in that one.");
    expect(store.getPracticeState().recall!.recording).toBe(false);
    expect(store.getPracticeState().recall!.attempt).toBeNull();
    // The whole point: a take the app could not hear is not evidence about the
    // whistler, and a phantom failure in the heatmap is worse than no data.
    expect(store.getPracticeState().stats.targets.size).toBe(0);
    expect(store.getPracticeState().message).toBe("Nothing tonal in that one.");
  });

  it("scores, remembers and shows an attempt in one breath", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86, 88], 1);
    store.addTarget(saved);
    store.beginRecall(saved.id);
    store.beginRecallTake();

    const alignment = attemptAt(saved.notes, 0, -45);
    const seen: (number | null)[] = [];
    store.subscribePractice((state) => {
      // Every listener must see the two in agreement: a heatmap that has heard
      // about an attempt the overlay has not is a disagreement the user can see.
      seen.push(state.recall?.attempt ? (state.stats.targets.get(saved.id)?.attempts ?? 0) : null);
    });
    store.finishRecallAttempt({ notes: [], trail: [], alignment }, 9);

    expect(seen).toEqual([1]);
    const state = store.getPracticeState();
    expect(state.recall!.recording).toBe(false);
    expect(state.recall!.attempt!.alignment).toBe(alignment);
    expect(state.stats.targets.get(saved.id)!.history[0].verdicts).toEqual([
      "off",
      "off",
      "off",
    ]);
  });

  /**
   * The interval statistics are the thing T4's drills will read, and this is
   * the property that makes them worth reading: they are keyed by the *step*
   * in the melody, so the same tune practised in any register teaches the same
   * buckets. Here the target is written around middle C, played an octave and
   * a half higher because that is where this whistler lives, and echoed a 5th
   * above that — and the rising whole tone is still a rising whole tone.
   */
  it("feeds the interval statistics from the melody as it was played", async () => {
    const store = await loadStore();
    const saved = target("Tron", [60, 62, 64], 1);
    store.addTarget(saved);
    store.setRange(RANGE);
    store.beginRecall(saved.id);

    const played = store.getPracticeState().recall!.notes;
    expect(played.map((note) => note.midi)).toEqual([84, 86, 88]);
    const alignment = attemptAt(played, 7, -45);
    expect(alignment.transposition).toBe(-7);
    store.finishRecallAttempt({ notes: [], trail: [], alignment }, 9);

    const stats = store.getPracticeState().stats;
    // Two rising whole tones, both sung 45 cents flat — and keyed on +2
    // whatever octave and whatever register they were sung in.
    expect([...stats.intervals.keys()]).toEqual([2]);
    expect(stats.intervals.get(2)!.observations).toBe(2);
    expect(stats.intervals.get(2)!.absCentsEwma).toBeCloseTo(45, 6);
    expect(stats.intervals.get(2)!.wrongRateEwma).toBe(0);

    // And it survives the session, which is what makes it a history.
    const reloaded = await loadStore({
      [KEY]: storage.peek(KEY) ?? "",
      [STATS_KEY]: storage.peek(STATS_KEY) ?? "",
    });
    expect(reloaded.getPracticeState().stats.intervals.get(2)!.observations).toBe(2);
  });

  it("goes back for another go without forgetting the sitting", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.beginRecall(saved.id);
    store.countRecallListen();
    store.finishRecallAttempt({ notes: [], trail: [], alignment: attemptAt(saved.notes) }, 9);

    store.retryRecall();
    const recall = store.getPracticeState().recall!;
    expect(recall.attempt).toBeNull();
    // The listen count is about this sitting, not about this attempt.
    expect(recall.listens).toBe(1);
    // The attempt that was already made stays in the history.
    expect(store.getPracticeState().stats.targets.get(saved.id)!.attempts).toBe(1);
  });

  it("ends the exercise on the melody it was about", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.beginRecall(saved.id);
    store.closeRecall();
    expect(store.getPracticeState().screen).toBe("target");
    expect(store.getPracticeState().selectedId).toBe(saved.id);
    expect(store.getPracticeState().recall).toBeNull();
  });

  it("cannot be left running on a melody that has been deleted", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.beginRecall(saved.id);
    store.removeTarget(saved.id);
    expect(store.getPracticeState().recall).toBeNull();
    expect(store.getPracticeState().screen).toBe("library");
  });

  it("says so when an attempt cannot be saved, and keeps showing it", async () => {
    const store = await loadStore();
    const saved = target("Tron", [84, 86], 1);
    store.addTarget(saved);
    store.beginRecall(saved.id);
    storage.jam();

    const alignment = attemptAt(saved.notes);
    store.finishRecallAttempt({ notes: [], trail: [], alignment }, 9);
    // The result is on screen and correct; only its persistence failed, and the
    // user hears about that rather than losing the screen.
    expect(store.getPracticeState().recall!.attempt!.alignment).toBe(alignment);
    expect(store.getPracticeState().storageError).toBe(store.STORAGE_ERROR_MESSAGE);
  });
});

/**
 * The two drills and the warm-up, where the store has to hold three things
 * together that a screen can show disagreeing: the prompt that was played, the
 * thing it will be scored against, and the statistics it feeds.
 */
describe("the echo drills", () => {
  const RANGE = { lowMidi: 79, highMidi: 91 };

  /** An echo of `phrase`, sung `shift` semitones away and `cents` off. */
  function echoOf(
    phrase: readonly { midi: number }[],
    shift = 0,
    cents = 0,
  ): { notes: never[]; trail: never[]; alignment: ReturnType<typeof alignAttempt> } {
    return {
      notes: [],
      trail: [],
      alignment: alignAttempt(
        phrase.map((note) => ({ midi: note.midi + shift, centsOffset: cents, durationSec: 0.5 })),
        phrase.map((note) => ({ midi: note.midi, durSec: 0.5 })),
      ),
    };
  }

  it("opens the hold drill on a note inside the measured register", async () => {
    const store = await loadStore();
    store.setRange(RANGE);
    store.beginHold(makeRng(3));
    const hold = store.getPracticeState().hold!;
    expect(store.getPracticeState().screen).toBe("hold");
    expect(hold.referenceMidi).toBeGreaterThan(RANGE.lowMidi);
    expect(hold.referenceMidi).toBeLessThan(RANGE.highMidi);
    expect(hold.score).toBeNull();
    expect(hold.plays).toBe(0);
  });

  it("opens it on a guessed register when nothing has been measured", async () => {
    const store = await loadStore();
    store.beginHold(makeRng(3));
    const midi = store.getPracticeState().hold!.referenceMidi;
    expect(midi).toBeGreaterThanOrEqual(DEFAULT_DRILL_RANGE.lowMidi);
    expect(midi).toBeLessThanOrEqual(DEFAULT_DRILL_RANGE.highMidi);
  });

  it("remembers a scored hold as two running numbers, and writes them down", async () => {
    const store = await loadStore();
    store.beginHold(makeRng(3));
    store.beginHoldTake();
    store.finishHold({ medianCents: 24, wobbleCents: 11, steadySec: 2, frames: 150 }, 7);

    const state = store.getPracticeState();
    expect(state.hold!.recording).toBe(false);
    expect(state.hold!.score!.medianCents).toBe(24);
    expect(state.stats.holds).toEqual({
      count: 1,
      offsetEwma: 24,
      wobbleEwma: 11,
      updatedAt: 7,
    });
    expect(state.storageError).toBeNull();
    expect(JSON.parse(storage.peek(STATS_KEY)!).holds.count).toBe(1);
  });

  it("keeps the note for another go, and changes it for a new one", async () => {
    const store = await loadStore();
    store.beginHold(makeRng(3));
    const first = store.getPracticeState().hold!.referenceMidi;
    store.finishHold({ medianCents: 0, wobbleCents: 5, steadySec: 2, frames: 150 }, 1);

    store.retryHold();
    expect(store.getPracticeState().hold!.referenceMidi).toBe(first);
    // The score goes: it was about the take before, not about this one.
    expect(store.getPracticeState().hold!.score).toBeNull();

    store.nextHold(makeRng(3));
    expect(store.getPracticeState().hold!.referenceMidi).not.toBe(first);
  });

  it("opens the phrase drill at the shortest phrase", async () => {
    const store = await loadStore();
    store.setRange(RANGE);
    store.beginEcho(makeRng(11));
    const echo = store.getPracticeState().echo!;
    expect(store.getPracticeState().screen).toBe("echo");
    expect(echo.phrase).toHaveLength(ECHO_MIN_NOTES);
    expect(echo.length).toBe(ECHO_MIN_NOTES);
    for (const note of echo.phrase) {
      expect(note.midi).toBeGreaterThanOrEqual(RANGE.lowMidi);
      expect(note.midi).toBeLessThanOrEqual(RANGE.highMidi);
    }
  });

  it("folds an echo into the interval ledger and nothing else", async () => {
    const store = await loadStore();
    store.beginEcho(makeRng(11));
    const echo = store.getPracticeState().echo!;
    store.beginEchoTake();
    store.finishEchoAttempt(echoOf(echo.phrase));

    const state = store.getPracticeState();
    expect(state.echo!.attempt).not.toBeNull();
    // Two steps in a three-note phrase, both now in the shared ledger.
    expect(state.stats.intervals.size).toBe(new Set(steps(echo.phrase)).size);
    // ...and no per-slot history: a generated phrase has no identity to keep
    // one against.
    expect(state.stats.targets.size).toBe(0);
    expect(JSON.parse(storage.peek(STATS_KEY)!).targets).toEqual({});
  });

  it("moves the ramp up on a clean echo and back down on a miss", async () => {
    const store = await loadStore();
    store.beginEcho(makeRng(11));
    store.finishEchoAttempt(echoOf(store.getPracticeState().echo!.phrase));
    expect(store.getPracticeState().echo!.length).toBe(ECHO_MIN_NOTES + 1);
    expect(store.getPracticeState().echo!.ramp).toMatch(/one more/i);

    // A new phrase at the ramped length, then an echo with a wrong note in it.
    store.nextEcho(makeRng(12));
    const phrase = store.getPracticeState().echo!.phrase;
    expect(phrase).toHaveLength(ECHO_MIN_NOTES + 1);
    store.finishEchoAttempt({
      notes: [],
      trail: [],
      alignment: alignAttempt(
        phrase.map((note, i) => ({
          midi: note.midi + (i === 1 ? 2 : 0),
          centsOffset: 0,
          durationSec: 0.5,
        })),
        phrase.map((note) => ({ midi: note.midi, durSec: 0.5 })),
      ),
    });
    expect(store.getPracticeState().echo!.length).toBe(ECHO_MIN_NOTES);
  });

  it("forgives the register, exactly as the recall exercise does", async () => {
    const store = await loadStore();
    store.beginEcho(makeRng(11));
    const phrase = store.getPracticeState().echo!.phrase;
    // Echoed a 5th up: the shape is right, so the ramp moves.
    store.finishEchoAttempt(echoOf(phrase, 7));
    expect(store.getPracticeState().echo!.length).toBe(ECHO_MIN_NOTES + 1);
  });

  it("keeps the phrase for another go, and drops it for a new one", async () => {
    const store = await loadStore();
    store.beginEcho(makeRng(11));
    const phrase = store.getPracticeState().echo!.phrase;
    store.finishEchoAttempt(echoOf(phrase));

    store.retryEcho();
    expect(store.getPracticeState().echo!.phrase).toBe(phrase);
    expect(store.getPracticeState().echo!.attempt).toBeNull();
    expect(store.getPracticeState().echo!.listens).toBe(0);

    store.nextEcho(makeRng(99));
    expect(store.getPracticeState().echo!.phrase).not.toBe(phrase);
  });

  it("leaves both drills behind when the library comes back", async () => {
    const store = await loadStore();
    store.beginHold(makeRng(1));
    store.closeDrill();
    expect(store.getPracticeState().hold).toBeNull();
    expect(store.getPracticeState().screen).toBe("library");

    store.beginEcho(makeRng(1));
    store.closeDrill();
    expect(store.getPracticeState().echo).toBeNull();
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
    // `midi` and `bundled` joined the island in T2 and belong on it for the
    // same reason: the parser has to be testable against bytes built in a test
    // file rather than against a `.mid` a browser handed it, and a data file of
    // melodies has no business knowing what a DOM is. `recall` joined in T3,
    // and it is the sharpest case of all: it lays a melody out for a synth it
    // may not import and lays a diff out on a canvas it may not touch, and both
    // of those are arithmetic that a test can check exactly.
    // `drill` joined in T4, and it is the one that had to be argued for: it
    // chooses random notes, and the obvious way to do that is `Math.random` —
    // which would be untestable. So randomness is injected, and the impure
    // default lives in `store.ts` where the rest of the platform does.
    for (const name of [
      "align",
      "stats",
      "range",
      "target",
      "midi",
      "bundled",
      "recall",
      "drill",
    ]) {
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
