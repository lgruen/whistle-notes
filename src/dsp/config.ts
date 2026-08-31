/**
 * Default parameters and the user-facing presets.
 *
 * Every value here is a **starting point** chosen from the physics of
 * whistling and from what the detector can resolve — not a tuned constant.
 * M2/M3 re-derive them from measured histograms on real recordings using the
 * harness's sweep mode. Treat a number in this file as a hypothesis.
 *
 * Part of the pure `src/dsp` island: no browser globals, no Node built-ins.
 */

import type { DspConfig, DspConfigOverrides } from "./types.js";

export const DEFAULT_CONFIG: DspConfig = {
  analysis: {
    // 2048 samples ≈ 43 ms at 48 kHz. The trade is resolution against
    // stationarity: longer windows localise the peak better but smear
    // vibrato, and a whistle's vibrato is fast enough to matter.
    windowSize: 2048,
    // FFT length 8192. Padding buys no new information — it interpolates the
    // spectrum so the 3-point parabolic peak fit sits on a smoother curve and
    // stops biasing its answer towards the bin centre.
    zeroPadFactor: 4,
    // ≈ 94 frames/second at 48 kHz: fine enough to catch a short note's
    // onset, coarse enough to stay cheap on a phone.
    hopSize: 512,
    // Whistles live from roughly 500 Hz to 4 kHz. The margin below catches
    // low whistles while still excluding speech fundamentals (85–255 Hz) and
    // mains hum, which is why band-limiting is such cheap noise rejection.
    minHz: 400,
    maxHz: 4500,
    // Octave-error guard: a half-frequency peak within 6 dB of the winner is
    // more likely to be the true fundamental than a coincidence.
    subOctaveToleranceDb: 6,
    removeDc: true,
  },

  voicing: {
    // A near-pure tone puts most of its in-band energy under one mainlobe;
    // breath noise scores close to zero. 0.5 is a deliberately loose gate —
    // the SNR and hysteresis checks do the discriminating work.
    minClarity: 0.5,
    minSnrDb: 12,
    // Only 6 dB: this rejects genuinely ambiguous frames without punishing a
    // whistle that happens to share the room with a second tone.
    minPeakToSecondDb: 6,
    // The 20th percentile of recent unvoiced levels: low enough to sit in the
    // quiet part of the distribution, high enough not to chase a single
    // anomalously silent frame.
    noiseFloorPercentile: 20,
    // Three seconds, centred. Long enough that a cough cannot move the median
    // of it, short enough that a room which genuinely changes level is tracked
    // in about a second and a half. Those are the same property read two ways,
    // and this number is where the line between them sits.
    noiseFloorWindowSec: 3,
    // A shapeless frame more than 12 dB over the local room level is an
    // *event*, not the room: the same margin a note needs to start is the
    // margin past which "background" stops being a plausible description. Wide
    // enough that the ordinary few-dB breathing of room tone is all still
    // evidence.
    backgroundAboveFloorDb: 12,
    // −70 dBFS, and closer to the signal than "backstop" suggests. Measured on
    // the reference recording: the quietest in-note frame is −69.4 dBFS in band
    // (a note's dying fall) — 0.6 dB of clearance — and the room reads −67.5
    // dBFS as the median of every frame outside a note, −73.7 as the median of
    // frames a clear 150 ms from one. In the real gaps the 20th percentile of
    // those frames — the statistic the adaptive floor tracks — sits near −83,
    // so `floor + 12` is about −71 and the maximum in `levelGate` picks *this*
    // number: the absolute floor is what decides the quiet stretches of that
    // recording, not a rule that never fires. (Run it with `absoluteFloorDb:
    // -Infinity` and the take holds at 38 notes from 0 to −30 dB of
    // attenuation, so the extra notes below are this constant's doing.)
    //
    // It stays at −70 anyway. Lowering it gives back, in proportion, the hole
    // it exists for: one muted stretch at −240 dBFS drags the percentile down
    // with it, `floor + 12` goes to −228, every frame in the file clears it,
    // and the level gate silently stops existing for the whole take.
    //
    // What that costs, stated plainly. Behaviour is robust to attenuation of
    // the reference take — 38 notes at full level, 40 at −18 dB, the melody
    // intact throughout — because the notes are ~40 dB above the floor and the
    // adaptive floor follows the level down. But there is a hard cliff at the
    // bottom, measured on a synthetic five-note melody: at −69.0 dBFS in band
    // the transcript is complete, at −71.0 dBFS it is empty, and nothing in
    // between says why. A user whose whole take lands under the floor gets "no
    // notes found" with no diagnostic — except that the debug panel prints each
    // frame's `bandRmsDb` in dBFS, which is where that question is answered.
    absoluteFloorDb: -70,
    // Asymmetric by design — see VoicingConfig. Starting a note demands
    // 12 dB over the floor; holding one needs only 6.
    onsetAboveFloorDb: 12,
    sustainAboveFloorDb: 6,
    warmupSec: 0.3,
  },

  smoothing: {
    // Under ~32 ms of agreement is not a note anyone whistled.
    minVoicedRunFrames: 3,
    // Five frames ≈ 53 ms. A median removes isolated octave jumps outright
    // rather than averaging them into a wrong-but-plausible pitch, which is
    // exactly the failure mode a mean would produce here.
    medianFilterFrames: 5,
  },

  segment: {
    // 18 semitones/second. The plan proposed 12 on the reasoning that vibrato
    // is much slower than a glide; measurement says otherwise. A sinusoidal
    // vibrato of ±c cents at f Hz peaks at 2π·f·c/100 semitones per second, so
    // the ±60 cents at 5 Hz that a human actually produces peaks at 18.8 —
    // faster than a one-semitone glide taken over 120 ms. The two populations
    // genuinely overlap, and the cost of guessing wrong is asymmetric: marking
    // vibrato as "transitional" strips the middle out of the oscillation and
    // leaves a bimodal set of extremes whose median is unstable (measured:
    // 46 cents of error on a ±60-cent vibrato, and a wrong note at ±80).
    // 18 sits just above human vibrato and well below any real portamento
    // (measured on the reference recording: 95th percentile 13.9 st/s, 99th
    // 20.9, genuine scoops 30–36). The transcription of that recording is
    // identical for anything from 12 to 24, so this is not a fitted constant.
    //
    // The overlap this paragraph describes is not resolved by rate at all. A
    // movement is only transitional if it is not part of an oscillation — if it
    // is not immediately undone — which is what lets the rules below catch slow
    // scoops without stripping the middle out of a wide vibrato. And because a
    // legato step wearing vibrato passes even that test, the last word belongs
    // to the pitch the trail is *centred* on: it moves across a note change and
    // stands still across a wobble. See `centreTrack` in segment.ts.
    glideSlopeStPerSec: 18,
    // Where a movement begins and ends. A whistle held steady wanders by a few
    // cents between frames, which at a 10.7 ms hop is already a couple of
    // semitones per second, so this cannot be near zero; a real scoop runs at
    // 8–40. It only ever decides *extent* — how far a movement reaches — never
    // whether one happened.
    //
    // Not a plateau, and an earlier comment claiming "room to spare" was
    // wrong. Measured on the 150-shape scoop grid it degrades monotonically
    // upwards — 150/150 at 1.5–2, 149 at 2.5–3, 148 at 3.5–4.5, 147 at 5, 138
    // at 8 — because a movement whose ends are cut short stops being
    // recognised as one. On the reference recording it is exact at 3 and at
    // 5–10, and differs by one note at 2 and at 3.5–4.5. Those two facts point
    // in different directions and 3 is where they meet: the best value the
    // synthetic evidence still agrees with.
    //
    // The recording's disagreement at 3.5–4.5 is worth naming, because it looks
    // like a knife edge and is not one. The note that changes is a 150 ms
    // gesture at 21.36 s measured at 1440.5 Hz — 47 cents flat of F#6, which is
    // 53 cents sharp of F6. It is a coin flip between two piano keys, and a
    // couple of frames moving in or out of the attack trim is enough to tip it.
    // What is delicate there is the whistling, not the threshold.
    glideMinSlopeStPerSec: 3,
    // 80 cents. Under half of this is wobble; a movement that covers most of a
    // semitone and does not come back is a transition however long it took.
    // Measured: a scoop of 100–200 cents taken over 160–250 ms runs at 8–11
    // st/s, sails under the 18 st/s rate test, and used to dwell long enough
    // near its starting pitch to confirm a phantom note a semitone flat of the
    // real one — 43 of 150 scoop shapes on a synthetic grid did exactly that.
    glideMinSemitones: 0.8,
    // 60 cents — a bit over half a semitone. The "wobble snap" knob.
    //
    // It says how far a single frame may sit from the running reference and
    // still be the same note, and it is *not* the widest wobble the pipeline
    // survives: a vibrato of ±90 cents swings three times this far and still
    // comes out as one correctly-named note, because stage G puts the pieces
    // back together wherever the pitch they are centred on holds still.
    // Measured limits of that repair, on a 1.2 s held note: one note through
    // ±200 cents at 4 Hz, three notes at ±300. Nobody wobbles by half an
    // octave, but the boundary is real, it is pinned in test/glide.test.ts,
    // and past it the pipeline reports several plausible notes rather than one
    // right one — which is the honest failure of the two available.
    toleranceCents: 60,
    refMedianLength: 15,
    // 7 frames ≈ 75 ms at the default hop, which is deliberately close to
    // `minNoteMs`: committing a note on less evidence than the shortest note
    // we are willing to report would be incoherent. Measured, not guessed —
    // the plan started at 3 frames (32 ms) and synthetic vibrato of ±60 cents
    // at 5 Hz then split into twelve notes, because a 5 Hz vibrato dwells
    // ~40 ms near each extreme and three frames of "agreement" at the top of a
    // wobble look exactly like a new note. Human vibrato is the constraint
    // here, and it sets the floor at roughly 60 ms.
    //
    // It cannot be raised much further to buy more wobble immunity: a wide
    // wobble at 4 Hz dwells ~100 ms near each extreme, so the value that would
    // out-wait it is also long enough to swallow real notes. That is why the
    // wobble is repaired after the fact instead.
    confirmFrames: 7,
    driftCapSemitones: 1.5,
    // Whistlers scoop into notes. Dropping the first quarter of a long note
    // keeps the approach out of the pitch estimate.
    attackTrimFraction: 0.25,
    attackTrimMinMs: 120,
    // 80 ms is around the shortest deliberate note in a whistled melody.
    minNoteMs: 80,
    // Under 60 ms at the same pitch is a detector dropout, not a rest.
    gapMergeMs: 60,
    // 400 ms for a gap the room drowned out. That is comfortably longer than
    // the events this rule exists for — a cough, a door, a chair scrape all
    // run 150–350 ms — and comfortably shorter than any stretch over which a
    // whistler could have played something we would then be discarding.
    maskedGapMs: 400,
    restGapMs: 180,
  },

  tuning: {
    a4Hz: 440,
    enableAutoTuning: true,
    maxTuningOffsetCents: 50,
    // Circular resultant length; below this the offsets are scattered enough
    // that "the whistler is detuned" is the wrong explanation.
    minTuningConcentration: 0.6,
    minTuningNotes: 4,
  },
};

