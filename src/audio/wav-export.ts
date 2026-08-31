/**
 * Save the take that just produced a bad transcription.
 *
 * This is the debug affordance the plan asks for, and it is worth more than it
 * looks. Every interesting failure in this app is a failure on *real* audio: a
 * whistle the segmenter split in two, a scoop it heard as a note, a phone whose
 * voice processing quietly gated the signal. None of that reproduces from a
 * screenshot, and none of it can be re-whistled the same way twice. One tap
 * here turns it into a file that `tools/transcribe-file.ts` can sweep offline
 * and, if it matters, that becomes a fixture with the failure baked in.
 *
 * 16-bit PCM because it is the format every tool on earth reads, including this
 * repo's own hand-rolled reader. Written from scratch rather than imported:
 * `tools/wav.ts` is Node-side harness code and the browser bundle must not grow
 * a dependency on it — two hundred lines of `DataView` calls in two places is a
 * better trade than a module that has to work in both worlds.
 *
 * The recording never leaves the device: this builds a Blob and hands it to the
 * browser's own download path. There is no upload anywhere in this app.
 */

/** Bytes of RIFF/WAVE header before the samples. */
const HEADER_BYTES = 44;

/**
 * Encode mono float samples as a 16-bit PCM WAV file.
 *
 * Values outside [-1, 1] are clamped rather than wrapped: a clipped take should
 * come back as a clipped take, not as one whose peaks fold inside out into
 * something that never happened. The asymmetric scaling is the conventional
 * one — two's complement has one more negative step than positive — so full
 * scale in either direction survives the round trip exactly.
 */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const channels = 1;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF is little-endian throughout; the four-character codes are the only
  // big-endian-looking thing in it, and they are plain ASCII bytes.
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk length for PCM
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(HEADER_BYTES + i * bytesPerSample, Math.round(value), true);
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * A filename that sorts chronologically and says what it is.
 *
 * Local time, not ISO/UTC: these files are matched up with "the take I did just
 * now" by a human looking at a downloads folder, and a timestamp three hours
 * off makes that harder for no benefit.
 */
export function takeFilename(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `whistle-${stamp}.wav`;
}

/**
 * Encode a take and hand it to the browser's download path.
 *
 * The object URL is revoked on a timer rather than immediately: revoking it in
 * the same task as the synthetic click cancels the download in some browsers,
 * because the fetch has not started yet. A minute is far longer than needed and
 * costs nothing but the blob's memory until then.
 *
 * Not universal, and deliberately not worked around: an `<a download>` is
 * ignored by older iOS Safari, which opens the file in a tab instead. That is a
 * usable outcome for a debug affordance, and every alternative is worse.
 */
export function downloadWav(samples: Float32Array, sampleRate: number, filename: string): void {
  const blob = new Blob([encodeWav16(samples, sampleRate)], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
