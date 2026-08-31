/**
 * Playback of a transcription, so a beginner can check by ear before hunting
 * for the notes on a keyboard.
 *
 * Everything is scheduled up front against the audio clock: the oscillators and
 * the gain for every note, `start`/`stop` times computed once. The main thread
 * is then free to be janky without the melody stuttering, which a `setTimeout`
 * per note could never promise.
 *
 * ## Two voices
 *
 * `clean` is the original single triangle, and it is the default because it is
 * the honest one: nothing about it can flatter a wrong octave. `supersaw` is
 * the same schedule played by a stack of detuned sawtooths — the JP-8000 sound,
 * asked for and kept because a whistled melody read back as a wall of saws is
 * a genuinely different way to hear your own take. Everything that surrounds
 * playback — transposition, the gap rule, the refusal to run while the
 * microphone is open, the click-free stop — is voice-independent by
 * construction: the voice only ever decides what {@link voiceSpec} returns.
 */

import { midiToHz } from "../dsp/index.js";
import { transposeMidi } from "../notes/format.js";
import { isRecording } from "./capture.js";

/**
 * The whole of what playback reads from a note.
 *
 * Structurally satisfied by `src/dsp`'s `Note` — so every existing caller passes
 * a transcription unchanged — and by anything else that knows when it starts and
 * how long it lasts. Practice mode's targets are `{midi, durSec}` with no times
 * at all, and `practice/recall.ts` lays them on a timeline into exactly this
 * shape without either module importing the other: the practice island may not
 * depend on the audio half of the app, and this is the contract that lets it
 * play something anyway.
 */
