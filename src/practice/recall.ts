/**
 * Melody recall — the exercise itself, as arithmetic.
 *
 * The loop is three taps long: listen to a melody as often as you like, whistle
 * it back from memory, look at what came out. `align.ts` already answers *what
 * happened*; this module answers the two questions that stand between that
 * answer and a screen — **where do I draw it**, and **what do I say about it**.
 *
 * ## The overlay's x axis is the attempt's own clock
 *
 * The obvious layout for a diff is slot-by-slot: box one against box one, box
 * two against box two. It is also wrong here, because it throws away the trail —
 * the continuous pitch measurement that shows the scoop into a note and the
 * wobble across it, and which is the only thing on the picture that explains
 * *why* a note came back `off` rather than `clean`.
 *
 * So the axis is time, as the attempt actually happened, and each target slot is
 * drawn as a ghost rectangle occupying **the same span as the note that answered
 * it**. The claim the picture then makes is exactly the claim the aligner makes:
 * *at this moment, you were here, and the melody wanted you there.* Every error
 * is a vertical distance, and vertical distance is the one thing this app scores.
 *
 * Slots nobody sang have no note to borrow a span from, so they are wedged into
 * the silence between their neighbours ({@link MISSING_SLICE_FRACTION}). That is
 * not a measurement — nothing was measured, that is the point — but it puts the
 * gap where the melody went missing, which is where a reader looks for it.
 *
 * ## Registers: everything is drawn in the attempt's
 *
 * The target is *already* transposed into the whistler's range before it is
 * played (`range.ts`), so what they heard is the as-played melody and any
 * remaining transposition is a register the user chose in the moment. The
 * aligner reports it as `transposition`: semitones to *add* to the attempt to
 * reach the target. Every pitch on this screen therefore has it *subtracted*,
 * which draws the ghost where the user should have whistled given the register
 * they picked — rather than moving their own take somewhere they never sang.
 *
 * ## What gets named, and what does not
 *
 * Practice mode is ear-first, and the boundary is about prompts rather than
 * feedback: after an attempt, names are a report. This module holds to a
 * narrower line that is easy to state and easy to keep — **the app names what
 * you did, never what it wanted.** A wrong note is named, an extra note is
 * named; a missed slot and a target ghost are shown as a position and a
 * distance. So the melody's own notes are never spelled out for a target the
 * user is about to be asked for again by the Try-again button two inches below.
 *
 * Pure: no DOM, no storage, no `src/dsp` and no `src/audio` import. The two
 * shapes it shares with those halves of the app — a note with a start time, a
 * note ready to be scheduled — are structural, so `transcribe()`'s output and
 * `startPlayback`'s input both fit with no adapter.
 */

import {
  countVerdicts,
  type Alignment,
  type AttemptNote,
  type TargetNote,
  type Verdict,
} from "./align.js";

/**
 * One note as whistled, with the times the segmenter gave it.
 *
 * Structurally a subset of `src/dsp`'s `Note`, exactly as {@link AttemptNote}
 * is: `alignAttempt(result.notes, …)` and `overlayModel({attempt: result.notes})`
 * both type-check against a transcription with no conversion step.
 */
export interface HeardNote extends AttemptNote {
  startSec: number;
  endSec: number;
}

/** One point of the measured pitch trail, already in MIDI and already corrected
 *  for the take's global tuning bias (see `ui/diffroll.ts`, which is where the
 *  frames live and where that correction is applied). */
export interface TrailPoint {
  tSec: number;
  midi: number;
}

/* ── Playing the target ───────────────────────────────────────────────── */

/**
 * A note ready for the synth.
 *
 * Structurally what `startPlayback` takes, and deliberately *not* imported from
 * `src/audio/synth.ts`: the practice island may not depend on the browser half
 * of the app. The four fields are the whole of what playback ever reads, so the
 * structural match is the contract.
 */
