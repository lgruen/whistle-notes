/**
 * The debug panel: what the device is actually doing, one tap away.
 *
 * Most of this app can be verified from a laptop. The parts that cannot are all
 * *platform* behaviour — whether the browser honoured the raw-signal
 * constraints, what sample rate it decided on, whether the numbers behind the
 * live readout look anything like a whistle — and those are exactly the things
 * that fail on a phone, silently, in a way that looks like the algorithm being
 * wrong. Guessing across a USB cable is slow; reading the values off the screen
 * is not.
 *
 * Collapsed by default and built out of a `<details>`, so it costs nothing:
 * no layout, no paint, and no DOM writes at all while it is shut — the hot
 * `tick` returns immediately unless the panel is open.
 */

import { getCaptureInfo, type LiveStatus } from "../audio/capture.js";
import { formatCents } from "../notes/format.js";
import type { AppState } from "./state.js";

export interface DebugElements {
  /** The `<details>` itself, read for its `open` state. */
  panel: HTMLDetailsElement;
  /** Sample rate and the granted microphone settings. */
  audio: HTMLElement;
  /** Newest frame's clarity/SNR, while recording. */
  live: HTMLElement;
  /** What the last transcription concluded about tuning. */
  result: HTMLElement;
  /** Build stamp — the same one in the footer, repeated here so a screenshot
   *  of this panel is self-contained. */
  build: HTMLElement;
}

export interface DebugView {
  /** Cold: called on every state change. */
  render(state: AppState): void;
  /** Hot: called once per animation frame while recording. */
  tick(status: LiveStatus): void;
}

/** Refresh interval for the live line, in seconds of frame time. Sixty
 *  updates a second of two-decimal numbers is unreadable *and* wasteful; ten
 *  is plenty to see a metric move. */
const LIVE_INTERVAL_SEC = 0.1;

/**
 * The three constraints that decide whether a whistle survives the microphone.
 *
 * Noise suppression is the dangerous one — a speech model treats a sustained
 * pure tone as stationary noise and gates it out — but all three are reported,
 * because "off" here is the evidence that the signal problem is somewhere else.
 */
export function describeProcessing(settings: MediaTrackSettings | null): string {
  if (!settings) return "not recorded yet";
  // Not just `boolean`: echo cancellation grew string modes ("all",
  // "remote-only") in a later revision of the spec, and a device that answers
  // with one of those is exactly the kind of thing this panel exists to show.
  const flag = (label: string, value: boolean | string | undefined): string =>
    `${label} ${value === undefined ? "?" : value === false ? "off" : value === true ? "ON" : value}`;
  return [
    flag("NS", settings.noiseSuppression),
    flag("AEC", settings.echoCancellation),
    flag("AGC", settings.autoGainControl),
  ].join(" · ");
}

export function createDebugView(elements: DebugElements): DebugView {
  let lastLiveSec = -Infinity;
  let lastLive = "";

  elements.build.textContent = __BUILD__;

  function setLive(text: string): void {
    if (text === lastLive) return;
    lastLive = text;
    elements.live.textContent = text;
  }

  return {
    render(state) {
      const { sampleRate, settings } = getCaptureInfo();
      elements.audio.textContent =
        `${sampleRate === null ? "—" : `${sampleRate} Hz`} · ${describeProcessing(settings)}`;

      elements.result.textContent =
        state.phase === "result"
          ? `${state.notes.length} notes · tuning ${formatCents(state.tuningOffsetCents)} cents`
          : "—";

      // Leaving a stale live line under a finished result would invite reading
      // it as part of that result.
      if (state.phase !== "recording") {
        lastLiveSec = -Infinity;
        setLive("—");
      }
    },

    tick(status) {
      // Shut means genuinely free: no `textContent` writes, no string building.
      if (!elements.panel.open) return;
      const frame = status.frame;
      if (!frame || frame.tSec - lastLiveSec < LIVE_INTERVAL_SEC) return;
      lastLiveSec = frame.tSec;
      setLive(
        `clarity ${frame.clarity.toFixed(2)} · snr ${frame.snrDb.toFixed(1)} dB · ` +
          `p2s ${frame.peakToSecondDb.toFixed(1)} dB · ${frame.bandRmsDb.toFixed(1)} dBFS` +
          (frame.clipped ? " · CLIPPED" : ""),
      );
    },
  };
}
