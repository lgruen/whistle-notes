import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioFileError,
  DECODE_SAMPLE_RATE,
  MAX_FILE_BYTES,
  capSamples,
  decodeAudioFile,
  mixToMono,
} from "../src/audio/decode.js";

/**
 * File import, tested either side of the one line that cannot be tested here.
 *
 * `decodeAudioData` is a platform codec: there is no honest way to exercise it
 * outside a browser, and pretending otherwise would only test the fake. So the
 * module is shaped to keep that seam as thin as possible — the arithmetic
 * around it (channel mixdown, the duration cap) is pure and is tested for real,
 * and the seam itself is checked for the things that are about *our* code
 * rather than the codec's: that the decode context is built at a fixed sample
 * rate, that failures come back as messages a user can act on, and that nothing
 * hands out a view into a buffer it is about to drop.
 *
 * What remains device-only: whether a given phone can decode a given m4a at
 * all.
 */

/** Minimal stand-in for an `AudioBuffer`; only four members are ever read. */
class FakeAudioBuffer {
  constructor(
    readonly channels: Float32Array[],
    readonly sampleRate: number,
  ) {}

  get numberOfChannels(): number {
    return this.channels.length;
  }

  get length(): number {
    return this.channels[0]?.length ?? 0;
  }

  getChannelData(index: number): Float32Array {
    return this.channels[index];
  }
}

type DecodeOutcome =
  | { kind: "promise"; buffer: FakeAudioBuffer }
  /** Older WebKit ignores the return value and only ever calls back. */
  | { kind: "callback"; buffer: FakeAudioBuffer }
  | { kind: "reject"; error: Error };

let outcome: DecodeOutcome = { kind: "promise", buffer: new FakeAudioBuffer([], 48000) };

class FakeOfflineAudioContext {
  static lastArgs: number[] | null = null;

  constructor(channels: number, length: number, sampleRate: number) {
    FakeOfflineAudioContext.lastArgs = [channels, length, sampleRate];
  }

  decodeAudioData(
    _bytes: ArrayBuffer,
    success: (buffer: FakeAudioBuffer) => void,
    failure: (error: Error) => void,
  ): Promise<FakeAudioBuffer> | undefined {
    switch (outcome.kind) {
      case "promise":
        return Promise.resolve(outcome.buffer);
      case "callback": {
        const { buffer } = outcome;
        // Asynchronously, like the real one: a synchronous callback would hide
        // any ordering mistake in the promise wrapper.
        setTimeout(() => success(buffer), 0);
        return undefined;
      }
      case "reject": {
        const { error } = outcome;
        setTimeout(() => failure(error), 0);
        return undefined;
      }
    }
  }
}

/** A file of `bytes` bytes whose contents never matter — the fake decoder does
 *  not look at them. Built as a stub rather than a real Blob so the oversize
 *  case does not have to allocate 32 MB to be tested. */
function fakeFile(bytes: number): File {
  return {
    size: bytes,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(Math.min(bytes, 8))),
  } as unknown as File;
}

function ramp(length: number, from: number, to: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = from + ((to - from) * i) / Math.max(1, length - 1);
  return data;
}

