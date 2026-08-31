import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { alignAttempt, type Alignment } from "../src/practice/align.js";
import type { HeardNote } from "../src/practice/recall.js";
import { BUNDLED_MELODIES } from "../src/practice/bundled.js";
import type { MidiMelody } from "../src/practice/midi.js";
import {
  makeDraft,
  makeTarget,
  type PracticeTarget,
  type TargetDraft,
} from "../src/practice/target.js";
import type {
  PracticeState,
  RecallAttempt,
  RecallSession,
} from "../src/practice/store.js";
import { emptyStats, recordAttempt, type TargetTally } from "../src/practice/stats.js";
import {
  DRAFT_HINT_IMPORTED,
  DRAFT_HINT_RECORDED,
  EXERCISES_COMING,
  RECALL_HINT_FIRST,
  RECALL_HINT_HEARD,
  chipText,
  createPracticeView,
  draftChipsHtml,
  draftMetaText,
  heatRowHtml,
  historyHtml,
  historyMetaText,
  listenLabel,
  midiHintText,
  midiRowHtml,
  rangeStepHint,
  rangeSummaryText,
  recallHint,
  starterRowHtml,
  targetRowHtml,
  troubleText,
  verdictStripHtml,
  type PracticeElements,
  type PracticeHandlers,
} from "../src/ui/practice.js";

/**
 * Practice mode's screens, tested where they are strings rather than pixels.
 *
 * Two things are worth pinning here and neither is visible in a screenshot.
 *
 * The first is the **ear-first rule**, which is the whole mode's reason for
 * existing: this user's music theory is minimal, so no exercise may present a
 * written or named target as the prompt. That is a claim about copy, and copy
 * drifts — a well-meaning "whistle a C6" would look like a helpful improvement
 * and would quietly break the feature. So the rule is enforced against the real
 * text, in `index.html` and in this module, rather than remembered.
 *
 * The second is that a target's *name* is the user's own text and is written
 * into `innerHTML`.
 */