export interface PlayableNote {
  midi: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

/**
 * Silence inserted between one target note and the next.
 *
 * A target has durations and no start times — it is a melody, not a recording —
 * so playing it means laying the notes end to end. Butted exactly together, two
 * notes of the same pitch are one long note: the envelope never closes, and a
 * melody with a repeated note (which is most melodies) is quietly handed to the
 * user with a note missing. 80 ms is long enough for the 30 ms release to finish
 * and be heard as a re-articulation, and short enough that the phrase still
 * sounds like a phrase.
 */
export const TARGET_GAP_SEC = 0.08;

/**
 * Lay a target out on a timeline so the synth can play it.
 *
 * The synth applies its own minimum note length and its own gap rule on top of
 * this; all this has to do is turn a list of durations into start times, which
 * is the one thing the target model deliberately does not carry.
 */
export function targetPlayback(
  notes: readonly TargetNote[],
  gapSec: number = TARGET_GAP_SEC,
): PlayableNote[] {
  const out: PlayableNote[] = [];
  let cursor = 0;
  for (const note of notes) {
    const durationSec = Math.max(0, note.durSec);
    out.push({ midi: note.midi, startSec: cursor, endSec: cursor + durationSec, durationSec });
    cursor += durationSec + gapSec;
  }
  return out;
}

/* ── The overlay ──────────────────────────────────────────────────────── */

/** What happened at one drawn position: a target slot's verdict, or a note that
 *  answered to no slot at all. */
export type Outcome = Verdict | "extra";

export interface OverlayItem {
  /** Position in {@link OverlayModel.items} — what a tapped chip reports back,
   *  because an `extra` has no slot number to be identified by. */
  index: number;
  /** Index into the target, or `null` for an extra. */
  slot: number | null;
  /** Index into the attempt, or `null` for a slot nobody sang. */
  attemptIndex: number | null;
  outcome: Outcome;
  /** Where the melody wanted a note, **in the attempt's register**. `null` for
   *  an extra, which answers to no slot. */
  targetMidi: number | null;
  /** What came out, unrounded and in its own register. `null` for `missing`. */
  heardMidi: number | null;
  /** Signed cents from the target: positive is sharp. `null` unless both of the
   *  above are present. */
  residualCents: number | null;
  startSec: number;
  endSec: number;
}

export interface OverlayModel {
  items: OverlayItem[];
  /** Semitones the attempt sat away from the target; see the module header. */
  transposition: number;
  /** Vertical extent to draw, in MIDI numbers, padded. */
  minMidi: number;
  maxMidi: number;
  /** Timeline length, in seconds. */
  spanSec: number;
}

/** Semitones of headroom above and below, matching the transcriber's roll. */
const RANGE_PADDING = 2;
/** Never zoom in tighter than an octave, for the same reason: a three-note
 *  melody would otherwise fill the plot with meaningless vertical drama. */
const MIN_RANGE_SEMITONES = 12;

/**
 * Width given to a slot nobody sang, as a fraction of the attempt's median note.
 *
 * Wide enough to be a tap target and to carry its marker, narrow enough that a
 * run of three missed notes squeezed between two sung ones still reads as a
 * gap rather than as a section of the melody.
 */
const MISSING_SLICE_FRACTION = 0.5;

/** Fallback slice when there is no attempt to take a median from. */
const DEFAULT_SLICE_SEC = 0.2;

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface OverlayInput {
  alignment: Alignment;
  attempt: readonly HeardNote[];
  /** Optional; only widens the vertical extent so the trail cannot be clipped
   *  by the very rectangles it explains. */
  trail?: readonly TrailPoint[];
}

/**
 * Everything the diff overlay draws, in one pass and in drawing order.
 *
 * Order is the *melody's*: target slots in sequence, with each extra note
 * inserted after the slot it followed. That is the order the verdict strip
 * reads in too, so a chip and a rectangle are the same object seen twice.
 */
export function overlayModel(input: OverlayInput): OverlayModel {
  const { alignment, attempt } = input;
  const transposition = alignment.transposition;
  const items: OverlayItem[] = [];

  /** Extras grouped by the slot they came after; `-1` is "before everything". */
  const extrasAfter = new Map<number, typeof alignment.extras>();
  for (const extra of alignment.extras) {
    const list = extrasAfter.get(extra.afterSlot) ?? [];
    list.push(extra);
    extrasAfter.set(extra.afterSlot, list);
  }

  const heard = (index: number): number | null => {
    const note = attempt[index];
    return note ? note.midi + note.centsOffset / 100 : null;
  };
  const span = (index: number): { startSec: number; endSec: number } => {
    const note = attempt[index];
    return note
      ? { startSec: note.startSec, endSec: note.endSec }
      : { startSec: 0, endSec: 0 };
  };

  const pushExtras = (afterSlot: number): void => {
    for (const extra of extrasAfter.get(afterSlot) ?? []) {
      items.push({
        index: items.length,
        slot: null,
        attemptIndex: extra.attemptIndex,
        outcome: "extra",
        targetMidi: null,
        heardMidi: heard(extra.attemptIndex),
        residualCents: null,
        ...span(extra.attemptIndex),
      });
    }
  };

  pushExtras(-1);
  for (const slot of alignment.slots) {
    // Drawn where the user should have whistled it, not where the target is
    // written: the whole screen lives in the attempt's register.
    const targetMidi = slot.targetMidi - transposition;
    if (slot.attemptIndex === null) {
      items.push({
        index: items.length,
        slot: slot.slot,
        attemptIndex: null,
        outcome: "missing",
        targetMidi,
        heardMidi: null,
        residualCents: null,
        // Placed by `placeMissing` once every sung note has its span.
        startSec: NaN,
        endSec: NaN,
      });
    } else {
      items.push({
        index: items.length,
        slot: slot.slot,
        attemptIndex: slot.attemptIndex,
        outcome: slot.verdict,
        targetMidi,
        heardMidi: heard(slot.attemptIndex),
        residualCents: slot.residualCents,
        ...span(slot.attemptIndex),
      });
    }
    pushExtras(slot.slot);
  }

  const slice = Math.max(
    1e-3,
    MISSING_SLICE_FRACTION *
      (attempt.length > 0
        ? median(attempt.map((note) => Math.max(0, note.endSec - note.startSec)))
        : DEFAULT_SLICE_SEC),
  );
  placeMissing(items, slice, lastEnd(attempt));

  const range = midiRange(items, input.trail ?? []);
  return {
    items,
    transposition,
    minMidi: range.min,
    maxMidi: range.max,
    spanSec: Math.max(
      0.5,
      lastEnd(attempt),
      items.reduce((max, item) => Math.max(max, item.endSec), 0),
      input.trail?.length ? input.trail[input.trail.length - 1].tSec : 0,
    ),
  };
}

function lastEnd(attempt: readonly HeardNote[]): number {
  return attempt.reduce((max, note) => Math.max(max, note.endSec), 0);
}

/**
 * Give every unsung slot a span, in the silence where it should have been.
 *
 * A run of them shares the gap between the sung notes on either side; when that
 * gap is too tight to hold them (or does not exist, because the user ran two
 * notes together), the run is centred on the join and allowed to overlap its
 * neighbours slightly — which reads as *squeezed in between*, and is a truer
 * picture than hiding it.
 */
function placeMissing(items: OverlayItem[], slice: number, takeEnd: number): void {
  let i = 0;
  while (i < items.length) {
    if (!Number.isNaN(items[i].startSec)) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < items.length && Number.isNaN(items[end + 1].startSec)) end++;
    const count = end - i + 1;

    // The silence available: from the last thing sung before the run to the
    // first thing sung after it. A run at either edge borrows the take's own
    // start or finish.
    const before = i > 0 ? items[i - 1].endSec : 0;
    const after = end + 1 < items.length ? items[end + 1].startSec : takeEnd + count * slice;
    const needed = count * slice;
    let start = before;
    let width = after - before;
    if (!(width >= needed)) {
      const centre = (before + after) / 2;
      start = Math.max(0, centre - needed / 2);
      width = needed;
    }
    for (let k = 0; k < count; k++) {
      items[i + k].startSec = start + (width * k) / count;
      items[i + k].endSec = start + (width * (k + 1)) / count;
    }
    i = end + 1;
  }
}

