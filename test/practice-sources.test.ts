import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MELODIES, bundledMelody } from "../src/practice/bundled.js";
import {
  canShiftDraft,
  cleanTargetName,
  defaultTargetName,
  draftNoteCount,
  draftNotes,
  draftTarget,
  makeDraft,
  resetDraftTrim,
  shiftDraft,
  targetFromNotes,
  trimDraft,
  type TargetDraft,
} from "../src/practice/target.js";

/**
 * The three ways a melody becomes a target, and the one screen they share.
 *
 * A draft is where every source ends up before it is saved, so this is where
 * the decisions that cannot be automated get pinned: what a trim does, what a
 * move does, and — most importantly — what neither of them may ever do, which
 * is leave the user with nothing or with something they cannot undo.
 *
 * The store half runs against a stubbed `localStorage`, exactly as
 * `practice-store.test.ts` does and for the same reason: the feature touches
 * one global, and stubbing it beats pulling in a DOM.
 */

const NOTES = [
  { midi: 72, durSec: 0.2 },
  { midi: 74, durSec: 0.4 },
  { midi: 76, durSec: 0.4 },
  { midi: 74, durSec: 0.4 },
  { midi: 72, durSec: 0.6 },
];

const draft = (): TargetDraft => makeDraft("recorded", "Take", NOTES);

describe("a draft", () => {
  it("starts as everything that was heard", () => {
    const d = draft();
    expect(draftNoteCount(d)).toBe(5);
    expect(draftNotes(d)).toEqual(NOTES);
    expect(d.octaveShift).toBe(0);
  });

  it("rounds the pitches it was given", () => {
    // The transcriber reports integers, but nothing in the type says so, and a
    // fractional MIDI number would round differently every time it was drawn.
    const d = makeDraft("recorded", "Take", [{ midi: 71.6, durSec: 0.3 }]);
    expect(d.notes[0].midi).toBe(72);
  });

  it("drops one note at a time, from either end", () => {
    let d = trimDraft(draft(), "start");
    d = trimDraft(d, "end");
    expect(draftNotes(d).map((note) => note.midi)).toEqual([74, 76, 74]);
    expect(draftNoteCount(d)).toBe(3);
  });

  it("never trims away the last note", () => {
    // A target with no notes is not a melody: it would sit in the library as a
    // row that can never be played or scored, and `parseTarget` would refuse to
    // read it back.
    let d = draft();
    for (let i = 0; i < 20; i++) d = trimDraft(d, "start");
    for (let i = 0; i < 20; i++) d = trimDraft(d, "end");
    expect(draftNoteCount(d)).toBe(1);
    expect(draftNotes(d)).toHaveLength(1);
  });

  it("keeps the trimmed notes, so trimming can be undone", () => {
    // The whole reason a draft holds a kept *range* rather than a shortened
    // array: an over-trimmed take is a recording nobody can make again.
    let d = draft();
    d = trimDraft(trimDraft(d, "start"), "end");
    expect(d.notes).toHaveLength(5);
    expect(draftNotes(resetDraftTrim(d))).toEqual(NOTES);
  });

  it("moves the whole melody by whole octaves", () => {
    const d = shiftDraft(draft(), -1);
    expect(draftNotes(d).map((note) => note.midi)).toEqual([60, 62, 64, 62, 60]);
    // Lengths are untouched: moving a melody is not editing it.
    expect(draftNotes(d).map((note) => note.durSec)).toEqual(NOTES.map((note) => note.durSec));
  });

  it("stops at the end of the octaves it allows", () => {
    let d = draft();
    for (let i = 0; i < 10; i++) d = shiftDraft(d, 1);
    expect(d.octaveShift).toBe(3);
    expect(canShiftDraft(d, 1)).toBe(false);
    expect(canShiftDraft(d, -1)).toBe(true);
    // ...and the melody is still five notes, three octaves up.
    expect(draftNotes(d).map((note) => note.midi)).toEqual([108, 110, 112, 110, 108]);
  });

  it("trims and moves independently", () => {
    const d = shiftDraft(trimDraft(draft(), "start"), 1);
    expect(draftNotes(d).map((note) => note.midi)).toEqual([86, 88, 86, 84]);
  });
});

