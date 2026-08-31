import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "../tools/wav.js";

/**
 * The WAV codec is Node-only harness plumbing, but it is the *only* thing
 * standing between a recording on disk and every tuning decision made against
 * it. A reader that quietly halves the sample rate, or misreads 24-bit as
 * 16-bit, would produce a transcription that is wrong in a way no amount of
 * DSP debugging would explain. So it gets tested like production code.
 */

/** Build a WAV by hand so the reader is tested against bytes, not against the
 *  writer's idea of what a WAV is. */
function buildWav(options: {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bits: number;
  /** Interleaved sample writer, given a DataView positioned at the data body. */
  writeData: (view: DataView, offset: number) => void;
  dataBytes: number;
  /** Insert a junk chunk before `data`, the way afconvert's `FLLR` padding
   *  does. A reader that assumes a 44-byte header reads pure noise here. */
  junkChunk?: boolean;
  /** Use WAVE_FORMAT_EXTENSIBLE, whose real format tag hides in a GUID. */
  extensible?: boolean;
}): Uint8Array {
  const fmtSize = options.extensible ? 40 : 16;
  const junkSize = options.junkChunk ? 20 : 0;
  const junkTotal = options.junkChunk ? 8 + junkSize : 0;
  const total = 12 + 8 + fmtSize + junkTotal + 8 + options.dataBytes;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  const tag = (at: number, text: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  tag(0, "RIFF");
  view.setUint32(4, total - 8, true);
  tag(8, "WAVE");

  tag(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, options.extensible ? 0xfffe : options.formatTag, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  const blockAlign = (options.bits >> 3) * options.channels;
  view.setUint32(28, options.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, options.bits, true);
  if (options.extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, options.bits, true); // valid bits
    view.setUint32(40, 0, true); // channel mask
    view.setUint16(44, options.formatTag, true); // SubFormat GUID, first two bytes
  }

  let at = 20 + fmtSize;
  if (options.junkChunk) {
    tag(at, "FLLR");
    view.setUint32(at + 4, junkSize, true);
    at += 8 + junkSize;
  }

  tag(at, "data");
  view.setUint32(at + 4, options.dataBytes, true);
  options.writeData(view, at + 8);
  return bytes;
}

describe("wav", () => {
  it("round-trips float samples through PCM16 within quantisation error", () => {
    const sampleRate = 48000;
    const original = new Float32Array(2000);
    for (let i = 0; i < original.length; i++) original[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);

    const decoded = decodeWav(encodeWav(original, sampleRate));
    expect(decoded.sampleRate).toBe(sampleRate);
    expect(decoded.samples.length).toBe(original.length);
    let worst = 0;
    for (let i = 0; i < original.length; i++) {
      worst = Math.max(worst, Math.abs(decoded.samples[i] - original[i]));
    }
    // One LSB of 16-bit is 1/32768 ≈ 3.05e-5; rounding costs at most half of
    // that, so anything above one LSB means the scaling is wrong.
    expect(worst).toBeLessThan(1 / 32768);
  });

  it("clamps rather than wraps on out-of-range input", () => {
    // A float buffer may legally exceed ±1. Letting int16 wrap would turn the
    // loudest moment of a recording into white noise, which is a spectacular
    // and entirely silent failure.
    const decoded = decodeWav(encodeWav(new Float32Array([2, -2, 0.5]), 48000));
    expect(decoded.samples[0]).toBeCloseTo(1, 3);
    expect(decoded.samples[1]).toBeCloseTo(-1, 3);
    expect(decoded.samples[2]).toBeCloseTo(0.5, 3);
  });

  it("reads the shape afconvert actually writes: extensible fmt, junk chunk, PCM16", () => {
    // This is exactly the layout of the project's own reference recording:
    // WAVE_FORMAT_EXTENSIBLE with a 40-byte fmt chunk and an `FLLR` padding
    // chunk sitting between fmt and data.
    const values = [0, 16384, -16384, 32767, -32768];
    const bytes = buildWav({
      formatTag: 1,
      extensible: true,
      junkChunk: true,
      channels: 1,
      sampleRate: 48000,
      bits: 16,
      dataBytes: values.length * 2,
      writeData: (view, at) => values.forEach((v, i) => view.setInt16(at + i * 2, v, true)),
    });

    const { samples, sampleRate } = decodeWav(bytes);
    expect(sampleRate).toBe(48000);
    expect([...samples].map((s) => Math.round(s * 32768))).toEqual(values);
  });

  it("reads 24-bit PCM, including the sign bit", () => {
    const values = [0, 4194304, -4194304, 8388607, -8388608];
    const bytes = buildWav({
      formatTag: 1,
      channels: 1,
      sampleRate: 44100,
      bits: 24,
      dataBytes: values.length * 3,
      writeData: (view, at) =>
        values.forEach((v, i) => {
          const u = v < 0 ? v + 0x1000000 : v;
          view.setUint8(at + i * 3, u & 0xff);
          view.setUint8(at + i * 3 + 1, (u >> 8) & 0xff);
          view.setUint8(at + i * 3 + 2, (u >> 16) & 0xff);
        }),
    });

    const { samples, sampleRate } = decodeWav(bytes);
    expect(sampleRate).toBe(44100);
    expect([...samples].map((s) => Math.round(s * 8388608))).toEqual(values);
  });

  it("reads IEEE float32 unchanged", () => {
    const values = [0, 0.25, -0.5, 1, -1];
    const bytes = buildWav({
      formatTag: 3,
      channels: 1,
      sampleRate: 48000,
      bits: 32,
      dataBytes: values.length * 4,
      writeData: (view, at) => values.forEach((v, i) => view.setFloat32(at + i * 4, v, true)),
    });
    expect([...decodeWav(bytes).samples]).toEqual(values);
  });

  it("averages multi-channel input to mono", () => {
    // Left and right of the same voice are the same signal; averaging gains
    // 3 dB of SNR and matches what a phone's mono capture does anyway.
    const frames: [number, number][] = [
      [1, -1],
      [0.5, 0.5],
      [1, 0],
    ];
    const bytes = buildWav({
      formatTag: 1,
      channels: 2,
      sampleRate: 48000,
      bits: 16,
      dataBytes: frames.length * 4,
      writeData: (view, at) =>
        frames.forEach(([l, r], i) => {
          view.setInt16(at + i * 4, Math.round(l * 32767), true);
          view.setInt16(at + i * 4 + 2, Math.round(r * 32767), true);
        }),
    });

    const { samples } = decodeWav(bytes);
    expect(samples.length).toBe(3);
    expect(samples[0]).toBeCloseTo(0, 3);
    expect(samples[1]).toBeCloseTo(0.5, 3);
    expect(samples[2]).toBeCloseTo(0.5, 3);
  });

  it("rejects what is not a WAV file instead of returning noise", () => {
    expect(() => decodeWav(new Uint8Array(4))).toThrow(/not a WAV/);
    expect(() => decodeWav(new TextEncoder().encode("free-form nonsense, 32 bytes.…"))).toThrow();
  });
});
