/**
 * Segmentation: a continuous pitch track in, discrete notes out.
 *
 * This is where every judgement call in the pipeline lives. `pitch.ts`
 * deliberately reports raw measurements and no decisions, so this module owns
 * all of the thresholds — which means the Node harness can cache frames once
 * and re-run a whole parameter sweep in milliseconds. See CLAUDE.md.
 *
 * The stages, in order:
 *
 *   A. **Voicing** — which frames are a whistle rather than a room.
 *   B. **Pitch representation** — Hz to fractional MIDI. Never rounded early.
 *   C. **Smoothing** — drop specks, median-filter *within* voiced runs.
 *   D. **Glide marking** — steep slopes are transitions, not notes.
 *   E. **State machine** — a running median reference, with confirmation.
 *   F. **Per-note pitch** — trim the attack, take the median.
 *   G. **Gaps** — dropout versus silence, short-note merges, rests.
 *   H. **Global tuning** — a circular mean of the residuals.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import { hzToMidiFloat, midiToHz, midiToName, nearestNote } from "./tuning.js";
import type { DspConfig, Note, NoteFlags, PitchFrame } from "./types.js";

/** Minimum number of background frames before their percentile is believed as
 *  a noise floor. Fewer than this and one unlucky frame sets the threshold. */
const MIN_FLOOR_SAMPLES = 8;

/** How many times the global background estimate is refined by discarding the
 *  samples that turned out to be too loud to be background. Two passes is
 *  enough to walk down from a sample set containing a burst to the true floor;
 *  more never moved the answer on any signal tried. */
const FLOOR_REFINE_PASSES = 3;

/** What one pass of segmentation concluded. */
export interface SegmentationResult {
  notes: Note[];
  /** The global tuning correction actually applied, in cents. */
  tuningOffsetCents: number;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/** Median of at most the last `count` entries. Used for the running reference
 *  pitch: a median, not a mean, so a single wild frame cannot drag it. */
function medianOfTail(values: readonly number[], count: number): number {
  return median(values.length <= count ? values : values.slice(values.length - count));
}

/** Nearest-rank percentile, `p` in 0..100. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[rank];
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function spread(values: readonly number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

// ---------------------------------------------------------------------------
// Stage A — voicing
// ---------------------------------------------------------------------------

export interface Voicing {
  /** Per frame: does the spectrum look like a single pure tone? Level plays no
   *  part in this, and neither does the warm-up. */
  tonal: boolean[];
  /** Per frame: `tonal` and past the microphone warm-up — eligible to be
   *  voiced if the level agrees. */
  candidate: boolean[];
  /** Per frame: the frames whose level was believed as evidence about the
   *  background. Exposed for instrumentation. */
  background: boolean[];
  /** Per frame: the adaptive noise floor in dBFS that applied there.
   *  `-Infinity` where there was no evidence for one. */
  floorDb: number[];
  /** Per frame: the final voicing decision, hysteresis included. */
  voiced: boolean[];
}

/**
 * Estimate the level the room sits at when nobody is whistling.
 *
 * The subtle part is deciding *which* frames are evidence. "Not tone-shaped"
 * is necessary but nowhere near sufficient: a cough, a door, a chair scrape and
 * a hand over the microphone all fail the shape tests at 40 dB above the room,
 * and letting them into the sample set drags the floor up to their level for as
 * long as they stay inside the trailing window — which blanks the transcription
 * *after* the event, seconds later, where nobody would think to look for the
 * cause. The microphone warm-up is the same bug wearing a different hat: a take
 * that starts whistling at t=0 has its opening frames excluded from voicing,
 * and if those frames then count as "background" the floor is set to the level
 * of the whistle itself and the whole take disappears.
 *
 * So background evidence has to be *quiet as well as shapeless*, which is
 * circular — quiet relative to what? — and the way out of the circle is to
 * iterate. Start from the naive estimate, throw away everything more than
 * `backgroundAboveFloorDb` above it, re-estimate, repeat. Loud events are a
 * minority of any real recording, so the first estimate is already in the right
 * basin and the refinement only sharpens it. When it converges on nothing
 * (a file that is wall-to-wall whistling), the honest answer is that there is
 * no evidence for a floor at all, and the level gate stands down rather than
 * inventing one.
 */
function backgroundFloor(level: number[], tonal: boolean[], cfg: DspConfig): number {
  const v = cfg.voicing;
  const shapeless: number[] = [];
  for (let i = 0; i < level.length; i++) if (!tonal[i]) shapeless.push(level[i]);
  if (shapeless.length < MIN_FLOOR_SAMPLES) return -Infinity;

  let floor = percentile(shapeless, v.noiseFloorPercentile);
  for (let pass = 0; pass < FLOOR_REFINE_PASSES; pass++) {
    const kept = shapeless.filter((l) => l <= floor + v.backgroundAboveFloorDb);
    if (kept.length < MIN_FLOOR_SAMPLES) break;
    const next = percentile(kept, v.noiseFloorPercentile);
    if (Math.abs(next - floor) < 0.01) break;
    floor = next;
  }
  return floor;
}

/**
 * Decide which frames carry a whistle.
 *
 * Two independent kinds of evidence are combined. The *shape* tests (clarity,
 * SNR, peak-to-second) ask whether the spectrum looks like a single pure tone;
 * they are level-independent, so a quiet whistle passes them and a loud
 * dishwasher does not. The *level* test asks whether there is more energy here
 * than in the room's background, against a floor re-estimated continuously —
 * because a quiet bedroom and a café differ by far more than any fixed
 * threshold could span.
 *
 * The level test is asymmetric on purpose: starting a note demands
 * `onsetAboveFloorDb`, holding one only `sustainAboveFloorDb`. That hysteresis
 * is what stops a note that fades as the whistler runs out of breath from
 * being chopped into a stutter of fragments, while still requiring conviction
 * before a new note is allowed to begin.
 *
 * The floor itself is a percentile of the *nearest* background frames rather
 * than of a fixed trailing window. Those two agree wherever the recording has
 * background to spare, and where it does not the window simply reaches further
 * out instead of falling off a cliff onto a global estimate. That matters more
 * than it sounds: a floor that jumps tens of dB between one frame and the next
 * takes `isTrueSilence` with it, and a spurious "silence" is what turns one
 * held note into a stutter of re-articulated ones.
 */