/** Scientific pitch names: C4, F#5, Bb2 — the thing a prompt must never be. */
const PITCH_NAME = /\b[A-G][#b]?-?\d\b/;

/** Interval names, which the plan allows only as passive post-hoc labels. */
const INTERVAL_WORDS =
  /\b(unison|minor|major|perfect|second|third|fourth|fifth|sixth|seventh|octave|semitone|tritone)s?\b/i;

/** The practice half of `index.html`, as visible text. */
function practiceMarkupText(): string {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf('id="practice-view"');
  const end = html.indexOf('id="build-stamp"');
  expect(start, "practice view not found in index.html").toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return (
    html
      .slice(start, end)
      // Drop comments, ids, classes and attributes: only what a user reads.
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
  );
}

describe("the ear-first rule", () => {
  it("holds over every word of practice mode's markup", () => {
    const text = practiceMarkupText();
    expect(text).not.toMatch(PITCH_NAME);
    expect(text).not.toMatch(INTERVAL_WORDS);
    // Not vacuous: the block really does contain the copy being checked.
    expect(text).toMatch(/whistle/i);
  });

  it("holds over the sentences this module writes", () => {
    for (const copy of [
      EXERCISES_COMING,
      rangeStepHint(null, null),
      rangeStepHint(null, "low"),
      rangeStepHint(null, "high"),
      rangeStepHint({ lowMidi: 84, highMidi: 96 }, null),
      DRAFT_HINT_RECORDED,
      DRAFT_HINT_IMPORTED,
      midiHintText(0),
      midiHintText(1),
      midiHintText(4),
      ...BUNDLED_MELODIES.map((melody) => melody.name),
    ]) {
      expect(copy, copy).not.toMatch(PITCH_NAME);
      expect(copy, copy).not.toMatch(INTERVAL_WORDS);
    }
  });

  /**
   * The rule has one boundary, and it is worth pinning from both sides: the
   * *draft* screen names notes, because it is a transcript of something already
   * played and the trim and move controls have nothing to aim at otherwise. A
   * *target* never does, because that is the thing the app is about to ask for
   * from memory.
   */
  it("names notes while a melody is being made, and never once it is saved", () => {
    const draft = makeDraft("recorded", "Take", [
      { midi: 84, durSec: 0.4 },
      { midi: 88, durSec: 0.4 },
    ]);
    expect(draftChipsHtml(draft)).toMatch(PITCH_NAME);

    const target = makeTarget("Take", "recorded", [{ midi: 84, durationSec: 0.4 }], 1);
    expect(targetRowHtml(target).replace(/<[^>]*>/g, " ")).not.toMatch(PITCH_NAME);
    expect(draftMetaText(draft)).not.toMatch(PITCH_NAME);
  });

  /**
   * Measured, and therefore worth defending: the pitch search starts at 400 Hz,
   * so a piano melody played around the middle of the keyboard comes back with
   * notes *missing* rather than wrong — the clarity gate reads a harmonic-rich
   * tone whose fundamental is out of band as unvoiced. The actionable advice is
   * "play it higher up", and it is the kind of sentence that gets tidied away
   * by someone who does not know why it is there.
   */
  it("tells a piano player the one thing that will fix a half-empty take", () => {
    expect(DRAFT_HINT_RECORDED).toMatch(/missing/i);
    expect(DRAFT_HINT_RECORDED).toMatch(/further up the keyboard/);
  });

  it("asks for a feeling rather than for a pitch", () => {
    expect(rangeStepHint(null, "low")).toMatch(/comfortably low/);
    expect(rangeStepHint(null, "high")).toMatch(/comfortably high/);
    expect(rangeStepHint(null, null)).toMatch(/No particular note/);
  });

  it("describes the exercises by what the user does, not by what to read", () => {
    expect(EXERCISES_COMING).toMatch(/whistle it back/);
    expect(EXERCISES_COMING).toMatch(/Nothing to read/);
  });
});

describe("the range readout", () => {
  /**
   * The one place note names are allowed, and the plan says why: an interval or
   * note name may appear as a *passive post-hoc label* about something already
   * whistled. This is a measurement of the user, not an instruction to them.
   */
  it("names the two ends it measured", () => {
    expect(rangeSummaryText({ lowMidi: 84, highMidi: 108 })).toMatch(/^C6 to C8/);
  });

  it("says how big the range is, because that is how you tell it went wrong", () => {
    expect(rangeSummaryText({ lowMidi: 84, highMidi: 108 })).toContain("2.0 octaves");
    expect(rangeSummaryText({ lowMidi: 84, highMidi: 96 })).toContain("about an octave");
    // A range narrower than an octave usually means one take caught a squeak
    // rather than a comfortable note, and silently using it would transpose
    // every target to the wrong place for weeks.
    const narrow = rangeSummaryText({ lowMidi: 84, highMidi: 91 });
    expect(narrow).toContain("7 semitones");
    expect(narrow).toMatch(/measure it again/);
    expect(rangeSummaryText({ lowMidi: 84, highMidi: 96 })).not.toMatch(/measure it again/);
  });

  it("says what happens when it has not been measured", () => {
    for (const missing of [null, { lowMidi: 96, highMidi: 84 }]) {
      const text = rangeSummaryText(missing);
      expect(text, text).toMatch(/Not measured yet/);
      // ...and what that costs, which is the part that makes it a choice.
      expect(text, text).toMatch(/own pitch/);
    }
  });
});

describe("a library row", () => {
  const rowFor = (name: string) =>
    targetRowHtml(makeTarget(name, "recorded", [{ midi: 84, durationSec: 0.5 }], 1));

  it("shows the name and the shape, and no pitch anywhere", () => {
    const row = rowFor("Tron");
    expect(row).toContain(">Tron<");
    expect(row).toContain("1 note · 0.5 s · Recorded");
    expect(row.replace(/<[^>]*>/g, " ")).not.toMatch(PITCH_NAME);
  });

  it("cannot be turned into markup by its own name", () => {
    const row = rowFor('<img src=x onerror="boom">');
    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
    expect(row).toContain("&quot;boom&quot;");
    // Exactly one element opens the row, whatever the name was.
    expect(row.match(/<button/g)).toHaveLength(1);
  });

  it("carries the id the click handler reads back", () => {
    const target = makeTarget("t", "bundled", [{ midi: 84, durationSec: 0.5 }], 1);
    expect(targetRowHtml(target)).toContain(`data-target="${target.id}"`);
  });
});

/**
 * The screens themselves, driven against a hand-rolled element stub.
 *
 * No jsdom, for the reason the rest of `test/ui-*` gives: the view touches a
 * handful of element properties and nothing else, so a stub that implements
 * exactly those is both smaller and more honest about what is being simulated.
 * What it buys is the class of bug that types cannot see and a screenshot does
 * not show — a Stop button left over a microphone that is already closed, a
 * delete confirmation that stays armed after the target is gone, a screen that
 * is showing when it should not be.
 */

interface StubElement {
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  innerHTML: string;
  /** For the name field. */
  value: string;
  /** For the MIDI file input. */
  files: File[] | null;
  dataset: Record<string, string>;
  classes: Set<string>;
  attributes: Record<string, string>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): void;
  };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  /** Fire every listener of one type, with an event of the caller's choosing. */
  dispatch(type: string, event?: unknown): void;
  /** Fire every click listener attached to this element. */
  click(): void;
  /** The result screen's canvas. `null` makes `drawDiffOverlay` bail out at its
   *  first line, which is what a test that is about the strip and the sentences
   *  wants — the drawing itself is tested against a recording context in
   *  `test/practice-recall.test.ts`. */
  getContext(): null;
  querySelectorAll(selector: string): StubElement[];
}

