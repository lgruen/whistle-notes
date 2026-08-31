/**
 * The canonical DSP contract. Everything downstream — the UI, the Node
 * harness, the tests — is written against these types, so they are frozen at
 * M1 and the real implementation slots in behind them unchanged.
 *
 * This module is part of the pure `src/dsp` island: no browser globals, no
 * Node built-ins, no imports outside `src/dsp` and `fft.js`. See CLAUDE.md.
 */

/**
 * One analysis frame. Deliberately **threshold-free**: the pitch stage reports
 * what it measured and never decides whether a frame counts as a note. All
 * gating lives in segmentation.
 *
 * The reason is practical rather than aesthetic. Frames are expensive to
 * compute and cheap to store, so the harness caches them to JSON once and then
 * re-runs a whole parameter sweep in milliseconds. If a threshold had already
 * been baked into `hz`, every sweep would need a fresh FFT pass — and the
 * thresholds are exactly the part we need to tune against real whistling.
 */
export interface PitchFrame {
  /** Time of the **centre** of the analysis window, in seconds from the start
   *  of the signal. Centre, not start: a note onset should be reported where
   *  the energy actually is, not half a window late. */
  tSec: number;
  /** Estimated fundamental in Hz, or `null` when no peak was found inside the
   *  configured band. `null` means "nothing to report", not "silence" —
   *  deciding that is segmentation's job. */
  hz: number | null;
  /** Fraction of in-band energy sitting under the winning peak's mainlobe,
   *  0..1. A whistle is nearly a pure sine and scores high; breath noise
   *  spreads its energy everywhere and scores near zero. */
  clarity: number;
  /** Peak bin level relative to the median bin level, in dB. A robust
   *  "is there a tone here at all" measure that ignores the noise's colour. */
  snrDb: number;
  /** Winning peak relative to the next-highest independent peak, in dB. Low
   *  values mean the frame is ambiguous — two competing tones, or an octave
   *  the detector could plausibly have gone either way on. */
  peakToSecondDb: number;
  /** RMS level inside the analysis band only, in dBFS. Drives the adaptive
   *  noise floor and the onset/sustain hysteresis. */
  bandRmsDb: number;
  /** RMS level across the full spectrum, in dBFS. Compared against
   *  `bandRmsDb` it says how much of the energy is out of band — a room full
   *  of speech and traffic rumble looks very different from a whistle. */
  broadbandRmsDb: number;
  /** Any sample in this window at or beyond full scale. Clipping distorts a
   *  pure tone into a harmonic-rich one and can pull the peak to a harmonic,
   *  so it is surfaced to the user as a "too loud" hint. */
  clipped: boolean;
}

/** Non-fatal observations about how a note was heard, for UI annotation. */
export interface NoteFlags {
  /** The note was approached by a glide or scoop rather than started on
   *  pitch. Those leading frames are excluded from the pitch estimate. */
  glidedIn?: boolean;
  /** Pitch moved substantially across the note without ever exceeding the
   *  split threshold — the reported pitch is a compromise. */
  drifted?: boolean;
  /** At least one frame in the note clipped. */
  clipped?: boolean;
}

/** A transcribed note. */
export interface Note {
  /** **True** sounding pitch as an integer MIDI number (60 = C4). Never
   *  transposed: the octave toggle is a display concern and lives entirely
   *  outside `src/dsp`. */
  midi: number;
  /** Scientific pitch name for `midi`, e.g. `"F#5"`. Sharps only. */
  noteName: string;
  /** Measured pitch relative to `midi`, in cents, in [-50, +50). How far the
   *  whistle actually sat from the note it was snapped to — this is what
   *  tells you whether a transcription was confident or a coin flip. */
  centsOffset: number;
  startSec: number;
  endSec: number;
  /** `endSec - startSec`. Stored rather than derived so serialised results
   *  survive a round trip through JSON without recomputation drift. */
  durationSec: number;
  /** Pitch estimate before rounding, in Hz. */
  pitchHz: number;
  /** 0..1 summary of the frame metrics backing this note. Ranking, not
   *  probability: useful for dimming shaky notes in the UI. */
  confidence: number;
  /** Silence or dropout before this note, in seconds; 0 for the first note.
   *  Feeds the rest markers and the repeated-note rule. */
  gapBeforeSec: number;
  flags: NoteFlags;
}