function midiRange(
  items: readonly OverlayItem[],
  trail: readonly TrailPoint[],
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const see = (midi: number | null): void => {
    if (midi === null || !Number.isFinite(midi)) return;
    if (midi < min) min = midi;
    if (midi > max) max = midi;
  };
  for (const item of items) {
    see(item.targetMidi);
    see(item.heardMidi);
  }
  for (const point of trail) see(point.midi);

  if (min > max) {
    // Nothing to show. Centre on C6, where whistling lives, so an empty plot
    // has the same shape as a full one.
    min = 84;
    max = 84;
  }
  min = Math.floor(min) - RANGE_PADDING;
  max = Math.ceil(max) + RANGE_PADDING;
  const short = MIN_RANGE_SEMITONES - (max - min);
  if (short > 0) {
    min -= Math.floor(short / 2);
    max += Math.ceil(short / 2);
  }
  return { min, max };
}

/* ── The verdict strip ────────────────────────────────────────────────── */

export interface VerdictChip {
  /** Matches {@link OverlayItem.index}: tapping a chip highlights its rectangle. */
  index: number;
  outcome: Outcome;
  /** 1-based position in the melody, or `null` for an extra note. */
  position: number | null;
  /** Signed cents from the target, when the slot was sung. */
  cents: number | null;
  /**
   * The pitch to name on this chip, or `null` when there is nothing to name.
   *
   * Only ever a pitch the *user produced* — see the module header. `clean` and
   * `off` name nothing either: the number of cents is the whole story, and the
   * note name is the one the user already knows they were aiming at.
   */
  nameMidi: number | null;
}