export interface PlayableNote {
  midi: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

/** A note placed on the playback timeline, in seconds from the first note. */
export interface ScheduledNote {
  /** Sounding MIDI number, i.e. already transposed. */
  midi: number;
  startSec: number;
  durationSec: number;
}

export interface ScheduleOptions {
  /** Silence longer than this is a "thinking" pause, not a musical rest. */
  maxGapSec?: number;
  /** ...and is replayed as this much, so a take with a long hesitation in the
   *  middle does not make the user sit through it again. */
  compressedGapSec?: number;
  /** Floor on note length: a 90 ms note is audible, a 20 ms one is a click. */
  minDurationSec?: number;
}

/** Envelope, sized to be click-free without smearing short notes. */
const ATTACK_SEC = 0.005;
const RELEASE_SEC = 0.03;
const PEAK_GAIN = 0.25;
/**
 * Scheduling lead-in, so the first note is not already late when it is set.
 *
 * Exported because one caller has to draw a picture in step with the sound: the
 * follow-along playhead starts when `startPlayback` is *called*, and without
 * subtracting this it would run 80 ms ahead of the melody for the whole run.
 */
export const PLAYBACK_LEAD_SEC = 0.08;
const LEAD_SEC = PLAYBACK_LEAD_SEC;

/** Which synth plays the transcript back. See the module header. */
export type Voice = "clean" | "supersaw";

/** The authority on what a voice is, so the store's load-validation and the UI
 *  do not each keep their own copy of the list — the same job `OCTAVE_SHIFTS`
 *  does for the octave toggle. */
export const VOICES: readonly Voice[] = ["clean", "supersaw"];

/* ── The supersaw ──────────────────────────────────────────────────────
 *
 * The Roland JP-8000 recipe, with the numbers argued rather than copied.
 */

/** Seven, as on the JP-8000 — but *odd* is what actually matters. The centre
 *  oscillator sits exactly on the written pitch, so the stack still has an
 *  unambiguous fundamental and an octave error stays as audible as it is on the
 *  clean voice. An even count would leave the pitch as an average of two
 *  detuned saws and nothing playing it. */
const SUPERSAW_OSCILLATORS = 7;

/** Widest detune, in cents, given to the outermost pair. A quarter of a
 *  semitone is about where the stack reads as unmistakably wide while the pitch
 *  is still the pitch; this synth exists to be checked against a keyboard, so a
 *  voice that came back as "somewhere near D6" would defeat its own purpose. */
const SUPERSAW_DETUNE_CENTS = 25;

/**
 * How the detune is distributed across the pairs.
 *
 * Not evenly, and that is the whole trick. The JP-8000's measured offsets sit
 * at roughly 0.18, 0.57 and 1.0 of its maximum rather than at 1/3, 2/3 and 1:
 * the outer saws are pushed out and the inner ones pulled in towards the
 * centre. Clustering near the fundamental is what turns the stack into one
 * thick voice instead of three separate chorus taps, while the far-flung outer
 * pair supplies the slow beating that makes it move.
 *
 * `u^1.5` on `u = k / pairs` reproduces that shape (0.19 / 0.54 / 1.0) closely
 * enough for the ear and, unlike a hard-coded table of three numbers, still
 * means something at five or nine oscillators.
 */
const SUPERSAW_SPREAD_EXPONENT = 1.5;

/**
 * Perceptual trim on top of the 1/√N equalisation in {@link voiceSpec}.
 *
 * Detuned saws beat rather than reinforce, so over a note their powers add and
 * not their amplitudes: seven of them at 1/√7 the amplitude carry the same RMS
 * as one at full. Equal RMS is not equal loudness, though — a saw's partials
 * fall off as 1/n where a triangle's fall as 1/n², so far more of a saw's
 * energy lands in the 2–5 kHz band the ear is most sensitive to. Backing off a
 * further ~2 dB lands the two voices at roughly the same apparent level. The
 * last word here is a phone speaker, not this comment.
 */
const SUPERSAW_TRIM = 0.8;

/**
 * Longer than the clean voice's 30 ms, so the stack breathes instead of being
 * chopped off.
 *
 * It stays *inside* the note: `sustainEnd` below subtracts the release from the
 * note's scheduled end, so a note of ordinary length still falls silent exactly
 * when it was scheduled to and the highlight stays tied to note boundaries
 * rather than to release tails. Only notes at or near the 90 ms floor are
 * shorter than attack+release and spill into their successor at all, and ~65 ms
 * of overlap on the shortest notes reads as legato rather than as smear.
 */
const SUPERSAW_RELEASE_SEC = 0.15;

/**
 * How long this voice takes to fall silent, in seconds.
 *
 * Exported because a caller laying notes out on a timeline has to know it. The
 * release lives *inside* a note of ordinary length (see above), so a melody
 * with room in it never needs to think about this — but a caller choosing the
 * silence between two notes is choosing whether a repeated note re-articulates,
 * and that answer is five times longer for the supersaw than for the triangle.
 * Reading the constant is the only way to be right for both.
 */
export function voiceReleaseSec(voice: Voice): number {
  return voice === "supersaw" ? SUPERSAW_RELEASE_SEC : RELEASE_SEC;
}

/**
 * One gentle lowpass for the whole playback.
 *
 * Seven saws put a great deal of energy above the tenth harmonic, and on a
 * phone speaker that is fizz rather than music — it also masks exactly the
 * pitch cue the user is listening for. 5 kHz keeps the bite and loses the
 * hiss; Q at Butterworth means no resonant peak that could colour a note near
 * the corner and make one pitch louder than its neighbour.
 *
 * Per playback rather than per note because it is a static filter with
 * identical settings for every note: one biquad does the work of N, and the
 * per-note envelope gains simply sum into it.
 */
const SUPERSAW_LOWPASS_HZ = 5000;
const SUPERSAW_LOWPASS_Q = Math.SQRT1_2;

/**
 * Detune offsets in cents, one per oscillator: symmetric about 0, widest pair
 * at `±maxCents`, non-linearly spaced (see {@link SUPERSAW_SPREAD_EXPONENT}).
 *
 * Pure and exported so the spread can be tested as arithmetic. Symmetry is not
 * decoration — an asymmetric spread would drag the perceived pitch off the
 * written note, which is the one thing this synth may not do.
 */
export function supersawDetuneCents(
  count: number = SUPERSAW_OSCILLATORS,
  maxCents: number = SUPERSAW_DETUNE_CENTS,
): number[] {
  if (count <= 0) return [];
  const pairs = Math.floor(count / 2);
  const offsets: number[] = [];
  for (let k = pairs; k >= 1; k--) {
    offsets.push(-maxCents * Math.pow(k / pairs, SUPERSAW_SPREAD_EXPONENT));
  }
  if (count % 2 === 1) offsets.push(0);
  for (let k = 1; k <= pairs; k++) {
    offsets.push(maxCents * Math.pow(k / pairs, SUPERSAW_SPREAD_EXPONENT));
  }
  return offsets;
}

/** Everything `startPlayback` needs to know about a voice. */
export interface VoiceSpec {
  oscillatorType: OscillatorType;
  /** One entry per oscillator, so its length *is* the oscillator count. */
  detuneCents: readonly number[];
  /** Peak of the per-note envelope. It scales the *sum* of the oscillators, so
   *  it already carries the 1/√N loudness correction. */
  peakGain: number;
  releaseSec: number;
  /** Shared lowpass corner in Hz, or `null` to connect straight to the output. */
  lowpassHz: number | null;
  lowpassQ: number;
}

/**
 * The whole difference between the two voices, as data.
 *
 * Keeping it here rather than as branches inside `startPlayback` is what makes
 * the claim in the module header checkable: there is exactly one `if` about the
 * voice in this file, and it is this function.
 */
export function voiceSpec(voice: Voice): VoiceSpec {
  if (voice === "supersaw") {
    const detuneCents = supersawDetuneCents();
    return {
      oscillatorType: "sawtooth",
      detuneCents,
      peakGain: (PEAK_GAIN / Math.sqrt(detuneCents.length)) * SUPERSAW_TRIM,
      releaseSec: SUPERSAW_RELEASE_SEC,
      lowpassHz: SUPERSAW_LOWPASS_HZ,
      lowpassQ: SUPERSAW_LOWPASS_Q,
    };
  }
  // Triangle: a sine is so plain it is hard to pick out of a room, and a
  // triangle's weak odd harmonics read as "a note" without any of the buzz
  // that would make octave errors hard to hear.
  return {
    oscillatorType: "triangle",
    detuneCents: [0],
    peakGain: PEAK_GAIN,
    releaseSec: RELEASE_SEC,
    lowpassHz: null,
    lowpassQ: SUPERSAW_LOWPASS_Q,
  };
}

/**
 * Lay notes out on a playback timeline.
 *
 * Pure and exported for its own sake: the gap rule is the only musical judgment
 * in the synth, and it is much easier to test as arithmetic than by listening.
 * Rhythm is otherwise preserved exactly as transcribed — v1 does not quantise,
 * so what you hear is what the segmenter actually measured.
 */
export function playbackSchedule(
  notes: readonly PlayableNote[],
  transpose: number,
  options: ScheduleOptions = {},
): ScheduledNote[] {
  const maxGap = options.maxGapSec ?? 1;
  const compressed = options.compressedGapSec ?? 0.5;
  const minDuration = options.minDurationSec ?? 0.09;

  const scheduled: ScheduledNote[] = [];
  let cursor = 0;
  let previousEnd: number | null = null;

  for (const note of notes) {
    if (previousEnd !== null) {
      const gap = Math.max(0, note.startSec - previousEnd);
      cursor += gap > maxGap ? compressed : gap;
    }
    const duration = Math.max(minDuration, note.durationSec);
    scheduled.push({
      midi: transposeMidi(note.midi, transpose),
      startSec: cursor,
      durationSec: duration,
    });
    cursor += duration;
    previousEnd = note.endSec;
  }
  return scheduled;
}

/** Total sounding length of a schedule, in seconds. */
export function scheduleDuration(scheduled: readonly ScheduledNote[]): number {
  const last = scheduled[scheduled.length - 1];
  return last ? last.startSec + last.durationSec : 0;
}

export interface PlaybackHandlers {
  /** Called when the sounding note changes, with an index into `notes`. */
  onIndex(index: number | null): void;
  /** Called once when playback finishes or is stopped. */
  onEnd(): void;
}

let ctx: AudioContext | null = null;
/** One entry per scheduled note: its envelope, and the oscillators feeding it.
 *  A list rather than a count because `stopPlayback` has to reach every node. */
let sounding: { oscillators: OscillatorNode[]; gain: GainNode }[] = [];
let raf = 0;
let handlers: PlaybackHandlers | null = null;

export function isPlaying(): boolean {
  return ctx !== null;
}

/**
 * Start playback; returns whether it actually started.
 *
 * Must be called synchronously from a tap handler — a fresh `AudioContext` is
 * created here and can only autoplay inside a gesture.
 *
 * ## Why the microphone check lives here
 *
 * Echo cancellation is switched off on purpose (it eats whistles), so a phone
 * playing this synth into its own open microphone would transcribe itself. The
 * UI already disables the Play button while recording, but a *disabled button*
 * is a presentation detail: it does not survive a keyboard activation racing a
 * state change, a stray `beginPlayback()` from a future caller, or anyone
 * reordering `render()`. The rule belongs where the resource is acquired, so
 * refusing here makes it structural rather than cosmetic.
 *
 * The refusal is reported rather than silent because the caller has UI state to
 * keep in step: a `playing: true` set against a playback that never started
 * leaves a Stop button that stops nothing.
 *
 * There is exactly one deliberate exception, and it is a different function —
 * see {@link startPlaybackOverMicrophone}.
 *
 * ## Why a fresh context per playback
 *
 * The capture context is closed on stop, so there is nothing to reuse; and on
 * iOS reusing a context that has ever had a microphone attached is exactly what
 * routes output to the *earpiece* at whisper volume. Building a new one after
 * the tracks are stopped gets normal media routing. A context costs about a
 * millisecond, and it is closed again when playback ends, so there is no
 * accumulation.
 *
 * The exception above is the one case where the tracks are *not* stopped first,
 * and on iOS a fresh context may not be enough to escape that routing — the
 * audio session is still record-capable, which is what the earpiece behaviour
 * actually keys off. Untested on iOS at the time of writing; on Android the two
 * contexts coexist and play at normal volume. If a warm-up comes out at whisper
 * volume on an iPhone, that is this, and the honest fix is headphones rather
 * than a second audio path to keep alive.
 */
export function startPlayback(
  notes: readonly PlayableNote[],
  transpose: number,
  playbackHandlers: PlaybackHandlers,
  voice: Voice = "clean",
): boolean {
  // Before `stopPlayback()`: a refused start must change nothing at all.
  if (isRecording()) return false;
  return play(notes, transpose, playbackHandlers, voice);
}

/**
 * The one deliberate exception to the rule above, for the follow-along warm-up.
 *
 * A separate exported function rather than a flag on {@link startPlayback},
 * because the exemption should be *greppable*: `startPlayback` keeps a refusal
 * that no caller can accidentally opt out of, and every place in the app that
 * plays over an open microphone is found by searching for this name. There is
 * exactly one.
 *
 * What makes it safe is not anything this module does — the microphone really
 * will hear the speaker, because echo cancellation is off everywhere in this
 * project on purpose. It is what the caller does with the audio: the warm-up
 * transcribes nothing, aligns nothing and stores nothing, so the worst the echo
 * can do is draw a faint line on a picture nobody is graded on, and the screen
 * says so. See `practice/follow.ts`. **If follow-along ever grows a score, this
 * function has to go.**
 */
export function startPlaybackOverMicrophone(
  notes: readonly PlayableNote[],
  playbackHandlers: PlaybackHandlers,
  voice: Voice = "clean",
): boolean {
  return play(notes, 0, playbackHandlers, voice);
}

function play(
  notes: readonly PlayableNote[],
  transpose: number,
  playbackHandlers: PlaybackHandlers,
  voice: Voice,
): boolean {
  stopPlayback();
  const scheduled = playbackSchedule(notes, transpose);
  if (scheduled.length === 0) return false;

  ctx = new AudioContext();
  // Swallowed, not left floating: Safari rejects `resume()` when it disagrees
  // about the gesture, and the schedule below is what actually matters.
  ctx.resume().catch(() => undefined);
  handlers = playbackHandlers;

  // Read once, here: a voice change mid-playback cannot reach a graph that has
  // already been built, and pretending otherwise would need the whole schedule
  // torn down and rebuilt for a preference the user can simply hear on the next
  // tap of Play. See `setVoice` in `ui/state.ts`.
  const spec = voiceSpec(voice);

  let output: AudioNode = ctx.destination;
  if (spec.lowpassHz !== null) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = spec.lowpassHz;
    filter.Q.value = spec.lowpassQ;
    filter.connect(ctx.destination);
    output = filter;
  }

