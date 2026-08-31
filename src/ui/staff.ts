/**
 * Sheet music, hand-rolled as SVG in about two hundred lines.
 *
 * VexFlow would be 21 MB whose entire value is rhythm layout — precisely the
 * thing this app does not transcribe. What is left is genuinely small: a staff
 * is a diatonic grid, `staffPosition()` in `src/notes/format.ts` already turns a
 * MIDI number into a height on it, and everything else is arithmetic.
 *
 * Two deliberate departures from engraved music, both for a beginner's benefit:
 *
 * - **No clef glyph.** A real treble clef is a licensed font or a long path;
 *   the word "treble" costs nothing and is more informative to someone who
 *   cannot yet read one.
 * - **Note names under the noteheads.** The point of the page is to find the
 *   notes on a keyboard, so the answer is written under each one.
 *
 * The accidental is drawn from four straight lines rather than the ♯ character,
 * because a glyph would inherit whatever font the platform felt like and would
 * not stay aligned with a 10-pixel staff.
 */

import type { Note } from "../dsp/index.js";
import { midiToName, staffPosition, transposeMidi } from "../notes/format.js";

/** Half a staff space, in SVG units: the quantum of vertical position. */
const HALF = 5;
/** Bottom line (E4) to top line (F5) is eight half-spaces. */
const STAFF_HALVES = 8;
const STAFF_HEIGHT = STAFF_HALVES * HALF;

/** Horizontal room for the "treble" label. */
const MARGIN_LEFT = 34;
const MARGIN_RIGHT = 10;
/** Fixed spacing per note. Rhythm is not transcribed, so proportional spacing
 *  would be inventing information; even spacing says "these came in this
 *  order" and nothing more. */
const NOTE_SPACING = 30;

const HEAD_RX = 6.5;
const HEAD_RY = 4.7;
/** Real noteheads are tilted so that consecutive ones on adjacent lines and
 *  spaces do not merge into a vertical smear. */
const HEAD_ROTATION = -20;
const LEDGER_HALF_WIDTH = 9.5;

export interface StaffLayout {
  /** Noteheads per row at this width. */
  perRow: number;
  rows: number;
  /** Horizontal centre of each note, in SVG units. */
  xs: number[];
  /** Row index of each note. */
  rowOf: number[];
}

/**
 * Where each notehead goes horizontally, and how many rows that needs.
 *
 * Pure, and exported for tests: wrapping is the one part of the renderer with
 * an off-by-one worth guarding — a row that fits `n` notes must not start a new
 * row for the `n`th.
 */
export function staffLayout(count: number, width: number): StaffLayout {
  const usable = Math.max(NOTE_SPACING, width - MARGIN_LEFT - MARGIN_RIGHT);
  const perRow = Math.max(1, Math.floor(usable / NOTE_SPACING));
  const rows = Math.max(1, Math.ceil(count / perRow));

  const xs: number[] = [];
  const rowOf: number[] = [];
  for (let i = 0; i < count; i++) {
    const column = i % perRow;
    xs.push(MARGIN_LEFT + column * NOTE_SPACING + NOTE_SPACING / 2);
    rowOf.push(Math.floor(i / perRow));
  }
  return { perRow, rows, xs, rowOf };
}

/**
 * Draw `notes` into `element`, at the display octave `transpose`.
 *
 * Signature kept deliberately dull (`notes, element, transpose`) so a VexFlow
 * implementation could replace this file without touching anything else.
 */