/** The strip, in melody order. One chip per drawn item, by construction. */
export function verdictChips(model: OverlayModel): VerdictChip[] {
  return model.items.map((item) => ({
    index: item.index,
    outcome: item.outcome,
    position: item.slot === null ? null : item.slot + 1,
    cents: item.residualCents,
    nameMidi:
      (item.outcome === "wrong" || item.outcome === "extra") && item.heardMidi !== null
        ? Math.round(item.heardMidi)
        : null,
  }));
}

/* ── The words ────────────────────────────────────────────────────────── */

/** `1 → "1st"`, `2 → "2nd"`, `13 → "13th"`, `21 → "21st"`. */
export function ordinal(n: number): string {
  const rounded = Math.round(n);
  const tens = rounded % 100;
  if (tens >= 11 && tens <= 13) return `${rounded}th`;
  switch (rounded % 10) {
    case 1:
      return `${rounded}st`;
    case 2:
      return `${rounded}nd`;
    case 3:
      return `${rounded}rd`;
    default:
      return `${rounded}th`;
  }
}

/**
 * Interval names, for the one place they are allowed: a label on something that
 * has already been whistled.
 *
 * Index is the interval in semitones. "A whole tone" rather than "a major 2nd"
 * because it is the name a beginner has actually met; everything above it is
 * named the ordinary way, because there is no plainer word for a minor sixth.
 */
const INTERVAL_NAMES: readonly string[] = [
  "",
  "a semitone",
  "a whole tone",
  "a minor 3rd",
  "a major 3rd",
  "a 4th",
  "a tritone",
  "a 5th",
  "a minor 6th",
  "a major 6th",
  "a minor 7th",
  "a major 7th",
];

function octavesText(octaves: number): string {
  return octaves === 1 ? "an octave" : `${octaves} octaves`;
}

/** An unsigned distance in semitones, as a musician would say it. */
export function intervalName(semitones: number): string {
  const n = Math.abs(Math.round(semitones));
  if (n === 0) return "the same note";
  const octaves = Math.floor(n / 12);
  const rest = n % 12;
  if (octaves === 0) return INTERVAL_NAMES[rest];
  if (rest === 0) return octavesText(octaves);
  return `${octavesText(octaves)} and ${INTERVAL_NAMES[rest]}`;
}

/**
 * The register the attempt came out in, said out loud.
 *
 * Reassurance is the job here, not correction. Echoing a melody in your own
 * register is not a mistake — it is what the whole transposition-invariant
 * aligner exists to allow — and a beginner who sees "a 5th above" without being
 * told that is fine will try to fix something that is not broken.
 */