beforeEach(() => {
  FakeOfflineAudioContext.lastArgs = null;
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("channel mixdown", () => {
  it("averages every channel rather than picking one", () => {
    // Not "take the left channel": a whistle panned to one side would come
    // back at half level or not at all, and averaging is what the phone's own
    // mono capture does anyway.
    const mono = mixToMono([
      new Float32Array([1, 0, -1, 0.5]),
      new Float32Array([0, 0, 1, 0.5]),
    ]);
    expect([...mono]).toEqual([0.5, 0, 0, 0.5]);
  });

  it("copies rather than aliasing the decoded buffer", () => {
    // The `AudioBuffer` this came from is dropped immediately afterwards. A
    // returned view would keep its whole multi-megabyte backing store alive —
    // a leak with no symptom until the fourth import of the session.
    const channel = new Float32Array([0.25, -0.25]);
    const mono = mixToMono([channel]);
    channel[0] = 99;
    expect(mono[0]).toBe(0.25);
    expect(mono.buffer).not.toBe(channel.buffer);
  });

  it("handles the degenerate shapes", () => {
    expect(mixToMono([])).toHaveLength(0);
    // Channels of an AudioBuffer are always equal length; if that ever stops
    // being true, stop at the shortest rather than read past the end.
    expect([...mixToMono([new Float32Array([1, 1, 1]), new Float32Array([0])])]).toEqual([0.5]);
  });
});

describe("the duration cap", () => {
  const RATE = 48000;

  it("leaves anything inside the cap alone", () => {
    const samples = new Float32Array(10 * RATE);
    expect(capSamples(samples, RATE, 60)).toBe(samples);
  });

  it("keeps the beginning of anything longer", () => {
    const samples = ramp(90 * RATE, 0, 1);
    const capped = capSamples(samples, RATE, 60);
    expect(capped).toHaveLength(60 * RATE);
    expect(capped[0]).toBe(samples[0]);
    expect(capped[capped.length - 1]).toBe(samples[60 * RATE - 1]);
    // A slice, not a subarray: the discarded half hour must actually be
    // collectable.
    expect(capped.buffer.byteLength).toBe(capped.length * 4);
  });

  it("cuts on a sample boundary at any rate", () => {
    expect(capSamples(new Float32Array(100), 10, 3.5)).toHaveLength(35);
    expect(capSamples(new Float32Array(100), 44100, 0)).toHaveLength(0);
  });
});

describe("decoding a file", () => {
  it("always decodes at one fixed rate", async () => {
    outcome = { kind: "promise", buffer: new FakeAudioBuffer([ramp(4800, -1, 1)], 48000) };
    const decoded = await decodeAudioFile(fakeFile(1024));

    // The whole point of an `OfflineAudioContext` here: it resamples whatever
    // it decodes to its own rate, so the same file transcribes identically on
    // every device and in the Node harness. A device-dependent rate would make
    // a bug report reproduce differently on the phone that filed it.
    expect(FakeOfflineAudioContext.lastArgs).toEqual([1, 1, DECODE_SAMPLE_RATE]);
    expect(decoded.sampleRate).toBe(DECODE_SAMPLE_RATE);
    expect(decoded.samples).toHaveLength(4800);
    expect(decoded.truncated).toBe(false);
    expect(decoded.sourceDurationSec).toBeCloseTo(0.1, 10);
  });

  it("mixes a multi-channel file down and caps it, in that order", async () => {
    const seconds = 90;
    const length = seconds * DECODE_SAMPLE_RATE;
    const left = new Float32Array(length).fill(1);
    const right = new Float32Array(length).fill(0);
    outcome = { kind: "promise", buffer: new FakeAudioBuffer([left, right], 48000) };

    const decoded = await decodeAudioFile(fakeFile(2048), 60);

    expect(decoded.samples).toHaveLength(60 * DECODE_SAMPLE_RATE);
    expect(decoded.samples[0]).toBe(0.5);
    expect(decoded.truncated).toBe(true);
    // Reported from the *source*, not from what survived: the warning line
    // tells the user how long the file they picked actually was.
    expect(decoded.sourceDurationSec).toBeCloseTo(seconds, 6);
  });

  it("accepts a decoder that only calls back", async () => {
    // Older WebKit ignores the promise form entirely. Without the callback
    // arm, import there does nothing at all — no error, no result.
    outcome = { kind: "callback", buffer: new FakeAudioBuffer([ramp(480, 0, 1)], 48000) };
    const decoded = await decodeAudioFile(fakeFile(512));
    expect(decoded.samples).toHaveLength(480);
  });

  it("turns a codec failure into something a human can act on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    outcome = { kind: "reject", error: new Error("EncodingError") };
    await expect(decodeAudioFile(fakeFile(1024))).rejects.toBeInstanceOf(AudioFileError);
    await expect(decodeAudioFile(fakeFile(1024))).rejects.toThrow(/could not be decoded/i);
  });

  it("rejects a file with nothing in it", async () => {
    await expect(decodeAudioFile(fakeFile(0))).rejects.toThrow(/empty/i);

    // Decodes fine, contains no audio: a zero-length result would otherwise be
    // transcribed into a confident "no notes found".
    outcome = { kind: "promise", buffer: new FakeAudioBuffer([new Float32Array(0)], 48000) };
    await expect(decodeAudioFile(fakeFile(1024))).rejects.toThrow(/no audio/i);
  });

  it("refuses a file too big to decode before it tries", async () => {
    // `decodeAudioData` decodes the whole file before anything can be
    // truncated — an hour of audio is most of a gigabyte of float, and a phone
    // answers that with a tab crash rather than an error.
    await expect(decodeAudioFile(fakeFile(MAX_FILE_BYTES + 1))).rejects.toBeInstanceOf(
      AudioFileError,
    );
    expect(FakeOfflineAudioContext.lastArgs).toBeNull();
  });

  it("says so when the browser cannot decode at all", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    await expect(decodeAudioFile(fakeFile(1024))).rejects.toBeInstanceOf(AudioFileError);
  });
});
