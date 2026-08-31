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
 *   D. **Glide marking** — steep slopes are transitions, not notes; and the
 *      wobble-free *centre* of the trail, with the steps in it.
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

/** Percentile of the nearby shapeless frames taken as the provisional level of
 *  the room, against which a frame is judged too loud to be evidence about it.
 *  The *median*, deliberately: it is the statistic that flips exactly when the
 *  majority of the window does, which is what makes "a loud event" and "a
 *  louder room" separable by their duration alone. A low percentile would sit
 *  in the quiet tail and could not be moved by a room change at all. */
const BACKGROUND_SEED_PERCENTILE = 50;

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
 * Percentile `p` of `level` over the frames in `sample` nearest to each frame.
 *
 * `sample` is a sorted list of frame indices — whichever frames the caller
 * believes are evidence. The window is centred and `windowFrames` wide, and
 * where it holds fewer than `minSamples` of them it reaches outwards for the
 * nearest evidence in either direction rather than swapping in a different
 * estimator. The sample set then changes by at most a frame or two from one
 * position to the next, so the result moves continuously. That matters more
 * than it sounds: a floor that jumps tens of dB between one frame and the next
 * takes `isTrueSilence` with it, and a spurious "silence" is what turns one
 * held note into a stutter of re-articulated ones.
 *
 * `-Infinity` everywhere when there is not enough evidence to have an opinion.
 */
function nearestPercentile(
  level: number[],
  sample: number[],
  frameCount: number,
  windowFrames: number,
  minSamples: number,
  p: number,
): number[] {
  const out = new Array<number>(frameCount).fill(-Infinity);
  if (sample.length < MIN_FLOOR_SAMPLES) return out;

  const half = Math.max(1, windowFrames >> 1);
  const values: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < frameCount; i++) {
    // [i - half, i + half] as a half-open range of positions into `sample`.
    // Both pointers only ever advance, so the whole loop is linear.
    while (lo < sample.length && sample[lo] < i - half) lo++;
    while (hi < sample.length && sample[hi] <= i + half) hi++;

    let left = lo;
    let right = hi;
    let count = right - left;
    while (count < minSamples && (left > 0 || right < sample.length)) {
      const distanceLeft = left > 0 ? i - sample[left - 1] : Infinity;
      const distanceRight = right < sample.length ? sample[right] - i : Infinity;
      if (distanceLeft <= distanceRight) left--;
      else right++;
      count++;
    }

    values.length = 0;
    for (let q = left; q < right; q++) values.push(level[sample[q]]);
    out[i] = percentile(values, p);
  }
  return out;
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
 * Deciding *which* frames are evidence about the room is the subtle part.
 * "Not tone-shaped" is necessary and nowhere near sufficient: a cough, a door,
 * a chair scrape and a hand over the microphone all fail the shape tests at
 * 40 dB above the room, and letting one into the sample set drags the floor up
 * to its level for as long as the window remembers it — which blanks the
 * transcription *after* the event, seconds later, where nobody would think to
 * look for the cause. The microphone warm-up is the same bug wearing a
 * different hat: a take that starts whistling at t=0 has its opening frames
 * excluded from voicing, and if those then count as "background" the floor is
 * set to the level of the whistle and the whole take disappears.
 *
 * So background evidence has to be *quiet as well as shapeless*, which is
 * circular — quiet relative to what? — and the way out of the circle is a
 * **local** answer. Every frame gets a seed: the median level of the shapeless
 * frames around it, over the same span the floor itself is measured on. A frame
 * more than `backgroundAboveFloorDb` above its own seed is an event and not
 * evidence.
 *
 * Making that comparison local rather than global is what lets the floor follow
 * a room that *changes*. An earlier version compared every frame against one
 * number for the whole take, which meant no recording could contain two rooms:
 * step the noise up by 18 dB at t=8s — a window opening, a fan starting, a
 * phone put down on a different table — and not one frame after the step was
 * ever believed as background again. The floor stayed 19 dB low for the rest of
 * the take, the onset gate under-gated by the same amount, and `isTrueSilence`
 * stopped being able to fire at all. Against a local median the same step is
 * tracked in about a second and a half.
 *
 * A median, and a span of seconds, is also exactly what separates the two cases
 * the paragraphs above want separated, and it says so honestly: an event
 * shorter than half the window cannot move the median and is rejected; a shift
 * that outlasts it becomes the new room. "Loud" and "sustained" are the only
 * two facts available, and this uses both.
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

  const windowFrames = Math.max(1, Math.round(v.noiseFloorWindowSec / framePeriod));
  const shapeless: number[] = [];
  for (let i = 0; i < n; i++) if (!tonal[i]) shapeless.push(i);

  // The seed insists on a *quota* of evidence, not just a span of time, and
  // that is what keeps it honest where the room is barely observable. Under a
  // note that never stops, the only shapeless frames for seconds around may be
  // the very burst being judged — and a median of the burst says the burst is
  // the room. Demanding a window's worth of samples makes the estimate reach
  // back to the last time the room was actually audible instead.
  const seed = nearestPercentile(
    level,
    shapeless,
    n,
    windowFrames,
    windowFrames,
    BACKGROUND_SEED_PERCENTILE,
  );
  const background = new Array<boolean>(n).fill(false);
  const backgroundIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!tonal[i] && level[i] <= seed[i] + v.backgroundAboveFloorDb) {
      background[i] = true;
      backgroundIndices.push(i);
    }
  }

  const floorDb = nearestPercentile(
    level,
    backgroundIndices,
    n,
    windowFrames,
    MIN_FLOOR_SAMPLES,
    v.noiseFloorPercentile,
  );

  const voiced = new Array<boolean>(n).fill(false);
  let holding = false;
  for (let i = 0; i < n; i++) {
    if (!candidate[i]) {
      holding = false;
      continue;
    }
    const required = holding ? v.sustainAboveFloorDb : v.onsetAboveFloorDb;
    if (frames[i].bandRmsDb >= levelGate(floorDb[i], required, cfg)) {
      voiced[i] = true;
      holding = true;
    } else {
      holding = false;
    }
  }

  return { tonal, candidate, background, floorDb, voiced };
}