/** Everything one pass over a signal produced. */
export interface TranscriptionResult {
  notes: Note[];
  /** Every frame, including unvoiced ones. The piano roll draws this
   *  continuous pitch trail *underneath* the quantised note rectangles, which
   *  is what makes "why did it hear a D6 there?" answerable at a glance
   *  instead of requiring a debugger. */
  frames: PitchFrame[];
  /** The rate the signal was analysed at. The pipeline is rate-agnostic and
   *  reads whatever the device gave it; this records what that was. */
  sampleRate: number;
  /** Global tuning correction actually applied, in cents, clamped to ±50.
   *  0 when auto-tuning is off or the per-note offsets were too scattered to
   *  trust. Surfaced in the UI as "detected A = 4xx Hz". */
  tuningOffsetCents: number;
}

/** Spectral analysis: how the signal is turned into frames. */
export interface AnalysisConfig {
  /** Analysis window in samples. 2048 ≈ 43 ms at 48 kHz — long enough to
   *  resolve the peak, short enough that vibrato does not smear it. */
  windowSize: number;
  /** FFT length as a multiple of `windowSize`. Zero padding adds no
   *  information, but it interpolates the spectrum, which de-biases the
   *  3-point parabolic peak fit that follows. */
  zeroPadFactor: number;
  /** Frame advance in samples. 512 at 48 kHz ≈ 94 frames/second. */
  hopSize: number;
  /** Lower edge of the peak search, in Hz. Whistles start around 500 Hz, so
   *  400 leaves headroom while discarding speech fundamentals and mains hum
   *  for free — band-limiting is the cheapest noise rejection available. */
  minHz: number;
  /** Upper edge of the peak search, in Hz. */
  maxHz: number;
  /** If a peak exists at half the winning frequency and is within this many
   *  dB of it, prefer the lower one. Guards the classic octave error. */
  subOctaveToleranceDb: number;
  /** Subtract the window mean before transforming. DC and near-DC energy
   *  otherwise leaks into the low bins through the window sidelobes. */
  removeDc: boolean;
}

/**
 * Voicing: which frames are a whistle rather than a room.
 *
 * These numbers are **starting points** meant to be re-derived from measured
 * histograms on real recordings via the harness's sweep mode, not constants
 * anyone should trust on sight.
 */
export interface VoicingConfig {
  /** Minimum `PitchFrame.clarity`. */
  minClarity: number;
  /** Minimum `PitchFrame.snrDb`. */
  minSnrDb: number;
  /** Minimum `PitchFrame.peakToSecondDb`. */
  minPeakToSecondDb: number;
  /** Percentile of background `bandRmsDb` taken as the noise floor. */
  noiseFloorPercentile: number;
  /** How far above the floor a frame that fails the shape tests may still sit
   *  and count as *evidence about the background*, in dB.
   *
   *  Without this the estimate has no defence against loud shapeless events: a
   *  cough, a door or a chair scrape fails every tone test at 40 dB over the
   *  room, and admitting it drags the floor up to its level for as long as it
   *  stays inside the trailing window — silencing the transcription seconds
   *  *after* the noise, where the cause is invisible. */
  backgroundAboveFloorDb: number;
  /** Trailing span used to estimate that floor, in seconds. Adaptive because
   *  a quiet room and a café differ by more than any fixed threshold. */
  noiseFloorWindowSec: number;
  /** A note may *start* only this far above the noise floor, in dB. */
  onsetAboveFloorDb: number;
  /** ...but may *continue* at only this much above it. The asymmetry is
   *  deliberate hysteresis: it stops a fading sustain from being chopped into
   *  fragments while still requiring conviction to begin a note. */
  sustainAboveFloorDb: number;
  /** Discard this much audio at the start. Microphones settle, AGC (where it
   *  cannot be disabled) hunts, and the first moments are not signal. */
  warmupSec: number;
}

