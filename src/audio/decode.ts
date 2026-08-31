/**
 * File import: the second way audio gets into the pipeline, and the app's
 * escape hatch.
 *
 * The output shape is deliberately identical to what `stopRecording()` returns,
 * because the point is that there is only one pipeline. A decoded file goes
 * through the same `transcribe()` as a live take, produces the same frames, and
 * is drawn by the same views — so an import is not a second code path to keep in
 * sync, it is the same path fed from a different tap.
 *
 * That buys two things beyond the feature itself:
 *
 * - **A working app without a microphone.** Permission denied, no input device,
 *   an insecure context, a browser with no AudioWorklet: all of those leave
 *   import perfectly functional, so none of them are dead ends.
 * - **A controlled comparison.** Record a whistle live, record the same whistle
 *   in the phone's voice-memo app, import that, and compare. If the live take
 *   is mush and the import is clean, the platform's voice processing is eating
 *   the signal — which is otherwise very hard to prove from the outside.
 *
 * Browser-only by definition; nothing here may leak into `src/dsp`.
 */

import { MAX_RECORD_SEC } from "./capture.js";

/**
 * Decode rate, fixed rather than inherited.
 *
 * `OfflineAudioContext` resamples whatever it decodes to its own sample rate,
 * so pinning it at 48 kHz means the same file transcribes identically on every
 * device and in `tools/transcribe-file.ts`. A device-dependent rate would make
 * an imported fixture reproduce differently on the phone that reported the bug
 * than on the laptop fixing it, which is the entire property this app is built
 * around.
 */
export const DECODE_SAMPLE_RATE = 48000;

/*
 * ── The size guard, and what it can honestly promise ──────────────────────
 *
 * `decodeAudioData` decodes the **whole** file before anything can be
 * truncated, as one float32 per sample per channel at this context's rate. The
 * threat is therefore measured in *decoded* bytes, and the only number we have
 * before the decode is *compressed* bytes — which is a wildly different thing.
 *
 * There is no duration to check first. `Blob` exposes a size and a MIME type
 * and nothing else; the container's own duration field is only readable by
 * parsing the container, which is the codec's job, not ours. (A hidden
 * `HTMLAudioElement` would report `duration` from metadata alone, without
 * decoding to PCM — a real option, deliberately not taken here: it is another
 * browser-only path that cannot be tested off a device, and it answers `NaN`
 * for streams often enough to need a fallback anyway.)
 *
 * So the cap is a bound on the *plausible worst case*, computed rather than
 * guessed, and the try/catch around the decode is what catches the rest.
 */

/** Peak float bytes one decode may ask a phone for. Not a spec number — a
 *  judgment: a current phone survives this, a 2018 one may not, and the failure
 *  when it does not is caught rather than fatal. */
const DECODE_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * Peak decoded bytes per second of source audio.
 *
 * Two allocations are alive at once, because {@link mixToMono} builds its copy
 * while the `AudioBuffer` is still in scope: a stereo decode at 48 kHz costs
 * `48000 × 4 × 2` bytes per second, and the mono copy adds `48000 × 4` more.
 * Hence three channels' worth, not one.
 */
const PEAK_DECODED_BYTES_PER_SEC = DECODE_SAMPLE_RATE * 4 * 3; // ~576 kB/s

/**
 * Bytes per second of the lowest-bitrate audio we expect a recorder app to
 * hand us: 32 kbps, which is roughly what a phone's voice-memo app produces in
 * its compressed mode. (Codecs go far lower — Opus will encode speech at
 * 6 kbps — but nothing produces those by accident, and sizing for them would
 * reject legitimate music files.)
 */
const WORST_CASE_BYTES_PER_SEC = 32000 / 8;