function stub(): StubElement {
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const element: StubElement = {
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    value: "",
    files: null,
    dataset: {},
    classes,
    attributes,
    classList: {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      toggle: (name, force) => {
        if (force ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute: (name, value) => void (attributes[name] = value),
    getAttribute: (name) => attributes[name] ?? null,
    addEventListener: (type, listener) => {
      const forType = listeners.get(type) ?? [];
      forType.push(listener);
      listeners.set(type, forType);
    },
    dispatch: (type, event) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    click: () => element.dispatch("click", { target: null }),
    getContext: () => null,
    querySelectorAll: () => [],
  };
  return element;
}

/**
 * Click something *inside* a delegating container.
 *
 * The library list, the built-in melodies and the MIDI part picker are all
 * rebuilt from strings and listen on the container, so the only thing the
 * handler ever sees of the row is `closest("[data-x]")`. That is what this
 * fakes — and it is worth faking, because a delegated handler that reads the
 * wrong attribute is invisible to the type checker and to a screenshot alike.
 */
function clickChild(container: StubElement, attribute: string, value: string): void {
  const child = {
    getAttribute: (name: string) => (name === attribute ? value : null),
    closest: (selector: string): unknown => (selector === `[${attribute}]` ? child : null),
  };
  container.dispatch("click", { target: child });
}

const ELEMENT_KEYS = [
  "library",
  "targetList",
  "empty",
  "rangeSummary",
  "rangeButton",
  "addRecord",
  "addMidiLabel",
  "addMidiInput",
  "starters",
  "detail",
  "detailName",
  "detailMeta",
  "detailNext",
  "detailPractice",
  "detailHistory",
  "detailHeat",
  "detailTrouble",
  "detailAttempts",
  "detailBack",
  "detailDelete",
  "range",
  "rangeHint",
  "rangeCurrent",
  "rangeLow",
  "rangeHigh",
  "rangeDone",
  "draft",
  "draftBack",
  "draftHint",
  "draftNotes",
  "draftMeta",
  "draftNote",
  "draftTrimStart",
  "draftTrimEnd",
  "draftReset",
  "draftLower",
  "draftHigher",
  "draftName",
  "draftSave",
  "midi",
  "midiBack",
  "midiTitle",
  "midiHint",
  "midiList",
  "recall",
  "recallBack",
  "recallName",
  "recallHint",
  "recallListen",
  "recallListens",
  "recallWhistle",
  "result",
  "resultBack",
  "resultCanvas",
  "resultStrip",
  "resultSummary",
  "resultTakeaway",
  "resultRetry",
  "resultDone",
  "message",
] as const;

type Screen = Record<(typeof ELEMENT_KEYS)[number], StubElement>;

function mountPractice(): {
  el: Screen;
  handlers: { [K in keyof PracticeHandlers]: ReturnType<typeof vi.fn> };
  render: (
    patch?: Partial<PracticeState>,
    phase?: "idle" | "recording" | "analyzing",
    playing?: boolean,
  ) => void;
} {
  const el = Object.fromEntries(ELEMENT_KEYS.map((key) => [key, stub()])) as Screen;
  const handlers = {
    onSelect: vi.fn(),
    onBack: vi.fn(),
    onDelete: vi.fn(),
    onOpenRange: vi.fn(),
    onCaptureRange: vi.fn(),
    onStopCapture: vi.fn(),
    onCloseRange: vi.fn(),
    onRecordTarget: vi.fn(),
    onMidiFile: vi.fn(),
    onAddBundled: vi.fn(),
    onPickMelody: vi.fn(),
    onCloseMidi: vi.fn(),
    onTrimDraft: vi.fn(),
    onTrimDraftTo: vi.fn(),
    onResetTrim: vi.fn(),
    onShiftDraft: vi.fn(),
    onRenameDraft: vi.fn(),
    onSaveDraft: vi.fn(),
    onDiscardDraft: vi.fn(),
    onPractice: vi.fn(),
    onListen: vi.fn(),
    onStopListen: vi.fn(),
    onAttempt: vi.fn(),
    onRetry: vi.fn(),
    onCloseRecall: vi.fn(),
  };
  const view = createPracticeView(
    el as unknown as PracticeElements,
    handlers as unknown as PracticeHandlers,
  );
  const base: PracticeState = {
    screen: "library",
    targets: [],
    selectedId: null,
    range: null,
    stats: emptyStats(),
    rangeStep: null,
    rangeDraft: { low: null, high: null },
    draft: null,
    midi: null,
    recall: null,
    recordingTarget: false,
    message: "",
    storageError: null,
  };
  return {
    el,
    handlers,
    render: (patch = {}, phase = "idle", playing = false) =>
      view.render({ ...base, ...patch }, phase, playing),
  };
}

const TARGET: PracticeTarget = makeTarget(
  "Tron",
  "recorded",
  [{ midi: 84, durationSec: 0.5 }, { midi: 88, durationSec: 0.5 }],
  1,
);

/** Five notes: enough to trim from both ends and still have a melody. */
const DRAFT: TargetDraft = makeDraft("recorded", "Recorded now", [
  { midi: 72, durSec: 0.2 },
  { midi: 74, durSec: 0.4 },
  { midi: 76, durSec: 0.4 },
  { midi: 74, durSec: 0.4 },
  { midi: 72, durSec: 0.6 },
]);

/** The melody as the recall screen plays it: already in the whistler's range. */
const AS_PLAYED = [84, 86, 88, 91, 89].map((midi) => ({ midi, durSec: 0.4 }));

/** An attempt with one note a semitone sharp and one never sung, which is
 *  enough to exercise every kind of chip the strip can draw. */
const WHISTLED: HeardNote[] = [84, 86, 89, 89].map((midi, i) => ({
  midi,
  centsOffset: 0,
  durationSec: 0.4,
  startSec: i * 0.5,
  endSec: i * 0.5 + 0.4,
}));

const ATTEMPT: RecallAttempt = {
  notes: WHISTLED,
  trail: [],
  alignment: alignAttempt(WHISTLED, AS_PLAYED),
};

function session(patch: Partial<RecallSession> = {}): RecallSession {
  return {
    targetId: TARGET.id,
    notes: AS_PLAYED,
    listens: 0,
    recording: false,
    attempt: null,
    ...patch,
  };
}

/** A target's history, as the store would have built it. */
function tally(attempts: readonly Alignment[]): TargetTally {
  let stats = emptyStats();
  attempts.forEach((alignment, i) => {
    stats = recordAttempt(stats, TARGET.id, AS_PLAYED, alignment, i + 1);
  });
  return stats.targets.get(TARGET.id)!;
}

/** An attempt at {@link AS_PLAYED} with the given cents error per slot;
 *  `null` means the note was never sung. */
function attemptOf(errors: readonly (number | null)[]): Alignment {
  const notes: HeardNote[] = [];
  let cursor = 0;
  AS_PLAYED.forEach((note, i) => {
    const cents = errors[i];
    if (cents === null) return;
    const pitch = note.midi + cents / 100;
    const midi = Math.round(pitch);
    notes.push({
      midi,
      centsOffset: (pitch - midi) * 100,
      durationSec: 0.4,
      startSec: cursor,
      endSec: cursor + 0.4,
    });
    cursor += 0.5;
  });
  return alignAttempt(notes, AS_PLAYED);
}

const MELODY: MidiMelody = {
  id: "1:0",
  trackIndex: 1,
  channel: 0,
  name: "Lead",
  notes: [{ midi: 60, durSec: 0.5 }, { midi: 62, durSec: 0.5 }],
  chordFraction: 0,
  truncated: false,
  durationSec: 1,
};

describe("the library screen", () => {
  it("shows exactly one screen at a time", () => {
    const { el, render } = mountPractice();
    const showing = (): string[] =>
      (["library", "detail", "range", "draft", "midi", "recall", "result"] as const).filter(
        (name) => !el[name].hidden,
      );

    render({ screen: "library" });
    expect(showing()).toEqual(["library"]);
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    expect(showing()).toEqual(["detail"]);
    render({ screen: "range" });
    expect(showing()).toEqual(["range"]);
    render({ screen: "draft", draft: DRAFT });
    expect(showing()).toEqual(["draft"]);
    render({ screen: "midi", midi: { fileName: "tune", melodies: [MELODY] } });
    expect(showing()).toEqual(["midi"]);
    // One screen, two halves: before the attempt and after it.
    render({ screen: "recall", targets: [TARGET], recall: session() });
    expect(showing()).toEqual(["recall"]);
    render({ screen: "recall", targets: [TARGET], recall: session({ attempt: ATTEMPT }) });
    expect(showing()).toEqual(["result"]);
  });

  it("swaps the list for the empty state, and back", () => {
    const { el, render } = mountPractice();
    render();
    expect(el.targetList.hidden).toBe(true);
    expect(el.empty.hidden).toBe(false);

    render({ targets: [TARGET] });
    expect(el.targetList.hidden).toBe(false);
    expect(el.empty.hidden).toBe(true);
    expect(el.targetList.innerHTML).toContain(">Tron<");
  });

  it("names the range button after what tapping it will do", () => {
    const { el, render } = mountPractice();
    render();
    expect(el.rangeButton.textContent).toMatch(/^Measure your whistling range/);
    render({ range: { lowMidi: 84, highMidi: 96 } });
    expect(el.rangeButton.textContent).toMatch(/again/);
  });

  it("puts the exercises-are-coming line on the detail screen exactly once", () => {
    const { el } = mountPractice();
    expect(el.detailNext.textContent).toBe(EXERCISES_COMING);
  });
});

describe("deleting a target", () => {
  it("takes two taps, and says so in between", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    expect(el.detailDelete.textContent).toBe("Delete");

    el.detailDelete.click();
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(el.detailDelete.textContent).toBe("Tap again to delete");
    expect(el.detailDelete.classes.has("is-armed")).toBe(true);

    el.detailDelete.click();
    expect(handlers.onDelete).toHaveBeenCalledWith(TARGET.id);
  });

  it("stays armed across a re-render of the same target", () => {
    const { el, render } = mountPractice();
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    el.detailDelete.click();
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET], message: "hi" });
    expect(el.detailDelete.textContent).toBe("Tap again to delete");
  });

  it("disarms the moment the screen is about something else", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    el.detailDelete.click();

    // Back to the library: the confirmation must not survive it, or the next
    // visit to any target would delete it on the first tap.
    render({ screen: "library", selectedId: null, targets: [TARGET] });
    expect(el.detailDelete.textContent).toBe("Delete");
    expect(el.detailDelete.classes.has("is-armed")).toBe(false);

    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    el.detailDelete.click();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });
});