/** Cleaning the voiced pitch track before it is segmented. */
export interface SmoothingConfig {
  /** Voiced runs shorter than this many frames are discarded as glitches. */
  minVoicedRunFrames: number;
  /** Median filter length, in frames. Applied **within** voiced runs only,
   *  never across a gap — bridging a gap would invent pitch that was never
   *  whistled. Odd values only. */
  medianFilterFrames: number;
}

/** Turning a continuous pitch track into discrete notes. */
export interface SegmentConfig {
  /** Average slope above which a *movement* is transitional (a glide or a
   *  scoop) whatever distance it covers, in semitones per second.
   *  Transitional frames still count towards continuity and duration, but are
   *  excluded from the pitch estimate — which is what stops a portamento from
   *  spawning phantom notes at every semitone it passes through. */
  glideSlopeStPerSec: number;
  /** Slope at which a frame counts as *moving* at all, in semitones per
   *  second. Only used to find where a movement starts and stops: consecutive
   *  frames moving the same way are one movement, and a plateau ends it. */
  glideMinSlopeStPerSec: number;
  /** Distance a movement must cover to be transitional however slowly it went,
   *  in semitones. This is what catches the gentle scoop — too shallow for
   *  `glideSlopeStPerSec` but far enough that the frames it dwells on near its
   *  start would otherwise confirm a note of their own, a semitone below the
   *  one actually whistled. */
  glideMinSemitones: number;
  /** How far a frame may sit from the running reference pitch and still be
   *  the same note, in cents. The user-facing "wobble snap" knob. */
  toleranceCents: number;
  /** Length of the running median that defines that reference pitch. A
   *  median, not a mean, so one wild frame cannot drag the reference. */
  refMedianLength: number;
  /** Consecutive mutually-consistent frames required to commit a new note.
   *  Anything shorter is treated as a wobble and flushed back. */
  confirmFrames: number;
  /** Total drift within one note, in semitones, above which it is split
   *  regardless of the frame-to-frame tolerance. Without this a slow
   *  continuous slide would be swallowed whole as a single note. */
  driftCapSemitones: number;
  /** Fraction of a note's head to ignore when estimating its pitch. */
  attackTrimFraction: number;
  /** ...but only for notes at least this long, in ms. Trimming a quarter of
   *  a short note leaves nothing to measure. */
  attackTrimMinMs: number;
  /** Notes shorter than this are merged into a neighbour or dropped. */
  minNoteMs: number;
  /** A gap shorter than this between two same-pitch notes is a confidence
   *  dropout, so they merge. True silence never merges, however brief —
   *  that is what distinguishes one long note from two repeated ones. */
  gapMergeMs: number;
  /** Silence longer than this is reported as a rest. */
  restGapMs: number;
}

/** Reference pitch and the global tuning-offset correction. */
export interface TuningConfig {
  /** Reference frequency for A4, in Hz. */
  a4Hz: number;
  /** Estimate a global tuning offset from the notes themselves. A whistler
   *  who sits consistently 40 cents sharp otherwise gets coin-flip rounding
   *  on every note; measuring and removing the bias fixes all of them at
   *  once. */
  enableAutoTuning: boolean;
  /** Hard clamp on that correction, in cents. Beyond ±50 the "correction"
   *  would just be relabelling every note a semitone away. */
  maxTuningOffsetCents: number;
  /** How concentrated the per-note cent offsets must be (0..1, a circular
   *  resultant length) before the offset is believed. Scattered offsets mean
   *  an unsteady whistler, not a detuned one, and correcting for that would
   *  make things worse. */
  minTuningConcentration: number;
  /** Minimum number of notes before auto-tuning is attempted at all. */
  minTuningNotes: number;
}

/** The complete parameter set for one transcription pass. */
export interface DspConfig {
  analysis: AnalysisConfig;
  voicing: VoicingConfig;
  smoothing: SmoothingConfig;
  segment: SegmentConfig;
  tuning: TuningConfig;
}

/** A partial override of `DspConfig`, one group at a time. */
export type DspConfigOverrides = {
  [K in keyof DspConfig]?: Partial<DspConfig[K]>;
};