function computeVoicing(frames: PitchFrame[], cfg: DspConfig, framePeriod: number): Voicing {
  const v = cfg.voicing;
  const n = frames.length;
  const level = frames.map((f) => f.bandRmsDb);

  const tonal = frames.map(
    (f) =>
      f.hz !== null &&
      f.hz > 0 &&
      f.clarity >= v.minClarity &&
      f.snrDb >= v.minSnrDb &&
      f.peakToSecondDb >= v.minPeakToSecondDb,
  );
  // The microphone's first moments are not signal: gain control settles, and on
  // some platforms the voice-processing chain is still deciding what the room
  // sounds like. Frames in there may not become notes — but a *loud* one is not
  // thereby evidence about the room either, which is why the warm-up is applied
  // here and not to `tonal` above.
  const candidate = tonal.map((t, i) => t && frames[i].tSec >= v.warmupSec);

  const globalFloor = backgroundFloor(level, tonal, cfg);
  const background = new Array<boolean>(n).fill(false);
  const backgroundIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!tonal[i] && level[i] <= globalFloor + v.backgroundAboveFloorDb) {
      background[i] = true;
      backgroundIndices.push(i);
    }
  }

  const floorDb = new Array<number>(n).fill(-Infinity);
  if (backgroundIndices.length >= MIN_FLOOR_SAMPLES) {
    const windowFrames = Math.max(1, Math.round(v.noiseFloorWindowSec / framePeriod));
    const values: number[] = [];
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      // Trailing window [i - windowFrames, i), as a half-open range of
      // positions into `backgroundIndices`. Both pointers only ever advance,
      // so the whole loop is linear.
      while (lo < backgroundIndices.length && backgroundIndices[lo] < i - windowFrames) lo++;
      while (hi < backgroundIndices.length && backgroundIndices[hi] < i) hi++;

      // Starved of trailing evidence, reach outwards for the nearest frames in
      // either direction rather than swapping in a different estimator. The
      // sample set then changes by at most one frame from here to the next, so
      // the floor moves continuously.
      let left = lo;
      let right = hi;
      let count = right - left;
      while (count < MIN_FLOOR_SAMPLES && (left > 0 || right < backgroundIndices.length)) {
        const distanceLeft = left > 0 ? i - backgroundIndices[left - 1] : Infinity;
        const distanceRight =
          right < backgroundIndices.length ? backgroundIndices[right] - i : Infinity;
        if (distanceLeft <= distanceRight) left--;
        else right++;
        count++;
      }

      values.length = 0;
      for (let p = left; p < right; p++) values.push(level[backgroundIndices[p]]);
      floorDb[i] = percentile(values, v.noiseFloorPercentile);
    }
  }

  const voiced = new Array<boolean>(n).fill(false);
  let holding = false;
  for (let i = 0; i < n; i++) {
    if (!candidate[i]) {
      holding = false;
      continue;
    }
    const required = holding ? v.sustainAboveFloorDb : v.onsetAboveFloorDb;
    if (frames[i].bandRmsDb >= floorDb[i] + required) {
      voiced[i] = true;
      holding = true;
    } else {
      holding = false;
    }
  }

  return { tonal, candidate, background, floorDb, voiced };
}

/** Everything stages A–D worked out about a frame track. */
export interface Prepared {
  voicing: Voicing;
  runs: Run[];
  /** Fractional MIDI after median filtering; NaN outside voiced runs. */
  smoothed: number[];
  /** Frames belonging to a transition rather than to a note. */
  transitional: boolean[];
  /** Frames belonging to a movement that *was* recognised as a transition and
   *  then immediately undone — i.e. to a wobble rather than to a glide. */
  oscillating: boolean[];
}

/**
 * Stages A–D: voicing, pitch representation, smoothing, glide marking.
 *
 * Exported (though not re-exported by `index.ts`, so it is not app-facing)
 * because these stages are where this pipeline's failures *hide*. A poisoned
 * noise floor and an over-eager glide detector both show up in the output as
 * notes that are simply not there, with nothing to distinguish them from a
 * whistler who never whistled — so the tests have to be able to read the
 * intermediate decisions rather than infer them from the notes.
 */
export function prepare(frames: PitchFrame[], cfg: DspConfig, sampleRate: number): Prepared {
  const framePeriod = cfg.analysis.hopSize / sampleRate;
  const a4Hz = cfg.tuning.a4Hz;

  // A — voicing.
  const voicing = computeVoicing(frames, cfg, framePeriod);

  // B — fractional MIDI. Rounding here would throw away exactly the evidence
  // that decides every borderline note later.
  const midiFloat = frames.map((f) => (f.hz !== null && f.hz > 0 ? hzToMidiFloat(f.hz, a4Hz) : NaN));

  // C — smoothing, strictly within voiced runs. A median filter that reached
  // across a gap would invent pitch in the silence that nobody whistled.
  const runs = voicedRuns(voicing.voiced, cfg.smoothing.minVoicedRunFrames);
  const smoothed = midiFloat.slice();
  const radius = Math.max(0, (cfg.smoothing.medianFilterFrames - 1) >> 1);
  if (radius > 0) {
    for (const run of runs) {
      for (let i = run.start; i <= run.end; i++) {
        const from = Math.max(run.start, i - radius);
        const to = Math.min(run.end, i + radius);
        const values: number[] = [];
        for (let j = from; j <= to; j++) values.push(midiFloat[j]);
        smoothed[i] = median(values);
      }
    }
  }

  // D — glide marking. The frames of a transition still count towards duration
  // and continuity, but their pitch is excluded from the estimate.
  const { transitional, oscillating } = markTransitional(runs, smoothed, framePeriod, cfg);

  return { voicing, runs, smoothed, transitional, oscillating };
}

