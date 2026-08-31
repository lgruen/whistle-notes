/**
 * The diff overlay: what you whistled, drawn on top of what you were asked for.
 *
 * A piano roll in the user's own register, with three layers and one claim.
 *
 * 1. **Ghost outlines** — the target, one per slot, drawn where the user
 *    *should* have whistled given the register they chose (see the register note
 *    in `practice/recall.ts`). Outlines rather than fills, because they are the
 *    thing that did not happen.
 * 2. **The trail** — the continuous pitch measurement, exactly as the
 *    transcriber's own roll draws it. This is the layer that turns "that note
 *    was 45 cents flat" into something a person can act on: a scoop that never
 *    arrived reads differently from a steady note in the wrong place, and they
 *    want different practice.
 * 3. **The notes** — filled rectangles at the pitches the segmenter committed
 *    to, coloured by verdict, sitting inside their ghosts when they were right
 *    and visibly away from them when they were not.
 *
 * The claim is the vertical distance between 1 and 3: *at that moment, you were
 * here, and the melody wanted you there.* Everything else on the picture is in
 * service of making that distance readable — which is why the horizontal axis is
 * the attempt's own clock and why a ghost borrows the span of the note that
 * answered it.
 *
 * The layout is all in `practice/recall.ts` and is pure; this file is the
 * canvas, the palette and the device-pixel arithmetic.
 */

import { hzToMidiFloat, midiToName, pitchClass, type PitchFrame } from "../dsp/index.js";
import type { Outcome, OverlayItem, OverlayModel, TrailPoint } from "../practice/recall.js";
import { roundRect } from "./pianoroll.js";
import { readPalette, type Palette } from "./theme.js";

/** Same gate the transcriber's roll uses: below this a frame is breath and room
 *  noise, and drawing it would bury the melody in a grey haze. */
const TRAIL_MIN_CLARITY = 0.5;
/** A gap in time is a gap in the line, never an interpolation across silence. */
const TRAIL_BREAK_SEC = 0.06;

const PAD = { left: 26, right: 6, top: 8, bottom: 8 };

/**
 * The measured pitch trail, in the same reference the notes are drawn in.
 *
 * The segmenter takes each take's global tuning bias out *before* rounding to
 * note names, so a trail drawn from raw Hz sits up to half a semitone away from
 * the very rectangles it is supposed to explain. Subtracting the same offset is
 * what puts both on one reference — the identical correction
 * `ui/pianoroll.ts` applies, and for the identical reason.
 */
export function trailFromFrames(
  frames: readonly PitchFrame[],
  tuningOffsetCents = 0,
): TrailPoint[] {
  const shift = tuningOffsetCents / 100;
  const out: TrailPoint[] = [];
  for (const frame of frames) {
    if (frame.hz === null || frame.clarity < TRAIL_MIN_CLARITY) continue;
    const midi = hzToMidiFloat(frame.hz) - shift;
    if (Number.isFinite(midi)) out.push({ tSec: frame.tSec, midi });
  }
  return out;
}

export interface DiffView {
  model: OverlayModel;
  trail: readonly TrailPoint[];
  /** {@link OverlayItem.index} of the item a tapped chip is asking about, or
   *  `null`. Everything else dims around it. */
  highlight: number | null;
}

/** Verdict → colour, from the stylesheet's own custom properties so the two
 *  themes stay one palette rather than two. */
function outcomeColour(outcome: Outcome, palette: Palette): string {
  switch (outcome) {
    case "clean":
      return palette.accent;
    case "off":
      return palette.warn;
    case "wrong":
      return palette.danger;
    case "extra":
      return palette.warn;
    default:
      return palette.textDim;
  }
}

