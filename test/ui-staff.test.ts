import { describe, expect, it } from "vitest";
import { midiToHz, midiToName, type Note } from "../src/dsp/index.js";
import { renderNoteList, sequenceText } from "../src/ui/notelist.js";
import { renderStaff, staffLayout } from "../src/ui/staff.js";

/**
 * The staff renderer and the chip list, tested through the strings they
 * produce.
 *
 * Both write exactly two properties on their target element — `innerHTML` and
 * `hidden` — and `renderStaff` reads `clientWidth`. That is a small enough
 * surface to stand in for with a plain object, which keeps these tests free of
 * jsdom while still exercising the real geometry: the vertical placement of a
 * notehead is the one thing in the SVG that is genuinely easy to get wrong and
 * genuinely hard to eyeball.
 */
function stubElement(clientWidth = 320): HTMLElement & { innerHTML: string; hidden: boolean } {
  return { innerHTML: "", hidden: false, clientWidth } as unknown as HTMLElement & {
    innerHTML: string;
    hidden: boolean;
  };
}

function note(midi: number, startSec = 0, gapBeforeSec = 0): Note {
  return {
    midi,
    noteName: midiToName(midi),
    centsOffset: 0,
    startSec,
    endSec: startSec + 0.3,
    durationSec: 0.3,
    pitchHz: midiToHz(midi),
    confidence: 0.9,
    gapBeforeSec,
    flags: {},
  };
}

/** Every `cy` in document order — one per notehead. */
function noteheadYs(svg: string): number[] {
  return [...svg.matchAll(/<ellipse[^>]*cy="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
}

function count(svg: string, className: string): number {
  return svg.split(`class="${className}"`).length - 1;
}

describe("staff layout", () => {
  it("fills a row completely before starting the next one", () => {
    // 320 wide: 276 usable / 30 per note = 9 per row. The ninth note must not
    // start a second row — the classic wrap off-by-one.
    expect(staffLayout(9, 320).perRow).toBe(9);
    expect(staffLayout(9, 320).rows).toBe(1);
    expect(staffLayout(10, 320).rows).toBe(2);
    expect(staffLayout(18, 320).rows).toBe(2);
    expect(staffLayout(19, 320).rows).toBe(3);
  });

  it("keeps a row for an empty transcript rather than reporting zero", () => {
    expect(staffLayout(0, 320).rows).toBe(1);
    expect(staffLayout(0, 320).xs).toEqual([]);
  });

  it("never gives up entirely on a very narrow screen", () => {
    expect(staffLayout(4, 40).perRow).toBe(1);
    expect(staffLayout(4, 40).rows).toBe(4);
  });

  it("spaces notes evenly and wraps their rows", () => {
    const layout = staffLayout(11, 320);
    expect(layout.xs[1] - layout.xs[0]).toBe(30);
    expect(layout.rowOf).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    // The first note of row 2 sits at the same x as the first of row 1.
    expect(layout.xs[9]).toBe(layout.xs[0]);
  });
});

describe("staff rendering", () => {
  it("draws five lines and a treble label per row", () => {
    const element = stubElement();
    renderStaff([note(64), note(77)], element, 0);
    expect(count(element.innerHTML, "staff-line")).toBe(5);
    expect(count(element.innerHTML, "staff-clef")).toBe(1);
    expect(element.innerHTML).toContain(">treble<");

    renderStaff(Array.from({ length: 12 }, (_, i) => note(64 + i)), element, 0);
    expect(count(element.innerHTML, "staff-line")).toBe(10);
    expect(count(element.innerHTML, "staff-clef")).toBe(2);
  });

  it("puts E4 on the bottom line and F5 exactly eight half-spaces above", () => {
    const element = stubElement();
    renderStaff([note(64), note(77)], element, 0);
    const [e4, f5] = noteheadYs(element.innerHTML);
    // Eight half-spaces at 5 units each: the whole staff, and the only vertical
    // constant the rest of the geometry hangs off.
    expect(e4 - f5).toBe(40);
  });

  it("shares one step between a note and its sharp", () => {
    const element = stubElement();
    renderStaff([note(65), note(66)], element, 0); // F4, F#4
    const [f4, fSharp4] = noteheadYs(element.innerHTML);
    expect(fSharp4).toBe(f4);
    // Four straight lines, not a ♯ glyph: no font can move them out of place.
    expect(count(element.innerHTML, "staff-sharp")).toBe(4);
  });

  it("draws ledger lines only for notes off the staff", () => {
    const element = stubElement();
    renderStaff([note(60)], element, 0); // middle C, one ledger below
    expect(count(element.innerHTML, "staff-ledger")).toBe(1);

    renderStaff([note(71)], element, 0); // B4, the middle line
    expect(count(element.innerHTML, "staff-ledger")).toBe(0);

    renderStaff([note(84)], element, 0); // C6: A5 and C6 both need one
    expect(count(element.innerHTML, "staff-ledger")).toBe(2);
  });

  it("transposes what is drawn, never what was heard", () => {
    const element = stubElement();
    const whistled = note(96); // C7 — two octaves above the staff
    renderStaff([whistled], element, 0);
    const high = noteheadYs(element.innerHTML)[0];
    const ledgersAtTruePitch = count(element.innerHTML, "staff-ledger");
    expect(element.innerHTML).toContain(">C7<");

    renderStaff([whistled], element, -2);
    expect(element.innerHTML).toContain(">C5<");
    expect(count(element.innerHTML, "staff-ledger")).toBeLessThan(ledgersAtTruePitch);
    expect(whistled.midi).toBe(96);
    // Lower on the page after transposing down, in a taller-is-higher plot.
    expect(noteheadYs(element.innerHTML)[0]).toBeGreaterThan(high);
  });

  it("hides itself rather than drawing an empty staff", () => {
    const element = stubElement();
    renderStaff([], element, 0);
    expect(element.hidden).toBe(true);
    expect(element.innerHTML).toBe("");
  });
});

describe("note list rendering", () => {
  it("renders one chip per note, indexed for the playback highlight", () => {
    const element = stubElement();
    const notes = [note(96, 0), note(98, 0.4), note(100, 0.8)];
    renderNoteList(element, notes, -2);
    expect(count(element.innerHTML, "chip chip-medium")).toBe(3);
    expect(element.innerHTML).toContain('data-i="0"');
    expect(element.innerHTML).toContain('data-i="2"');
    expect(element.innerHTML).toContain(">C5<");
    expect(element.innerHTML).toContain(sequenceText(notes, -2));
  });

  it("shows rests between chips", () => {
    const element = stubElement();
    renderNoteList(element, [note(96, 0), note(98, 1, 0.6)], 0);
    expect(count(element.innerHTML, "chip-rest")).toBe(1);
  });

  it("hides itself when there is nothing to show", () => {
    const element = stubElement();
    renderNoteList(element, [], 0);
    expect(element.hidden).toBe(true);
    expect(element.innerHTML).toBe("");
  });
});