/**
 * The level a frame has to clear here, in dBFS.
 *
 * Two thresholds, and the *higher* wins. The adaptive one is the interesting
 * one and does the work on any ordinary recording. The absolute one is a
 * backstop against the adaptive one being nonsense, and it has to exist because
 * "nonsense" is not hypothetical: an imported file with a muted stretch in it —
 * an editor's trimmed tail, a phone that dropped the mic for a second — puts
 * digital zeroes in the sample set, and a fifth of a take at −240 dBFS drags
 * the percentile there too. `floor + 12` is then −228, every frame in the file
 * clears it, and the level gate silently stops existing for the whole take. It
 * also quietly made most of the synthetic segmentation tests vacuous with
 * respect to that gate, because the gaps `sequence()` leaves between notes are
 * digital silence.
 *
 * The same maximum is what `isTrueSilence` compares against, so the two agree
 * on where the background is by construction.
 */
function levelGate(floorDb: number, aboveFloorDb: number, cfg: DspConfig): number {
  return Math.max(cfg.voicing.absoluteFloorDb, floorDb + aboveFloorDb);
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
  /** Per frame: the pitch the trail is locally *centred* on, with any wobble
   *  averaged out. NaN outside voiced runs. See `centreTrack`. */
  centre: number[];
  /** Per frame: this is where the centre stepped from one pitch to another —
   *  one frame per step, at the moment it happened. See `markSteps`. */
  stepped: boolean[];
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
  const centre = centreTrack(runs, smoothed, framePeriod);
  const stepped = markSteps(runs, centre, framePeriod, cfg);

  return { voicing, runs, smoothed, transitional, oscillating, centre, stepped };
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
 *  Applied to the *whole chain*, not per merge: twice this is the widest the
 *  reported pitches of all the fragments being reunited may span between them,
 *  so a wobble of up to roughly ±2 semitones about its centre is still put back
 *  together and one wider than that comes apart. Measured against the chain's
 *  own extremes rather than its running median, because a bound that moves as
 *  the median moves is not a bound at all — see `mergeWobbles`. Measured: one
 *  note through ±200 cents at 4 Hz, several at ±300. */
const MAX_WOBBLE_SEMITONES = 2;

/** How far the pitch an oscillation is centred on may wander across the
 *  material being reunited, in semitones.
 *
 *  This is the test that tells a wobbling note from a wobbling *melody*, and it
 *  needs no margin for the wobble itself — `centreTrack` has already removed
 *  that — so what is left to allow for is the whistler's own unsteadiness
 *  within one note. Half a semitone is comfortably under the smallest interval
 *  anyone plays and comfortably over the few tens of cents a held note drifts
 *  by. */
const WOBBLE_CENTRE_SEMITONES = 0.6;

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
 * comparable movement the other way keeps its pitch rather than being blanked.
 *
 * Note what that test can and cannot claim. "Something comparable happened the
 * other way within a couple of frames" is good enough to decide *not to blank*
 * — being half of something is reason enough to keep a frame's pitch — and it
 * is nowhere near good enough to conclude "this is one note wobbling". A
 * legato semitone step wearing a ±80-cent vibrato passes it easily: the climb
 * runs from the departing note's trough to the arriving note's peak and the
 * swing back covers most of it. The `oscillating` map it produces is therefore
 * a *hint* for stage G and not a licence; stage G tests the centre of the
 * material itself before acting on it, which is the measurement that can tell
 * these two apart. See `centreTrack`.
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

      /** Is there a comparable movement the other way right next to this one? */
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
        // Not a transition — but worth remembering *where* the wobbling might
        // have been, because the state machine cannot tell an oscillation's
        // extreme from a new note and will happily report a wide slow vibrato
        // as a trill. Stage G takes this as its list of places to *look*, and
        // decides for itself.
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

/** Window the local pitch centre is measured over, in milliseconds. Chosen to
 *  span a whole cycle of the slowest wobble anyone produces (human vibrato
 *  bottoms out around 4 Hz, so 250 ms), because a half-cycle window would
 *  report the wobble's own swing as movement of its centre. */
const CENTRE_WINDOW_MS = 300;

/**
 * The pitch the trail is locally centred on, with any wobble averaged out.
 *
 * This is the one measurement the rest of the file cannot make for itself:
 * whether a stretch of trail is *one* pitch being wobbled around or two. A
 * ±80-cent vibrato on a legato semitone step looks, frame to frame and swing to
 * swing, exactly like a ±80-cent vibrato on a held note — the two notes' pitch
 * ranges overlap by more than half, so every local test is ambiguous and the
 * running median simply slides across the boundary. The centres are not
 * ambiguous at all: one moves by a semitone and the other does not.
 *
 * Two choices make it work.
 *
 * **Midpoint of the extremes**, not a mean or a median. Over any window
 * spanning at least one full cycle, the highest and lowest points of an
 * oscillation *are* its two extremes whatever the phase, so their midpoint is
 * the centre exactly — no leakage of the wobble's amplitude, no dependence on
 * where in the cycle the window happens to land. A mean or a median over a
 * non-integer number of cycles has neither property and reports a centre that
 * wobbles in its own right.
 *
 * **The least-spread window containing the frame**, not the one centred on it.
 * A window centred on a note change straddles both notes, so its extremes are
 * the low of one and the high of the other and its midpoint is halfway between
 * — which would smear every boundary across the window's whole width and put a
 * long false plateau at the halfway pitch, exactly where the boundary needs to
 * be sharp. Straddling is visible without knowing where the boundary is: a
 * window inside one note spans the wobble, one across a boundary spans the
 * wobble *plus the interval*. Preferring the narrowest available window
 * therefore snaps the estimate to whichever note the frame mostly belongs to,
 * and the centre steps at the boundary instead of ramping through it. It also
 * makes the estimate ignore a scoop or a glide for free: those are the widest
 * windows around, and never the ones chosen.
 */
function centreTrack(runs: Run[], smoothed: number[], framePeriod: number): number[] {
  const centre = new Array<number>(smoothed.length).fill(NaN);
  const width = Math.max(3, Math.round(CENTRE_WINDOW_MS / 1000 / framePeriod));

  for (const run of runs) {
    const length = run.end - run.start + 1;
    const w = Math.min(width, length);
    const positions = length - w + 1;
    const spreads = new Array<number>(positions);
    const middles = new Array<number>(positions);
    for (let p = 0; p < positions; p++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = run.start + p; j < run.start + p + w; j++) {
        if (smoothed[j] < lo) lo = smoothed[j];
        if (smoothed[j] > hi) hi = smoothed[j];
      }
      spreads[p] = hi - lo;
      middles[p] = 0.5 * (lo + hi);
    }

    for (let i = run.start; i <= run.end; i++) {
      const from = Math.max(0, i - run.start - w + 1);
      const to = Math.min(positions - 1, i - run.start);
      let best = from;
      for (let p = from + 1; p <= to; p++) if (spreads[p] < spreads[best]) best = p;
      centre[i] = middles[best];
    }
  }

  return centre;
}