/**
 * Cap for a compressed file, ~3.6 MB — derived, not chosen.
 *
 * 512 MB ÷ 576 kB/s ≈ 15½ minutes of audio we can afford to decode; at 4 kB/s
 * that weighs ~3.6 MB. The old cap was 32 MB, which sounds cautious and is not:
 * 32 MB of 32 kbps voice memo is 133 minutes, or ~1.5 GB decoded, and a phone
 * answers that by killing the tab rather than by returning an error.
 *
 * The trade is real and worth stating plainly: this also refuses a legitimate
 * file that would have decoded fine — eight minutes at 128 kbps, say. Refusing
 * it with a sentence beats crashing the tab, and the 60 s cap means such a file
 * was going to be cut to its first minute regardless.
 */
export const MAX_COMPRESSED_BYTES = Math.floor(
  (DECODE_BUDGET_BYTES / PEAK_DECODED_BYTES_PER_SEC) * WORST_CASE_BYTES_PER_SEC,
);

/**
 * Cap for an uncompressed file, which is a different question entirely.
 *
 * RIFF/WAVE and AIFF carry raw PCM, so their expansion factor is known and
 * small — 16-bit mono decodes to 2× its size, and the mono copy makes 4×
 * (before resampling; 44.1 → 48 kHz adds another 9%). At 32 MB that is ~160 MB
 * peak, comfortably inside the budget.
 *
 * This tier is not a nicety. This app's own Save button writes 16-bit mono WAV,
 * and a 60 s take is 5.8 MB of it — so a single low cap would have made the
 * app unable to re-import its own debug export, which is precisely the loop the
 * export exists to serve.
 */
export const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

/** Bytes of a file we look at to decide which cap applies. Twelve is enough
 *  for every container header below. */
export const HEADER_SNIFF_BYTES = 12;

/**
 * Whether these leading bytes are an uncompressed PCM container.
 *
 * Sniffed from the bytes rather than trusted from `file.type` or the file name,
 * because both are advisory: pickers hand over an empty MIME type all the time,
 * and a mislabelled `.wav` that is really a 32 kbps AAC would otherwise be
 * granted the 32 MB cap and decode to a gigabyte. Twelve bytes is a cheap and
 * *actual* answer to the question the cap depends on.
 *
 * - `RIFF....WAVE` — a WAV file, including everything this app's own Save
 *   button writes.
 * - `FORM....AIFF` / `AIFC` — AIFF, which is what a Mac recorder may produce.
 *
 * Anything else is treated as compressed, which is the conservative direction:
 * an unrecognised uncompressed format simply gets the smaller cap.
 */
export function isUncompressedContainer(header: Uint8Array): boolean {
  if (header.length < HEADER_SNIFF_BYTES) return false;
  const tag = (at: number): string => String.fromCharCode(...header.subarray(at, at + 4));
  const container = tag(0);
  const form = tag(8);
  if (container === "RIFF") return form === "WAVE";
  if (container === "FORM") return form === "AIFF" || form === "AIFC";
  return false;
}

/** An expected failure with a message that can go straight on screen. Separate
 *  from `CaptureError` on purpose: nothing here touches the microphone, and the
 *  advice a user needs is completely different. */
export class AudioFileError extends Error {}

/** Decoded audio, shaped exactly like a finished take. */
export interface DecodedFile {
  samples: Float32Array;
  sampleRate: number;
  /** Length of the source, in seconds, *before* the cap was applied. */
  sourceDurationSec: number;
  /** Whether {@link samples} is only the beginning of the file. */
  truncated: boolean;
}

/**
 * Web Audio's own 5.1 → mono coefficients, in the spec's channel order
 * `[L, R, C, LFE, Ls, Rs]`.
 *
 * A flat 1/6 average would be wrong twice over: it drops the front content
 * ~6 dB below where a stereo file lands, and it folds the LFE in at full
 * weight — a subwoofer channel of pure rumble, mixed into the signal a pitch
 * tracker is about to look at. The spec's answer is `0.7071·(L+R) + C +
 * 0.5·(Ls+Rs)`, LFE discarded, and there is no reason to invent a second one.
 *
 * The one departure: the spec's coefficients sum to 3.41 and are allowed to,
 * because they end at a DAC that will clip gracefully. These samples end at a
 * *clipping detector*, which would then report clipping the source never had,
 * so {@link mixToMono} normalises by the weight sum.
 */