// ---------------------------------------------------------------------------
// Stages B–D — pitch representation, smoothing, glide marking
// ---------------------------------------------------------------------------

interface Run {
  start: number;
  end: number; // inclusive
}

/** Maximal stretches of consecutive voiced frames, specks removed. */
function voicedRuns(voiced: boolean[], minRunFrames: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= voiced.length; i++) {
    const on = i < voiced.length && voiced[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start >= minRunFrames) runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return runs;
}

/** One stretch of consecutive frames all moving the same way. */
interface Leg {
  /** First and last *moving* frame, inclusive. */
  start: number;
  end: number;
  direction: number;
  /** Signed pitch change across the movement, in semitones. */
  semitones: number;
  seconds: number;
}

/** How much the pitch must gain on its own running extreme to count as still
 *  making headway, in semitones. Five cents is under the measurement noise on
 *  a held whistle and far under any real movement, which is the point: it
 *  separates climbing from flat-with-jitter. */
const PROGRESS_SEMITONES = 0.05;

/** How close two opposite movements must be to count as one oscillation.
 *  Vibrato turns around at a smooth extreme and spends barely a frame there;
 *  a melody puts a whole note between its transitions, and the shortest note
 *  anyone whistles is several times this. */
const OSCILLATION_ADJACENT_FRAMES = 3;

/** How much of a movement must be undone for it to have been an oscillation
 *  rather than a transition. */
const OSCILLATION_RATIO = 0.5;

/** How far a movement may be pushed back by a wobble riding on top of it and
 *  still be one movement, in semitones. Whistlers scoop and wobble at the same
 *  time: a ±50-cent vibrato at 5.5 Hz swings the pitch backwards by four tenths
 *  of a semitone twice a second, which would otherwise break the scoop
 *  underneath into pieces too small to recognise. Deliberately a constant and
 *  not `toleranceCents`: the wobble-snap knob is a statement about how the
 *  *notes* should be grouped, and letting it also redefine what counts as a
 *  glide would make one preset mean two unrelated things — the same reasoning
 *  that keeps the voicing thresholds out of the presets. */
const WOBBLE_REVERSAL_SEMITONES = 0.6;

/** How long the pitch must stop gaining ground before a movement counts as
 *  over, in milliseconds. Around the shortest note anyone whistles, which is
 *  the honest answer to "when has this pitch arrived somewhere?". */
const MOVEMENT_STALL_MS = 80;

/** Widest wobble that stage G will put back together as one note, measured
 *  between the two pitches it was reported as, in semitones. A whole tone is
 *  already an extravagant vibrato; past that, whatever the pitch trail is
 *  doing, "one note with a wobble" has stopped being the better description.
 *  Deliberately wider than `toleranceCents`, because by the time this runs the
 *  two halves have each been measured at their own *extreme* — the distance
 *  between them is the wobble's full peak-to-peak, not its amplitude.
 *
 *  Applied per merge, against the *running* merged pitch, which converges on
 *  the centre of the wobble as halves are absorbed — so a wobble of up to
 *  roughly ±2 semitones about its centre is still reunited, and one wider than
 *  that comes apart. Measured: one note through ±200 cents at 4 Hz, three
 *  notes at ±300. */
const MAX_WOBBLE_SEMITONES = 2;

/**
 * Cut a voiced run into movements: stretches over which the pitch travels
 * somewhere, separated by the stretches where it is holding still.
 *
 * This is the piece the old instantaneous-slope test was missing. A slope
 * threshold answers "is this frame moving fast?", which conflates two entirely
 * different things — a fast movement and a *far* one — and a whistler's scoop
 * is usually the second: 150 cents taken over 160 ms is only 9 semitones per
 * second, well under any threshold that leaves vibrato alone, yet it covers a
 * semitone and a half. Looking at whole movements instead lets both questions
 * be asked separately, of the thing that actually has a distance and a
 * duration.
 *
 * A movement is tracked by its running extreme rather than frame by frame,
 * which is what lets it survive a wobble. Whistlers scoop *and* wobble at the
 * same time, and a ±50-cent vibrato at 5.5 Hz swings the pitch backwards by
 * four tenths of a semitone twice a second — enough to break any
 * frame-to-frame rule into pieces too small to recognise, while the scoop
 * underneath sails on. The movement therefore ends only when the pitch either
 * gives back more than a wobble's worth of its own progress or stops gaining
 * ground for about as long as the shortest note anyone whistles. Both endings
 * say the same thing: the pitch arrived somewhere.
 */
function movementLegs(
  run: Run,
  smoothed: number[],
  slope: number[],
  framePeriod: number,
  cfg: DspConfig,
): Leg[] {
  const s = cfg.segment;
  const legs: Leg[] = [];
  const stillFrames = Math.max(2, Math.round(MOVEMENT_STALL_MS / 1000 / framePeriod));

  let i = run.start;
  while (i < run.end) {
    if (Math.abs(slope[i]) < s.glideMinSlopeStPerSec) {
      i++;
      continue;
    }
    const direction = Math.sign(slope[i]);
    // The slope at a frame is measured across its neighbours, so the movement
    // it reports began at the frame before.
    const start = Math.max(run.start, i - 1);
    let extreme = smoothed[start];
    let end = start;
    for (let j = start + 1; j <= run.end; j++) {
      const gained = direction * (smoothed[j] - extreme);
      if (gained > PROGRESS_SEMITONES) {
        extreme = smoothed[j];
        end = j;
        continue;
      }
      if (-gained > WOBBLE_REVERSAL_SEMITONES) break;
      if (j - end > stillFrames) break;
    }

    if (end > start) {
      legs.push({
        start,
        end,
        direction,
        semitones: smoothed[end] - smoothed[start],
        seconds: (end - start) * framePeriod,
      });
    }
    i = Math.max(end + 1, i + 1);
  }

  return legs;
}