/**
 * Presets for the user-facing "wobble snap" control.
 *
 * They move only the *taste* axis — how much pitch movement still counts as
 * one note. Voicing thresholds deliberately stay identical across presets:
 * those are measured properties of the signal, not a preference, and letting
 * a taste knob change them would make "Forgiving" mean two unrelated things
 * at once.
 */
export const PRESETS = {
  /** Splits readily. Best for someone whose pitch is already steady. */
  strict: { segment: { toleranceCents: 40, driftCapSemitones: 1.0 } },
  /** The default. */
  normal: { segment: { toleranceCents: 60, driftCapSemitones: 1.5 } },
  /** Holds a note through a lot of wobble. Fewer, longer, calmer notes. */
  forgiving: { segment: { toleranceCents: 90, driftCapSemitones: 2.0 } },
} as const satisfies Record<string, DspConfigOverrides>;

export type PresetName = keyof typeof PRESETS;

/**
 * Shallow-merges per group, returning a new config. Used by the presets and
 * by the harness's `--set group.key=value` flag; never mutates its input.
 *
 * Written out group by group rather than looped: an object literal has to
 * satisfy `DspConfig` in full, so adding a group to the config and forgetting
 * it here is a compile error rather than a silently dropped section.
 */
export function mergeConfig(base: DspConfig, overrides: DspConfigOverrides): DspConfig {
  return {
    analysis: { ...base.analysis, ...overrides.analysis },
    voicing: { ...base.voicing, ...overrides.voicing },
    smoothing: { ...base.smoothing, ...overrides.smoothing },
    segment: { ...base.segment, ...overrides.segment },
    tuning: { ...base.tuning, ...overrides.tuning },
  };
}

/** `DEFAULT_CONFIG` with a named preset applied. */
export function presetConfig(name: PresetName, base: DspConfig = DEFAULT_CONFIG): DspConfig {
  return mergeConfig(base, PRESETS[name]);
}
