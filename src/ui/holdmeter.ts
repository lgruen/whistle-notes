/**
 * The hold drill's live needle: how far off the note you are holding is, right
 * now, in cents.
 *
 * The transcriber's readout answers "which note is this?" and centres its bar on
 * whichever semitone happens to be nearest — which is exactly the wrong
 * behaviour here. A whistler holding 60 cents flat would see the bar snap to the
 * note *below* and sit proudly at +40, reporting good aim at the wrong target.
 * So this bar is centred on the **reference the drill played**, and the number
 * on it is signed distance from that one note, however far away the user drifts.
 *
 * Hot path, by the same rules as `ui/live.ts`: called from a `requestAnimation
 * Frame` loop with the microphone open, writing straight into two text nodes and
 * two custom properties, never through a store, and caching its strings because
 * a note name changes twice a second while the loop runs sixty times.
 */

import { hzToMidiFloat } from "../dsp/index.js";
import type { LiveStatus } from "../audio/capture.js";
import { formatCents } from "../notes/format.js";

export interface HoldMeterElements {
  /** The big signed readout: `+12¢`. */
  cents: HTMLElement;
  /** Full-width sled whose centred line is the needle. */
  needle: HTMLElement;
  /** One line: what to do, or what is wrong. */
  hint: HTMLElement;
}

export interface HoldMeter {
  /** Hot: once per animation frame while the hold take is running. */
  tick(status: LiveStatus, referenceMidi: number): void;
  /** Cold: park it, between takes. */
  reset(): void;
}

/**
 * How much of the bar a cent is worth.
 *
 * ±100 cents end to end rather than the transcriber's ±50. A beginner's first
 * holds land 40–80 cents out, and a bar that pins at 50 would show them a needle
 * jammed against the wall that never moves as they improve — the feedback
 * disappears exactly where it is needed. A whole semitone each way keeps the
 * whole approach visible, and past that the arrows below take over.
 */
export const HOLD_NEEDLE_CENTS = 100;

/** Past this the needle is pinned and the number stops being the point. */
const READOUT_LIMIT_CENTS = 200;

/** No note. An em dash, so the readout never changes width. */
const NO_PITCH = "—";

/**
 * The needle's position as a percentage of the bar, clamped.
 *
 * Half the width each way, matching the transcriber's `--cents` convention so
 * both bars can share one stylesheet rule shape.
 */
export function needleOffsetPercent(cents: number, range = HOLD_NEEDLE_CENTS): number {
  const fraction = Math.max(-1, Math.min(1, cents / range));
  return fraction * 50;
}

/**
 * The number on the readout.
 *
 * An arrow rather than a four-digit number once the user is a whole tone away:
 * "+1204¢" is a true statement that helps nobody, and the situation it describes
 * — the wrong note entirely, usually the wrong register — is one the ear fixes
 * by moving, not by reading. Pure and exported so the boundary is a test rather
 * than a judgement call.
 */
export function holdReadoutText(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return NO_PITCH;
  if (cents >= READOUT_LIMIT_CENTS) return "↑";
  if (cents <= -READOUT_LIMIT_CENTS) return "↓";
  return `${formatCents(cents)}¢`;
}

/** How long a reading lingers after the whistle stops, in frame time. The same
 *  quarter-second `ui/live.ts` uses, so the two readouts feel alike. */
const HOLD_SEC = 0.25;

export function createHoldMeter(elements: HoldMeterElements): HoldMeter {
  let lastCents = "";
  let lastHint = "";

  const setCents = (text: string): void => {
    if (text === lastCents) return;
    lastCents = text;
    elements.cents.textContent = text;
  };
  const setHint = (text: string): void => {
    if (text === lastHint) return;
    lastHint = text;
    elements.hint.textContent = text;
  };
  const setNeedle = (percent: number, opacity: number): void => {
    elements.needle.style.setProperty("--cents", percent.toFixed(1));
    elements.needle.style.setProperty("--needle-opacity", String(opacity));
  };

  return {
    tick(status, referenceMidi) {
      const now = status.frame?.tSec ?? 0;
      const voiced = status.voiced;
      const fresh = voiced !== null && now - voiced.tSec <= HOLD_SEC;
      const cents =
        fresh && voiced.hz !== null
          ? (hzToMidiFloat(voiced.hz) - referenceMidi) * 100
          : null;

      setCents(holdReadoutText(cents));
      setNeedle(cents === null ? 0 : needleOffsetPercent(cents), cents === null ? 0.25 : 1);
      setHint(
        status.clipped
          ? "Too loud — move back a little."
          : cents === null
            ? "Whistle it, and hold."
            : "Hold it there…",
      );
    },

    reset() {
      setCents(NO_PITCH);
      setNeedle(0, 0.25);
      setHint("");
    },
  };
}
