/**
 * The piano roll: a pitch-versus-time plot, drawn on a canvas.
 *
 * It shows two things at once, and the overlap is the point. Underneath is the
 * **continuous pitch trail** — every analysis frame, exactly as measured, wobble
 * and scoops included. On top are the **quantised note rectangles** the
 * segmenter committed to. The trail is *why*, the rectangles are *what*, and
 * seeing them together turns "why on earth did it hear a D6 there?" from a
 * debugger session into a glance: either the trail really did jump, or the
 * segmentation drew a box where the trail did not go.
 */

import { hzToMidiFloat, midiToName, pitchClass, type Note, type PitchFrame } from "../dsp/index.js";
import { transposeMidi } from "../notes/format.js";
import { readPalette } from "./theme.js";

export interface MidiRange {
  min: number;
  max: number;
}

export interface RollView {
  frames: readonly PitchFrame[];
  notes: readonly Note[];
  /** Display octave shift; affects the gridline *labels* only — see below. */
  transpose: number;
  playingIndex: number | null;
  /** True while recording: the plot grows with the take and the vertical range
   *  is only ever widened, so held notes do not make the axis breathe. */
  live: boolean;
}

/** Frames below this are breath and room noise; drawing them would bury the
 *  melody in a grey haze. Display-only, like every threshold in the UI. */
const TRAIL_MIN_CLARITY = 0.5;

/** Break the trail when frames are further apart than this — a gap in time is
 *  a gap in the line, never an interpolation across silence. */
const TRAIL_BREAK_SEC = 0.06;

/** Semitones of headroom above and below the content. */
const RANGE_PADDING = 2;
/** Never zoom in tighter than an octave; a three-note melody would otherwise
 *  fill the plot with meaningless vertical drama. */
const MIN_RANGE_SEMITONES = 12;
/** Shortest timeline drawn, so the first second of a take is not stretched
 *  across the whole width. */
const MIN_SPAN_SEC = 4;

const PAD = { left: 26, right: 6, top: 8, bottom: 8 };

/** At most this many drawn points per CSS pixel of width. A minute of audio is
 *  ~5600 frames across ~350 px; stroking every one of them costs a lot and
 *  shows nothing a half-pixel step does not. */
const TRAIL_STEP_PX = 0.5;

/**
 * The vertical extent to draw, in **true** MIDI numbers.
 *
 * Pure and exported for tests: getting this wrong is how a piano roll ends up
 * either flat-lined or scrolling wildly, and neither is obvious from a static
 * screenshot.
 *
 * `previous` is unioned in rather than replaced so that a live plot can only
 * ever widen. During a take the range must not shrink back when the whistler
 * pauses, or the trail already drawn would silently mean something different
 * from the trail about to be drawn next to it.
 */
export function rollMidiRange(
  frames: readonly PitchFrame[],
  notes: readonly Note[],
  previous?: MidiRange | null,
): MidiRange {
  const extent = { min: Infinity, max: -Infinity };
  extendExtent(extent, frames, 0);
  for (const note of notes) {
    if (note.midi < extent.min) extent.min = note.midi;
    if (note.midi > extent.max) extent.max = note.midi;
  }
  return padExtent(extent, previous);
}

/** Widen `extent` by the frames from `from` onwards. Split out from
 *  {@link rollMidiRange} so the live path can scan only what is new. */
function extendExtent(extent: MidiRange, frames: readonly PitchFrame[], from: number): void {
  for (let i = from; i < frames.length; i++) {
    const frame = frames[i];
    if (frame.hz === null || frame.clarity < TRAIL_MIN_CLARITY) continue;
    const midi = hzToMidiFloat(frame.hz);
    if (!Number.isFinite(midi)) continue;
    if (midi < extent.min) extent.min = midi;
    if (midi > extent.max) extent.max = midi;
  }
}

/** Turn a raw extent into a drawable range: padded, at least an octave, and
 *  never narrower than `previous`. */
