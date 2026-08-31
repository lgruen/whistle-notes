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

/**
 * Refuse absurd files before decoding them.
 *
 * `decodeAudioData` decodes the *whole* file before anything can be truncated,
 * as one float per sample per channel — an hour-long recording is most of a
 * gigabyte, and a phone answers that with a tab crash rather than an error.
 * This is a memory guard, not a format rule: 32 MB is ~30 minutes of the
 * compressed audio a voice-memo app produces, against an intended use of about
 * a minute.
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

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
 * Average channels down to one.
 *
 * Averaging, not "take the left channel": that is what a phone's own mono
 * capture does, what `tools/wav.ts` does for fixtures, and what keeps a stereo
 * file from losing whichever side the whistle happened to be panned towards.
 * (It also means a deliberately out-of-phase stereo file cancels itself — a
 * pathological case that no recorder produces by accident.)
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

  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i];
  }
  const scale = 1 / channels.length;
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
  if (file.size > MAX_FILE_BYTES) {
    throw new AudioFileError(
      "That file is too large to decode on a phone. Trim it to a minute or so and try again.",
    );
  }

  const bytes = await file.arrayBuffer();
  // One frame at the target rate: the context is never rendered, it exists only
  // to own the decoder and to fix the output sample rate.
  const ctx = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);

  let buffer: AudioBuffer;
  try {
    buffer = await decodeBytes(ctx, bytes);
  } catch (error) {
    console.error("[decode] decodeAudioData failed", error);
    throw new AudioFileError(
      "That file could not be decoded. Try an m4a, mp3, wav or ogg recording.",
    );
  }

  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channels.push(buffer.getChannelData(channel));
  }
  const mono = mixToMono(channels);
  if (mono.length === 0) {
    throw new AudioFileError("That file has no audio in it.");
  }

  // `buffer.sampleRate`, not the constant: the two agree on every browser that
  // implements the spec, and if one ever disagrees the frames must be timed by
  // what was actually produced rather than by what was asked for.
  const sampleRate = buffer.sampleRate || DECODE_SAMPLE_RATE;
  const samples = capSamples(mono, sampleRate, maxSec);
  return {
    samples,
    sampleRate,
    sourceDurationSec: mono.length / sampleRate,
    truncated: samples.length < mono.length,
  };
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