/** How far the centre must move for the movement to have been a note change
 *  rather than an unsteady hand, in semitones. The smallest interval anybody
 *  plays is one semitone and the widest a held note wanders is a few tens of
 *  cents, so this sits between them — and deliberately below `glideMinSemitones`,
 *  because by the time the centre has moved this far the *pitch* has already
 *  moved further, and it is the pitch that stage D was measuring. */
const STEP_CENTRE_SEMITONES = 0.6;

/** Stillness on each side of a step, in milliseconds. A note change has a note
 *  on either side of it; the run-up into the very first note of a phrase has
 *  only one, which is what keeps this from firing on a scoop. */
const STEP_PLATEAU_MS = 120;

/**
 * Where did the pitch the trail is centred on step from one note to another?
 *
 * The state machine works frame by frame against a running median, and there is
 * a class of note change it structurally cannot see: a legato semitone step
 * underneath a wobble at least as wide as the step. The arriving note's low
 * swings land inside `toleranceCents` of the departing note's centre, so every
 * frame is individually "consistent" and the reference simply slides across
 * the boundary. Measured on a wobbling `84 86 88 89 91`: the 88 and the 89 came
 * out as one note of 88.65, a pitch nobody whistled.
 *
 * The centre track has the wobble removed, so on it the same passage is a
 * staircase and the boundaries are exactly the risers. Finding them is stage
 * D's own movement machinery run over the centre instead of the raw pitch —
 * same question, asked of a signal where it has an answer.
 *
 * Two guards keep this from firing where the state machine was already right.
 * A step must *land*: the centre has to be as still after it as before it, for
 * about the length of the shortest note anyone whistles. That is what separates
 * a note change from a scoop (which has no note before it, only a run-up) and
 * from a whistler drifting slowly across a semitone (which never stops moving).
 * And a step is reported as the single frame where the centre moved fastest —
 * the riser's midpoint, which is where the note actually changed — rather than
 * as the whole smeared ramp, so no frame loses its pitch to this.
 */
