import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { midiToHz, midiToName, type Note, type PitchFrame } from "../src/dsp/index.js";
import {
  drawPianoRoll,
  invalidateRollSize,
  resetRollRange,
  rollMidiRange,
  type MidiRange,
} from "../src/ui/pianoroll.js";

/**
 * The piano roll's hot path, checked through what it actually draws.
 *
 * The roll is redrawn sixty times a second while a take grows towards five and
 * a half thousand frames, so two things in it are incremental rather than
 * recomputed: the vertical range (accumulated frame by frame instead of
 * rescanned) and the trail (decimated to about two points per pixel). Both are
 * optimisations, and an optimisation that quietly changes the picture is a bug
 * — so these tests compare the drawing against the same drawing done in one
 * pass, and pin the property decimation must never break: a gap in time stays
 * a gap.
 */

interface Point {
  x: number;
  y: number;
}

interface Path {
  moves: Point[];
  lines: Point[];
}

/** Records the paths the renderer builds, which is the only output that
 *  matters here. Each `beginPath` starts a new one, so the trail can be told
 *  apart from the gridlines (two points each) and the note rectangles. */
class RecordingContext {
  readonly paths: Path[] = [];
  private current: Path = { moves: [], lines: [] };

  font = "";
  textBaseline = "";
  textAlign = "";
  strokeStyle = "";
  fillStyle = "";
  globalAlpha = 1;
  lineWidth = 1;
  lineJoin = "";

  setTransform(): void {}
  clearRect(): void {}
  stroke(): void {}
  fill(): void {}
  closePath(): void {}
  arcTo(): void {}
  fillText(): void {}

  beginPath(): void {
    this.current = { moves: [], lines: [] };
    this.paths.push(this.current);
  }

  moveTo(x: number, y: number): void {
    this.current.moves.push({ x, y });
  }

  lineTo(x: number, y: number): void {
    this.current.lines.push({ x, y });
  }

  /** The pitch trail: by far the longest path on the canvas. */
  get trail(): Path {
    const size = (path: Path): number => path.moves.length + path.lines.length;
    return this.paths.reduce((best, path) => (size(path) > size(best) ? path : best), {
      moves: [],
      lines: [],
    });
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  clientWidth = 350;
  clientHeight = 150;
  readonly context = new RecordingContext();
  getContext(): RecordingContext {
    return this.context;
  }
}

function draw(
  fake: FakeCanvas,
  frames: readonly PitchFrame[],
  live: boolean,
  view: { notes?: readonly Note[]; tuningOffsetCents?: number } = {},
): void {
  drawPianoRoll(fake as unknown as HTMLCanvasElement, {
    frames,
    notes: view.notes ?? [],
    transpose: -2,
    playingIndex: null,
    live,
    tuningOffsetCents: view.tuningOffsetCents,
  });
}

function frame(tSec: number, midi: number): PitchFrame {
  return {
    tSec,
    hz: midiToHz(midi),
    clarity: 0.9,
    snrDb: 20,
    peakToSecondDb: 12,
    bandRmsDb: -30,
    broadbandRmsDb: -30,
    clipped: false,
  };
}

/**
 * A minute of whistling at ~94 frames a second: a fast wobble over an octave,
 * with the last couple of seconds climbing out of it. The wobble covers its
 * whole range inside the first chunk and the climb widens it only at the very
 * end, which is what makes the incremental range comparable to a full rescan —
 * a live range is allowed to widen and never to shrink, so a take whose range
 * shrinks halfway through legitimately draws differently either way.
 */
function longTake(): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const total = 5600;
  for (let i = 0; i < total; i++) {
    const t = i / 93.75;
    const climb = Math.max(0, i - (total - 200)) / 30;
    frames.push(frame(t, 84 + 6 * Math.sin(t * 6) + climb));
  }
  return frames;
}

/** `seconds` of a perfectly steady whistle at `midi`, which may be fractional
 *  — a real whistler's "steady" is what the tuning offset is measured from. */
function steady(midi: number, seconds: number): PitchFrame[] {
  const frames: PitchFrame[] = [];
  for (let i = 0; i < seconds * 93.75; i++) frames.push(frame(i / 93.75, midi));
  return frames;
}

/**
 * Recover the roll's pitch→y mapping from the octave gridlines it drew.
 *
 * The renderer's padding is private, and hard-coding a copy of it here would
 * make this test fail for the wrong reason the first time it is tuned. The
 * gridlines are already on the canvas at known pitches — every C in range — so
 * two of them fix the (linear) mapping exactly.
 */
function gridlineMapping(fake: FakeCanvas, range: MidiRange): (midi: number) => number {
  const cs: number[] = [];
  for (let midi = Math.ceil(range.min); midi <= range.max; midi++) {
    if (midi % 12 === 0) cs.push(midi);
  }
  // A gridline is the only path with exactly one `moveTo` and one `lineTo`;
  // the trail has many of both and a note rectangle has no `lineTo` at all.
  const lines = fake.context.paths.filter(
    (path) => path.moves.length === 1 && path.lines.length === 1,
  );
  expect(lines).toHaveLength(cs.length);
  expect(cs.length).toBeGreaterThanOrEqual(2);

  const [lowMidi, highMidi] = [cs[0], cs[cs.length - 1]];
  const [lowY, highY] = [lines[0].moves[0].y, lines[lines.length - 1].moves[0].y];
  const pixelsPerSemitone = (lowY - highY) / (highMidi - lowMidi);
  return (midi) => lowY - (midi - lowMidi) * pixelsPerSemitone;
}

