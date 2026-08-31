/**
 * Hz ↔ MIDI ↔ cents. The pipeline needs this to fill in `Note.midi` and
 * `Note.noteName`, so it lives inside the pure `src/dsp` island rather than in
 * `src/notes` — the dependency may only point that way.
 *
 * `src/notes/format.ts` re-exports everything here and adds the display-only
 * concerns (octave transposition, staff geometry) on top, so there is exactly
 * one implementation of the pitch maths in the repository.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

/** Sharps only. Whistled melodies carry no key signature to spell against, so
 *  inventing enharmonic flats would be guessing at information we don't have. */
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Pitch class 0..11, correct for negative MIDI numbers too. */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Scientific-pitch octave number: MIDI 60 is C4, so MIDI 0 is C-1. */
export function midiOctave(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** Scientific pitch name, e.g. 60 → `"C4"`, 90 → `"F#6"`. Rounds first. */
export function midiToName(midi: number): string {
  return `${NOTE_NAMES[pitchClass(midi)]}${midiOctave(midi)}`;
}

/**
 * Frequency to a **fractional** MIDI number.
 *
 * Fractional is the whole point: a semitone is a factor of 2^(1/12), so pitch
 * is logarithmic in frequency, and working in this domain turns "how far apart
 * are these two pitches, musically?" into plain subtraction at any register.
 * The pipeline never rounds until the very last step — rounding early throws
 * away exactly the evidence that decides borderline notes.
 *
 * Returns NaN for non-positive `hz`.
 */
export function hzToMidiFloat(hz: number, a4Hz = 440): number {
  return 69 + 12 * Math.log2(hz / a4Hz);
}

/** Inverse of {@link hzToMidiFloat}; accepts fractional MIDI numbers. */
export function midiToHz(midi: number, a4Hz = 440): number {
  return a4Hz * Math.pow(2, (midi - 69) / 12);
}

/** How far `hz` sits from the given MIDI note, in cents (100 per semitone). */
export function centsOffset(hz: number, midi: number, a4Hz = 440): number {
  return 100 * (hzToMidiFloat(hz, a4Hz) - midi);
}

/** A frequency snapped to the nearest semitone, with the residual kept. */
export interface NearestNote {
  /** Integer MIDI number. */
  midi: number;
  /** Residual in cents, in [-50, +50) — ties round upward. */
  centsOffset: number;
}

/** Snap a frequency to the nearest semitone without discarding the residual. */
export function nearestNote(hz: number, a4Hz = 440): NearestNote {
  const midiFloat = hzToMidiFloat(hz, a4Hz);
  const midi = Math.round(midiFloat);
  return { midi, centsOffset: 100 * (midiFloat - midi) };
}

/**
 * The A4 reference implied by shifting standard tuning by `cents`. This is
 * what turns an abstract "you whistle 38 cents sharp" into the UI's much more
 * legible "detected A = 450 Hz".
 */
export function a4FromOffsetCents(cents: number, a4Hz = 440): number {
  return a4Hz * Math.pow(2, cents / 1200);
}