function markSteps(
  runs: Run[],
  centre: number[],
  framePeriod: number,
  cfg: DspConfig,
): boolean[] {
  const stepped = new Array<boolean>(centre.length).fill(false);
  const plateau = Math.max(2, Math.round(STEP_PLATEAU_MS / 1000 / framePeriod));
  const slope = new Array<number>(centre.length).fill(0);

  for (const run of runs) {
    for (let i = run.start; i <= run.end; i++) {
      const previous = Math.max(run.start, i - 1);
      const next = Math.min(run.end, i + 1);
      if (next === previous) continue;
      slope[i] = (centre[next] - centre[previous]) / ((next - previous) * framePeriod);
    }

    for (const leg of movementLegs(run, centre, slope, framePeriod, cfg)) {
      if (Math.abs(leg.semitones) < STEP_CENTRE_SEMITONES) continue;
      // A step is *abrupt*. The centre is a plateau-and-riser affair by
      // construction, so a real note change moves it within a frame or two and
      // reads as tens of semitones per second; a whistler sliding across a
      // semitone over a whole second moves it just as far but a hundred times
      // more slowly, and that is drift, which `driftCapSemitones` already has
      // an opinion about. `glideSlopeStPerSec` is the existing statement of
      // where "too fast to be a note" begins, so it is the one used here.
      if (Math.abs(leg.semitones) / leg.seconds < cfg.segment.glideSlopeStPerSec) continue;
      // Still on both sides? Compare the centre a plateau's width out from each
      // end of the movement with the movement's own endpoints: if the centre
      // is still travelling out there, this was not a step but part of a longer
      // journey, and stage D's raw-pitch pass is the right judge of it.
      const before = leg.start - plateau;
      const after = leg.end + plateau;
      if (before < run.start || after > run.end) continue;
      if (Math.abs(centre[before] - centre[leg.start]) > STEP_CENTRE_SEMITONES / 2) continue;
      if (Math.abs(centre[after] - centre[leg.end]) > STEP_CENTRE_SEMITONES / 2) continue;

      let at = leg.start;
      for (let i = leg.start; i <= leg.end; i++) {
        if (Math.abs(slope[i]) > Math.abs(slope[at])) at = i;
      }
      stepped[at] = true;
    }
  }

  return stepped;
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
  /** Frames where stage D saw the centre of the trail step to a new pitch. */
  stepped: boolean[];
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

      // Stage D saw the pitch this passage is centred on step to a new one
      // here. That is a note boundary the running reference cannot find on its
      // own — under a wobble wider than the step, every individual frame of the
      // arriving note is still "consistent" with the departing one, so the
      // reference slides across the boundary and reports a pitch between the
      // two that nobody whistled. It is therefore imposed rather than inferred:
      // close the note and start the next from a clean slate here. Checked
      // *before* the glide rule below, because a legato step is a glide, and a
      // short one at that: the couple of frames where the pitch is in motion
      // are exactly where the boundary is.
      //
      // It applies whether or not the note has settled on a pitch, which is the
      // case that matters most. A wobbling legato run gives the confirmation
      // rule almost nothing to work with — the pitch is in motion nearly every
      // frame — so a draft can run through two or three whole notes without
      // ever settling, and everything it swallowed is then measured as approach
      // to whichever note it finally did settle on. Measured on an ascending
      // `84 86 88 90 92 94` under ±70 cents: three notes vanished into one.
      if (input.stepped[i] && i > current.startIndex) {
        current.endIndex = i - 1;
        finish();
        draft = { startIndex: i, endIndex: i, firstPitchIndex: -1, refSpan: 0, glidedIn: false };
        pending = input.transitional[i] ? [] : [{ index: i, m }];
        continue;
      }

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
    if (frames[i].bandRmsDb < levelGate(voicing.floorDb[i], cfg.voicing.sustainAboveFloorDb, cfg)) {
      return true;
    }
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

/** What fraction of this span was louder than `levelDb`? */
function fractionLouderThan(
  from: number,
  to: number,
  levelDb: number,
  frames: PitchFrame[],
): number {
  let louder = 0;
  for (let i = from; i <= to; i++) if (frames[i].bandRmsDb >= levelDb) louder++;
  return louder / (to - from + 1);
}

/** How much of a gap has to be louder than the notes around it before the gap
 *  is a masking event rather than a rest.
 *
 *  A fraction rather than "all of it", because a real event is not a rectangle:
 *  a door swinging shut has a body and a decay, and one frame in its tail
 *  dipping under the whistle's level should not turn one held note into two
 *  repeated ones. It used to, which made the outcome non-monotonic in the gap's
 *  length — the same event a little longer or a little shorter could go either
 *  way for no reason a listener would recognise. Four frames in five is a
 *  comfortable majority and still nowhere near what an ordinary quiet rest
 *  produces, which is zero. */
const MASKED_GAP_FRACTION = 0.8;

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
      // continued. That reasoning is why the ordinary `gapMergeMs` limit does
      // not apply: it exists to stop two genuinely repeated notes in a noisy
      // room from merging, and in that case the gap sits at the *room's* level,
      // below the notes, not above them.
      //
      // But the reasoning has a shelf life, and `maskedGapMs` is it. "A
      // re-articulation would have been inaudible" is a fair guess about a door
      // slam and an absurd one about five seconds of noise, over which a
      // whistler could have played a whole phrase. Past the limit the honest
      // answer is that we cannot tell, and two notes is the answer that at
      // least reports the two things actually heard.
      const masked =
        gapFrames > 0 &&
        !silent &&
        gapMs <= s.maskedGapMs &&
        fractionLouderThan(
          previous.endIndex + 1,
          next.startIndex - 1,
          Math.min(noteLevel(previous, frames), noteLevel(next, frames)),
          frames,
        ) >= MASKED_GAP_FRACTION;

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
 * comparable movement the other way brought the pitch back where it started.
 * A boundary sitting inside that is a candidate for reassembly.
 *
 * A *candidate*, not a conclusion, and this is where an earlier version of
 * this function went confidently wrong. Wobbling a melody makes the state
 * machine emit fragments at every swing — six of them across two legato notes
 * — and merging them pairwise against the running median walks: each merge
 * moves the median a little, which brings the next fragment within reach,
 * which moves it again. Twelve merges once walked from 84.4 to 86.6 and
 * reported a six-note chromatic run as two notes. Nothing local can stop that,
 * because locally every step of the walk is a perfectly ordinary wobble.
 *
 * So the test is not local. The whole of the material being reunited must be
 * an oscillation about a centre that stays put (`centre`, whose window is a
 * full wobble cycle, so it is blind to the wobble and sees only where the
 * wobble sits), and the fragments must between them span no more than one
 * wobble's width measured from where the chain *started* rather than from the
 * median as it drifts. A melody fails both the moment it moves on.
 *
 * Measuring the reunited note over all of its frames is what makes it come out
 * right: a median over whole periods of an oscillation is its centre.
 */
function mergeWobbles(
  notes: Measured[],
  context: FrameContext,
  oscillating: boolean[],
  transitional: boolean[],
  centre: number[],
  cfg: DspConfig,
): Measured[] {
  /** A merged note plus the pitch extremes of everything that went into it —
   *  the chain's own history, which is what bounds the walk. */
  interface Chain {
    note: Measured;
    lo: number;
    hi: number;
  }

  const start = (note: Measured): Chain => ({ note, lo: note.midiFloat, hi: note.midiFloat });

  /** Does the pitch this stretch is centred on hold still across all of it? */
  const centreHolds = (from: number, to: number): boolean => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i <= to; i++) {
      const c = centre[i];
      if (!Number.isFinite(c)) continue;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    return hi - lo <= WOBBLE_CENTRE_SEMITONES;
  };

  let changed = true;
  let current = notes;

  while (changed && current.length > 1) {
    changed = false;
    const out: Chain[] = [start(current[0])];
    for (let n = 1; n < current.length; n++) {
      const chain = out[out.length - 1];
      const previous = chain.note;
      const next = current[n];
      const gapFrames = next.startIndex - previous.endIndex - 1;
      const boundaryMoves = (): boolean => {
        for (let i = previous.endIndex; i <= next.startIndex; i++) {
          if (!oscillating[i] && !transitional[i]) return false;
        }
        return true;
      };

      if (
        gapFrames <= 0 &&
        Math.max(chain.hi, next.midiFloat) - Math.min(chain.lo, next.midiFloat) <=
          2 * MAX_WOBBLE_SEMITONES &&
        boundaryMoves() &&
        // From where the first note settled, not from where it starts: its
        // opening frames are approach, and on a legato step they are still
        // centred on the note being left.
        centreHolds(
          previous.firstPitchIndex >= 0 ? previous.firstPitchIndex : previous.startIndex,
          next.endIndex,
        )
        // No silence test here, deliberately. `gapFrames <= 0` means these two
        // notes touch, and every frame inside a note is a *voiced* frame, which
        // by construction cleared the sustain threshold over the floor. There is
        // no room between them for silence to be in, so a check would only look
        // reassuring. Dropout merging, where a real gap does exist, is where
        // that question belongs.
      ) {
        chain.note = measure(
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
        chain.lo = Math.min(chain.lo, next.midiFloat);
        chain.hi = Math.max(chain.hi, next.midiFloat);
        changed = true;
      } else {
        out.push(start(next));
      }
    }
    current = out.map((c) => c.note);
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
  const { voicing, runs, smoothed, transitional, oscillating, centre, stepped } = prepare(
    frames,
    cfg,
    sampleRate,
  );

  // E — the state machine.
  const drafts = runStateMachine(cfg, { runs, smoothed, transitional, stepped });

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
  measured = mergeWobbles(measured, context, oscillating, transitional, centre, cfg);
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
