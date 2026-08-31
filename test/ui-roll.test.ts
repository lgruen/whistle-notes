import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { midiToHz, type PitchFrame } from "../src/dsp/index.js";
import { drawPianoRoll, invalidateRollSize, resetRollRange } from "../src/ui/pianoroll.js";

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

function draw(fake: FakeCanvas, frames: readonly PitchFrame[], live: boolean): void {
  drawPianoRoll(fake as unknown as HTMLCanvasElement, {
    frames,
    notes: [],
    transpose: -2,
    playingIndex: null,
    live,
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