export function transpositionText(transposition: number): string {
  if (transposition === 0) return "You whistled it in the register it played in.";
  // `transposition` is what the *attempt* needs adding to reach the target, so
  // a positive value means the attempt was below.
  const direction = transposition > 0 ? "below" : "above";
  return `You whistled it ${intervalName(transposition)} ${direction} what played — which is fine, the shape is what counts.`;
}

/** "4 of 5 notes clean · 1 missed" — the score, such as it is. */
export function scoreText(alignment: Alignment): string {
  const counts = countVerdicts(alignment);
  const total = alignment.slots.length;
  const parts = [`${counts.clean} of ${total} note${total === 1 ? "" : "s"} clean`];
  if (counts.off > 0) parts.push(`${counts.off} a little off`);
  if (counts.wrong > 0) parts.push(`${counts.wrong} wrong`);
  if (counts.missing > 0) parts.push(`${counts.missing} missed`);
  if (counts.extra > 0) parts.push(`${counts.extra} extra`);
  return parts.join(" · ");
}

/** How far off, in the unit that carries the most meaning at that distance. */
function distanceText(cents: number): string {
  const magnitude = Math.abs(cents);
  const direction = cents > 0 ? "sharp" : "flat";
  if (magnitude < 100) return `${Math.round(magnitude)} cents ${direction}`;
  const semitones = magnitude / 100;
  const whole = Math.round(semitones);
  // Within a fifth of a semitone of a whole number, "a semitone flat" is both
  // truer to the ear and easier to act on than "97 cents flat".
  if (Math.abs(semitones - whole) < 0.2) {
    return whole === 12
      ? `an octave ${cents > 0 ? "high" : "low"}`
      : `${whole === 1 ? "a" : whole} semitone${whole === 1 ? "" : "s"} ${direction}`;
  }
  return `${Math.round(magnitude)} cents ${direction}`;
}

/**
 * The one sentence worth saying about this attempt.
 *
 * Deliberately *one*. A list of every deviation is a wall a beginner reads none
 * of; the strip above it already carries the detail for anyone who wants it.
 * Priority is by what most needs doing something about: a wrong note beats an
 * imprecise one, a missed note beats an extra one, and among off-pitch notes the
 * worst is the one worth naming.
 */
export function takeawayText(alignment: Alignment): string {
  const counts = countVerdicts(alignment);
  if (alignment.slots.length === 0) return "";

  const wrong = alignment.slots.find((slot) => slot.verdict === "wrong");
  if (wrong && wrong.residualCents !== null) {
    return `The ${ordinal(wrong.slot + 1)} note came out ${distanceText(wrong.residualCents)}.`;
  }

  const missing = alignment.slots.find((slot) => slot.verdict === "missing");
  if (missing) {
    return `The ${ordinal(missing.slot + 1)} note never arrived.`;
  }

  let worst: (typeof alignment.slots)[number] | null = null;
  for (const slot of alignment.slots) {
    if (slot.verdict !== "off" || slot.residualCents === null) continue;
    if (!worst || Math.abs(slot.residualCents) > Math.abs(worst.residualCents ?? 0)) worst = slot;
  }
  if (worst && worst.residualCents !== null) {
    return `The ${ordinal(worst.slot + 1)} note came out ${distanceText(worst.residualCents)}.`;
  }

  if (counts.extra > 0) {
    return counts.extra === 1
      ? "There was one note in there the melody does not have."
      : `There were ${counts.extra} notes in there the melody does not have.`;
  }
  return "Every note landed. Nothing to fix.";
}

/* ── Before the attempt ───────────────────────────────────────────────── */

/**
 * What the listen button says it has done so far.
 *
 * Counted and reported without a word of judgement, because the difficulty knob
 * in this exercise is the user's own: listening once and whistling is a memory
 * test, listening five times and whistling is an ear test, and both are worth
 * doing. An app that said "3 listens" in a tone would push people towards
 * whichever number it seemed to prefer.
 */
export function listenCountText(listens: number): string {
  if (listens === 0) return "";
  return listens === 1 ? "Heard it once." : `Heard it ${listens} times.`;
}