const SURROUND_5_1_WEIGHTS: readonly number[] = [0.7071, 0.7071, 1, 0, 0.5, 0.5];

/** Per-channel weights for a downmix. Anything that is not a 5.1 layout is
 *  averaged flat, which is exactly right for mono and stereo and is the only
 *  defensible guess for a layout we cannot name. */
function channelWeights(count: number): readonly number[] {
  if (count === SURROUND_5_1_WEIGHTS.length) return SURROUND_5_1_WEIGHTS;
  return new Array<number>(count).fill(1);
}

/**
 * Mix channels down to one.
 *
 * A weighted average, not "take the left channel": averaging is what a phone's
 * own mono capture does, what `tools/wav.ts` does for fixtures, and what keeps
 * a stereo file from losing whichever side the whistle happened to be panned
 * towards. (It also means a deliberately out-of-phase stereo file cancels
 * itself — a pathological case that no recorder produces by accident.)
 *
 * For one and two channels — everything a recorder actually hands over — the
 * weights are flat and this is a plain average. See {@link channelWeights} for
 * the one layout that gets different treatment.
 *
 * Always copies. The caller's arrays belong to an `AudioBuffer` that is about
 * to be dropped, and a `Float32Array` that keeps a multi-megabyte backing store
 * alive is a memory leak with no symptom until the fourth import.
 */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();

  // Shortest channel wins: an AudioBuffer's channels are always the same
  // length, but nothing here should quietly read past the end of one if that
  // ever stops being true.
  let length = channels[0].length;
  for (const channel of channels) length = Math.min(length, channel.length);

  const weights = channelWeights(channels.length);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const mono = new Float32Array(length);
  for (let c = 0; c < channels.length; c++) {
    const weight = weights[c];
    if (weight === 0) continue;
    const channel = channels[c];
    for (let i = 0; i < length; i++) mono[i] += weight * channel[i];
  }
  const scale = total > 0 ? 1 / total : 0;
  for (let i = 0; i < length; i++) mono[i] *= scale;
  return mono;
}

/**
 * Cut `samples` down to at most `maxSec`.
 *
 * Truncating rather than rejecting is a deliberate choice about what a user is
 * actually trying to do: someone importing a three-minute voice memo whistled
 * a melody somewhere in it and wants to see notes, and "file too long" gets
 * them nothing. They are told what happened in the warning line instead.
 *
 * Slices rather than views, for the same backing-store reason as
 * {@link mixToMono}.
 */
export function capSamples(
  samples: Float32Array,
  sampleRate: number,
  maxSec: number = MAX_RECORD_SEC,
): Float32Array {
  const max = Math.floor(maxSec * sampleRate);
  return samples.length <= max ? samples : samples.slice(0, max);
}

/**
 * Decode a picked file into samples the pipeline can transcribe.
 *
 * Everything browser-shaped is confined to this function — `arrayBuffer()`,
 * `OfflineAudioContext`, `decodeAudioData` — precisely because none of it can
 * be tested off a device. The arithmetic it wraps (mixdown, cap) is pure and
 * is tested; this is the thin seam around a platform codec that either works
 * or does not.
 */