export function renderStaff(
  notes: readonly Note[],
  element: HTMLElement,
  transpose: number,
  playingIndex: number | null = null,
): void {
  if (notes.length === 0) {
    element.innerHTML = "";
    element.hidden = true;
    return;
  }
  element.hidden = false;

  const width = Math.max(260, contentWidth(element) || 320);
  const layout = staffLayout(notes.length, width);
  const positions = notes.map((note) => staffPosition(transposeMidi(note.midi, transpose)));

  // Vertical room is derived from the actual content rather than assumed: at
  // transpose 0 a whistled melody sits far above the staff on a stack of ledger
  // lines, and the rows still have to stay clear of each other.
  let highest = STAFF_HALVES;
  let lowest = 0;
  for (const position of positions) {
    highest = Math.max(highest, position.offsetFromBottomLine);
    lowest = Math.min(lowest, position.offsetFromBottomLine);
  }
  const padAbove = (highest - STAFF_HALVES) * HALF + 16;
  const padBelow = -lowest * HALF + 16;
  /** All rows share one geometry, so the staves line up down the page. */
  const rowHeight = padAbove + STAFF_HEIGHT + padBelow + 14;
  const height = layout.rows * rowHeight;

  const parts: string[] = [];
  for (let row = 0; row < layout.rows; row++) {
    const bottomY = row * rowHeight + padAbove + STAFF_HEIGHT;
    for (let line = 0; line <= STAFF_HALVES; line += 2) {
      const y = bottomY - line * HALF;
      parts.push(
        `<line class="staff-line" x1="${MARGIN_LEFT - 6}" y1="${f(y)}" x2="${f(width - MARGIN_RIGHT)}" y2="${f(y)}"/>`,
      );
    }
    parts.push(
      `<text class="staff-clef" x="1" y="${f(bottomY - STAFF_HEIGHT / 2 + 3)}">treble</text>`,
    );
  }

  for (let i = 0; i < notes.length; i++) {
    const position = positions[i];
    const x = layout.xs[i];
    const bottomY = layout.rowOf[i] * rowHeight + padAbove + STAFF_HEIGHT;
    const y = bottomY - position.offsetFromBottomLine * HALF;
    const classes = `staff-note${i === playingIndex ? " is-playing" : ""}`;

    const glyphs: string[] = [];
    for (const offset of position.ledgerOffsets) {
      const ledgerY = bottomY - offset * HALF;
      glyphs.push(
        `<line class="staff-ledger" x1="${f(x - LEDGER_HALF_WIDTH)}" y1="${f(ledgerY)}" x2="${f(x + LEDGER_HALF_WIDTH)}" y2="${f(ledgerY)}"/>`,
      );
    }
    if (position.sharp) glyphs.push(sharpGlyph(x - 12, y));
    glyphs.push(
      `<ellipse class="staff-head" cx="${f(x)}" cy="${f(y)}" rx="${HEAD_RX}" ry="${HEAD_RY}" transform="rotate(${HEAD_ROTATION} ${f(x)} ${f(y)})"/>`,
    );
    glyphs.push(
      `<text class="staff-label" x="${f(x)}" y="${f(bottomY + padBelow)}">${midiToName(transposeMidi(notes[i].midi, transpose))}</text>`,
    );

    parts.push(`<g class="${classes}" data-i="${i}">${glyphs.join("")}</g>`);
  }

  element.innerHTML =
    `<svg class="staff-svg" viewBox="0 0 ${f(width)} ${f(height)}" width="100%" height="${f(height)}" ` +
    `preserveAspectRatio="xMinYMin meet" role="img" aria-label="Transcribed notes on a treble staff">` +
    parts.join("") +
    `</svg>`;
}

/**
 * The width the SVG actually gets, in CSS pixels.
 *
 * `clientWidth` includes the element's padding, and the container has some, so
 * measuring with it draws a viewBox a few pixels wider than the box the SVG is
 * scaled into — every staff comes out uniformly under-scaled with a sliver of
 * dead space on the right. Small, but it is the kind of error that compounds
 * with every layout tweak, so measure the content box.
 */
function contentWidth(element: HTMLElement): number {
  // Guarded the way `theme.ts` guards `matchMedia`: the layout tests render
  // this module against a plain object with no stylesheet behind it, and there
  // is no padding to subtract in that world.
  if (typeof getComputedStyle !== "function") return element.clientWidth;
  const styles = getComputedStyle(element);
  const padding = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  return Math.max(0, element.clientWidth - padding);
}

/** Move the playback highlight without rebuilding the SVG. */
export function highlightStaff(element: HTMLElement, index: number | null): void {
  for (const group of element.querySelectorAll<SVGGElement>(".staff-note")) {
    group.classList.toggle("is-playing", Number(group.dataset.i) === index);
  }
}

/**
 * A sharp, from four straight lines: two near-vertical strokes and two
 * horizontals slanted upwards. The slant is not decoration — it is what stops
 * the horizontals from disappearing into the staff lines they cross.
 */
function sharpGlyph(cx: number, cy: number): string {
  const lines = [
    [cx - 2.2, cy - 7, cx - 2.2, cy + 5.5],
    [cx + 2.2, cy - 5.5, cx + 2.2, cy + 7],
    [cx - 5, cy - 1.2, cx + 5, cy - 3.2],
    [cx - 5, cy + 3.8, cx + 5, cy + 1.8],
  ];
  return lines
    .map(
      ([x1, y1, x2, y2]) =>
        `<line class="staff-sharp" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`,
    )
    .join("");
}

/** Trim coordinates to one decimal; SVG strings get long fast. */
function f(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}
