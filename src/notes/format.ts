/**
 * Music-theory helpers for *display*.
 *
 * The pitch maths itself lives in `src/dsp/tuning.ts`, because segmentation
 * needs it to fill in `Note.midi` / `Note.noteName` and the DSP island may not
 * import from here. This module re-exports it so the UI has one place to look,
 * and adds the two things that are display-only by definition: octave
 * transposition and staff geometry.
 *
 * Transposition is deliberately *not* part of the pipeline. `Note.midi` is
 * always the true sounding pitch; the octave toggle changes what is drawn and
 * played, never what was heard. Keeping that boundary sharp is what stops a UI
 * preference from silently corrupting a transcription.
 */

export {
  NOTE_NAMES,
  a4FromOffsetCents,
  centsOffset,
  hzToMidiFloat,
  midiOctave,
  midiToHz,
  midiToName,
  nearestNote,
  pitchClass,
  type NearestNote,
} from "../dsp/tuning.js";

import { midiOctave, pitchClass } from "../dsp/tuning.js";

/**
 * Pitch class → diatonic step within the octave (C=0, D=1, … B=6).
 *
 * This is the table that makes a staff work. A staff is a *diatonic* grid: it
 * has seven positions per octave, not twelve, so C and C♯ share a line and are
 * told apart by an accidental rather than by height. Everything about vertical
 * placement follows from mapping the twelve pitch classes onto those seven
 * steps.
 */
export const PC_TO_STEP: readonly number[] = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

/** Whether a pitch class needs a sharp drawn in front of it. */
export const IS_SHARP: readonly boolean[] = [
  false, true, false, true, false, false, true, false, true, false, true, false,
];

/**
 * Absolute diatonic step number, counting seven per octave from C-1 = 0.
 *
 * Consecutive steps are one staff position apart — a line to the space above
 * it — so the difference between two steps is directly a distance on the
 * staff, in half-spaces.
 */
export function staffStep(midi: number): number {
  return 7 * midiOctave(midi) + PC_TO_STEP[pitchClass(midi)];
}

/** E4: the bottom line of the treble staff, and this renderer's origin. */
export const TREBLE_BOTTOM_STEP = 30;

/** B4: the middle line, used as the target when auto-choosing an octave. */
export const TREBLE_MIDDLE_STEP = 34;

/** F5: the top line. Offsets 0..8 are on the staff; beyond needs ledgers. */
export const TREBLE_TOP_STEP = 38;

export interface StaffPosition {
  /** Absolute diatonic step; see {@link staffStep}. */
  step: number;
  /** Half-spaces above the bottom line (E4). 0 = bottom line, 8 = top line,
   *  odd values are spaces, negative values are below the staff. */
  offsetFromBottomLine: number;
  /** Draw a sharp before this notehead. */
  sharp: boolean;
  /** Ledger lines needed, as offsets from the bottom line. Always even —
   *  ledger lines only ever appear where a *line* would be — and empty for
   *  anything sitting on the staff. */
  ledgerOffsets: number[];
}

/** Where a MIDI note sits on a treble staff, and what it needs drawn around it. */
export function staffPosition(midi: number): StaffPosition {
  const step = staffStep(midi);
  const offset = step - TREBLE_BOTTOM_STEP;

  const ledgerOffsets: number[] = [];
  // Ledger lines continue the staff's every-other-step line pattern outward,
  // so they land on even offsets only. A note in the space above the top line
  // (offset 9) gets no ledger; the line above it (offset 10) gets one.
  for (let o = -2; o >= offset; o -= 2) ledgerOffsets.push(o);
  for (let o = 10; o <= offset; o += 2) ledgerOffsets.push(o);

  return {
    step,
    offsetFromBottomLine: offset,
    sharp: IS_SHARP[pitchClass(midi)],
    ledgerOffsets,
  };
}

/** Shift a MIDI note by whole octaves, for display and playback only. */
export function transposeMidi(midi: number, octaveShift: number): number {
  return midi + 12 * octaveShift;
}

/** The octave shifts the UI toggle offers. Whistling sits far above the
 *  treble staff, so the useful direction is always downward. */
export const OCTAVE_SHIFTS: readonly number[] = [0, -1, -2];

/**
 * Pick the octave shift that lands the melody most centrally on the treble
 * staff — i.e. the one a beginner can actually read without counting ledger
 * lines. Uses the median so a single outlying note cannot drag the choice.
 * Ties go to the smallest shift.
 */
export function suggestOctaveShift(
  midis: readonly number[],
  shifts: readonly number[] = OCTAVE_SHIFTS,
): number {
  if (midis.length === 0) return 0;

  const steps = midis.map(staffStep).sort((a, b) => a - b);
  const mid = steps.length >> 1;
  const medianStep =
    steps.length % 2 === 1 ? steps[mid] : (steps[mid - 1] + steps[mid]) / 2;

  let best = shifts[0] ?? 0;
  let bestDistance = Infinity;
  for (const shift of shifts) {
    // Shifting by an octave moves exactly 7 diatonic steps, so this needs no
    // re-derivation through MIDI.
    const distance = Math.abs(medianStep + 7 * shift - TREBLE_MIDDLE_STEP);
    if (distance < bestDistance - 1e-9 ||
        (Math.abs(distance - bestDistance) <= 1e-9 && Math.abs(shift) < Math.abs(best))) {
      best = shift;
      bestDistance = distance;
    }
  }
  return best;
}

/** Signed cents, formatted the way the UI shows them: `"+12"`, `"-7"`, `"0"`. */
export function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}