/**
 * Which frames are a transition rather than a note?
 *
 * A movement qualifies if it is *fast* (`glideSlopeStPerSec`, which catches a
 * portamento however far it travels) or *far* (`glideMinSemitones`, which
 * catches a scoop however slowly it was taken) — and, crucially, if it is not
 * immediately undone.
 *
 * That last clause is the one that earns its keep. Vibrato and a scoop are the
 * same gesture over any short window: a smooth slide of a semitone or so,
 * sometimes faster than a portamento (a ±60-cent wobble at 5 Hz peaks at
 * 18.8 st/s). No threshold on rate or distance can separate them, and getting
 * it wrong is expensive in both directions — miss the scoop and its opening
 * frames confirm a phantom note a semitone flat; catch the vibrato and the
 * middle of the oscillation is stripped out, leaving a bimodal pile of extremes
 * whose median is a coin flip between two notes a semitone apart.
 *
 * What does separate them is *shape*: an oscillation comes back and a
 * transition does not. So a movement immediately followed or preceded by a
 * comparable movement the other way is vibrato, and its frames keep their
 * pitch. Between two real notes there is a note in the way — several times
 * longer than the couple of frames a wobble spends turning around — so a
 * genuine step is never mistaken for half a wobble.
 */
function markTransitional(
  runs: Run[],
  smoothed: number[],
  framePeriod: number,
  cfg: DspConfig,
): { transitional: boolean[]; oscillating: boolean[] } {
  const s = cfg.segment;
  const transitional = new Array<boolean>(smoothed.length).fill(false);
  const oscillating = new Array<boolean>(smoothed.length).fill(false);
  const slope = new Array<number>(smoothed.length).fill(0);

  for (const run of runs) {
    for (let i = run.start; i <= run.end; i++) {
      const previous = Math.max(run.start, i - 1);
      const next = Math.min(run.end, i + 1);
      if (next === previous) continue;
      slope[i] = (smoothed[next] - smoothed[previous]) / ((next - previous) * framePeriod);
    }

    const legs = movementLegs(run, smoothed, slope, framePeriod, cfg);
    for (const [k, leg] of legs.entries()) {
      const distance = Math.abs(leg.semitones);
      const rate = distance / leg.seconds;
      if (distance < s.glideMinSemitones && rate <= s.glideSlopeStPerSec) continue;

      const undone = (other: Leg | undefined, gapFrames: number): boolean =>
        other !== undefined &&
        other.direction !== leg.direction &&
        Math.abs(other.semitones) >= OSCILLATION_RATIO * distance &&
        gapFrames <= OSCILLATION_ADJACENT_FRAMES;
      const before = legs[k - 1];
      const after = legs[k + 1];
      const undoneBefore = undone(before, before ? leg.start - before.end - 1 : Infinity);
      const undoneAfter = undone(after, after ? after.start - leg.end - 1 : Infinity);
      if (undoneBefore || undoneAfter) {
        // Not a transition — but worth remembering *where* the wobbling was,
        // because the state machine cannot tell an oscillation's extreme from
        // a new note and will happily report a wide slow vibrato as a trill.
        // Stage G uses this to put such a note back together.
        for (let i = leg.start; i <= leg.end; i++) oscillating[i] = true;
        // Include the turning point itself: the couple of frames where the
        // pitch is neither climbing nor falling belong to the wobble as much
        // as the swings either side of them do.
        if (undoneBefore) for (let i = before.end; i <= leg.start; i++) oscillating[i] = true;
        if (undoneAfter) for (let i = leg.end; i <= after.start; i++) oscillating[i] = true;
        continue;
      }

      // Mark the frames that are actually in motion, not the whole span. A
      // movement can legitimately reach across a moment of stillness — a
      // wobble pausing at the top of its swing, a plateau too short to be a
      // note — and blanking those frames wholesale would delete any real note
      // unlucky enough to sit between two transitions. Frames left unmarked
      // inside a movement are harmless: a note needs `confirmFrames`
      // *consecutive* ones to exist, and a transition never leaves that many.
      for (let i = leg.start; i <= leg.end; i++) {
        if (Math.abs(slope[i]) >= s.glideMinSlopeStPerSec) transitional[i] = true;
      }
    }
  }

  return { transitional, oscillating };
}

// ---------------------------------------------------------------------------
// Stage E — the segmentation state machine
// ---------------------------------------------------------------------------

interface Draft {
  startIndex: number;
  /** Inclusive. */
  endIndex: number;
  /**
   * First frame whose pitch the state machine actually accepted, or −1.
   *
   * Everything before it is approach — a scoop, a glide, a moment of
   * indecision — and must not colour the pitch estimate. Everything from it
   * onwards does, *including* frames the state machine merely tolerated: the
   * machine's job is to decide where a note begins and ends, and stage F then
   * measures the whole of what it delimited. Estimating from the accepted
   * frames alone would bias a wobbling note towards whichever side of the
   * wobble happened to start it — measurably, by tens of cents.
   */
  firstPitchIndex: number;
  /** How far the running reference pitch moved across the note, in semitones.
   *  Distinguishes genuine drift from wobble — a median barely notices wobble. */
  refSpan: number;
  glidedIn: boolean;
}

interface StateMachineInput {
  runs: Run[];
  smoothed: number[];
  transitional: boolean[];
}