describe("naming a target", () => {
  it("falls back rather than saving something with no name", () => {
    // A name is the *only* thing the library shows about a target — spelling
    // out its notes is what the ear-first rule forbids — so a blank one is a
    // row nobody can choose.
    expect(cleanTargetName("   ", "Fallback")).toBe("Fallback");
    expect(cleanTargetName("", "Fallback")).toBe("Fallback");
    expect(cleanTargetName("  Tron  ", "Fallback")).toBe("Tron");
    expect(cleanTargetName("two   spaces\nand a line", "x")).toBe("two spaces and a line");
  });

  it("bounds a pasted name", () => {
    expect(cleanTargetName("x".repeat(500), "y")).toHaveLength(60);
  });

  it("names a take after when it was made, the same way everywhere", () => {
    // Hand-formatted rather than `toLocaleString`: the same take must be named
    // the same thing in a test, in Node and on a phone whose locale is anyone's
    // guess.
    const at = new Date(2026, 7, 31, 22, 5).getTime();
    expect(defaultTargetName(at)).toBe("Recorded 31 Aug, 22:05");
  });

  it("saves what the draft was edited into", () => {
    const d = shiftDraft(trimDraft(draft(), "start"), -1);
    const target = draftTarget({ ...d, name: "  My tune " }, "fallback", 42);
    expect(target.name).toBe("My tune");
    expect(target.source).toBe("recorded");
    expect(target.createdAt).toBe(42);
    expect(target.notes.map((note) => note.midi)).toEqual([62, 64, 62, 60]);
  });
});

describe("the built-in melodies", () => {
  it("are all there, and all distinct", () => {
    expect(BUNDLED_MELODIES.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(BUNDLED_MELODIES.map((melody) => melody.id));
    expect(ids.size).toBe(BUNDLED_MELODIES.length);
    for (const melody of BUNDLED_MELODIES) {
      expect(bundledMelody(melody.id)).toBe(melody);
    }
    expect(bundledMelody("nope")).toBeNull();
  });

  it("are melodies a person could actually whistle", () => {
    for (const melody of BUNDLED_MELODIES) {
      expect(melody.notes.length, melody.name).toBeGreaterThanOrEqual(6);
      // Short enough to hold in your head, which is the whole exercise.
      expect(melody.notes.length, melody.name).toBeLessThanOrEqual(32);
      for (const note of melody.notes) {
        expect(Number.isInteger(note.midi), melody.name).toBe(true);
        // Written around middle C, in the octave a piano part lives in;
        // `range.ts` is what moves them to the whistler.
        expect(note.midi, melody.name).toBeGreaterThanOrEqual(48);
        expect(note.midi, melody.name).toBeLessThanOrEqual(84);
        expect(note.durSec, melody.name).toBeGreaterThan(0.1);
        expect(note.durSec, melody.name).toBeLessThan(3);
      }
      // Nothing that is really one note repeated: a target has to have a shape
      // for an attempt to be wrong about.
      expect(new Set(melody.notes.map((note) => note.midi)).size, melody.name).toBeGreaterThan(2);
    }
  });

  it("become targets without being reshaped on the way", () => {
    const melody = BUNDLED_MELODIES[0];
    const target = targetFromNotes(melody.name, "bundled", melody.notes, 7);
    expect(target.source).toBe("bundled");
    expect(target.notes).toEqual(melody.notes);
    expect(target.createdAt).toBe(7);
  });
});

/* ── The store's half ─────────────────────────────────────────────────── */

type Store = typeof import("../src/practice/store.js");

function fakeStorage(): Storage & { peek(key: string): string | null } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
    peek: (key) => map.get(key) ?? null,
  };
}