describe("the range check screen", () => {
  it("starts a take, then offers the only way out of it", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "range" });
    expect(el.rangeLow.textContent).toBe("Low note");

    el.rangeLow.click();
    expect(handlers.onCaptureRange).toHaveBeenCalledWith("low");

    // The store's answer comes back as a render, and now the button that
    // started the take is the one that stops it.
    render({ screen: "range", rangeStep: "low" }, "recording");
    expect(el.rangeLow.textContent).toBe("Stop");
    expect(el.rangeLow.classes.has("is-recording")).toBe(true);
    // ...and the other one cannot open a second microphone behind its back.
    expect(el.rangeHigh.disabled).toBe(true);
    expect(el.rangeDone.disabled).toBe(true);

    el.rangeLow.click();
    expect(handlers.onStopCapture).toHaveBeenCalledTimes(1);
    expect(handlers.onCaptureRange).toHaveBeenCalledTimes(1);
  });

  it("never leaves a Stop over a microphone that is already closed", () => {
    // The bug this pins: `rangeStep` is practice state and `phase` is app
    // state, and they are set by different modules. A screen that trusted only
    // the first would show Stop after the take had already ended.
    const { el, render } = mountPractice();
    render({ screen: "range", rangeStep: "low" }, "idle");
    expect(el.rangeLow.textContent).toBe("Low note");
    expect(el.rangeLow.disabled).toBe(false);
  });

  it("locks both buttons while the take is being listened to", () => {
    const { el, render } = mountPractice();
    render({ screen: "range", rangeStep: "high" }, "analyzing");
    expect(el.rangeLow.disabled).toBe(true);
    expect(el.rangeHigh.disabled).toBe(true);
    expect(el.rangeHigh.textContent).toBe("High note");
  });

  it("ticks off the end that has been answered", () => {
    const { el, render } = mountPractice();
    render({ screen: "range", rangeDraft: { low: 84, high: null } });
    expect(el.rangeLow.textContent).toBe("Low note ✓");
    expect(el.rangeLow.classes.has("is-done")).toBe(true);
    expect(el.rangeHigh.textContent).toBe("High note");
    expect(el.rangeHigh.classes.has("is-done")).toBe(false);
  });
});

