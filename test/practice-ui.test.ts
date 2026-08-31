import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeTarget, type PracticeTarget } from "../src/practice/target.js";
import type { PracticeState } from "../src/practice/store.js";
import { emptyStats } from "../src/practice/stats.js";
import {
  EXERCISES_COMING,
  createPracticeView,
  rangeStepHint,
  rangeSummaryText,
  targetRowHtml,
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
    ]) {
      expect(copy, copy).not.toMatch(PITCH_NAME);
      expect(copy, copy).not.toMatch(INTERVAL_WORDS);
    }
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
  addEventListener(type: string, listener: () => void): void;
  /** Fire every click listener attached to this element. */
  click(): void;
}

function stub(): StubElement {
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  const listeners: (() => void)[] = [];
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
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
      if (type === "click") listeners.push(listener);
    },
    click: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

const ELEMENT_KEYS = [
  "library",
  "targetList",
  "empty",
  "rangeSummary",
  "rangeButton",
  "detail",
  "detailName",
  "detailMeta",
  "detailNext",
  "detailBack",
  "detailDelete",
  "range",
  "rangeHint",
  "rangeCurrent",
  "rangeLow",
  "rangeHigh",
  "rangeDone",
  "message",
] as const;

type Screen = Record<(typeof ELEMENT_KEYS)[number], StubElement>;

function mountPractice(): {
  el: Screen;
  handlers: { [K in keyof PracticeHandlers]: ReturnType<typeof vi.fn> };
  render: (patch?: Partial<PracticeState>, phase?: "idle" | "recording" | "analyzing") => void;
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
    message: "",
    storageError: null,
  };
  return {
    el,
    handlers,
    render: (patch = {}, phase = "idle") => view.render({ ...base, ...patch }, phase),
  };
}

const TARGET: PracticeTarget = makeTarget(
  "Tron",
  "recorded",
  [{ midi: 84, durationSec: 0.5 }, { midi: 88, durationSec: 0.5 }],
  1,
);

describe("the library screen", () => {
  it("shows exactly one screen at a time", () => {
    const { el, render } = mountPractice();
    render({ screen: "library" });
    expect([el.library.hidden, el.detail.hidden, el.range.hidden]).toEqual([false, true, true]);
    render({ screen: "target", selectedId: TARGET.id, targets: [TARGET] });
    expect([el.library.hidden, el.detail.hidden, el.range.hidden]).toEqual([true, false, true]);
    render({ screen: "range" });
    expect([el.library.hidden, el.detail.hidden, el.range.hidden]).toEqual([true, true, false]);
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
