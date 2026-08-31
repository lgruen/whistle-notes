/**
 * A hand-rolled RIFF/WAVE reader and writer.
 *
 * Node-only, deliberately outside `src/dsp`: the app never touches a WAV file
 * (it uses `decodeAudioData`), so this exists purely so the harness can read
 * the same audio the phone would hear. That is also why it is hand-rolled — a
 * dependency whose entire job is 100 lines of `DataView` calls is a dependency
 * whose supply chain costs more than its code.
 *
 * Handles what `afconvert` and the usual recorders actually emit: PCM 16/24/32,
 * IEEE float 32/64, `WAVE_FORMAT_EXTENSIBLE`, and arbitrary extra chunks
 * (`afconvert` inserts a `FLLR` padding chunk before `data`). Multi-channel
 * input is averaged to mono, because the pipeline is mono and averaging is what
 * a phone's mono capture does anyway.
 */

/** Decoded audio, shaped exactly like the app's `decodeAudioData` result so a
 *  fixture drops straight into `transcribe(samples, sampleRate)`. */
export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

const FORMAT_PCM = 0x0001;
const FORMAT_IEEE_FLOAT = 0x0003;
const FORMAT_EXTENSIBLE = 0xfffe;

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Decode a RIFF/WAVE file.
 *
 * RIFF is a chunk list, not a fixed header: `fmt ` and `data` can be separated
 * by anything, and assuming a 44-byte preamble is the classic way to read a
 * file as noise. So walk the chunks. Chunk bodies are padded to an even length
 * while the size field reports the unpadded length — forget that and every
 * chunk after the first odd one is misaligned.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) throw new Error("not a WAV file: shorter than a RIFF header");
  if (fourCC(view, 0) !== "RIFF" || fourCC(view, 8) !== "WAVE") {
    throw new Error(`not a WAV file: ${fourCC(view, 0)}/${fourCC(view, 8)}`);
  }

  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      formatTag = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (formatTag === FORMAT_EXTENSIBLE && size >= 40) {
        // The real format lives in the first two bytes of the SubFormat GUID.
        formatTag = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataOffset = body;
      // A streaming writer that never seeked back may have left the size as 0
      // or 0xffffffff; trust the file length over the header in that case.
      dataLength = Math.min(size, bytes.byteLength - body);
      if (size === 0) dataLength = bytes.byteLength - body;
    }

    offset = body + size + (size % 2); // chunk bodies are word-aligned
  }

  if (dataOffset < 0) throw new Error("WAV file has no data chunk");
  if (channels < 1 || sampleRate < 1) throw new Error("WAV file has no usable fmt chunk");

  const bytesPerSample = bitsPerSample >> 3;
  if (bytesPerSample < 1) throw new Error(`unsupported bit depth ${bitsPerSample}`);
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);

  const readOne = sampleReader(formatTag, bitsPerSample);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    const base = dataOffset + frame * bytesPerSample * channels;
    for (let c = 0; c < channels; c++) sum += readOne(view, base + c * bytesPerSample);
    // Average rather than take channel 0: a stereo recording of one voice puts
    // the same signal in both channels, and averaging gains 3 dB of SNR for
    // free. It also matches what mono capture does on a two-mic phone.
    samples[frame] = sum / channels;
  }

  return { samples, sampleRate };
}

/** A function that reads one sample at a byte offset and normalises to ±1. */
function sampleReader(formatTag: number, bits: number): (view: DataView, at: number) => number {
  if (formatTag === FORMAT_IEEE_FLOAT) {
    if (bits === 32) return (view, at) => view.getFloat32(at, true);
    if (bits === 64) return (view, at) => view.getFloat64(at, true);
    throw new Error(`unsupported float bit depth ${bits}`);
  }
  if (formatTag !== FORMAT_PCM) throw new Error(`unsupported WAV format tag 0x${formatTag.toString(16)}`);

  switch (bits) {
    case 8:
      // 8-bit PCM is the odd one out: unsigned, biased by 128.
      return (view, at) => (view.getUint8(at) - 128) / 128;
    case 16:
      return (view, at) => view.getInt16(at, true) / 32768;
    case 24:
      return (view, at) => {
        const value =
          view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        return value / 8388608;
      };
    case 32:
      return (view, at) => view.getInt32(at, true) / 2147483648;
    default:
      throw new Error(`unsupported PCM bit depth ${bits}`);
  }
}

/**
 * Encode mono float samples as 16-bit PCM.
 *
 * 16 bits rather than float32 because the only consumer is a human dropping the
 * file into an audio editor or the app's import path, and every tool on earth
 * reads PCM16. Samples are clamped before scaling: a float buffer can legally
 * exceed ±1, and letting that wrap around turns a loud note into white noise.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeTag = (offset: number, tag: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };

  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true);
  writeTag(36, "data");
  view.setUint32(40, dataLength, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric scaling: int16 runs −32768…32767, so +1.0 must map to 32767
    // and −1.0 to −32768 if a full-scale sine is not to clip on one side only.
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
  }

  return new Uint8Array(buffer);
}