describe("recording a melody to practise", () => {
  it("starts a take, and becomes the only way out of it", () => {
    const { el, handlers, render } = mountPractice();
    render();
    expect(el.addRecord.textContent).toBe("Record one");

    el.addRecord.click();
    expect(handlers.onRecordTarget).toHaveBeenCalledTimes(1);

    render({ recordingTarget: true }, "recording");
    expect(el.addRecord.textContent).toBe("Stop");
    expect(el.addRecord.classes.has("is-recording")).toBe(true);
    // A file picked mid-take would land on a draft the microphone is about to
    // replace, so the other way in goes away while one is running.
    expect(el.addMidiLabel.hidden).toBe(true);
    expect(el.addMidiInput.disabled).toBe(true);

    el.addRecord.click();
    expect(handlers.onStopCapture).toHaveBeenCalledTimes(1);
    expect(handlers.onRecordTarget).toHaveBeenCalledTimes(1);
  });

  it("never leaves a Stop over a microphone that is already closed", () => {
    // The same split-state bug the range buttons have: `recordingTarget` is
    // practice state, `phase` belongs to the transcriber, and a screen that
    // trusted only the first would offer to stop a take that already ended.
    const { el, render } = mountPractice();
    render({ recordingTarget: true }, "idle");
    expect(el.addRecord.textContent).toBe("Record one");
    expect(el.addRecord.disabled).toBe(false);
  });

  it("locks the button while the take is being listened to", () => {
    const { el, render } = mountPractice();
    render({ recordingTarget: true }, "analyzing");
    expect(el.addRecord.disabled).toBe(true);
    expect(el.addMidiLabel.hidden).toBe(true);
  });

  it("offers every built-in melody, and reports which one was tapped", () => {
    const { el, handlers } = mountPractice();
    for (const melody of BUNDLED_MELODIES) {
      expect(el.starters.innerHTML).toContain(`data-bundled="${melody.id}"`);
    }
    clickChild(el.starters, "data-bundled", "twinkle");
    expect(handlers.onAddBundled).toHaveBeenCalledWith("twinkle");
  });

  it("hands over a picked MIDI file and forgets it immediately", () => {
    const { el, handlers } = mountPractice();
    const file = { name: "tune.mid" } as unknown as File;
    el.addMidiInput.files = [file];
    el.addMidiInput.dispatch("change");
    expect(handlers.onMidiFile).toHaveBeenCalledWith(file);
    // Cleared, or picking the same file again fires no `change` — which is
    // exactly what you do after picking the wrong part out of it.
    expect(el.addMidiInput.value).toBe("");
  });
});

describe("the draft screen", () => {
  it("shows every note, and greys the ones that are about to go", () => {
    const { el, render } = mountPractice();
    render({ screen: "draft", draft: { ...DRAFT, keepFrom: 1, keepTo: 4 } });
    const chips = el.draftNotes.innerHTML.split("</button>");
    // Five chips, of which the first and last are struck out.
    expect(el.draftNotes.innerHTML.match(/class="chip[ "]/g)).toHaveLength(5);
    expect(chips[0]).toContain("is-dropped");
    expect(chips[1]).not.toContain("is-dropped");
    expect(el.draftMeta.textContent).toBe("3 notes · 1.2 s · 2 dropped");
  });

  it("moves the whole melody when the melody moved", () => {
    const { el, render } = mountPractice();
    render({ screen: "draft", draft: DRAFT });
    const before = el.draftNotes.innerHTML;
    render({ screen: "draft", draft: { ...DRAFT, octaveShift: -1 } });
    expect(el.draftNotes.innerHTML).not.toBe(before);
    // Same shape, twelve semitones down: the first chip was C5, and is C4.
    expect(el.draftNotes.innerHTML).toContain(">C4<");
  });

  it("stops trimming before the melody is gone", () => {
    const { el, render } = mountPractice();
    render({ screen: "draft", draft: DRAFT });
    expect(el.draftTrimStart.disabled).toBe(false);
    expect(el.draftReset.disabled).toBe(true);

    render({ screen: "draft", draft: { ...DRAFT, keepFrom: 2, keepTo: 3 } });
    expect(el.draftTrimStart.disabled).toBe(true);
    expect(el.draftTrimEnd.disabled).toBe(true);
    expect(el.draftReset.disabled).toBe(false);
  });

  it("stops moving at the ends of the range it allows", () => {
    const { el, render } = mountPractice();
    render({ screen: "draft", draft: { ...DRAFT, octaveShift: 3 } });
    expect(el.draftHigher.disabled).toBe(true);
    expect(el.draftLower.disabled).toBe(false);
  });

  it("reports every edit, and asks the caller to make it", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "draft", draft: DRAFT });
    el.draftTrimStart.click();
    el.draftTrimEnd.click();
    el.draftReset.click();
    el.draftLower.click();
    el.draftHigher.click();
    el.draftSave.click();
    el.draftBack.click();
    clickChild(el.draftNotes, "data-i", "3");
    expect(handlers.onTrimDraft.mock.calls).toEqual([["start"], ["end"]]);
    // A number, not the string the attribute holds: the store's trim does index
    // arithmetic with it.
    expect(handlers.onTrimDraftTo).toHaveBeenCalledWith(3);
    expect(handlers.onResetTrim).toHaveBeenCalledTimes(1);
    expect(handlers.onShiftDraft.mock.calls).toEqual([[-1], [1]]);
    expect(handlers.onSaveDraft).toHaveBeenCalledTimes(1);
    expect(handlers.onDiscardDraft).toHaveBeenCalledTimes(1);
  });

  it("does not fight the user for the name field", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "draft", draft: DRAFT });
    expect(el.draftName.value).toBe("Recorded now");

    // A keystroke: the field reports it, and the render that follows must not
    // write the old value back over what is being typed.
    el.draftName.value = "Recorded now!";
    el.draftName.dispatch("input");
    expect(handlers.onRenameDraft).toHaveBeenCalledWith("Recorded now!");
    render({ screen: "draft", draft: { ...DRAFT, name: "Recorded now!" } });
    expect(el.draftName.value).toBe("Recorded now!");
  });

  it("says what an import had to decide, and stays quiet otherwise", () => {
    const { el, render } = mountPractice();
    render({ screen: "draft", draft: DRAFT });
    expect(el.draftNote.hidden).toBe(true);
    expect(el.draftHint.textContent).toBe(DRAFT_HINT_RECORDED);

    render({
      screen: "draft",
      draft: { ...makeDraft("midi", "Tune", DRAFT.notes, "Mostly chords."), source: "midi" },
    });
    expect(el.draftNote.hidden).toBe(false);
    expect(el.draftNote.textContent).toBe("Mostly chords.");
    expect(el.draftHint.textContent).toBe(DRAFT_HINT_IMPORTED);
  });
});

