import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioFileError,
  DECODE_SAMPLE_RATE,
  HEADER_SNIFF_BYTES,
  MAX_COMPRESSED_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  capSamples,
  decodeAudioFile,
  isUncompressedContainer,
  mixToMono,
  resetDecodeContext,
  uncompressedByteLimit,
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
  /** Every construction ever, across the whole file. Not reset between tests,
   *  so "how many were built" is a file-wide fact: the module caches one
   *  context and these tests share one import of it. The `afterEach` drops that
   *  cache, so expect one construction per test that decodes — the thing worth
   *  asserting is that a single *test* does not build several. */
  static built: number[][] = [];
  /** Reset per test: how many times the codec was actually reached. */
  static decodeCalls = 0;

  constructor(channels: number, length: number, sampleRate: number) {
    FakeOfflineAudioContext.built.push([channels, length, sampleRate]);
  }

  decodeAudioData(
    _bytes: ArrayBuffer,
    success: (buffer: FakeAudioBuffer) => void,
    failure: (error: Error) => void,
  ): Promise<FakeAudioBuffer> | undefined {
    FakeOfflineAudioContext.decodeCalls++;
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

/**
 * A file of `bytes` bytes whose *contents* never matter to the fake decoder —
 * but whose header does, because that is what decides which size cap applies.
 * The default header is a compressed-looking file.
 *
 * Built as a stub rather than a real Blob so the oversize cases do not have to
 * allocate tens of megabytes to be tested.
 */
function fakeFile(bytes: number, head: Uint8Array = new Uint8Array(HEADER_SNIFF_BYTES)): File {
  return {
    size: bytes,
    slice: (start: number, end: number) => ({
      arrayBuffer: () => Promise.resolve(head.slice(start, end).buffer),
    }),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(Math.min(bytes, 8))),
  } as unknown as File;
}

function ascii(head: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) head[at + i] = text.charCodeAt(i);
}

interface WavShape {
  /** 1 = PCM, 3 = float, and anything else is a codec: 0x11 IMA ADPCM,
   *  0x55 an entire MP3 stream inside a WAV, 0xFFFE extensible. */
  format?: number;
  channels?: number;
  sampleRate?: number;
  bits?: number;
  /** A chunk to put in front of `fmt `, as real writers do. */
  lead?: string;
}

/** A RIFF/WAVE header with a real `fmt ` chunk in it. The defaults are what
 *  this app's own Save button writes. */
function wavHeader({
  format = 1,
  channels = 1,
  sampleRate = 48000,
  bits = 16,
  lead,
}: WavShape = {}): Uint8Array {
  const head = new Uint8Array(HEADER_SNIFF_BYTES);
  const view = new DataView(head.buffer);
  ascii(head, 0, "RIFF");
  ascii(head, 8, "WAVE");
  let at = 12;
  if (lead !== undefined) {
    ascii(head, at, lead);
    view.setUint32(at + 4, 8, true);
    at += 16;
  }
  ascii(head, at, "fmt ");
  view.setUint32(at + 4, 16, true);
  view.setUint16(at + 8, format, true);
  view.setUint16(at + 10, channels, true);
  view.setUint32(at + 12, sampleRate, true);
  view.setUint32(at + 16, (sampleRate * channels * bits) / 8, true);
  view.setUint16(at + 20, (channels * bits) / 8, true);
  view.setUint16(at + 22, bits, true);
  return head;
}

/** The AIFF counterpart: a `COMM` chunk, big-endian, with the sample rate as
 *  an 80-bit extended float. `codec` makes it an AIFC. */
function aiffHeader(bits = 16, codec?: string): Uint8Array {
  const head = new Uint8Array(HEADER_SNIFF_BYTES);
  const view = new DataView(head.buffer);
  ascii(head, 0, "FORM");
  ascii(head, 8, codec === undefined ? "AIFF" : "AIFC");
  ascii(head, 12, "COMM");
  view.setUint32(16, codec === undefined ? 18 : 22, false);
  view.setUint16(20, 1, false); // channels
  view.setUint32(22, 48000, false); // frames
  view.setUint16(26, bits, false);
  // 44100 as an 80-bit extended float: exponent, then a 64-bit mantissa whose
  // leading 1 is explicit. Exact in a double for a rate this size.
  const exponent = Math.floor(Math.log2(44100));
  const mantissa = 44100 * 2 ** (63 - exponent);
  view.setUint16(28, 16383 + exponent, false);
  view.setUint32(30, Math.floor(mantissa / 2 ** 32), false);
  view.setUint32(34, mantissa % 2 ** 32, false);
  if (codec !== undefined) ascii(head, 38, codec);
  return head;
}

