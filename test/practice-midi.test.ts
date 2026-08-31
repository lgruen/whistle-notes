import { describe, expect, it } from "vitest";
import {
  MAX_MELODY_NOTES,
  MAX_MIDI_BYTES,
  MidiError,
  chordWarning,
  melodySummary,
  midiMelodies,
  parseMidi,
} from "../src/practice/midi.js";

/**
 * The MIDI parser, against files built byte by byte in this file.
 *
 * **No `.mid` fixtures are committed**, and that is not only the repository's
 * no-binaries rule. A hand-built file is the only kind whose ground truth is
 * known by construction: when a test says "this note lasts 0.5 s" it is because
 * these bytes say 480 ticks at 480 ticks per quarter at 120 bpm, and every step
 * of that is visible three lines above the assertion. A downloaded `.mid` would
 * make the *parser* the definition of what the file means, which is precisely
 * the thing under test.
 *
 * It also lets the nasty cases exist at all. Running status across a meta event,
 * a variable-length quantity at exactly 0x3fff, a note-on nobody ever turned
 * off, a file that stops mid-event — none of those are things you can go and
 * find, but all of them are things a real export can contain.
 *
 * The one thing this cannot do is prove the parser survives the wild. That is a
 * device check: real exports from a notation program and from a DAW.
 */

/* ── Building files ───────────────────────────────────────────────────── */