describe("the MIDI part picker", () => {
  it("lists the parts and reports the one that was tapped", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "midi", midi: { fileName: "tune", melodies: [MELODY] } });
    expect(el.midiTitle.textContent).toBe("tune");
    expect(el.midiHint.textContent).toMatch(/One part/);
    expect(el.midiList.innerHTML).toContain(">Lead<");
    expect(el.midiList.innerHTML).toContain("2 notes · 1.0 s");

    clickChild(el.midiList, "data-melody", "1:0");
    expect(handlers.onPickMelody).toHaveBeenCalledWith("1:0");
    el.midiBack.click();
    expect(handlers.onCloseMidi).toHaveBeenCalledTimes(1);
  });

  it("warns about a part that is not a single line, before it is picked", () => {
    const row = midiRowHtml({ ...MELODY, chordFraction: 0.4 });
    expect(row).toMatch(/40%/);
    expect(row).toMatch(/highest/);
    // ...and says nothing about a part that is one.
    expect(midiRowHtml(MELODY)).not.toMatch(/%/);
  });

  it("cannot be turned into markup by a name from the file", () => {
    const row = midiRowHtml({ ...MELODY, name: '<img src=x onerror="boom">' });
    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
    expect(row.match(/<button/g)).toHaveLength(1);
  });

  it("escapes a built-in melody's id and name too", () => {
    expect(starterRowHtml({ id: 'a"b', name: "<b>" })).toBe(
      '<button type="button" class="starter" data-bundled="a&quot;b">&lt;b&gt;</button>',
    );
  });
});

describe("the recall screen, before the attempt", () => {
  /**
   * The ear-first rule, at the one place in the app where it does real work.
   *
   * Everything else in practice mode merely happens not to name a pitch; this
   * screen is holding a melody in memory *and choosing not to show it*, with
   * the notes sitting right there in the state it was handed. A helpful future
   * change — a preview roll, a "starts on C6" hint, a staff — would look like
   * an improvement and would delete the exercise. So it is checked against
   * every string the screen writes, rather than remembered.
   */
  it("shows the melody's name and length, and not one of its notes", () => {
    const { el, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session({ listens: 3 }) });

    const written = [
      el.recallName,
      el.recallHint,
      el.recallListens,
      el.recallListen,
      el.recallWhistle,
      el.recallBack,
    ].flatMap((element) => [element.textContent, element.innerHTML]);

    for (const text of written) {
      expect(text, text).not.toMatch(PITCH_NAME);
      expect(text, text).not.toMatch(INTERVAL_WORDS);
    }
    // Not vacuous: the screen really is showing something.
    expect(el.recallName.textContent).toBe("Tron");
    expect(el.recallHint.textContent).toMatch(/whistle it back/i);
    expect(el.recallListens.textContent).toBe("Heard it 3 times.");
  });

  it("says listening is unlimited, and never grades the number", () => {
    expect(RECALL_HINT_FIRST).toMatch(/as many times as you like/);
    expect(RECALL_HINT_HEARD).toMatch(/as often as you like/);
    for (const copy of [RECALL_HINT_FIRST, RECALL_HINT_HEARD, recallHint(0), recallHint(7)]) {
      expect(copy, copy).not.toMatch(PITCH_NAME);
      expect(copy, copy).not.toMatch(INTERVAL_WORDS);
    }
    // The register is forgiven up front, so nobody spends the attempt worrying
    // about it — the aligner does not care and neither should they.
    expect(RECALL_HINT_FIRST).toMatch(/comfortable/);
  });

  it("hides the listen count until there is one", () => {
    const { el, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session() });
    expect(el.recallListens.hidden).toBe(true);
    render({ screen: "recall", targets: [TARGET], recall: session({ listens: 1 }) });
    expect(el.recallListens.hidden).toBe(false);
    expect(el.recallListens.textContent).toBe("Heard it once.");
  });

  it("plays the melody, and becomes the only way to stop it", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session() });
    expect(el.recallListen.textContent).toBe("Listen");

    el.recallListen.click();
    expect(handlers.onListen).toHaveBeenCalledTimes(1);

    render({ screen: "recall", targets: [TARGET], recall: session({ listens: 1 }) }, "idle", true);
    expect(el.recallListen.textContent).toBe("Stop");
    expect(el.recallListen.classes.has("is-playing")).toBe(true);
    el.recallListen.click();
    expect(handlers.onStopListen).toHaveBeenCalledTimes(1);
    expect(handlers.onListen).toHaveBeenCalledTimes(1);

    // ...and afterwards it offers the thing you actually want next.
    render({ screen: "recall", targets: [TARGET], recall: session({ listens: 1 }) });
    expect(el.recallListen.textContent).toBe("Listen again");
    expect(listenLabel(0, false)).toBe("Listen");
    expect(listenLabel(3, true)).toBe("Stop");
  });

  it("starts the attempt, and becomes the only way out of it", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session() });
    expect(el.recallWhistle.textContent).toBe("Whistle it");

    el.recallWhistle.click();
    expect(handlers.onAttempt).toHaveBeenCalledTimes(1);

    render(
      { screen: "recall", targets: [TARGET], recall: session({ recording: true }) },
      "recording",
    );
    expect(el.recallWhistle.textContent).toBe("Stop");
    expect(el.recallWhistle.classes.has("is-recording")).toBe(true);
    // One microphone: the melody cannot be replayed into it mid-take.
    expect(el.recallListen.disabled).toBe(true);

    el.recallWhistle.click();
    expect(handlers.onStopCapture).toHaveBeenCalledTimes(1);
    expect(handlers.onAttempt).toHaveBeenCalledTimes(1);
  });

  it("never leaves a Stop over a microphone that is already closed", () => {
    // The same split-state bug the range and record buttons have: `recording`
    // is practice state, `phase` belongs to the transcriber.
    const { el, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session({ recording: true }) }, "idle");
    expect(el.recallWhistle.textContent).toBe("Whistle it");
    expect(el.recallWhistle.disabled).toBe(false);
  });

  it("locks both buttons while the attempt is being listened to", () => {
    const { el, render } = mountPractice();
    render(
      { screen: "recall", targets: [TARGET], recall: session({ recording: true }) },
      "analyzing",
    );
    expect(el.recallWhistle.disabled).toBe(true);
    expect(el.recallListen.disabled).toBe(true);
  });

  /**
   * The bug this pins: walking off this screen mid-take would leave the
   * microphone open with nothing on screen that gets back to a Stop — the take
   * would run until the 60 s cap closed it. The range check's Done button
   * already follows this rule; so does this one.
   */
  it("will not let you walk away from a running take", () => {
    const { el, render } = mountPractice();
    for (const phase of ["recording", "analyzing"] as const) {
      render({ screen: "recall", targets: [TARGET], recall: session({ recording: true }) }, phase);
      expect(el.recallBack.disabled, phase).toBe(true);
    }
    // ...and it is right back the moment the take is over.
    render({ screen: "recall", targets: [TARGET], recall: session() });
    expect(el.recallBack.disabled).toBe(false);
  });

  it("will not open the microphone over its own loudspeaker", () => {
    // Echo cancellation is off throughout this app, so a phone recording while
    // the melody is still playing would transcribe the answer.
    const { el, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session({ listens: 1 }) }, "idle", true);
    expect(el.recallWhistle.disabled).toBe(true);
  });

  it("leaves the exercise from either end of the screen", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session() });
    el.recallBack.click();
    render({ screen: "recall", targets: [TARGET], recall: session({ attempt: ATTEMPT }) });
    el.resultBack.click();
    el.resultDone.click();
    expect(handlers.onCloseRecall).toHaveBeenCalledTimes(3);
  });
});