function runStateMachine(cfg: DspConfig, input: StateMachineInput): Draft[] {
  const s = cfg.segment;
  const toleranceSt = s.toleranceCents / 100;
  const drafts: Draft[] = [];

  for (const run of input.runs) {
    let draft: Draft | null = null;
    /** Pitches accepted into the current note, oldest first. Empty means the
     *  note has not settled on a pitch yet — it is still being approached. */
    let accepted: number[] = [];
    /** Frames not yet attributed to a pitch: either wobble away from the
     *  reference, or the run-up to a new one. Their frames already belong to
     *  the note for duration purposes; the question is only whose *pitch* they
     *  are. */
    let pending: { index: number; m: number }[] = [];
    let refLo = Infinity;
    let refHi = -Infinity;

    const finish = (): void => {
      if (draft) {
        draft.refSpan = refHi >= refLo ? refHi - refLo : 0;
        draft.glidedIn = draft.firstPitchIndex > draft.startIndex;
        drafts.push(draft);
      }
      draft = null;
      accepted = [];
      pending = [];
      refLo = Infinity;
      refHi = -Infinity;
    };

    /**
     * Is there a run of mutually consistent frames at the end of `pending`?
     *
     * If so, return the index within `pending` where that pitch begins,
     * extended backwards over any earlier buffered frames that agree with it,
     * so a note starts where it actually started rather than three frames
     * late. `-1` means "not yet".
     */
    const confirmedFrom = (): number => {
      if (pending.length < s.confirmFrames) return -1;
      const tail = pending.slice(pending.length - s.confirmFrames);
      if (spread(tail.map((p) => p.m)) > toleranceSt) return -1;
      const tailMedian = median(tail.map((p) => p.m));
      let from = pending.length - s.confirmFrames;
      while (from > 0 && Math.abs(pending[from - 1].m - tailMedian) <= toleranceSt) from--;
      return from;
    };

    for (let i = run.start; i <= run.end; i++) {
      const m = input.smoothed[i];

      if (draft === null) {
        draft = { startIndex: i, endIndex: i, firstPitchIndex: -1, refSpan: 0, glidedIn: false };
      }
      const current: Draft = draft;
      // Every frame in a run belongs to *some* note for timing purposes. Only
      // its contribution to a pitch is in question below.
      current.endIndex = Math.max(current.endIndex, i);

      // Glide and scoop frames carry continuity and duration but never pitch:
      // their pitch is a moving target, and including it would spawn a phantom
      // note at every semitone a portamento sweeps through. Anything buffered
      // when a glide starts was part of the run-up, not a note.
      if (input.transitional[i]) {
        pending = [];
        continue;
      }

      // ---- The note has not settled on a pitch yet ------------------------
      // A note's opening frames get exactly the same confirmation as a note
      // *change* does. Without that symmetry the first frames of a scoop —
      // which are, by definition, a sweep — would seed the reference and the
      // approach would be transcribed as a note of its own.
      if (accepted.length === 0) {
        pending.push({ index: i, m });
        const from = confirmedFrom();
        if (from < 0) continue;
        const claimed = pending.slice(from);
        current.firstPitchIndex = claimed[0].index;
        for (const p of claimed) accepted.push(p.m);
        pending = [];
        const seeded = medianOfTail(accepted, s.refMedianLength);
        refLo = seeded;
        refHi = seeded;
        continue;
      }

      // ---- Settled: compare against the running reference ------------------
      const reference = medianOfTail(accepted, s.refMedianLength);
      if (Math.abs(m - reference) <= toleranceSt) {
        accepted.push(m);
        const nextRef = medianOfTail(accepted, s.refMedianLength);

        // Drift cap: a slow continuous slide never breaks the frame-to-frame
        // tolerance, so without this it would be swallowed as one enormous
        // note. Measured on the *reference*, not on raw frames, so that
        // vibrato — which a median absorbs — does not count as drift.
        if (Math.max(refHi, nextRef) - Math.min(refLo, nextRef) > s.driftCapSemitones) {
          accepted.pop();
          current.endIndex = i - 1;
          finish();
          draft = { startIndex: i, endIndex: i, firstPitchIndex: i, refSpan: 0, glidedIn: false };
          accepted = [m];
          refLo = m;
          refHi = m;
          continue;
        }

        // Consistent with the reference, so anything buffered as a possible
        // new note was a wobble after all: give it back to this one.
        for (const p of pending) accepted.push(p.m);
        pending = [];
        refLo = Math.min(refLo, nextRef);
        refHi = Math.max(refHi, nextRef);
        continue;
      }

      // Disagrees with the reference. Do not commit yet: one frame off pitch
      // is a wobble, and only a run of mutually consistent ones is a new note.
      pending.push({ index: i, m });
      const from = confirmedFrom();
      if (from < 0) continue;

      const claimed = pending.slice(from);

      // A transition immediately before the new pitch is that note's *approach*
      // — the same thing a scoop is at the start of a run, and it belongs to
      // the note it arrives at rather than to the one it left. Leaving it with
      // the previous note would credit that note with time it did not sound,
      // and dock the new one of the run-up that is audibly part of it: a short
      // note reached by a glide would then measure as shorter than the
      // shortest note we are willing to report, and vanish.
      let onset = claimed[0].index;
      while (onset - 1 > current.startIndex && input.transitional[onset - 1]) onset--;

      current.endIndex = onset - 1;
      finish();

      draft = {
        startIndex: onset,
        endIndex: claimed[claimed.length - 1].index,
        firstPitchIndex: claimed[0].index,
        refSpan: 0,
        glidedIn: false,
      };
      accepted = claimed.map((p) => p.m);
      const seeded = medianOfTail(accepted, s.refMedianLength);
      refLo = seeded;
      refHi = seeded;
    }

    finish();
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// Stages F–H and assembly
// ---------------------------------------------------------------------------

interface Measured extends Draft {
  /** Fractional MIDI, before any rounding or tuning correction. */
  midiFloat: number;
  clipped: boolean;
  confidence: number;
}

/** Everything stage F needs about a frame that stage E already worked out. */
interface FrameContext {
  frames: PitchFrame[];
  smoothed: number[];
  /** Voiced and not part of a glide: eligible to carry a note's pitch. */
  usable: boolean[];
}

/**
 * Turn a draft's frames into one pitch.
 *
 * Three corrections matter. Frames before the state machine settled on a pitch
 * are dropped — they are the approach, not the note. Transitional (glide)
 * frames are dropped for the same reason. And the first quarter of a long note
 * is dropped on top of that, because whistlers slide into notes from below and
 * the slide is not what they meant to play.
 *
 * Then a **median**, not a mean: an octave-jumping frame that survived every
 * earlier filter would drag a mean by six semitones and a median not at all.
 */
function measure(draft: Draft, context: FrameContext, cfg: DspConfig): Measured {
  const s = cfg.segment;
  const { frames, smoothed, usable } = context;
  const startSec = frames[draft.startIndex].tSec;
  const endSec = frames[draft.endIndex].tSec;
  const durationMs = (endSec - startSec) * 1000;

  const from = draft.firstPitchIndex >= 0 ? draft.firstPitchIndex : draft.startIndex;
  let indices: number[] = [];
  for (let i = from; i <= draft.endIndex; i++) if (usable[i]) indices.push(i);
  // An all-glide note (a portamento with a silence at each end) still has to
  // report *something*; fall back to whatever pitch it had.
  if (indices.length === 0) {
    for (let i = draft.startIndex; i <= draft.endIndex; i++) {
      if (Number.isFinite(smoothed[i])) indices.push(i);
    }
  }
  if (indices.length === 0) return { ...draft, midiFloat: NaN, clipped: false, confidence: 0 };

  if (durationMs > s.attackTrimMinMs) {
    const cutoff = startSec + s.attackTrimFraction * (endSec - startSec);
    const trimmed = indices.filter((i) => frames[i].tSec >= cutoff);
    if (trimmed.length > 0) indices = trimmed;
  }

  const midiFloat = median(indices.map((i) => smoothed[i]));

  let clipped = false;
  for (let i = draft.startIndex; i <= draft.endIndex; i++) if (frames[i].clipped) clipped = true;

  // A ranking, not a probability: how tone-like the frames behind this note
  // were, and how far above the noise bed. Used to dim shaky notes in the UI.
  const clarity = indices.reduce((a, i) => a + frames[i].clarity, 0) / indices.length;
  const snr = indices.reduce((a, i) => a + frames[i].snrDb, 0) / indices.length;
  const confidence = clamp01(0.6 * clarity + 0.4 * clamp01((snr - 6) / 24));

  return { ...draft, midiFloat, clipped, confidence };
}

/**
 * Was the gap between two notes real silence, or did the detector merely lose
 * confidence for a moment?
 *
 * This is the whole difference between one held note and two repeated ones,
 * and no amount of pitch analysis can settle it — the answer is in the
 * *level*. A re-articulated note has a genuine drop to the noise floor between
 * its halves; a detector dropout (a breathy moment, a momentary octave
 * ambiguity) does not. So look at whether any frame in the gap actually fell
 * to the background.
 */
function isTrueSilence(
  from: number,
  to: number,
  frames: PitchFrame[],
  voicing: Voicing,
  cfg: DspConfig,
): boolean {
  for (let i = from; i <= to; i++) {
    if (frames[i].bandRmsDb < voicing.floorDb[i] + cfg.voicing.sustainAboveFloorDb) return true;
  }
  return false;
}

/** Typical in-band level of a note, in dBFS. A median, so an attack or a fade
 *  at one end does not stand for the whole. */
function noteLevel(note: Measured, frames: PitchFrame[]): number {
  const levels: number[] = [];
  for (let i = note.startIndex; i <= note.endIndex; i++) levels.push(frames[i].bandRmsDb);
  return median(levels);
}

/** Was every frame in this span louder than `levelDb`? */
function louderThan(from: number, to: number, levelDb: number, frames: PitchFrame[]): boolean {
  for (let i = from; i <= to; i++) if (frames[i].bandRmsDb < levelDb) return false;
  return true;
}

/** Merge same-pitch notes separated only by a brief dropout. Repeats until
 *  stable, since merging two can bring a third within reach. */
function mergeDropouts(
  notes: Measured[],
  context: FrameContext,
  voicing: Voicing,
  cfg: DspConfig,
  framePeriod: number,
): Measured[] {
  const frames = context.frames;
  const s = cfg.segment;
  let changed = true;
  let current = notes;

  while (changed && current.length > 1) {
    changed = false;
    const out: Measured[] = [current[0]];
    for (let n = 1; n < current.length; n++) {
      const previous = out[out.length - 1];
      const next = current[n];
      const gapFrames = next.startIndex - previous.endIndex - 1;
      const gapMs = gapFrames * framePeriod * 1000;
      const samePitch = Math.round(previous.midiFloat) === Math.round(next.midiFloat);
      const silent =
        gapFrames > 0 &&
        isTrueSilence(previous.endIndex + 1, next.startIndex - 1, frames, voicing, cfg);

      // A gap *louder* than the notes on either side of it is a different
      // animal from a dropout: something happened in the room — a cough, a
      // door, a chair — that buried the whistle rather than interrupted it.
      // The tone is unrecoverable while it lasts, but a re-articulation would
      // have been inaudible under it too, so the better guess is that the note
      // continued. Length is no evidence here, which is why this bypasses
      // `gapMergeMs`; that limit exists to stop two genuinely repeated notes
      // in a noisy room from merging, and in that case the gap sits at the
      // *room's* level, below the notes, not above them.
      const masked =
        gapFrames > 0 &&
        !silent &&
        louderThan(
          previous.endIndex + 1,
          next.startIndex - 1,
          Math.min(noteLevel(previous, frames), noteLevel(next, frames)),
          frames,
        );

      if (samePitch && (gapMs <= s.gapMergeMs || masked) && !silent) {
        out[out.length - 1] = measure(
          {
            startIndex: previous.startIndex,
            endIndex: next.endIndex,
            firstPitchIndex: previous.firstPitchIndex,
            refSpan: Math.max(previous.refSpan, next.refSpan),
            glidedIn: previous.glidedIn,
          },
          context,
          cfg,
        );
        changed = true;
      } else {
        out.push(next);
      }
    }
    current = out;
  }

  return current;
}

/**
 * Put back together a note the state machine cut up at its own wobble.
 *
 * The state machine has no way to know that a pitch it has held for
 * `confirmFrames` is about to be abandoned. A wide slow vibrato — ±80 cents at
 * 4 Hz, which is a lot but well within what people produce — dwells near each
 * extreme for around a tenth of a second, which is long enough to look exactly
 * like a note, so a single wobbling note comes out as a trill between two
 * pitches a semitone apart. Neither of which was whistled: the note is the
 * thing the wobble is centred on.
 *
 * Stage D already knows where the wobbling was — a movement it recognised as
 * a transition by size or speed, and then declined to mark because a
 * comparable movement the other way followed within a couple of frames. Two
 * notes whose boundary sits inside that are two halves of one oscillation, and
 * the test cannot fire at a real note change, because a real note puts its own
 * sustain between the two movements and that is far more than a couple of
 * frames.
 *
 * Measuring the reunited note over all of its frames is what makes it come out
 * right: a median over whole periods of an oscillation is its centre.
 */
function mergeWobbles(
  notes: Measured[],
  context: FrameContext,
  oscillating: boolean[],
  voicing: Voicing,
  cfg: DspConfig,
): Measured[] {
  let changed = true;
  let current = notes;

  while (changed && current.length > 1) {
    changed = false;
    const out: Measured[] = [current[0]];
    for (let n = 1; n < current.length; n++) {
      const previous = out[out.length - 1];
      const next = current[n];
      const gapFrames = next.startIndex - previous.endIndex - 1;
      const boundaryWobbles = (): boolean => {
        for (let i = previous.endIndex; i <= next.startIndex; i++) if (!oscillating[i]) return false;
        return true;
      };

      if (
        gapFrames <= 0 &&
        Math.abs(previous.midiFloat - next.midiFloat) <= MAX_WOBBLE_SEMITONES &&
        boundaryWobbles() &&
        !isTrueSilence(previous.endIndex, next.startIndex, context.frames, voicing, cfg)
      ) {
        out[out.length - 1] = measure(
          {
            startIndex: previous.startIndex,
            endIndex: next.endIndex,
            firstPitchIndex: previous.firstPitchIndex,
            refSpan: Math.max(previous.refSpan, next.refSpan),
            glidedIn: previous.glidedIn,
          },
          context,
          cfg,
        );
        changed = true;
      } else {
        out.push(next);
      }
    }
    current = out;
  }

  return current;
}

/**
 * Absorb or discard notes too short to have been whistled deliberately.
 *
 * "Absorb into a neighbour" only makes sense for a neighbour that is actually
 * adjacent. A 60 ms blip half a second away across an unmistakable silence is
 * not a fragment of the note before it — merging the two would stretch one note
 * over the rest, hand the survivor the *blip's* pitch, feed the attack trim a
 * span three quarters of which is silence, and swallow the rest in between. So
 * the same contiguity rule that governs dropout merging governs this: close in
 * time, and no silence in between. A blip that fails it is simply dropped,
 * which is what "too short to have been deliberate" meant in the first place.
 */
function resolveShortNotes(
  notes: Measured[],
  context: FrameContext,
  voicing: Voicing,
  cfg: DspConfig,
  framePeriod: number,
): Measured[] {
  const s = cfg.segment;
  const minSec = s.minNoteMs / 1000;
  const mergeSt = (2 * s.toleranceCents) / 100;

  /** Are these two notes adjacent enough for one to be part of the other? */
  const contiguous = (a: Measured, b: Measured): boolean => {
    const [first, second] = a.startIndex < b.startIndex ? [a, b] : [b, a];
    const gapFrames = second.startIndex - first.endIndex - 1;
    if (gapFrames <= 0) return true;
    if (gapFrames * framePeriod * 1000 > s.gapMergeMs) return false;
    return !isTrueSilence(first.endIndex + 1, second.startIndex - 1, context.frames, voicing, cfg);
  };

  let current = notes;
  for (;;) {
    const durationOf = (d: Measured): number => (d.endIndex - d.startIndex + 1) * framePeriod;
    let victim = -1;
    let shortest = Infinity;
    for (let i = 0; i < current.length; i++) {
      const duration = durationOf(current[i]);
      if (duration < minSec && duration < shortest) {
        shortest = duration;
        victim = i;
      }
    }
    if (victim < 0) return current;

    const target = current[victim];
    const candidates: number[] = [];
    if (victim > 0) candidates.push(victim - 1);
    if (victim < current.length - 1) candidates.push(victim + 1);

    let best = -1;
    let bestDistance = Infinity;
    for (const c of candidates) {
      if (!contiguous(current[c], target)) continue;
      const distance = Math.abs(current[c].midiFloat - target.midiFloat);
      if (distance <= mergeSt && distance < bestDistance) {
        bestDistance = distance;
        best = c;
      }
    }

    const next = current.filter((_, i) => i !== victim);
    if (best >= 0) {
      const keeper = current[best];
      // The surviving note inherits the earlier of the two settling points:
      // whichever came first is where this combined note stopped being an
      // approach and started being a pitch.
      const startIndex = Math.min(keeper.startIndex, target.startIndex);
      const settled = [keeper.firstPitchIndex, target.firstPitchIndex].filter((i) => i >= 0);
      const merged = measure(
        {
          startIndex,
          endIndex: Math.max(keeper.endIndex, target.endIndex),
          firstPitchIndex: settled.length > 0 ? Math.min(...settled) : -1,
          refSpan: Math.max(keeper.refSpan, target.refSpan),
          glidedIn: best > victim ? target.glidedIn : keeper.glidedIn,
        },
        context,
        cfg,
      );
      next[best > victim ? best - 1 : best] = merged;
    }
    current = next;
  }
}

/**
 * Stage H — the global tuning offset.
 *
 * A whistler who sits consistently 40 cents sharp gets coin-flip rounding on
 * every single note. Measuring that bias once and removing it fixes all of
 * them together, which is a much better deal than it sounds.
 *
 * The residuals live on a circle — +49 cents and −49 cents are two cents
 * apart, not 98 — so an arithmetic mean is the wrong tool and would report
 * roughly zero for a whistler who is consistently half a semitone off. The
 * circular mean maps each residual to an angle on the mod-100-cent circle,
 * averages the unit vectors, and reads the answer back off the resultant. The
 * resultant's *length* comes free and is exactly what we need to decide
 * whether to believe the answer at all: near 1 the residuals agree and the
 * whistler is genuinely detuned; near 0 they are scattered and the whistler is
 * merely unsteady, which is not something a global offset can fix.
 *
 * Weighted by duration, because a half-second note is much better evidence
 * about someone's tuning than a 90 ms grace note.
 */
function globalTuningOffset(residuals: { cents: number; weight: number }[], cfg: DspConfig): number {
  const t = cfg.tuning;
  if (!t.enableAutoTuning || residuals.length < t.minTuningNotes) return 0;

  let x = 0;
  let y = 0;
  let totalWeight = 0;
  for (const { cents, weight } of residuals) {
    const angle = (2 * Math.PI * cents) / 100;
    x += weight * Math.cos(angle);
    y += weight * Math.sin(angle);
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;

  const concentration = Math.hypot(x, y) / totalWeight;
  if (concentration < t.minTuningConcentration) return 0;

  let cents = (100 * Math.atan2(y, x)) / (2 * Math.PI);
  // Back onto [-50, +50): the circular mean is only defined up to a semitone,
  // and beyond half a semitone the "correction" would just relabel every note.
  if (cents >= 50) cents -= 100;
  if (cents < -50) cents += 100;
  return Math.max(-t.maxTuningOffsetCents, Math.min(t.maxTuningOffsetCents, cents));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Segment a frame track into notes.
 *
 * Pure and deterministic: the same frames and config always give the same
 * notes, which is what makes the harness's `--from-cache` sweep meaningful.
 */
export function segmentNotes(
  frames: PitchFrame[],
  cfg: DspConfig,
  sampleRate: number,
): SegmentationResult {
  if (frames.length === 0) return { notes: [], tuningOffsetCents: 0 };

  const framePeriod = cfg.analysis.hopSize / sampleRate;
  const a4Hz = cfg.tuning.a4Hz;

  // A–D.
  const { voicing, runs, smoothed, transitional, oscillating } = prepare(frames, cfg, sampleRate);

  // E — the state machine.
  const drafts = runStateMachine(cfg, { runs, smoothed, transitional });

  // F — per-note pitch. A draft with no usable pitch anywhere (all glide, all
  // gap) has nothing to report and is dropped rather than named.
  const context: FrameContext = {
    frames,
    smoothed,
    usable: frames.map((_, i) => voicing.voiced[i] && !transitional[i]),
  };
  let measured = drafts
    .map((d) => measure(d, context, cfg))
    .filter((m) => Number.isFinite(m.midiFloat));

  // G — gaps and lengths. Dropout merging runs twice: absorbing a short note
  // can leave two same-pitch neighbours newly adjacent.
  measured = mergeWobbles(measured, context, oscillating, voicing, cfg);
  measured = mergeDropouts(measured, context, voicing, cfg, framePeriod);
  measured = resolveShortNotes(measured, context, voicing, cfg, framePeriod);
  measured = mergeDropouts(measured, context, voicing, cfg, framePeriod);

  // H — global tuning.
  const half = framePeriod / 2;
  const residuals = measured.map((m) => ({
    cents: 100 * (m.midiFloat - Math.round(m.midiFloat)),
    weight: (m.endIndex - m.startIndex + 1) * framePeriod,
  }));
  const tuningOffsetCents = globalTuningOffset(residuals, cfg);
  const tuningOffsetSt = tuningOffsetCents / 100;

  const notes: Note[] = [];
  for (const m of measured) {
    // The frames are instants at window centres, so the note owns half a hop
    // either side of its first and last frame. Adjacent notes then meet
    // exactly, never overlap.
    const startSec = Math.max(0, frames[m.startIndex].tSec - half);
    const endSec = frames[m.endIndex].tSec + half;

    // Report the pitch in the standard reference: the measured pitch with the
    // whistler's global tuning bias removed. `tuningOffsetCents` records what
    // was taken out, so multiplying `pitchHz` by 2^(offset/1200) recovers the
    // raw measurement. Doing it this way keeps `midi`, `noteName`, `pitchHz`
    // and `centsOffset` mutually consistent under one reference, which is the
    // invariant every consumer of a `Note` relies on.
    const correctedMidi = m.midiFloat - tuningOffsetSt;
    const pitchHz = midiToHz(correctedMidi, a4Hz);
    const { midi, centsOffset } = nearestNote(pitchHz, a4Hz);

    const previous = notes[notes.length - 1];
    const flags: NoteFlags = {};
    if (m.glidedIn) flags.glidedIn = true;
    if (m.refSpan > cfg.segment.toleranceCents / 100) flags.drifted = true;
    if (m.clipped) flags.clipped = true;

    notes.push({
      midi,
      noteName: midiToName(midi),
      centsOffset,
      startSec,
      endSec,
      durationSec: endSec - startSec,
      pitchHz,
      confidence: m.confidence,
      gapBeforeSec: previous ? Math.max(0, startSec - previous.endSec) : 0,
      flags,
    });
  }

  return { notes, tuningOffsetCents };
}

/** Rough duration classes, relative to the median note length. The `Note`
 *  contract has no field for this — it is a display concern, and one that only
 *  makes sense relative to the rest of the take. */
export type DurationClass = "short" | "medium" | "long";

export function durationClasses(notes: Note[]): DurationClass[] {
  if (notes.length === 0) return [];
  const reference = median(notes.map((n) => n.durationSec));
  return notes.map((n) => {
    const ratio = n.durationSec / reference;
    if (ratio < 0.7) return "short";
    if (ratio > 1.5) return "long";
    return "medium";
  });
}

/** Whether a rest should be drawn before this note. `Note.gapBeforeSec` holds
 *  the measurement; `SegmentConfig.restGapMs` holds the taste. */
export function hasRestBefore(note: Note, cfg: DspConfig): boolean {
  return note.gapBeforeSec * 1000 > cfg.segment.restGapMs;
}
