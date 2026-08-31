/**
 * The whistler's comfortable register, and how a target melody is moved into
 * it.
 *
 * ## Why the app has to ask
 *
 * A whistle lives roughly two octaves above where melodies are written, and
 * *where* inside that is personal — this app's own author sits in a different
 * octave from the person sitting next to him, and neither of them can whistle
 * the bottom of a bass line at all. Practice mode plays a target and asks for it
 * back, so if it plays the target at its written pitch it is asking for
 * something that may be physically impossible, and every attempt comes back as
 * a register error the diagnosis engine then has to explain away.
 *
 * The fix is one measurement, taken once: whistle something comfortably low,
 * whistle something comfortably high. Everything after that is arithmetic.
 *
 * ## Why only octaves
 *
 * Moving a melody by anything other than a whole octave changes the *key*, and
 * the app has no business doing that behind a beginner's back — a phrase that
 * lands on a black note when it used to land on a white one is a different
 * phrase to find on a piano, and the whole point of this project is finding
 * notes on a piano. An octave shift leaves every note name intact.
 *
 * Pure: no storage, no DOM. `store.ts` owns the persistence.
 */

import type { TargetNote } from "./align.js";

export interface WhistleRange {
  /** Lowest comfortable MIDI note. */
  lowMidi: number;
  /** Highest comfortable MIDI note. */
  highMidi: number;
}

/**
 * How many octaves each way the auto-transpose will consider. Four is far more
 * than any real pair of (melody, whistler) needs; the bound exists so a
 * corrupted range cannot send the search off forever.
 */
const MAX_OCTAVE_SHIFT = 4;

/**
 * A range worth using. `null`, unmeasured or nonsense values all mean "we do
 * not know", and not knowing is different from knowing the user has no range.
 */
export function isUsableRange(range: WhistleRange | null | undefined): range is WhistleRange {
  return (
    !!range &&
    Number.isFinite(range.lowMidi) &&
    Number.isFinite(range.highMidi) &&
    range.highMidi > range.lowMidi
  );
}

/**
 * Build a range from the two ends, in whichever order they arrived.
 *
 * Sorting rather than trusting the labels is not defensive padding: "whistle
 * something low, now something high" is an instruction people get backwards,
 * and a range with its ends crossed would silently disable every transposition
 * that depends on it.
 */
export function rangeFromEnds(a: number, b: number): WhistleRange {
  return { lowMidi: Math.min(a, b), highMidi: Math.max(a, b) };
}

/**
 * The pitch a "hold one comfortable note" take was actually about.
 *
 * The longest note, and only the longest note. A take like that is one
 * sustained whistle; whatever else the segmenter found in it — the scoop at the
 * start that got its own note, a chirp at the end as the breath ran out — is
 * short by construction, which is exactly what makes "longest" the right
 * summary rather than an average that those fragments would drag.
 *
 * `null` when there is nothing to summarise.
 */
export function representativeMidi(
  notes: readonly { midi: number; durationSec: number }[],
): number | null {
  let best: { midi: number; durationSec: number } | null = null;
  for (const note of notes) {
    if (!best || note.durationSec > best.durationSec) best = note;
  }
  return best ? best.midi : null;
}

function medianMidi(notes: readonly TargetNote[]): number {
  const sorted = notes.map((note) => note.midi).sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * How many octaves to move a melody to put it where this whistler lives.
 *
 * Two criteria, in this order, and the order matters:
 *
 * 1. **Fewest notes outside the range.** A melody wider than someone's
 *    comfortable register cannot fit, and then the useful question is not where
 *    its middle sits but how much of it the user can actually reach. Centring a
 *    two-octave melody inside a one-octave range would push half of it off both
 *    ends; pushing it up until only the bottom notes are out at least leaves a
 *    contiguous singable stretch.
 * 2. **Median nearest the middle of the range.** Once a shift fits, this is what
 *    makes it comfortable rather than merely possible. Median, not mean, so one
 *    high note at the end of a phrase cannot drag the whole thing down an
 *    octave.
 *
 * Ties go to the smaller shift, and to no shift at all when it is among them —
 * moving a melody the user did not ask to have moved needs a reason.
 */
export function octaveShiftIntoRange(
  notes: readonly TargetNote[],
  range: WhistleRange | null | undefined,
): number {
  if (notes.length === 0 || !isUsableRange(range)) return 0;

  const median = medianMidi(notes);
  const centre = (range.lowMidi + range.highMidi) / 2;

  let best = 0;
  let bestOutside = Infinity;
  let bestDistance = Infinity;
  for (let shift = -MAX_OCTAVE_SHIFT; shift <= MAX_OCTAVE_SHIFT; shift++) {
    let outside = 0;
    for (const note of notes) {
      const midi = note.midi + 12 * shift;
      if (midi < range.lowMidi || midi > range.highMidi) outside++;
    }
    const distance = Math.abs(median + 12 * shift - centre);

    const better =
      outside < bestOutside ||
      (outside === bestOutside &&
        (distance < bestDistance - 1e-9 ||
          (Math.abs(distance - bestDistance) <= 1e-9 && Math.abs(shift) < Math.abs(best))));
    if (better) {
      best = shift;
      bestOutside = outside;
      bestDistance = distance;
    }
  }
  return best;
}

/** The melody, moved into the whistler's register. Unchanged when there is no
 *  usable range — the app never guesses at a measurement it does not have. */
export function transposeIntoRange(
  notes: readonly TargetNote[],
  range: WhistleRange | null | undefined,
): TargetNote[] {
  const shift = octaveShiftIntoRange(notes, range);
  return shift === 0
    ? notes.map((note) => ({ ...note }))
    : notes.map((note) => ({ midi: note.midi + 12 * shift, durSec: note.durSec }));
}

/** Semitones between the ends, for the "about two octaves" line in the UI. */
export function rangeSpanSemitones(range: WhistleRange): number {
  return range.highMidi - range.lowMidi;
}