function padExtent(extent: MidiRange, previous?: MidiRange | null): MidiRange {
  let min = extent.min;
  let max = extent.max;

  if (min > max) {
    // Nothing to show yet. Centre on C6, where whistling actually lives, so an
    // empty plot and a full one have the same shape.
    min = 84 - MIN_RANGE_SEMITONES / 2;
    max = 84 + MIN_RANGE_SEMITONES / 2;
  }

  min = Math.floor(min) - RANGE_PADDING;
  max = Math.ceil(max) + RANGE_PADDING;

  const short = MIN_RANGE_SEMITONES - (max - min);
  if (short > 0) {
    min -= Math.floor(short / 2);
    max += Math.ceil(short / 2);
  }

  if (previous) {
    min = Math.min(min, previous.min);
    max = Math.max(max, previous.max);
  }
  return { min, max };
}

/*
 * Live-path caches. The animation loop redraws the whole plot sixty times a
 * second while the take grows to thousands of frames, so anything that scales
 * with the take's length has to be incremental: the vertical extent is
 * accumulated frame by frame instead of rescanned, and the element's size is
 * remembered instead of being read back out of the layout engine — a
 * `clientWidth` read inside the loop forces a synchronous layout every frame.
 */
let liveRange: MidiRange | null = null;
let liveExtent: MidiRange = { min: Infinity, max: -Infinity };
let liveScanned = 0;
let cachedSize: { width: number; height: number } | null = null;

/** Call when a new take starts, so the axis is not inherited from the last. */
export function resetRollRange(): void {
  liveRange = null;
  liveExtent = { min: Infinity, max: -Infinity };
  liveScanned = 0;
}

/** Drop the cached element size — call on resize or orientation change. */
export function invalidateRollSize(): void {
  cachedSize = null;
}

/** The canvas's CSS size, measured at most once per resize while live. */
function rollSize(canvas: HTMLCanvasElement, live: boolean): { width: number; height: number } {
  if (live && cachedSize && cachedSize.width > 0 && cachedSize.height > 0) return cachedSize;
  cachedSize = { width: canvas.clientWidth, height: canvas.clientHeight };
  return cachedSize;
}

/** Seconds of timeline to draw for these frames. */
export function rollSpanSec(frames: readonly PitchFrame[], live: boolean): number {
  const last = frames.length > 0 ? frames[frames.length - 1].tSec : 0;
  return live ? Math.max(MIN_SPAN_SEC, last) : Math.max(0.5, last);
}

