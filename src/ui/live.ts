/**
 * The live readout: one huge note name, a cents bar, a level meter and a hint.
 *
 * This is the hot path. Everything here is called from a `requestAnimationFrame`
 * loop while the microphone is open, so it writes straight into text nodes and
 * two CSS custom properties and never goes near the store (see the hot/cold
 * note in `state.ts`). The bar and meter move by `transform` only — no width or
 * `left` animation, so a frame costs a style recalc and no layout.
 *
 * The strings written here are also cached: `textContent = x` when the text is
 * already `x` still dirties the node in some engines, and a note name changes
 * maybe twice a second while the loop runs sixty times.
 */

import type { LiveStatus } from "../audio/capture.js";
import { midiToName, nearestNote, transposeMidi } from "../notes/format.js";

export interface LiveElements {
  /** The 56–72 px note name. */
  note: HTMLElement;
  /** Full-width sled whose centred line is the needle. */
  needle: HTMLElement;
  /** Meter fill, scaled horizontally. */
  level: HTMLElement;
  /** One line of advice: too loud, no signal, mic warnings. */
  hint: HTMLElement;
  /** `0:07 / 1:00`. */
  time: HTMLElement;
}

export interface LiveView {
  /** Hot: called once per animation frame while recording. */
  tick(status: LiveStatus, transpose: number, maxSec: number): void;
  /** Cold: put a fixed string on the readout (idle, analysing, result). */
  show(note: string, hint: string): void;
}

/** Placeholder when nothing tonal is coming in. An em dash, not "—" spelled
 *  out, so the readout never changes width between silence and a note. */
const NO_NOTE = "—";

/** Below this the meter's own noise is all you would be watching. */
const LEVEL_FLOOR_DB = -70;
const LEVEL_CEILING_DB = -6;

/** How long a note name lingers after the whistle stops, in frame time. */
const HOLD_SEC = 0.25;

export function createLiveView(elements: LiveElements): LiveView {
  let lastNote = "";
  let lastHint = "";
  let lastTime = "";

  function setNote(text: string): void {
    if (text === lastNote) return;
    lastNote = text;
    elements.note.textContent = text;
  }

  function setHint(text: string): void {
    if (text === lastHint) return;
    lastHint = text;
    elements.hint.textContent = text;
  }

  function setTime(text: string): void {
    if (text === lastTime) return;
    lastTime = text;
    elements.time.textContent = text;
  }

  return {
    tick(status, transpose, maxSec) {
      const now = status.frame?.tSec ?? 0;
      const voiced = status.voiced;
      const fresh = voiced !== null && now - voiced.tSec <= HOLD_SEC;

      if (fresh && voiced.hz !== null) {
        const { midi, centsOffset } = nearestNote(voiced.hz);
        setNote(midiToName(transposeMidi(midi, transpose)));
        // The bar is centred on that nearest note and spans ±50 cents, so a
        // cent offset maps one-for-one onto a percentage of the bar's width.
        elements.needle.style.setProperty("--cents", centsOffset.toFixed(1));
        elements.needle.style.setProperty("--needle-opacity", "1");
      } else {
        setNote(NO_NOTE);
        elements.needle.style.setProperty("--needle-opacity", "0.25");
      }

      const db = status.frame?.bandRmsDb ?? LEVEL_FLOOR_DB;
      const level = (db - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB);
      elements.level.style.setProperty("--level", clamp01(level).toFixed(3));

      setHint(
        status.clipped
          ? "Too loud — move back a little."
          : fresh
            ? "Listening…"
            : "Whistle a steady note.",
      );
      setTime(`${formatClock(status.elapsedSec)} / ${formatClock(maxSec)}`);
    },

    show(note, hint) {
      setNote(note);
      setHint(hint);
      setTime("");
      elements.needle.style.setProperty("--cents", "0");
      elements.needle.style.setProperty("--needle-opacity", "0.25");
      elements.level.style.setProperty("--level", "0");
    },
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** `m:ss`. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