  const t0 = ctx.currentTime + LEAD_SEC;
  for (const note of scheduled) {
    const start = t0 + note.startSec;
    const end = start + note.durationSec;
    // A note shorter than attack+release gets a shortened sustain rather than
    // a negative one; the envelope stays monotonic either way.
    const sustainEnd = Math.max(start + ATTACK_SEC, end - spec.releaseSec);

    // One envelope for the whole note, whatever it is played by. The detuned
    // saws must open and close in lockstep — a gain per oscillator would let
    // them drift apart under the stop ramp and turn Stop into a chord.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(spec.peakGain, start + ATTACK_SEC);
    gain.gain.setValueAtTime(spec.peakGain, sustainEnd);
    gain.gain.linearRampToValueAtTime(0, sustainEnd + spec.releaseSec);
    gain.connect(output);

    const hz = midiToHz(note.midi);
    const oscillators: OscillatorNode[] = [];
    for (const cents of spec.detuneCents) {
      const osc = ctx.createOscillator();
      osc.type = spec.oscillatorType;
      osc.frequency.value = hz;
      // Detune rather than a pre-multiplied frequency: cents is the unit the
      // spread is designed in, and letting the platform apply it keeps one
      // rounding step instead of two.
      osc.detune.value = cents;
      osc.connect(gain);
      osc.start(start);
      osc.stop(sustainEnd + spec.releaseSec + 0.01);
      oscillators.push(osc);
    }
    sounding.push({ oscillators, gain });
  }