describe("the recall screen, after the attempt", () => {
  /** The other side of the boundary the draft screen already pins: a name
   *  about something already whistled is a label, not a prompt. */
  it("names what was whistled, once there is something to name", () => {
    const { el, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session({ attempt: ATTEMPT }) });
    // The 3rd note came out as the 4th note's pitch, so the strip says so.
    expect(el.resultStrip.innerHTML).toMatch(PITCH_NAME);
    expect(el.resultSummary.textContent).toMatch(/notes clean/);
    expect(el.resultTakeaway.textContent).toMatch(/note/);
  });

  it("draws one chip per note of the melody, plus anything extra", () => {
    const { el, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session({ attempt: ATTEMPT }) });
    expect(el.resultStrip.innerHTML.match(/data-recall-i=/g)).toHaveLength(AS_PLAYED.length);
  });

  it("marks the chip whose slot is framed, and unmarks it on a second tap", () => {
    const { el, render } = mountPractice();
    render({ screen: "recall", targets: [TARGET], recall: session({ attempt: ATTEMPT }) });

    const chip = stub();
    chip.setAttribute("data-recall-i", "2");
    el.resultStrip.querySelectorAll = () => [chip];
    clickChild(el.resultStrip, "data-recall-i", "2");
    expect(chip.classes.has("is-picked")).toBe(true);

    clickChild(el.resultStrip, "data-recall-i", "2");
    expect(chip.classes.has("is-picked")).toBe(false);
  });

  it("says what each verdict is, in as few characters as fit on a phone", () => {
    const chip = (patch: Partial<Parameters<typeof chipText>[0]>) =>
      chipText({ index: 0, outcome: "clean", position: 4, cents: null, nameMidi: null, ...patch });
    expect(chip({}).mark).toBe("✓");
    expect(chip({ outcome: "off", cents: 38 }).mark).toBe("+38¢");
    expect(chip({ outcome: "off", cents: -38 }).mark).toBe("-38¢");
    expect(chip({ outcome: "wrong", nameMidi: 89 }).mark).toBe("F6");
    expect(chip({ outcome: "missing" }).mark).toBe("—");
    expect(chip({ outcome: "extra", position: null, nameMidi: 89 }).mark).toBe("F6");

    /*
     * The number stays on every chip that has one — including the wrong and
     * missed ones. The summary says "the 5th note came out a semitone sharp",
     * and a strip that dropped the number from exactly the chips it was talking
     * about would leave the reader counting chips to find it.
     */
    for (const outcome of ["clean", "off", "wrong", "missing"] as const) {
      expect(chip({ outcome, cents: 40, nameMidi: 89 }).sub, outcome).toBe("4");
    }
    expect(chip({ outcome: "extra", position: null }).sub).toBe("extra");

    // ...and the verdict word itself survives for anyone not reading colours.
    expect(chip({}).label).toBe("Note 4: clean");
    expect(chip({ outcome: "off", cents: -38 }).label).toBe("Note 4: 38 cents flat");
    expect(chip({ outcome: "wrong", nameMidi: 89 }).label).toBe(
      "Note 4: wrong, you whistled F6",
    );
    expect(chip({ outcome: "missing" }).label).toBe("Note 4: missed");
    expect(chip({ outcome: "extra", position: null, nameMidi: 89 }).label).toBe(
      "Extra note: F6",
    );
  });

  it("cannot be turned into markup by anything it is handed", () => {
    const html = verdictStripHtml([
      { index: 0, outcome: "wrong", position: 1, cents: 700, nameMidi: 89 },
    ]);
    expect(html).toContain('data-recall-i="0"');
    expect(html).toContain("is-wrong");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("a melody's history", () => {
  const CLEAN = attemptOf([0, 0, 0, 0, 0]);
  const WRONG_THIRD = attemptOf([0, 0, 200, 0, 0]);
  const MISSED_THIRD = attemptOf([0, 0, null, 0, 0]);

  it("stays off the screen until there is something to show", () => {
    const { el, render } = mountPractice();
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    expect(el.detailHistory.hidden).toBe(true);
  });

  it("shows the recent attempts as strips, newest first", () => {
    const { el, render } = mountPractice();
    let stats = emptyStats();
    stats = recordAttempt(stats, TARGET.id, AS_PLAYED, WRONG_THIRD, 1);
    stats = recordAttempt(stats, TARGET.id, AS_PLAYED, CLEAN, 2);
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET], stats });

    expect(el.detailHistory.hidden).toBe(false);
    const rows = el.detailAttempts.innerHTML.split("</div>").filter((row) => row.includes("vcell"));
    expect(rows).toHaveLength(2);
    // Newest first: the clean attempt is the one on top.
    expect(rows[0]).not.toContain("is-wrong");
    expect(rows[1]).toContain("is-wrong");
    expect(el.detailAttempts.innerHTML).toContain("5/5");
    expect(el.detailMeta.textContent).toContain("2 attempts");
    expect(el.detailMeta.textContent).toContain("5 of 5 clean last time");
  });

  it("draws one heat bar per note of the melody", () => {
    const cells = heatRowHtml(tally([CLEAN, WRONG_THIRD]));
    expect(cells.match(/class="heat"/g)).toHaveLength(AS_PLAYED.length);
    // The slot that went wrong is the solid one.
    const opacities = [...cells.matchAll(/opacity:([\d.]+)/g)].map((m) => Number(m[1]));
    // Half the attempts went wrong at that slot, so it is half lit; a slot that
    // has never been anything but clean is the faintest mark the row can draw.
    expect(opacities[0]).toBeCloseTo(0.1, 9);
    expect(opacities[2]).toBeCloseTo(0.55, 9);
    const always = [...heatRowHtml(tally([WRONG_THIRD, WRONG_THIRD])).matchAll(
      /opacity:([\d.]+)/g,
    )].map((m) => Number(m[1]));
    expect(always[2]).toBe(1);
  });

  /**
   * The distinction the whole history exists for. One bad attempt is a flub and
   * the app says nothing; the same note twice is a trouble spot and it says so.
   * An app that announced one after a single miss would be reporting noise, and
   * would be ignored by the time it started being right.
   */
  it("tells a one-off flub from a note that keeps beating you", () => {
    expect(troubleText(tally([WRONG_THIRD, CLEAN, CLEAN, CLEAN]))).toBe("");
    const persistent = troubleText(tally([WRONG_THIRD, CLEAN, WRONG_THIRD, CLEAN]));
    expect(persistent).toContain("The 3rd note");
    expect(persistent).toContain("come out wrong in 2 of 4 attempts");
    // A slot that is skipped rather than fluffed is a different sentence,
    // because it is a different problem: recall, not aim.
    expect(troubleText(tally([MISSED_THIRD, MISSED_THIRD]))).toContain("gone missing");
  });

  it("counts the attempts, and how the last one went", () => {
    expect(historyMetaText(tally([CLEAN]))).toBe("1 attempt · 5 of 5 clean last time");
    expect(historyMetaText(tally([CLEAN, WRONG_THIRD]))).toBe(
      "2 attempts · 4 of 5 clean last time",
    );
  });

  it("shows only the last few attempts, however many there are", () => {
    const many = tally(Array.from({ length: 12 }, () => CLEAN));
    const rows = historyHtml(many).split("</div>").filter((row) => row.includes("vcell"));
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(many.attempts).toBe(12);
  });

  it("offers the exercise, and reports which melody it is about", () => {
    const { el, handlers, render } = mountPractice();
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    el.detailPractice.click();
    expect(handlers.onPractice).toHaveBeenCalledWith(TARGET.id);
  });
});

describe("the practice status line", () => {
  it("is hidden until there is something to say", () => {
    const { el, render } = mountPractice();
    render();
    expect(el.message.hidden).toBe(true);

    render({ message: "Heard it." });
    expect(el.message.hidden).toBe(false);
    expect(el.message.textContent).toBe("Heard it.");
    expect(el.message.classes.has("is-error")).toBe(false);
  });

  it("never lets a message hide the fact that nothing is being saved", () => {
    const { el, render } = mountPractice();
    render({ message: "Heard it.", storageError: "Storage is full." });
    expect(el.message.textContent).toBe("Heard it. Storage is full.");
    expect(el.message.classes.has("is-error")).toBe(true);
  });
});
