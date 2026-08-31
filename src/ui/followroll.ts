/**
 * The follow-along roll: the whole melody at once, with a playhead crossing it
 * and your own pitch drawn behind the playhead as you whistle.
 *
 * ## Why a fixed roll and a moving line, rather than a scrolling one
 *
 * A scrolling roll — notes sliding toward a fixed now-line — is the arcade
 * convention and it reads beautifully at television width. At 360 CSS pixels it
 * has one fatal property: to show a note early enough to prepare for it, the
 * window has to be a couple of seconds wide, which means the *whole* screen is
 * two seconds of melody and there is nothing to anticipate beyond that. A
 * warm-up is exactly the case where you want to see the shape of the phrase
 * coming.
 *
 * So the melody is drawn once, whole, and a line moves across it. Every note is
 * visible from the first frame, the picture never moves under the eye, and the
 * only thing animating is a line and a trail — which is also, not incidentally,
 * the cheapest thing to redraw sixty times a second on a phone.
 *
 * The layout and the timing are `practice/follow.ts`'s; this file is the canvas,
 * the palette and the device-pixel arithmetic, exactly as `ui/diffroll.ts` is
 * for the diff overlay.
 */

import { midiToName, pitchClass } from "../dsp/index.js";
import type { FollowModel } from "../practice/follow.js";
import type { TrailPoint } from "../practice/recall.js";
import { roundRect } from "./pianoroll.js";
import { readPalette } from "./theme.js";

const PAD = { left: 26, right: 6, top: 8, bottom: 8 };

export interface FollowView {
  model: FollowModel;
  /** The live pitch so far. `NaN` pitches are pen-lifts — see
   *  `appendFollowPoint`. */
  trail: readonly TrailPoint[];
  /** Seconds since the melody started, or `null` before it has. */
  elapsedSec: number | null;
}

export function drawFollowRoll(canvas: HTMLCanvasElement, view: FollowView): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Sized in CSS pixels by the stylesheet; the backing store has to be sized in
  // device pixels or every line is a blurry smear on a phone. Unlike the diff
  // overlay this really is a hot path, so the size is only *written* when it
  // actually changed — assigning `canvas.width` at all clears the bitmap and
  // costs a reallocation.
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
  const rectHeight = Math.max(4, (plotHeight / semitones) * 0.9);

  // ── Octave gridlines, at true pitch ───────────────────────────────────
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
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
    ctx.fillText(midiToName(midi), plotLeft - 5, lineY);
    ctx.globalAlpha = 1;
  }

  // ── The melody ────────────────────────────────────────────────────────
  // Notes the playhead has passed are solid, notes still to come are dim. That
  // is the whole progress indicator: no bar, no percentage, and it works at a
  // glance while you are busy whistling.
  const elapsed = view.elapsedSec;
  for (const note of model.notes) {
    const left = x(note.startSec);
    const rectWidth = Math.max(3, x(note.endSec) - left);
    const top = y(note.midi) - rectHeight / 2;
    const passed = elapsed !== null && elapsed >= note.startSec;
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = passed ? 0.85 : 0.35;
    roundRect(ctx, left, top, rectWidth, rectHeight, Math.min(3, rectHeight / 2));
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ── Your own pitch ────────────────────────────────────────────────────
  ctx.strokeStyle = palette.text;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let penDown = false;
  for (const point of view.trail) {
    if (!Number.isFinite(point.midi)) {
      // A break: silence, or the moment before the microphone opened.
      penDown = false;
      continue;
    }
    const px = x(point.tSec);
    const py = y(point.midi);
    if (penDown) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    penDown = true;
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ── The playhead ──────────────────────────────────────────────────────
  if (elapsed !== null) {
    const px = x(Math.max(0, Math.min(spanSec, elapsed)));
    ctx.strokeStyle = palette.danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, plotTop);
    ctx.lineTo(px, plotTop + plotHeight);
    ctx.stroke();
  }
}