async function loadStore(): Promise<Store> {
  vi.resetModules();
  vi.stubGlobal("localStorage", fakeStorage());
  return import("../src/practice/store.js");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const MELODY = {
  id: "0:0",
  trackIndex: 0,
  channel: 0,
  name: "Lead",
  notes: NOTES,
  chordFraction: 0,
  truncated: false,
  durationSec: 2,
};

describe("making a target, end to end", () => {
  it("carries a draft from the microphone to the library", async () => {
    const store = await loadStore();
    store.beginTargetTake();
    expect(store.getPracticeState().recordingTarget).toBe(true);

    store.beginDraft(draft());
    const opened = store.getPracticeState();
    expect(opened.screen).toBe("draft");
    // The flag is cleared by the notes arriving, so the button that started the
    // take cannot be left saying Stop.
    expect(opened.recordingTarget).toBe(false);

    store.editDraft(trimDraft(opened.draft!, "start"));
    store.saveDraft("fallback");

    const after = store.getPracticeState();
    expect(after.screen).toBe("library");
    expect(after.draft).toBeNull();
    expect(after.targets).toHaveLength(1);
    expect(after.targets[0].name).toBe("Take");
    expect(after.targets[0].notes).toHaveLength(4);
    expect(after.message).toContain("Take");
    // And it is on the device, not only in memory.
    expect(localStorage.getItem("whistle-notes:practice:v1")).toContain("Take");
  });

  it("gives up on a take that produced nothing, without leaving a draft", async () => {
    const store = await loadStore();
    store.beginTargetTake();
    store.endTargetTake("Nothing tonal in that one.");
    const state = store.getPracticeState();
    expect(state.recordingTarget).toBe(false);
    expect(state.draft).toBeNull();
    expect(state.message).toBe("Nothing tonal in that one.");
  });

  it("goes back to the part picker when the draft came from one", async () => {
    // Picking the wrong part of a MIDI file is the normal mistake, and making
    // the user find the file again to fix it would be gratuitous.
    const store = await loadStore();
    store.showMidiPicker({ fileName: "tune", melodies: [MELODY] });
    expect(store.getPracticeState().screen).toBe("midi");

    store.beginDraft(makeDraft("midi", "tune", MELODY.notes));
    store.discardDraft();
    expect(store.getPracticeState().screen).toBe("midi");
    expect(store.getPracticeState().midi?.fileName).toBe("tune");

    // ...and leaving the picker forgets the file, since the `File` behind it is
    // gone by now anyway.
    store.showLibrary();
    expect(store.getPracticeState().midi).toBeNull();
  });

  it("drops a half-made target on the way out", async () => {
    const store = await loadStore();
    store.beginDraft(draft());
    store.showLibrary();
    const state = store.getPracticeState();
    expect(state.draft).toBeNull();
    expect(state.targets).toHaveLength(0);
    expect(state.recordingTarget).toBe(false);
  });

  it("refuses to save a draft that is not there", async () => {
    const store = await loadStore();
    store.saveDraft("fallback");
    expect(store.getPracticeState().targets).toHaveLength(0);
    // ...and an edit with nothing to edit changes nothing.
    store.editDraft(draft());
    expect(store.getPracticeState().draft).toBeNull();
  });

  it("names a nameless draft rather than saving one", async () => {
    const store = await loadStore();
    store.beginDraft({ ...draft(), name: "   " });
    store.saveDraft("Recorded 31 Aug, 22:05");
    expect(store.getPracticeState().targets[0].name).toBe("Recorded 31 Aug, 22:05");
  });

  it("keeps a saved target after a reload", async () => {
    const store = await loadStore();
    store.beginDraft(draft());
    store.saveDraft("fallback");
    const written = localStorage.getItem("whistle-notes:practice:v1");

    // A second module instance reading the same storage: the app, restarted.
    vi.resetModules();
    const reloaded = await import("../src/practice/store.js");
    expect(written).not.toBeNull();
    expect(reloaded.getPracticeState().targets).toHaveLength(1);
    expect(reloaded.getPracticeState().targets[0].notes).toHaveLength(5);
    // Never a screen mid-make: a draft is a decision in progress, and restoring
    // one would confront the user with notes they no longer remember recording.
    expect(reloaded.getPracticeState().screen).toBe("library");
    expect(reloaded.getPracticeState().draft).toBeNull();
  });
});
