import { describe, expect, it } from "vitest";
import { encodeWav16, takeFilename } from "../src/audio/wav-export.js";

/**
 * The debug export, checked by reading its output back.
 *
 * This encoder exists so that a take which transcribed badly can become a file
 * — and a file that no other tool can open is worth nothing at all. So the
 * assertions here are deliberately about the *format* rather than about the
 * function: every header field is read back at its RIFF offset, and the samples
 * are decoded the way any reader would decode them.
 *
 * `tools/wav.ts` is the repo's own reader and would make a tidy round-trip
 * partner, but it is Node-side harness code and this is browser code; the two
 * are kept apart on purpose, so the reader here is four lines of `DataView`
 * instead.
 */

function ascii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

/** Everything a reader needs, pulled straight out of the bytes. */
function parse(wav: ArrayBuffer) {
  const view = new DataView(wav);
  const dataBytes = view.getUint32(40, true);
  const samples: number[] = [];
  for (let i = 0; i < dataBytes / 2; i++) samples.push(view.getInt16(44 + i * 2, true));
  return {
    riff: ascii(view, 0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(view, 8, 4),
    fmtId: ascii(view, 12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataId: ascii(view, 36, 4),
    dataBytes,
    samples,
  };
}

describe("the WAV header", () => {
  it("describes 16-bit mono PCM at the take's own rate", () => {
    const wav = parse(encodeWav16(new Float32Array(100), 44100));

    expect(wav.riff).toBe("RIFF");
    expect(wav.wave).toBe("WAVE");
    expect(wav.fmtId).toBe("fmt ");
    expect(wav.fmtSize).toBe(16);
    expect(wav.format).toBe(1); // WAVE_FORMAT_PCM
    expect(wav.channels).toBe(1);
    // Whatever the device gave us, not a guess: the pipeline is rate-agnostic
    // and the harness has to hear exactly what the phone heard.
    expect(wav.sampleRate).toBe(44100);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.blockAlign).toBe(2);
    expect(wav.byteRate).toBe(44100 * 2);
    expect(wav.dataId).toBe("data");
  });

  it("declares the sizes the file actually has", () => {
    // A wrong RIFF size is the classic hand-rolled-WAV bug: players either
    // refuse the file or truncate it, and both look like a recording problem.
    const buffer = encodeWav16(new Float32Array(1000), 48000);
    const wav = parse(buffer);
    expect(buffer.byteLength).toBe(44 + 2000);
    expect(wav.dataBytes).toBe(2000);
    expect(wav.riffSize).toBe(buffer.byteLength - 8);
  });

  it("stays valid for an empty take", () => {
    const buffer = encodeWav16(new Float32Array(0), 48000);
    expect(buffer.byteLength).toBe(44);
    expect(parse(buffer).dataBytes).toBe(0);
  });
});

describe("the samples", () => {
  it("survives the round trip to within a quantisation step", () => {
    const source = new Float32Array([0, 0.5, -0.5, 0.25, -0.75]);
    const { samples } = parse(encodeWav16(source, 48000));
    for (let i = 0; i < source.length; i++) {
      expect(samples[i] / 32768).toBeCloseTo(source[i], 4);
    }
  });

  it("reaches full scale in both directions", () => {
    const { samples } = parse(encodeWav16(new Float32Array([1, -1]), 48000));
    // Two's complement has one more step below zero than above it, which is
    // why the scaling is asymmetric.
    expect(samples).toEqual([32767, -32768]);
  });

  it("clamps rather than wrapping", () => {
    // A take that clipped must come back as a take that clipped. Wrapping
    // would fold the peaks inside out into something that never happened —
    // and clipping is exactly the condition someone exports a file to
    // investigate.
    const { samples } = parse(encodeWav16(new Float32Array([1.4, -2.7]), 48000));
    expect(samples).toEqual([32767, -32768]);
  });
});

describe("the filename", () => {
  it("is a sortable local timestamp", () => {
    // Local, not UTC: these are matched up with "the take I did just now" by a
    // human looking at a downloads folder.
    const name = takeFilename(new Date(2026, 7, 31, 9, 5, 3));
    expect(name).toBe("whistle-20260831-090503.wav");
  });
});