export function drawPianoRoll(canvas: HTMLCanvasElement, view: RollView): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Device-pixel scaling. The canvas is sized in CSS pixels by the stylesheet;
  // its backing store has to be sized in device pixels or every line is a
  // blurry two-pixel smear on a phone.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const { width, height } = rollSize(canvas, view.live);
  if (width === 0 || height === 0) return;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const palette = readPalette(canvas);
  let range: MidiRange;
  if (view.live) {
    // The frame buffer is appended to and never rewritten, so only the tail is
    // new. (If it ever got shorter, the take restarted without a reset — start
    // the scan over rather than trust a stale extent.)
    if (view.frames.length < liveScanned) resetRollRange();
    extendExtent(liveExtent, view.frames, liveScanned);
    liveScanned = view.frames.length;
    // Notes are empty while live, but folding them into a copy rather than into
    // the accumulator keeps this correct if that ever changes.
    const extent = { ...liveExtent };
    for (const note of view.notes) {
      if (note.midi < extent.min) extent.min = note.midi;
      if (note.midi > extent.max) extent.max = note.midi;
    }
    liveRange = padExtent(extent, liveRange);
    range = liveRange;
  } else {
    range = rollMidiRange(view.frames, view.notes);
  }
  const spanSec = rollSpanSec(view.frames, view.live);

  const plotLeft = PAD.left;
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotTop = PAD.top;
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);
  const semitones = Math.max(1, range.max - range.min);

  const x = (tSec: number): number => plotLeft + (tSec / spanSec) * plotWidth;
  const y = (midi: number): number => plotTop + ((range.max - midi) / semitones) * plotHeight;
  /** Height of one semitone, i.e. how tall a note rectangle is. */
  const semitoneHeight = plotHeight / semitones;

  // ── Octave gridlines ──────────────────────────────────────────────────
  // Lines at every C, labelled with the *displayed* octave. Geometry stays in
  // true pitch throughout — transposition moves every note by the same amount,
  // so shifting the drawing as well would produce an identical picture. Only
  // the labels have to change, and a C stays a C under octave transposition,
  // so the label is always still correct for the line it sits on.
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let midi = Math.ceil(range.min); midi <= range.max; midi++) {
    if (pitchClass(midi) !== 0) continue;
    const lineY = y(midi);
    ctx.strokeStyle = palette.textDim;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(plotLeft, lineY);
    ctx.lineTo(plotLeft + plotWidth, lineY);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = palette.textDim;
    ctx.textAlign = "right";
    ctx.fillText(midiToName(transposeMidi(midi, view.transpose)), plotLeft - 5, lineY);
    ctx.globalAlpha = 1;
  }

  // ── The trail: every voiced frame, unquantised ────────────────────────
  ctx.strokeStyle = palette.text;
  ctx.globalAlpha = view.notes.length > 0 ? 0.45 : 0.85;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let penDown = false;
  /** Time of the previous voiced frame — the break test compares consecutive
   *  frames, not consecutive *drawn points*, so decimation cannot invent a
   *  gap that the audio does not have. */
  let previousT = -Infinity;
  let lastPx = -Infinity;
  for (const frame of view.frames) {
    if (frame.hz === null || frame.clarity < TRAIL_MIN_CLARITY) {
      penDown = false;
      continue;
    }
    const midi = hzToMidiFloat(frame.hz);
    if (!Number.isFinite(midi)) {
      penDown = false;
      continue;
    }
    const continues = penDown && frame.tSec - previousT <= TRAIL_BREAK_SEC;
    previousT = frame.tSec;
    const px = x(frame.tSec);
    // Decimation, but only *within* a continuous run: a break has to be drawn
    // wherever it falls, or a gap in time silently becomes a line across it.
    if (continues && px - lastPx < TRAIL_STEP_PX) continue;
    const py = y(midi);
    if (continues) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    penDown = true;
    lastPx = px;
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ── The notes: what the segmenter committed to ────────────────────────
  const rectHeight = Math.max(3, semitoneHeight * 0.9);
  ctx.textAlign = "left";
  for (let i = 0; i < view.notes.length; i++) {
    const note = view.notes[i];
    const left = x(note.startSec);
    const rectWidth = Math.max(2, x(note.endSec) - left);
    const top = y(note.midi) - rectHeight / 2;
    const current = i === view.playingIndex;

    ctx.fillStyle = current ? palette.accent : palette.accentDim;
    ctx.globalAlpha = current ? 1 : 0.75;
    roundRect(ctx, left, top, rectWidth, rectHeight, Math.min(3, rectHeight / 2));
    ctx.fill();
    ctx.globalAlpha = 1;

    if (rectWidth > 24 && rectHeight >= 11) {
      // Dark ink on the bright accent, light ink on the dimmed one: the two
      // fills have opposite lightness, so one text colour cannot serve both.
      ctx.fillStyle = current ? palette.bg : palette.text;
      ctx.fillText(midiToName(transposeMidi(note.midi, view.transpose)), left + 3, top + rectHeight / 2);
    }
  }
}

/** `CanvasRenderingContext2D.roundRect` is recent enough to still be missing
 *  on some Android WebViews, so the path is built by hand. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(left + r, top);
  ctx.arcTo(left + width, top, left + width, top + height, r);
  ctx.arcTo(left + width, top + height, left, top + height, r);
  ctx.arcTo(left, top + height, left, top, r);
  ctx.arcTo(left, top, left + width, top, r);
  ctx.closePath();
}