export function drawDiffOverlay(canvas: HTMLCanvasElement, view: DiffView): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Sized in CSS pixels by the stylesheet; the backing store has to be sized in
  // device pixels or every line is a blurry two-pixel smear on a phone. Read
  // fresh each time rather than cached: this is a cold path — drawn once per
  // result and once per tapped chip — so there is no layout thrash to avoid,
  // and no cache to go stale behind a rotation.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const palette = readPalette(canvas);
  const { model } = view;

  const plotLeft = PAD.left;
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotTop = PAD.top;
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);
  const semitones = Math.max(1, model.maxMidi - model.minMidi);
  const spanSec = Math.max(0.5, model.spanSec);

  const x = (tSec: number): number => plotLeft + (tSec / spanSec) * plotWidth;
  const y = (midi: number): number =>
    plotTop + ((model.maxMidi - midi) / semitones) * plotHeight;
  const semitoneHeight = plotHeight / semitones;
  const rectHeight = Math.max(4, semitoneHeight * 0.9);

  // ── Octave gridlines ──────────────────────────────────────────────────
  // Labelled at true pitch: practice mode has no octave toggle, because there
  // is no transcript for one to be about — what is drawn here is what was
  // whistled, in the register it was whistled in.
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let midi = Math.ceil(model.minMidi); midi <= model.maxMidi; midi++) {
    if (pitchClass(midi) !== 0) continue;
    const lineY = y(midi);
    ctx.strokeStyle = palette.textDim;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, lineY);
    ctx.lineTo(plotLeft + plotWidth, lineY);
    ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = palette.textDim;
    ctx.textAlign = "right";
    ctx.fillText(midiToName(midi), plotLeft - 5, lineY);
    ctx.globalAlpha = 1;
  }

  const dimmed = (item: OverlayItem): boolean =>
    view.highlight !== null && view.highlight !== item.index;

  // ── The ghosts: where the melody wanted a note ────────────────────────
  for (const item of model.items) {
    if (item.targetMidi === null) continue;
    const left = x(item.startSec);
    const rectWidth = Math.max(3, x(item.endSec) - left);
    const top = y(item.targetMidi) - rectHeight / 2;
    // A slot nobody sang is the one ghost with nothing drawn inside it, so it
    // is the one that has to carry its own colour.
    const missing = item.outcome === "missing";
    ctx.strokeStyle = missing ? palette.danger : palette.textDim;
    ctx.globalAlpha = dimmed(item) ? 0.2 : missing ? 0.9 : 0.55;
    ctx.lineWidth = missing ? 2 : 1.5;
    roundRect(ctx, left, top, rectWidth, rectHeight, Math.min(3, rectHeight / 2));
    ctx.stroke();

    if (missing) {
      // The marker: a slash through the empty box. It survives being three
      // pixels wide, which is what a missed note between two sung ones is.
      ctx.beginPath();
      ctx.moveTo(left, top + rectHeight);
      ctx.lineTo(left + rectWidth, top);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ── The trail: every voiced frame, unquantised ────────────────────────
  ctx.strokeStyle = palette.text;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let penDown = false;
  let previousT = -Infinity;
  for (const point of view.trail) {
    const continues = penDown && point.tSec - previousT <= TRAIL_BREAK_SEC;
    previousT = point.tSec;
    const px = x(point.tSec);
    const py = y(point.midi);
    if (continues) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    penDown = true;
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ── The notes: what actually came out ─────────────────────────────────
  ctx.textAlign = "left";
  for (const item of model.items) {
    if (item.heardMidi === null) continue;
    const left = x(item.startSec);
    const rectWidth = Math.max(3, x(item.endSec) - left);
    const top = y(item.heardMidi) - rectHeight / 2;
    const colour = outcomeColour(item.outcome, palette);

    ctx.fillStyle = colour;
    ctx.globalAlpha = dimmed(item) ? 0.25 : 0.9;
    roundRect(ctx, left, top, rectWidth, rectHeight, Math.min(3, rectHeight / 2));
    ctx.fill();

    // An extra note has no ghost to be measured against, so it says so with a
    // mark of its own rather than by being a colour the reader has to recall.
    if (item.outcome === "extra" && rectWidth > 10) {
      ctx.strokeStyle = palette.bg;
      ctx.lineWidth = 2;
      const cx = left + rectWidth / 2;
      const cy = top + rectHeight / 2;
      const arm = Math.min(rectWidth, rectHeight) * 0.25;
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy);
      ctx.lineTo(cx + arm, cy);
      ctx.moveTo(cx, cy - arm);
      ctx.lineTo(cx, cy + arm);
      ctx.stroke();
    } else if (rectWidth > 24 && rectHeight >= 11) {
      // The app names what you did, never what it wanted — see the ear-first
      // note in `practice/recall.ts`. So the label goes on the note that came
      // out, and the ghost above or below it stays a position.
      ctx.fillStyle = palette.bg;
      ctx.fillText(midiToName(Math.round(item.heardMidi)), left + 3, top + rectHeight / 2);
    }
    ctx.globalAlpha = 1;
  }

  // ── The highlight: a tapped chip's slot, framed ───────────────────────
  const focus =
    view.highlight === null
      ? null
      : model.items.find((item) => item.index === view.highlight) ?? null;
  if (focus) {
    const left = x(focus.startSec);
    const rectWidth = Math.max(3, x(focus.endSec) - left);
    const pitches = [focus.targetMidi, focus.heardMidi].filter(
      (midi): midi is number => midi !== null,
    );
    const top = Math.min(...pitches.map((midi) => y(midi))) - rectHeight / 2 - 3;
    const bottom = Math.max(...pitches.map((midi) => y(midi))) + rectHeight / 2 + 3;
    ctx.strokeStyle = palette.text;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    roundRect(ctx, left - 3, top, rectWidth + 6, bottom - top, 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