export async function decodeAudioFile(
  file: Blob,
  maxSec: number = MAX_RECORD_SEC,
): Promise<DecodedFile> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new AudioFileError("This browser cannot decode audio files.");
  }
  if (file.size === 0) {
    throw new AudioFileError("That file is empty.");
  }

  // Twelve bytes before anything else: which cap applies depends on what the
  // file actually is, not on what it is called. See `isUncompressedContainer`.
  const header = new Uint8Array(await file.slice(0, HEADER_SNIFF_BYTES).arrayBuffer());
  const limit = isUncompressedContainer(header) ? MAX_UNCOMPRESSED_BYTES : MAX_COMPRESSED_BYTES;
  if (file.size > limit) {
    throw new AudioFileError(
      "That file is too large to decode on a phone. Trim it to a minute or so and try again.",
    );
  }

  const bytes = await file.arrayBuffer();

  let mono: Float32Array;
  let sampleRate: number;
  /*
   * The decode *and* the mixdown are inside this, not just the decode.
   *
   * The cap above bounds the plausible worst case; it cannot bound the actual
   * one, because bitrate varies fifty-fold across formats and nothing tells us
   * a file's duration beforehand. So the allocation really can fail — and it
   * fails in two different places, `decodeAudioData` itself and the
   * `new Float32Array` inside `mixToMono` — with a `RangeError` rather than
   * anything audio-shaped. Both come out here as a sentence on screen instead
   * of as an unhandled rejection and a blank result.
   */
  try {
    const buffer = await decodeBytes(decodeContext(), bytes);
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      channels.push(buffer.getChannelData(channel));
    }
    mono = mixToMono(channels);
    // `buffer.sampleRate`, not the constant: the two agree on every browser
    // that implements the spec, and if one ever disagrees the frames must be
    // timed by what was actually produced rather than by what was asked for.
    sampleRate = buffer.sampleRate || DECODE_SAMPLE_RATE;
  } catch (error) {
    console.error("[decode] could not decode the file", error);
    throw new AudioFileError(
      outOfMemory(error)
        ? "That file needed more memory than this device would give it. Trim it to a minute or so and try again."
        : "That file could not be decoded. Try an m4a, mp3, wav or ogg recording.",
    );
  }

  if (mono.length === 0) {
    throw new AudioFileError("That file has no audio in it.");
  }

  const samples = capSamples(mono, sampleRate, maxSec);
  return {
    samples,
    sampleRate,
    sourceDurationSec: mono.length / sampleRate,
    truncated: samples.length < mono.length,
  };
}

/**
 * The one decode context, built on first use and kept.
 *
 * It is never rendered and never connected to anything: it exists only to own
 * the decoder and to pin the output sample rate. A fresh one per import would
 * be tidy-looking and wrong — WebKit caps the number of live audio contexts a
 * page may hold (historically four on iOS) and does not reclaim them promptly,
 * so the import-tweak-import loop this app is built around would stop working
 * after a handful of tries, silently and only on a phone.
 *
 * Deliberately not closed: closing it would make the *next* import build
 * another one, which is the behaviour this exists to avoid.
 */
let decodeCtx: OfflineAudioContext | null = null;

function decodeContext(): BaseAudioContext {
  // One frame at the target rate is all that is needed to own a decoder.
  decodeCtx ??= new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  return decodeCtx;
}

/**
 * Whether a thrown value is the platform saying "no" to an allocation.
 *
 * There is no typed error for this. A `Float32Array` too large to allocate
 * throws `RangeError`, V8 words it "Array buffer allocation failed", and
 * WebKit's decoder answers a file it cannot fit with a plain `Error` whose
 * message mentions memory. Matching loosely is fine here because the only
 * consequence of a miss is a slightly less specific sentence.
 */
function outOfMemory(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /memory|allocation failed|too large|out of range/i.test(message);
}

/**
 * `decodeAudioData` in both of its shapes.
 *
 * The modern form returns a promise; older WebKit only ever calls the success
 * and error callbacks and returns nothing. Passing both and settling on
 * whichever arrives first costs three lines and removes an entire class of
 * "import does nothing at all on that iPad" report.
 */
function decodeBytes(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const returned: Promise<AudioBuffer> | undefined = ctx.decodeAudioData(
      bytes,
      resolve,
      reject,
    );
    void returned?.then(resolve, reject);
  });
}