beforeEach(() => {
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  invalidateRollSize();
  resetRollRange();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the live trail", () => {
  it("draws the same picture frame by frame as it does in one pass", () => {
    const frames = longTake();

    // Grown the way a take actually grows: the animation loop redraws after
    // every handful of new frames, and the range accumulates across draws
    // instead of being rescanned from the beginning each time.
    const incremental = new FakeCanvas();
    for (let end = 200; end < frames.length; end += 200) {
      draw(incremental, frames.slice(0, end), true);
    }
    incremental.context.paths.length = 0;
    draw(incremental, frames, true);

    // The same final state, computed from scratch.
    resetRollRange();
    const oneShot = new FakeCanvas();
    draw(oneShot, frames, true);

    expect(incremental.context.trail).toEqual(oneShot.context.trail);
    expect(incremental.context.trail.lines.length).toBeGreaterThan(100);
  });

  it("costs a bounded number of points however long the take gets", () => {
    const fake = new FakeCanvas();
    draw(fake, longTake(), false);

    // 5600 frames across ~318 px of plot. At two points per pixel that is at
    // most ~640 of them; stroking all 5600 buys nothing a phone can see.
    const trail = fake.context.trail;
    const drawn = trail.moves.length + trail.lines.length;
    expect(drawn).toBeLessThanOrEqual(2 * fake.clientWidth);
    // ...but it is still a trail, not three line segments.
    expect(drawn).toBeGreaterThan(200);
  });

  it("keeps the raw trail while live, where no offset has been measured yet", () => {
    const frames = steady(84.4, 2);
    const raw = new FakeCanvas();
    draw(raw, frames, true);
    resetRollRange();
    const offered = new FakeCanvas();
    // Live draws never carry an offset (`main.ts` does not pass one), but the
    // rule is in the renderer rather than in its caller: while the take is
    // running there are no rectangles to agree with, and the live trail is the
    // raw measurement by definition.
    draw(offered, frames, true, { tuningOffsetCents: 40 });

    expect(offered.context.trail).toEqual(raw.context.trail);
  });

  it("never draws a line across a silence, however narrow it is on screen", () => {
    // Two runs of tone with a minute of nothing between them, so the gap is a
    // fraction of a pixel wide on the finished plot.
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 1000; i++) frames.push(frame(i / 93.75, 84));
    for (let i = 0; i < 1000; i++) frames.push(frame(70 + i / 93.75, 88));

    const fake = new FakeCanvas();
    draw(fake, frames, false);

    // One `moveTo` per run: decimation may drop points inside a run, but it
    // must never join two runs into a line that claims a note was held.
    expect(fake.context.trail.moves).toHaveLength(2);
  });
});

/**
 * A whistler who runs consistently sharp is the case the global tuning offset
 * exists for: the segmenter measures the bias, takes it out, and *then* rounds,
 * which is what stops a 40-cents-sharp take from becoming a coin flip between
 * two note names. The consequence for this view is that the rectangles are
 * drawn at corrected pitches while the trail is raw measurement — so unless the
 * trail is corrected too, the picture accuses the segmenter of boxing a pitch
 * the whistler never produced.
 */
describe("a take with a tuning offset", () => {
  /** 40 cents sharp all the way through: two seconds on each of two notes,
   *  with a breath between them so each starts its own run of trail. */
  const SHARP_CENTS = 40;
  const GAP_SEC = 0.5;
  const frames = [
    ...steady(72 + SHARP_CENTS / 100, 2),
    ...steady(84 + SHARP_CENTS / 100, 2).map((f) => ({ ...f, tSec: f.tSec + 2 + GAP_SEC })),
  ];
  const notes: Note[] = [72, 84].map((midi, i) => ({
    midi,
    noteName: midiToName(midi),
    centsOffset: 0,
    startSec: i * (2 + GAP_SEC),
    endSec: i * (2 + GAP_SEC) + 2,
    durationSec: 2,
    pitchHz: midiToHz(midi + SHARP_CENTS / 100),
    confidence: 0.9,
    gapBeforeSec: i === 0 ? 0 : GAP_SEC,
    flags: {},
  }));

  it("draws the trail on the notes the segmenter committed to", () => {
    const fake = new FakeCanvas();
    draw(fake, frames, false, { notes, tuningOffsetCents: SHARP_CENTS });

    const range = rollMidiRange(frames, notes, null, SHARP_CENTS / 100);
    const y = gridlineMapping(fake, range);
    const trail = fake.context.trail;

    // The first point of each run is a `moveTo`; both should sit exactly on
    // the pitch of the rectangle underneath them, not 0.4 semitones above it.
    expect(trail.moves).toHaveLength(2);
    expect(trail.moves[0].y).toBeCloseTo(y(72), 6);
    expect(trail.moves[1].y).toBeCloseTo(y(84), 6);
  });

  it("would otherwise float a fixed fraction of a semitone above them", () => {
    // The bug this pins, drawn on purpose: without the correction the trail is
    // exactly the offset away from every rectangle it is meant to explain —
    // visible, consistent, and easy to misread as a segmentation error.
    const fake = new FakeCanvas();
    draw(fake, frames, false, { notes });

    const range = rollMidiRange(frames, notes);
    const y = gridlineMapping(fake, range);
    const semitone = y(0) - y(1);
    expect(fake.context.trail.moves[0].y).toBeCloseTo(
      y(72) - (SHARP_CENTS / 100) * semitone,
      6,
    );
  });
});