/** Seven bits per byte, high bit set on every byte but the last. */
function vlq(value: number): number[] {
  const out = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return out;
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function be16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function chunk(id: string, body: readonly number[]): number[] {
  return [...ascii(id), ...be32(body.length), ...body];
}

function header(format: number, tracks: number, division: number): number[] {
  return chunk("MThd", [...be16(format), ...be16(tracks), ...be16(division)]);
}

/** A track chunk, with the end-of-track meta event the spec requires. */
function track(...events: readonly number[][]): number[] {
  return chunk("MTrk", [...events.flat(), 0x00, 0xff, 0x2f, 0x00]);
}

function file(...parts: readonly number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

const on = (delta: number, pitch: number, velocity = 64, channel = 0): number[] => [
  ...vlq(delta),
  0x90 | channel,
  pitch,
  velocity,
];

const off = (delta: number, pitch: number, channel = 0): number[] => [
  ...vlq(delta),
  0x80 | channel,
  pitch,
  0x40,
];

const setTempo = (delta: number, usPerQuarter: number): number[] => [
  ...vlq(delta),
  0xff,
  0x51,
  0x03,
  (usPerQuarter >>> 16) & 0xff,
  (usPerQuarter >>> 8) & 0xff,
  usPerQuarter & 0xff,
];

const trackName = (delta: number, text: string): number[] => [
  ...vlq(delta),
  0xff,
  0x03,
  ...vlq(text.length),
  ...ascii(text),
];

/** 480 ticks to the quarter throughout, so a quarter note is 0.5 s at the
 *  default 120 bpm and the arithmetic in every assertion is checkable by eye. */
const PPQ = 480;

/* ── The format ───────────────────────────────────────────────────────── */

describe("reading a file", () => {
  it("reads notes, in seconds, at the tempo the spec assumes", () => {
    const midi = parseMidi(
      file(header(0, 1, PPQ), track(on(0, 60), off(PPQ, 60), on(0, 64), off(PPQ / 2, 64))),
    );
    expect(midi.format).toBe(0);
    expect(midi.tracks).toHaveLength(1);
    const notes = midi.tracks[0].notes;
    expect(notes.map((note) => note.midi)).toEqual([60, 64]);
    expect(notes[0].startSec).toBeCloseTo(0, 6);
    expect(notes[0].endSec).toBeCloseTo(0.5, 6);
    expect(notes[1].startSec).toBeCloseTo(0.5, 6);
    expect(notes[1].endSec).toBeCloseTo(0.75, 6);
  });

  it("treats a note-on at velocity zero as the note-off it is", () => {
    // The overwhelmingly common spelling, because it is what lets running
    // status compress a phrase into one status byte.
    const midi = parseMidi(
      file(header(0, 1, PPQ), track(on(0, 60), on(PPQ, 60, 0), on(0, 62), on(PPQ, 62, 0))),
    );
    const notes = midi.tracks[0].notes;
    expect(notes.map((note) => note.midi)).toEqual([60, 62]);
    expect(notes[0].endSec).toBeCloseTo(0.5, 6);
    expect(notes[1].endSec).toBeCloseTo(1, 6);
  });

  it("follows running status", () => {
    // One 0x90 for the whole phrase: every event after it is delta, pitch,
    // velocity with no status byte at all. A parser that misses this reads the
    // pitch as a status byte and produces nonsense or nothing.
    const events = [
      ...vlq(0), 0x90, 60, 64,
      ...vlq(PPQ), 60, 0,
      ...vlq(0), 62, 64,
      ...vlq(PPQ), 62, 0,
    ];
    const midi = parseMidi(file(header(0, 1, PPQ), track(events)));
    expect(midi.tracks[0].notes.map((note) => note.midi)).toEqual([60, 62]);
    expect(midi.tracks[0].notes[1].endSec).toBeCloseTo(1, 6);
  });

  it("refuses a file that leans on running status across a meta event", () => {
    // Meta and sysex cancel running status. A file that assumes otherwise is
    // malformed, and the honest answer is to say so rather than to resynchronise
    // on a data byte and invent a note out of it.
    const events = [
      ...vlq(0), 0x90, 60, 64,
      ...trackName(0, "x"),
      ...vlq(PPQ), 60, 0,
    ];
    expect(() => parseMidi(file(header(0, 1, PPQ), track(events)))).toThrow(MidiError);
  });

  it.each([
    ["0x00", 0],
    ["0x7f", 0x7f],
    ["0x80", 0x80],
    ["0x3fff", 0x3fff],
    ["0x0fffff", 0x0fffff],
  ])("reads a delta time of %s", (_name, delta) => {
    // The boundaries of the variable-length encoding: one byte, the first
    // two-byte value, the last two-byte value, and three bytes.
    const midi = parseMidi(file(header(0, 1, PPQ), track(on(delta, 60), off(1, 60))));
    expect(midi.tracks[0].notes[0].startSec).toBeCloseTo((delta * 0.5) / PPQ, 6);
  });

  it("skips chunks it does not know", () => {
    // Proprietary chunks are legal, and a reader that choked on one would
    // refuse real exports.
    const midi = parseMidi(
      file(header(0, 1, PPQ), chunk("XFIH", [1, 2, 3]), track(on(0, 60), off(PPQ, 60))),
    );
    expect(midi.tracks).toHaveLength(1);
    expect(midi.tracks[0].notes).toHaveLength(1);
  });

  it("reads past a header that is longer than it used to be", () => {
    const long = chunk("MThd", [...be16(0), ...be16(1), ...be16(PPQ), 0xaa, 0xbb]);
    const midi = parseMidi(file(long, track(on(0, 60), off(PPQ, 60))));
    expect(midi.tracks[0].notes).toHaveLength(1);
  });

  it("keeps a note nobody ever turned off, and ends it with the track", () => {
    // A file cut short, or an exporter that dropped the last note-off. Losing
    // it silently would lose the end of the melody, which is the part being
    // practised.
    const midi = parseMidi(file(header(0, 1, PPQ), track(on(0, 60), on(PPQ, 64), off(PPQ, 64))));
    const notes = midi.tracks[0].notes;
    expect(notes.map((note) => note.midi)).toEqual([60, 64]);
    const orphan = notes.find((note) => note.midi === 60);
    expect(orphan?.endSec).toBeCloseTo(1, 6);
  });

  it("ignores a note-off for a note that was never on", () => {
    const midi = parseMidi(file(header(0, 1, PPQ), track(off(0, 60), on(0, 62), off(PPQ, 62))));
    expect(midi.tracks[0].notes.map((note) => note.midi)).toEqual([62]);
  });

  it("matches a repeated pitch oldest-first", () => {
    // Two strikes of the same key before either is released. Oldest-first
    // matching is what every sequencer writes and the only rule that keeps
    // both durations sane.
    const midi = parseMidi(
      file(header(0, 1, PPQ), track(on(0, 60), on(PPQ, 60), off(PPQ, 60), off(PPQ, 60))),
    );
    const notes = midi.tracks[0].notes;
    expect(notes).toHaveLength(2);
    expect(notes[0].startSec).toBeCloseTo(0, 6);
    expect(notes[0].endSec).toBeCloseTo(1, 6);
    expect(notes[1].startSec).toBeCloseTo(0.5, 6);
    expect(notes[1].endSec).toBeCloseTo(1.5, 6);
  });

  it("steps over the events it has no use for", () => {
    const midi = parseMidi(
      file(
        header(0, 1, PPQ),
        track(
          [...vlq(0), 0xb0, 7, 100], // controller: two data bytes
          [...vlq(0), 0xc0, 5], // program change: one
          [...vlq(0), 0xe0, 0, 64], // pitch bend: two
          [...vlq(0), 0xf0, ...vlq(3), 1, 2, 0xf7], // sysex
          on(0, 60),
          off(PPQ, 60),
        ),
      ),
    );
    expect(midi.tracks[0].notes.map((note) => note.midi)).toEqual([60]);
  });
});

/* ── Tempo ────────────────────────────────────────────────────────────── */

describe("the tempo map", () => {
  it("uses a tempo written in another track", () => {
    // The format 1 case, and the one that matters: the tempo conventionally
    // lives alone in track 0 while every note is somewhere else. A parser that
    // timed each track by its own events would play this at 120 bpm.
    const midi = parseMidi(
      file(
        header(1, 2, PPQ),
        track(trackName(0, "Conductor"), setTempo(0, 1_000_000)), // 60 bpm
        track(trackName(0, "Lead"), on(0, 60), off(PPQ, 60)),
      ),
    );
    expect(midi.tracks[1].notes[0].endSec).toBeCloseTo(1, 6);
    expect(midi.tracks[0].name).toBe("Conductor");
    expect(midi.tracks[1].name).toBe("Lead");
  });

  it("integrates a tempo that changes part-way through", () => {
    const midi = parseMidi(
      file(
        header(1, 2, PPQ),
        track(setTempo(0, 500_000), setTempo(PPQ, 250_000)), // 120 then 240 bpm
        track(on(0, 60), off(PPQ, 60), on(0, 62), off(PPQ, 62)),
      ),
    );
    const notes = midi.tracks[1].notes;
    // First quarter at 120 bpm is half a second; the second, at 240, is a
    // quarter of one — so the phrase ends at 0.75 s, not at 1.0.
    expect(notes[0].endSec).toBeCloseTo(0.5, 6);
    expect(notes[1].endSec).toBeCloseTo(0.75, 6);
  });

  it("ignores a tempo of zero", () => {
    const midi = parseMidi(
      file(header(0, 1, PPQ), track(setTempo(0, 0), on(0, 60), off(PPQ, 60))),
    );
    expect(midi.tracks[0].notes[0].endSec).toBeCloseTo(0.5, 6);
  });

  it("lets track 0 win a tempo two tracks claim at the same tick", () => {
    // Two tempo events at tick 0 in different tracks is a malformed file, and
    // the convention decides it: format 1 puts the tempo map alone in track 0,
    // so a leftover event in a later track does not get to halve the score's
    // speed. The answer used to come from the order the tracks were flattened
    // in, which is to say from nothing at all.
    const both = (first: number, second: number): number =>
      parseMidi(
        file(
          header(1, 2, PPQ),
          track(setTempo(0, first), on(0, 60), off(PPQ, 60)),
          track(setTempo(0, second), on(0, 72), off(PPQ, 72)),
        ),
      ).tracks[0].notes[0].endSec;
    expect(both(500_000, 250_000)).toBeCloseTo(0.5, 6);
    expect(both(250_000, 500_000)).toBeCloseTo(0.25, 6);

    // Within one track the later event still wins, which is what a sequencer
    // means by writing two at one tick.
    const twice = parseMidi(
      file(header(0, 1, PPQ), track(setTempo(0, 500_000), setTempo(0, 250_000), on(0, 60), off(PPQ, 60))),
    );
    expect(twice.tracks[0].notes[0].endSec).toBeCloseTo(0.25, 6);

    // ...and a tempo change a later track owns alone is still honoured: the
    // rule is about collisions, not about ignoring other tracks.
    const later = parseMidi(
      file(
        header(1, 2, PPQ),
        track(setTempo(0, 500_000)),
        track(on(0, 60), off(PPQ, 60), setTempo(0, 250_000), on(0, 62), off(PPQ, 62)),
      ),
    );
    // A quarter at 120 bpm, then a quarter at 240: 0.5 s and then 0.25.
    expect(later.tracks[1].notes[1].endSec).toBeCloseTo(0.75, 6);
  });

  it("times a format 2 file by each track's own tempo", () => {
    // Format 2 is a bundle of independent sequences. Merging the maps — right
    // for format 1 — would time the second track by the first's tempo.
    const midi = parseMidi(
      file(
        header(2, 2, PPQ),
        track(setTempo(0, 1_000_000), on(0, 60), off(PPQ, 60)),
        track(on(0, 62), off(PPQ, 62)),
      ),
    );
    expect(midi.tracks[0].notes[0].endSec).toBeCloseTo(1, 6);
    expect(midi.tracks[1].notes[0].endSec).toBeCloseTo(0.5, 6);
  });

  it("reads an SMPTE division, where tempo means nothing", () => {
    // 25 frames a second, 40 ticks a frame: a tick is exactly one millisecond,
    // and the set-tempo event below must not change that by a hair.
    const division = ((256 - 25) << 8) | 40;
    const midi = parseMidi(
      file(header(0, 1, division), track(setTempo(0, 1_000_000), on(0, 60), off(500, 60))),
    );
    expect(midi.tracks[0].notes[0].endSec).toBeCloseTo(0.5, 6);
  });
});

/* ── Files that are not files ─────────────────────────────────────────── */

describe("a file that cannot be read", () => {
  it("says so rather than throwing something shapeless", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array(ascii("not a midi file at all")),
      file(chunk("RIFF", ascii("WAVEfmt "))),
    ]) {
      expect(() => parseMidi(bytes)).toThrow(MidiError);
    }
  });

  /**
   * Padding is not damage.
   *
   * A chunk header is eight bytes; anything shorter than that left at the end
   * of a file cannot be a chunk, and refusing the file over it throws away a
   * melody that read perfectly. Real files pick these up — an editor padding to
   * an even length, a transfer rounding up to a block — and "that MIDI file is
   * damaged" is a dead end with no way forward on screen.
   */
  it("reads a file with a few bytes left over after the last chunk", () => {
    for (const tail of [[], [0], [0, 0], [0, 0, 0], [0x0a], [0, 0, 0, 0, 0, 0, 0]]) {
      const midi = parseMidi(
        file(header(0, 1, PPQ), track(on(0, 60), off(PPQ, 60)), tail),
      );
      expect(midi.tracks, `${tail.length} trailing`).toHaveLength(1);
      expect(midi.tracks[0].notes, `${tail.length} trailing`).toHaveLength(1);
    }
    // Eight bytes *is* a chunk header, and one that lies about its length is
    // still a damaged file rather than padding.
    expect(() =>
      parseMidi(file(header(0, 1, PPQ), track(on(0, 60), off(PPQ, 60)), ascii("MTrk"), be32(99))),
    ).toThrow(MidiError);
  });

  /**
   * A data byte with its high bit set means the stream has desynchronised, and
   * everything after it is invention. Read anyway, a note-on with "pitch"
   * `0xC5` becomes MIDI 197 — a number the synth turns into 63 kHz, on a device
   * that has to render it — and in the orphaned-note path it used to alias onto
   * another channel as well.
   */
  it("refuses an event whose data bytes are not data bytes", () => {
    const damaged = (body: readonly number[]): Uint8Array =>
      file(header(0, 1, PPQ), chunk("MTrk", body));
    for (const body of [
      // Note-on with a pitch of 197, released properly.
      [...vlq(0), 0x90, 0xc5, 0x40, ...vlq(PPQ), 0x80, 0xc5, 0x00, ...vlq(0), 0xff, 0x2f, 0],
      // The same, never released, which is the orphan path.
      [...vlq(0), 0x91, 0xc5, 0x40, ...vlq(PPQ), 0xff, 0x2f, 0],
      // A velocity out of range.
      [...vlq(0), 0x90, 60, 0x90, ...vlq(PPQ), 0xff, 0x2f, 0],
      // ...and the events that are skipped rather than kept, which have to be
      // read for the same reason: a status byte inside one is a lost stream.
      [...vlq(0), 0xb0, 0x07, 0x80, ...vlq(0), 0xff, 0x2f, 0],
      [...vlq(0), 0xc0, 0x80, ...vlq(0), 0xff, 0x2f, 0],
    ]) {
      expect(() => parseMidi(damaged(body))).toThrow(MidiError);
    }

    // A legal file with every data byte at its maximum still reads.
    const edge = parseMidi(damaged([...vlq(0), 0x90, 0x7f, 0x7f, ...vlq(PPQ), 0x80, 0x7f, 0x40, ...vlq(0), 0xff, 0x2f, 0]));
    expect(edge.tracks[0].notes[0].midi).toBe(127);
  });

  it("refuses a header that does not describe a MIDI file", () => {
    // A format nobody has ever written, and a division of zero ticks per
    // quarter note — which would be a division by zero downstream.
    expect(() => parseMidi(file(header(9, 1, PPQ), track(on(0, 60))))).toThrow(MidiError);
    expect(() => parseMidi(file(header(0, 1, 0), track(on(0, 60))))).toThrow(MidiError);
  });

  it("refuses a file that stops part-way through", () => {
    const whole = [...file(header(0, 1, PPQ), track(on(0, 60), off(PPQ, 60)))];
    // Every truncation of a valid file, from just inside the header to one byte
    // short of the end: not one of them may hang, and not one may come back
    // with notes invented out of the missing bytes.
    for (let length = 1; length < whole.length; length++) {
      const cut = new Uint8Array(whole.slice(0, length));
      let notes = -1;
      try {
        notes = parseMidi(cut).tracks.reduce((total, t) => total + t.notes.length, 0);
      } catch (error) {
        expect(error, `at ${length} bytes`).toBeInstanceOf(MidiError);
        continue;
      }
      // A prefix that happens to parse (the header plus a complete track chunk
      // is one) must at least not have made anything up.
      expect(notes, `at ${length} bytes`).toBeLessThanOrEqual(1);
    }
  });

  it("refuses a track chunk that claims more bytes than the file has", () => {
    const body = [...on(0, 60), ...off(PPQ, 60)];
    const lying = [...ascii("MTrk"), ...be32(body.length + 500), ...body];
    expect(() => parseMidi(file(header(0, 1, PPQ), lying))).toThrow(MidiError);
  });

  it("refuses a file with no track in it", () => {
    expect(() => parseMidi(file(header(0, 0, PPQ)))).toThrow(MidiError);
  });

  it("refuses a file too large to be a melody", () => {
    const huge = new Uint8Array(MAX_MIDI_BYTES + 1);
    expect(() => parseMidi(huge)).toThrow(MidiError);
  });

  it("refuses a stray real-time byte rather than resynchronising on it", () => {
    const events = [...vlq(0), 0xf8, ...on(0, 60), ...off(PPQ, 60)];
    expect(() => parseMidi(file(header(0, 1, PPQ), track(events)))).toThrow(MidiError);
  });
});