  const total = scheduleDuration(scheduled);
  let lastIndex: number | null = null;

  const tick = (): void => {
    if (!ctx) return;
    const elapsed = ctx.currentTime - t0;

    // The index of the last note that has started, rather than the note
    // strictly sounding *now*: it keeps the highlight steady through rests
    // instead of blinking off in every gap.
    let index: number | null = null;
    for (let i = 0; i < scheduled.length; i++) {
      if (scheduled[i].startSec <= elapsed) index = i;
      else break;
    }
    if (index !== lastIndex) {
      lastIndex = index;
      handlers?.onIndex(index);
    }

    // The voice's own release, not a constant: the supersaw's tail is five
    // times the clean voice's, and auto-stopping on the shorter one would close
    // the context mid-decay — the exact click the stop ramp exists to avoid.
    // The highlight above is untouched by this; it follows note boundaries.
    if (elapsed >= total + spec.releaseSec) {
      stopPlayback();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return true;
}

/** Stop playback immediately, without a click, and release the context. */
export function stopPlayback(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;

  const closing = ctx;
  const ending = handlers;
  ctx = null;
  handlers = null;

  if (closing) {
    const now = closing.currentTime;
    for (const { oscillators, gain } of sounding) {
      // Cancel the schedule, pin the envelope where it actually is, then ramp
      // out over 20 ms. Cutting a mid-note oscillator dead is a click, and a
      // click on Stop is the one sound users report as "broken". One ramp per
      // note covers the whole stack, however many oscillators feed it.
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.02);
      for (const osc of oscillators) {
        try {
          osc.stop(now + 0.03);
        } catch {
          // Already stopped; nothing to do.
        }
      }
    }
    // Long enough for the ramp to finish before the context goes away.
    setTimeout(() => void closing.close().catch(() => undefined), 120);
  }
  sounding = [];
  ending?.onEnd();
}