/** A RIFF/WAVE file of `bytes` bytes — what this app's own Save button writes. */
function fakeWav(bytes: number, shape?: WavShape): File {
  return fakeFile(bytes, wavHeader(shape));
}

function ramp(length: number, from: number, to: number): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = from + ((to - from) * i) / Math.max(1, length - 1);
  return data;
}

beforeEach(() => {
  FakeOfflineAudioContext.decodeCalls = 0;
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
});

afterEach(() => {
  // Before the unstub, and the ordering is the point: the module parks the
  // context it built in a module-level variable, and `unstubAllGlobals` only
  // takes the *constructor* off the global object. Without this line every
  // later test in the process decodes against a fake belonging to a test that
  // has already finished.
  resetDecodeContext();
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

  it("drops the LFE and keeps the centre when the file is 5.1", () => {
    // A flat 1/6 average would fold a subwoofer channel of pure rumble into the
    // signal a pitch tracker is about to look at, and push the front content
    // ~6 dB below where the same material lands in stereo. Web Audio's own
    // coefficients say otherwise, so we use those.
    const ch = (value: number): Float32Array => new Float32Array([value]);
    // [L, R, C, LFE, Ls, Rs] — only the LFE is loud, and it is the one channel
    // that must not survive.
    const lfeOnly = mixToMono([ch(0), ch(0), ch(0), ch(1), ch(0), ch(0)]);
    expect(lfeOnly[0]).toBe(0);

    // Silence everywhere but the centre: it comes through at its full weight
    // relative to the others, not at a sixth.
    const centreOnly = mixToMono([ch(0), ch(0), ch(1), ch(0), ch(0), ch(0)]);
    expect(centreOnly[0]).toBeCloseTo(1 / 3.4142, 4);

    // And the result is normalised, so a full-scale 5.1 mix does not come out
    // over 1.0 and trip the clipping detector on audio that never clipped.
    const full = mixToMono([ch(1), ch(1), ch(1), ch(1), ch(1), ch(1)]);
    expect(full[0]).toBeCloseTo(1, 6);
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
    expect(FakeOfflineAudioContext.built[0]).toEqual([1, 1, DECODE_SAMPLE_RATE]);
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

  it("says so when the browser cannot decode at all", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    await expect(decodeAudioFile(fakeFile(1024))).rejects.toBeInstanceOf(AudioFileError);
  });

  it("reuses one decode context across imports", async () => {
    // WebKit caps how many live audio contexts a page may hold and does not
    // reclaim them promptly, so a context per import means the import-tweak-
    // import loop stops working after a handful of tries — silently, and only
    // on a phone. One context, built once, is the whole fix.
    const built = FakeOfflineAudioContext.built.length;
    outcome = { kind: "promise", buffer: new FakeAudioBuffer([ramp(480, 0, 1)], 48000) };
    for (let i = 0; i < 5; i++) await decodeAudioFile(fakeFile(1024));
    // One, for this test's own stub — see `resetDecodeContext` in the teardown.
    expect(FakeOfflineAudioContext.built).toHaveLength(built + 1);
    expect(FakeOfflineAudioContext.decodeCalls).toBe(5);
  });
});

/**
 * The size cap, which is the one guard here that cannot be exact.
 *
 * A compressed file's decoded size is its duration times the rate, and nothing
 * before the decode knows the duration — so the cap has to be sized for the
 * worst *bitrate* instead, and the arithmetic behind that number is worth
 * pinning: the old cap was 32 MB of anything, which at 32 kbps is 133 minutes
 * and about 1.5 GB of float, i.e. a dead tab rather than a message.
 */
describe("the size cap", () => {
  /** Peak float bytes per second of source: a stereo decode at 48 kHz plus the
   *  mono copy that is alive at the same time. */
  const PEAK_BYTES_PER_SEC = DECODE_SAMPLE_RATE * 4 * 3;

  it("keeps the worst plausible compressed file inside a phone's memory", () => {
    // 32 kbps is about what a voice-memo app produces in its compressed mode.
    const seconds = MAX_COMPRESSED_BYTES / (32000 / 8);
    expect(seconds * PEAK_BYTES_PER_SEC).toBeLessThanOrEqual(512 * 1024 * 1024);
    // The old 32 MB cap, for contrast: two hours of it, and well over a
    // gigabyte of float.
    expect((32 * 1024 * 1024) / (32000 / 8) * PEAK_BYTES_PER_SEC).toBeGreaterThan(
      1024 * 1024 * 1024,
    );
  });

  it("still admits a three-minute voice memo, which is the documented use", () => {
    // 128 kbps × 180 s. Truncating one of these to its first minute is the
    // behaviour the module is built around, so rejecting them would be a
    // regression dressed as a safety fix.
    expect((128000 / 8) * 180).toBeLessThan(MAX_COMPRESSED_BYTES);
  });

  it("gives an uncompressed file its own, much larger cap", async () => {
    // PCM's expansion factor is known and small, so the same memory budget buys
    // far more of it. This is not a nicety: this app's own Save button writes
    // 16-bit mono WAV, and a 60 s take is ~5.8 MB of it — over the compressed
    // cap. A single cap would have made the app unable to re-import its own
    // debug export.
    const ownExport = 44 + 60 * 48000 * 2;
    expect(ownExport).toBeGreaterThan(MAX_COMPRESSED_BYTES);
    expect(ownExport).toBeLessThan(MAX_UNCOMPRESSED_BYTES);

    outcome = { kind: "promise", buffer: new FakeAudioBuffer([ramp(480, 0, 1)], 48000) };
    await expect(decodeAudioFile(fakeWav(ownExport))).resolves.toBeDefined();
  });

  it("grants the big tier on the format chunk, not on the magic bytes", () => {
    // The hole this closes: `RIFF....WAVE` says the container is uncompressed
    // and says nothing whatever about the samples. A WAV is free to hold 8-bit
    // 8 kHz PCM — 32 MB of that is 70 minutes and ~1.6 GB decoded — or IMA
    // ADPCM, or an entire MP3 stream. All three pass a twelve-byte sniff.
    expect(uncompressedByteLimit(wavHeader())).toBe(MAX_UNCOMPRESSED_BYTES);
    expect(uncompressedByteLimit(wavHeader({ format: 3, bits: 32 }))).toBe(MAX_UNCOMPRESSED_BYTES);
    expect(uncompressedByteLimit(wavHeader({ channels: 2, sampleRate: 44100 }))).toBe(
      MAX_UNCOMPRESSED_BYTES,
    );

    // 8-bit, ADPCM, MP3-in-WAV, and `WAVE_FORMAT_EXTENSIBLE` — whose real tag
    // is behind a GUID this deliberately does not parse.
    expect(uncompressedByteLimit(wavHeader({ bits: 8, sampleRate: 8000 }))).toBeNull();
    expect(uncompressedByteLimit(wavHeader({ format: 0x11 }))).toBeNull();
    expect(uncompressedByteLimit(wavHeader({ format: 0x55 }))).toBeNull();
    expect(uncompressedByteLimit(wavHeader({ format: 0xfffe, bits: 24 }))).toBeNull();
  });

  it("computes the cap from the expansion rather than assuming one", () => {
    // Passing the format test is not enough on its own: 16-bit PCM at 8 kHz is
    // legal, uncompressed and *six times* the seconds per byte of the 48 kHz
    // file the 32 MB ceiling was sized for. The cap has to follow the rate.
    const slow = uncompressedByteLimit(wavHeader({ sampleRate: 8000 })) as number;
    expect(slow).toBeLessThan(MAX_UNCOMPRESSED_BYTES);
    expect(slow).toBeGreaterThan(MAX_COMPRESSED_BYTES);

    // And what "the cap" means: at that size the decode lands on the budget,
    // not past it. Peak is one float per channel at 48 kHz plus the mono copy.
    const seconds = slow / ((8000 * 1 * 16) / 8);
    expect(seconds * DECODE_SAMPLE_RATE * 4 * 2).toBeLessThanOrEqual(512 * 1024 * 1024);

    // The same file at 48 kHz is bounded by the ceiling instead — a phone can
    // afford four times this much of it, and 32 MB is the judgment call there.
    expect(uncompressedByteLimit(wavHeader())).toBe(MAX_UNCOMPRESSED_BYTES);
  });

  it("finds the format chunk behind the padding real writers put first", () => {
    // `fmt ` is normally at byte 12 and nothing requires it: JUNK padding for
    // alignment, a LIST of metadata, a bext broadcast chunk. Missing it would
    // silently demote every file that has one.
    expect(uncompressedByteLimit(wavHeader({ lead: "JUNK" }))).toBe(MAX_UNCOMPRESSED_BYTES);
    expect(uncompressedByteLimit(wavHeader({ lead: "LIST" }))).toBe(MAX_UNCOMPRESSED_BYTES);
  });

  it("reads AIFF's own format chunk, and does not trust an AIFC", () => {
    expect(uncompressedByteLimit(aiffHeader(16))).toBe(MAX_UNCOMPRESSED_BYTES);
    expect(uncompressedByteLimit(aiffHeader(8))).toBeNull();
    // An AIFC is an AIFF that may be compressed — `sowt` is little-endian PCM
    // and safe, `ima4` is 4:1 ADPCM and is exactly the case the magic misses.
    expect(uncompressedByteLimit(aiffHeader(16, "sowt"))).toBe(MAX_UNCOMPRESSED_BYTES);
    expect(uncompressedByteLimit(aiffHeader(16, "ima4"))).toBeNull();
  });

  it("resolves every unknown downwards", () => {
    // Being wrong in this direction costs a sentence on screen; being wrong in
    // the other one kills the tab. So: no format chunk, a truncated one, a
    // nonsense rate, a header shorter than the magic — all compressed.
    const noFmt = new Uint8Array(64);
    ascii(noFmt, 0, "RIFF");
    ascii(noFmt, 8, "WAVE");
    expect(uncompressedByteLimit(noFmt)).toBeNull();

    const cut = wavHeader().slice(0, 20);
    expect(uncompressedByteLimit(cut)).toBeNull();
    expect(uncompressedByteLimit(wavHeader({ sampleRate: 0 }))).toBeNull();
    expect(uncompressedByteLimit(wavHeader({ channels: 0 }))).toBeNull();
    expect(uncompressedByteLimit(new Uint8Array(4))).toBeNull();
  });

  it("refuses a mislabelled WAV before the codec sees it", async () => {
    // End to end, because the tiering is only worth anything if the cap it
    // picks is the one that runs. 8-bit 8 kHz at 32 MB is the ~1.6 GB decode.
    const calls = FakeOfflineAudioContext.decodeCalls;
    await expect(
      decodeAudioFile(fakeWav(MAX_UNCOMPRESSED_BYTES, { bits: 8, sampleRate: 8000 })),
    ).rejects.toThrow(/too large/i);
    expect(FakeOfflineAudioContext.decodeCalls).toBe(calls);
  });

  it("sniffs the container rather than trusting a name or a MIME type", () => {
    const bytes = (text: string): Uint8Array =>
      Uint8Array.from(text, (character) => character.charCodeAt(0));
    expect(isUncompressedContainer(bytes("RIFF\0\0\0\0WAVE"))).toBe(true);
    expect(isUncompressedContainer(bytes("FORM\0\0\0\0AIFF"))).toBe(true);
    expect(isUncompressedContainer(bytes("FORM\0\0\0\0AIFC"))).toBe(true);
    // A RIFF that is not WAVE (an AVI, say) gets the conservative cap.
    expect(isUncompressedContainer(bytes("RIFF\0\0\0\0AVI "))).toBe(false);
    // An m4a mislabelled `.wav` would otherwise be handed the 32 MB cap and
    // decode to a gigabyte.
    expect(isUncompressedContainer(bytes("\0\0\0 ftypM4A "))).toBe(false);
    expect(isUncompressedContainer(bytes("RIFF"))).toBe(false);
  });

  it("refuses an oversize file before it reaches the codec", async () => {
    const calls = FakeOfflineAudioContext.decodeCalls;
    await expect(decodeAudioFile(fakeFile(MAX_COMPRESSED_BYTES + 1))).rejects.toBeInstanceOf(
      AudioFileError,
    );
    await expect(decodeAudioFile(fakeWav(MAX_UNCOMPRESSED_BYTES + 1))).rejects.toThrow(/too large/i);
    expect(FakeOfflineAudioContext.decodeCalls).toBe(calls);
  });

  it("turns an allocation failure into advice rather than a blank screen", async () => {
    // The cap bounds the plausible worst case, not the actual one, so this
    // really can happen — and it arrives as a RangeError from an allocation,
    // which is nothing a codec-shaped error message would fit.
    vi.spyOn(console, "error").mockImplementation(() => {});
    outcome = { kind: "reject", error: new RangeError("Array buffer allocation failed") };
    await expect(decodeAudioFile(fakeFile(1024))).rejects.toThrow(/more memory/i);
  });
});