/* ── Picking a melody out of it ───────────────────────────────────────── */

describe("finding the melodies", () => {
  it("splits one track into its channels", () => {
    // The format 0 case: everything in one track, separated only by channel.
    // Handing back one stream would mix the tune with the bass.
    const midi = parseMidi(
      file(
        header(0, 1, PPQ),
        track(on(0, 72, 64, 0), on(0, 48, 64, 1), off(PPQ, 72, 0), off(0, 48, 1)),
      ),
    );
    const melodies = midiMelodies(midi);
    expect(melodies.map((melody) => melody.id)).toEqual(["0:0", "0:1"]);
    expect(melodies[0].notes[0].midi).toBe(72);
    expect(melodies[1].notes[0].midi).toBe(48);
    // Two voices out of one track, so the names have to be told apart.
    expect(melodies[0].name).not.toBe(melodies[1].name);
  });

  it("takes the top note of a chord, and says how often it had to", () => {
    const midi = parseMidi(
      file(
        header(0, 1, PPQ),
        track(
          // A triad, then a single note, then another triad.
          on(0, 60), on(0, 64), on(0, 67),
          off(PPQ, 60), off(0, 64), off(0, 67),
          on(0, 71), off(PPQ, 71),
          on(0, 62), on(0, 65), on(0, 69),
          off(PPQ, 62), off(0, 65), off(0, 69),
        ),
      ),
    );
    const [melody] = midiMelodies(midi);
    expect(melody.notes.map((note) => note.midi)).toEqual([67, 71, 69]);
    expect(melody.chordFraction).toBeCloseTo(2 / 3, 6);
    expect(chordWarning(melody)).toMatch(/67%/);
    // A single line earns no warning at all.
    expect(chordWarning({ chordFraction: 0 })).toBeNull();
  });

  it("does not mistake a fast run for a chord", () => {
    // 60 ticks at 120 bpm is 62.5 ms between onsets — twice the window, and
    // exactly the case where a wider one would eat a melody.
    const midi = parseMidi(
      file(
        header(0, 1, PPQ),
        track(on(0, 60), off(60, 60), on(0, 62), off(60, 62), on(0, 64), off(60, 64)),
      ),
    );
    const [melody] = midiMelodies(midi);
    expect(melody.notes.map((note) => note.midi)).toEqual([60, 62, 64]);
    expect(melody.chordFraction).toBe(0);
  });

  it("keeps durations real, and never longer than the melody", () => {
    // A note held right through the next one (a legato overlap): its slot has
    // to stop where the next slot starts, or the melody would play back longer
    // than the file it came from.
    const midi = parseMidi(
      file(header(0, 1, PPQ), track(on(0, 60), on(PPQ, 62), off(PPQ, 60), off(PPQ, 62))),
    );
    const [melody] = midiMelodies(midi);
    expect(melody.notes[0].durSec).toBeCloseTo(0.5, 6);
    expect(melody.notes[1].durSec).toBeCloseTo(1, 6);
    expect(melody.durationSec).toBeCloseTo(1.5, 6);
  });

  it("gives a zero-length note something to be", () => {
    // A note-on and note-off on the same tick is legal, and is nothing at all
    // to whistle.
    const midi = parseMidi(file(header(0, 1, PPQ), track(on(0, 60), off(0, 60))));
    const [melody] = midiMelodies(midi);
    expect(melody.notes[0].durSec).toBeGreaterThan(0);
  });

  it("leaves the drum kit alone unless it is all there is", () => {
    const withMelody = parseMidi(
      file(
        header(0, 1, PPQ),
        track(on(0, 60, 64, 0), off(PPQ, 60, 0), on(0, 38, 64, 9), off(PPQ, 38, 9)),
      ),
    );
    expect(midiMelodies(withMelody).map((melody) => melody.channel)).toEqual([0]);

    // ...but a file that is only drums must not come back empty, or the user is
    // told there are no notes in a file full of them.
    const drumsOnly = parseMidi(
      file(header(0, 1, PPQ), track(on(0, 38, 64, 9), off(PPQ, 38, 9))),
    );
    expect(midiMelodies(drumsOnly).map((melody) => melody.channel)).toEqual([9]);
  });

  it("names a part after the track, and falls back on its position", () => {
    const named = parseMidi(
      file(header(1, 2, PPQ), track(trackName(0, "Flute")), track(on(0, 60), off(PPQ, 60))),
    );
    expect(midiMelodies(named)[0].name).toBe("Part 2");

    const withName = parseMidi(
      file(header(1, 1, PPQ), track(trackName(0, "Flute"), on(0, 60), off(PPQ, 60))),
    );
    expect(midiMelodies(withName)[0].name).toBe("Flute");
  });

  it("cuts a melody that is longer than anyone can practise, and says so", () => {
    const events: number[][] = [];
    for (let i = 0; i < MAX_MELODY_NOTES + 10; i++) {
      events.push(on(0, 60 + (i % 12)), off(PPQ, 60 + (i % 12)));
    }
    const [melody] = midiMelodies(parseMidi(file(header(0, 1, PPQ), track(...events))));
    expect(melody.notes).toHaveLength(MAX_MELODY_NOTES);
    expect(melody.truncated).toBe(true);
    expect(melodySummary(melody)).toContain(`first ${MAX_MELODY_NOTES} kept`);
  });

  it("summarises a part without naming a single pitch", () => {
    const [melody] = midiMelodies(
      parseMidi(file(header(0, 1, PPQ), track(on(0, 60), off(PPQ, 60), on(0, 64), off(PPQ, 64)))),
    );
    expect(melodySummary(melody)).toBe("2 notes · 1.0 s");
    expect(melodySummary(melody)).not.toMatch(/\b[A-G][#b]?-?\d\b/);
  });

  it("has nothing to offer from a file with no notes", () => {
    expect(midiMelodies(parseMidi(file(header(0, 1, PPQ), track(trackName(0, "Empty")))))).toEqual(
      [],
    );
  });
});
