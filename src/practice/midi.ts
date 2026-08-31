/**
 * Standard MIDI Files, parsed by hand.
 *
 * ## Why hand-rolled
 *
 * This app ships `fft.js` and nothing else, and a MIDI parser is not where that
 * changes. The format is a 1988 chunk format with three moving parts — a header,
 * a stream of delta-timed events per track, and a tempo map — and the whole of
 * what practice mode needs from it (which notes, starting when, for how long)
 * is about two hundred lines. Every published parser is bigger than that because
 * it also implements the ninety per cent of MIDI this app has no use for: pitch
 * bend, controllers, sysex, SMF writing, real-time playback.
 *
 * Pure: no DOM, no storage, `Uint8Array` in and plain data out. That is what
 * makes it testable against byte fixtures built inside the test file rather than
 * against `.mid` files committed to a public repo.
 *
 * ## What a MIDI file actually is
 *
 * A sequence of chunks, each a four-character id and a big-endian length:
 *
 * - `MThd` — format (0, 1 or 2), track count, and the **division**, which says
 *   what a tick means: normally ticks per quarter note, occasionally SMPTE
 *   frames (see {@link buildTiming}).
 * - `MTrk` — a stream of `<delta-ticks> <event>` pairs. Delta times are
 *   variable-length quantities; events are the same status bytes a MIDI cable
 *   carries, plus meta events (`FF`) that only exist in files.
 *
 * Anything else is skipped, which the spec requires: proprietary chunks are
 * legal and a reader that choked on them would reject real exports.
 *
 * Three details do all the damage if you get them wrong:
 *
 * 1. **Running status.** An event may omit its status byte and inherit the
 *    previous one. Without it a file is unreadable — and a meta or sysex event
 *    *cancels* it, which is the part people forget.
 * 2. **Note-on with velocity 0 is a note-off.** Ubiquitous, because it is what
 *    lets running status compress a whole phrase into one status byte.
 * 3. **Ticks are not time.** Seconds come from integrating the tempo map, and in
 *    a format 1 file that map lives in a *different track* from the notes.
 *
 * ## What comes out
 *
 * {@link parseMidi} converts to seconds immediately, so nothing downstream ever
 * has to think about ticks. {@link midiMelodies} then turns the note soup into
 * candidate single-line melodies — one per track and channel, chords collapsed
 * to their top note — which is what a practice target is.
 */

import type { TargetNote } from "./align.js";

/** A file we cannot read, with a sentence that can go straight on screen. */
export class MidiError extends Error {}

const NOT_MIDI = "That does not look like a MIDI file.";
const DAMAGED = "That MIDI file is damaged — it stops part-way through.";

/**
 * The largest file we will even open.
 *
 * A MIDI file is events, not audio: a whole symphony is tens of kilobytes and
 * anything a person would practise against is under one. Two megabytes is
 * therefore absurdly generous and still small enough that the parse cannot
 * become the reason a phone stalls.
 */
export const MAX_MIDI_BYTES = 2 * 1024 * 1024;

/**
 * The longest melody a target may become.
 *
 * Not a format limit — a usefulness limit, three times over. A practice target
 * is a phrase you can hold in your head and whistle back; the alignment that
 * scores an attempt is O(n·m) in the note counts and runs once per candidate
 * register; and the trim controls take one tap per note, so a five-hundred-note
 * melody would be untrimmable anyway. What is over the line is dropped from the
 * end and the user is told so, rather than the melody being refused.
 *
 * It lives here because imports were the first source that could reach it, but
 * it applies to **every** target: `applyTargetTake` in `main.ts` caps a recorded
 * one the same way, since a minute of whistling is a perfectly ordinary way to
 * arrive at three hundred notes.
 */
export const MAX_MELODY_NOTES = 64;

/** 120 bpm, the tempo the spec says to assume until a file says otherwise. */
const DEFAULT_US_PER_QUARTER = 500_000;

/**
 * How close two note starts have to be to count as one chord.
 *
 * A judgement, and the trade is real in both directions. Too wide and a fast
 * run of single notes collapses into one "chord" and the melody loses notes;
 * too narrow and a humanised chord — a piano roll where the performer's fingers
 * landed a few milliseconds apart — is read as a fast run. 30 ms sits under the
 * ~75 ms between sixteenth notes at 200 bpm (so real runs survive) and over the
 * spread of any chord a sequencer writes.
 */
const CHORD_WINDOW_SEC = 0.03;

/** No target note may be shorter than this. A zero-length note is legal MIDI —
 *  a note-on and note-off on the same tick — and is nothing at all to whistle. */
const MIN_NOTE_SEC = 0.05;

/** General MIDI puts the drum kit on channel 10 (9, counting from zero), where
 *  "pitch" means "which drum" and a melody is not what you would get. */
const DRUM_CHANNEL = 9;

/** One note, already in seconds. */
export interface MidiNote {
  midi: number;
  channel: number;
  startSec: number;
  endSec: number;
}

export interface MidiTrack {
  /** Position in the file, from zero. */
  index: number;
  /** The `FF 03` track name, or `""`. Comes from the file: never trust it as
   *  markup. */
  name: string;
  notes: readonly MidiNote[];
}

export interface ParsedMidi {
  /** 0 (one track), 1 (parallel tracks, one timeline) or 2 (independent). */
  format: number;
  tracks: readonly MidiTrack[];
}

/* ── Reading bytes ────────────────────────────────────────────────────── */

/**
 * A bounds-checked cursor.
 *
 * Every read goes through {@link Reader.need}, so a truncated file produces one
 * sentence rather than a `NaN` that turns into a note at MIDI pitch `undefined`
 * three functions later. That is the entire reason this is a class and not four
 * loose functions over an index.
 */
class Reader {
  at: number;
  readonly end: number;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, at = 0, end = bytes.length) {
    this.bytes = bytes;
    this.at = at;
    this.end = end;
  }

  get done(): boolean {
    return this.at >= this.end;
  }

  private need(count: number): void {
    if (this.at + count > this.end) throw new MidiError(DAMAGED);
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.at++];
  }

  /**
   * A data byte, which in MIDI means one with its high bit clear.
   *
   * The spec is unambiguous: data bytes are `00`–`7F`, and a status byte can
   * only appear where an event begins. A file where one turns up mid-event is a
   * file we have lost sync with — the same conclusion the `0xF1`–`0xFE` arm
   * below reaches, and the same answer. Reading it anyway is how a note-on with
   * "pitch" `0xC5` becomes MIDI 197: a number `midiToHz` will happily turn into
   * 63 kHz, handed to a synth on a device that has to render it.
   */
  data(): number {
    const byte = this.u8();
    if (byte >= 0x80) throw new MidiError(DAMAGED);
    return byte;
  }

  /** How many bytes are left. A chunk header is eight of them, so this is what
   *  tells the walk in {@link parseMidi} whether another one can exist. */
  get remaining(): number {
    return Math.max(0, this.end - this.at);
  }

  /** Put back the byte just read. Used for exactly one thing: a running-status
   *  event, whose first byte turns out to be data rather than status. */
  rewind(): void {
    this.at--;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  /** Multiplication rather than `<< 16`: a length near 2^31 read with shifts
   *  comes back negative, and a negative length is an infinite loop. */
  u32(): number {
    return this.u16() * 0x10000 + this.u16();
  }

  skip(count: number): void {
    this.need(count);
    this.at += count;
  }

  take(count: number): Uint8Array {
    this.need(count);
    const out = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }

  fourCC(): string {
    return String.fromCharCode(...this.take(4));
  }

  /**
   * A variable-length quantity: seven bits per byte, high bit means "more".
   *
   * Four bytes maximum — the spec's own limit, and what keeps `<< 7` inside 28
   * bits where it is still ordinary integer arithmetic. A fifth continuation
   * byte means the file is not what it says it is.
   */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new MidiError(DAMAGED);
  }
}

/* ── Time ─────────────────────────────────────────────────────────────── */

interface TempoChange {
  tick: number;
  usPerQuarter: number;
}

/** A tempo change with the clock already integrated up to it. */
interface TempoPoint {
  tick: number;
  seconds: number;
  secPerTick: number;
}

/** Ticks → seconds, for one timeline. */
type Timing = (tick: number) => number;

/**
 * Turn a division and a list of tempo changes into a tick→seconds function.
 *
 * Two completely different time bases hide behind one 16-bit field:
 *
 * - **Metrical** (top bit clear): the value is ticks per quarter note, and a
 *   tick's length is whatever the current tempo says. So the map has to be
 *   *integrated* — each tempo change carries the number of seconds elapsed
 *   before it, and a tick inside a segment is that plus a linear offset.
 * - **SMPTE** (top bit set): the high byte is a negative frame rate (−24, −25,
 *   −29 for 29.97 drop-frame, −30) and the low byte is ticks per frame. A tick
 *   is then an absolute length of time and tempo events mean nothing at all.
 *
 * Getting the second case wrong is not exotic: film and video scoring tools
 * write it, and reading its division as ticks-per-quarter yields a melody about
 * fifty times too slow.
 */
function buildTiming(division: number, changes: readonly TempoChange[]): Timing {
  if ((division & 0x8000) !== 0) {
    // Two's-complement negative in the high byte; 29 is shorthand for 29.97.
    const rate = 256 - (division >>> 8);
    const fps = rate === 29 ? 29.97 : rate;
    const ticksPerFrame = division & 0xff;
    if (fps <= 0 || ticksPerFrame <= 0) throw new MidiError(NOT_MIDI);
    const secPerTick = 1 / (fps * ticksPerFrame);
    return (tick) => tick * secPerTick;
  }

  const ticksPerQuarter = division & 0x7fff;
  if (ticksPerQuarter <= 0) throw new MidiError(NOT_MIDI);

  // Sorted by tick, and a later change at the same tick wins — which is what a
  // sequencer means when it writes two, and keeps the map monotonic either way.
  const sorted = [...changes].sort((a, b) => a.tick - b.tick);
  const points: TempoPoint[] = [
    { tick: 0, seconds: 0, secPerTick: DEFAULT_US_PER_QUARTER / 1e6 / ticksPerQuarter },
  ];
  for (const change of sorted) {
    const secPerTick = change.usPerQuarter / 1e6 / ticksPerQuarter;
    const last = points[points.length - 1];
    if (change.tick <= last.tick) {
      // Same tick (or a file with its changes out of order): replace rather
      // than append, so no segment ever has zero or negative length.
      last.secPerTick = secPerTick;
      continue;
    }
    points.push({
      tick: change.tick,
      seconds: last.seconds + (change.tick - last.tick) * last.secPerTick,
      secPerTick,
    });
  }

  return (tick) => {
    let point = points[0];
    for (const candidate of points) {
      if (candidate.tick > tick) break;
      point = candidate;
    }
    return point.seconds + (tick - point.tick) * point.secPerTick;
  };
}

/* ── Parsing ──────────────────────────────────────────────────────────── */

/** One track, still in ticks. */
interface RawTrack {
  index: number;
  name: string;
  notes: { midi: number; channel: number; startTick: number; endTick: number }[];
  tempo: TempoChange[];
}

/**
 * Read one `MTrk` body.
 *
 * The state machine is small and the three things that make it correct are
 * `status` (running status, cancelled by anything `F0` and above), the
 * velocity-0 rule, and closing whatever is still sounding when the track ends.
 */
function parseTrack(reader: Reader, index: number): RawTrack {
  const track: RawTrack = { index, name: "", notes: [], tempo: [] };
  /**
   * Note-ons waiting for their note-off, keyed by channel and pitch.
   *
   * Each entry carries its own channel and pitch rather than leaving them to be
   * recovered from the key by arithmetic. The key is `channel * 128 + pitch`,
   * which only inverts while `pitch < 128` — true now that {@link Reader.data}
   * enforces it, and the sort of invariant that is cheaper to carry than to
   * re-derive at the one place (orphaned notes, below) that used to get it
   * wrong and alias a note onto another channel.
   *
   * The starts are a list rather than a single tick, because the same pitch can
   * legally be struck twice before either is released — an overlapping repeated
   * note, or a sustained chord tone re-triggered. Oldest-first matching
   * (`shift`) is the convention every sequencer writes and the only one that
   * keeps durations sane when the two overlap.
   */
  const pending = new Map<number, { channel: number; pitch: number; starts: number[] }>();
  let tick = 0;
  let status = 0;

  while (!reader.done) {
    tick += reader.vlq();
    let byte = reader.u8();
    if (byte < 0x80) {
      // Running status: this byte is data, and the event is the last one's kind.
      if (status === 0) throw new MidiError(DAMAGED);
      reader.rewind();
      byte = status;
    } else if (byte < 0xf0) {
      status = byte;
    } else {
      // Meta and sysex cancel running status. A parser that keeps it here reads
      // the next event's first data byte as a status byte and derails.
      status = 0;
    }

    if (byte === 0xff) {
      const type = reader.u8();
      const data = reader.take(reader.vlq());
      if (type === 0x03 && track.name === "") track.name = readText(data);
      if (type === 0x51 && data.length === 3) {
        const usPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
        // A zero-microsecond quarter note is infinitely fast; some exporters
        // write it as a placeholder. Ignoring it keeps the previous tempo.
        if (usPerQuarter > 0) track.tempo.push({ tick, usPerQuarter });
      }
      if (type === 0x2f) break; // end of track
      continue;
    }

    if (byte === 0xf0 || byte === 0xf7) {
      reader.skip(reader.vlq());
      continue;
    }

    const kind = byte & 0xf0;
    const channel = byte & 0x0f;
    switch (kind) {
      case 0x80:
      case 0x90: {
        const pitch = reader.data();
        const velocity = reader.data();
        // The velocity-0 rule: an "on" at zero is an off, and it is how most
        // files spell every off they have.
        if (kind === 0x90 && velocity > 0) {
          const key = channel * 128 + pitch;
          const held = pending.get(key);
          if (held) held.starts.push(tick);
          else pending.set(key, { channel, pitch, starts: [tick] });
        } else {
          const startTick = pending.get(channel * 128 + pitch)?.starts.shift();
          // An off with nothing sounding is not an error — it is what a file
          // that starts mid-phrase looks like. Drop it.
          if (startTick !== undefined) {
            track.notes.push({ midi: pitch, channel, startTick, endTick: tick });
          }
        }
        break;
      }
      case 0xa0:
      case 0xb0:
      case 0xe0:
        // Read rather than skipped: a status byte in a data position means the
        // stream has desynchronised, and every event after it is invention.
        reader.data();
        reader.data();
        break;
      case 0xc0:
      case 0xd0:
        reader.data();
        break;
      default:
        // 0xF1–0xFE are real-time messages that belong on a cable, not in a
        // file. Reaching one means we have lost sync with the stream, and
        // guessing our way forward would invent notes.
        throw new MidiError(DAMAGED);
    }
  }

  // Whatever is still held when the track ends gets closed there. Orphans
  // happen — a file cut short, an exporter that forgot the last note-off — and
  // dropping them would silently lose the end of the melody, which is exactly
  // the part someone is trying to practise.
  for (const held of pending.values()) {
    for (const startTick of held.starts) {
      track.notes.push({
        midi: held.pitch,
        channel: held.channel,
        startTick,
        endTick: Math.max(tick, startTick),
      });
    }
  }
  track.notes.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi);
  return track;
}

/**
 * The one tempo map a format 0 or 1 file's tracks all share.
 *
 * Every track's tempo events go in, because a file is free to put a ritardando
 * wherever it likes — but where two tracks claim the *same tick*, the lower
 * track index wins. That is the SMF convention (format 1 puts the tempo map
 * alone in track 0) and without it the answer came from `flatMap` order, so a
 * file with a leftover tempo event in a later track played its whole score at
 * the wrong speed, with nothing on screen to suggest why. Within one track the
 * later event still wins, which is what a sequencer means by writing two.
 */
function mergeTempo(tracks: readonly RawTrack[]): TempoChange[] {
  const byTick = new Map<number, { track: number; usPerQuarter: number }>();
  for (const track of tracks) {
    for (const change of track.tempo) {
      const held = byTick.get(change.tick);
      if (held && held.track < track.index) continue;
      byTick.set(change.tick, { track: track.index, usPerQuarter: change.usPerQuarter });
    }
  }
  return [...byTick].map(([tick, held]) => ({ tick, usPerQuarter: held.usPerQuarter }));
}

/**
 * A meta event's text, defensively.
 *
 * Latin-1 by hand rather than a decoder: SMF predates Unicode, names are ASCII
 * in practice, and the failure mode of a wrong guess is a mangled label rather
 * than anything structural. Control characters come out because this string
 * ends up on screen, and the length is capped because nothing stops a file from
 * putting a novel in a track name.
 */
function readText(data: Uint8Array): string {
  let out = "";
  for (const byte of data.subarray(0, 64)) {
    out += byte >= 0x20 && byte !== 0x7f ? String.fromCharCode(byte) : " ";
  }
  return out.trim();
}

/**
 * Parse a whole file into tracks whose notes are in seconds.
 *
 * The tempo map is the one thing that cannot be done per track:
 *
 * - **Format 1** is the common case — parallel tracks sharing one timeline,
 *   with the tempo conventionally alone in track 0. So every track's tempo
 *   events are merged into one map (see {@link mergeTempo}, which is also where
 *   "track 0 owns the tempo" is enforced for events that collide) and every
 *   track is read through it. A parser that timed each track by its own events
 *   would play a format 1 file at 120 bpm no matter what the score said.
 * - **Format 0** is one track, so merging is a no-op.
 * - **Format 2** is a *bundle of independent* sequences, each with its own
 *   timeline. Merging there would be actively wrong, so each track is timed by
 *   its own events. (Practically nothing writes format 2; supporting it is four
 *   lines and beats guessing.)
 */
export function parseMidi(bytes: Uint8Array): ParsedMidi {
  if (bytes.length > MAX_MIDI_BYTES) {
    throw new MidiError("That MIDI file is far larger than any melody needs to be.");
  }
  const reader = new Reader(bytes);
  if (bytes.length < 14 || reader.fourCC() !== "MThd") throw new MidiError(NOT_MIDI);

  const headerLength = reader.u32();
  if (headerLength < 6) throw new MidiError(NOT_MIDI);
  const format = reader.u16();
  reader.u16(); // declared track count: the chunks are the truth, so it is read
  //               past rather than trusted.
  const division = reader.u16();
  if (format > 2) throw new MidiError(NOT_MIDI);
  // The header is allowed to grow; a reader that assumed six bytes would break
  // on a future file for no reason.
  reader.skip(headerLength - 6);

  const raw: RawTrack[] = [];
  // A chunk header is eight bytes, so anything shorter than that at the end of
  // the file is not a chunk. Padding to an even length, an editor's stray
  // newline, a transfer that rounded up to a block: none of them are a reason
  // to refuse a file whose tracks all read cleanly, and refusing them is what
  // this loop used to do — one trailing zero byte and the melody was gone.
  while (reader.remaining >= 8) {
    const id = reader.fourCC();
    const length = reader.u32();
    const end = reader.at + length;
    if (end > reader.end) throw new MidiError(DAMAGED);
    // Unknown chunks are legal and must be skipped, not refused.
    if (id === "MTrk") raw.push(parseTrack(new Reader(bytes, reader.at, end), raw.length));
    reader.at = end;
  }
  if (raw.length === 0) throw new MidiError(NOT_MIDI);

  const shared = format === 2 ? null : buildTiming(division, mergeTempo(raw));

  return {
    format,
    tracks: raw.map((track) => {
      const at = shared ?? buildTiming(division, track.tempo);
      return {
        index: track.index,
        name: track.name,
        notes: track.notes.map((note) => ({
          midi: note.midi,
          channel: note.channel,
          startSec: at(note.startTick),
          endSec: at(note.endTick),
        })),
      };
    }),
  };
}

/* ── From notes to a melody ───────────────────────────────────────────── */

/** One candidate melody the user can pick out of a file. */
export interface MidiMelody {
  /** Stable within one file: `track:channel`. */
  id: string;
  trackIndex: number;
  channel: number;
  /** What to show in the picker. From the file, so never trusted as markup. */
  name: string;
  notes: TargetNote[];
  /** Fraction of the melody's slots that were chords, 0–1. */
  chordFraction: number;
  /** Whether {@link MAX_MELODY_NOTES} cut it short. */
  truncated: boolean;
  durationSec: number;
}

/**
 * Every single-line melody a file can offer, in file order.
 *
 * Split by **track and channel**, not by track alone. A format 0 file is one
 * track carrying the whole arrangement, separated only by channel; splitting by
 * track there would hand back one stream containing the melody, the bass and
 * the pads at once, and no amount of chord collapsing rescues that.
 */
export function midiMelodies(file: ParsedMidi): MidiMelody[] {
  const streams = new Map<string, { track: MidiTrack; channel: number; notes: MidiNote[] }>();
  for (const track of file.tracks) {
    for (const note of track.notes) {
      const id = `${track.index}:${note.channel}`;
      const stream = streams.get(id) ?? { track, channel: note.channel, notes: [] };
      stream.notes.push(note);
      streams.set(id, stream);
    }
  }

  // Percussion is not a melody: on channel 10 a "pitch" selects a drum, so the
  // contour is meaningless. Kept only when it is all the file has, because
  // refusing every note in the file is worse than offering a strange one.
  const pitched = [...streams.values()].filter((s) => s.channel !== DRUM_CHANNEL);
  // By track then channel, not by whichever voice happened to play the first
  // note: the picker's rows should be in the order a sequencer would show them,
  // and a list that reshuffles itself because of one pickup note is a list
  // nobody can point at.
  const chosen = (pitched.length > 0 ? pitched : [...streams.values()]).sort(
    (a, b) => a.track.index - b.track.index || a.channel - b.channel,
  );

  // How many voices each track contributed, so a name only has to be
  // disambiguated when it is actually ambiguous.
  const perTrack = new Map<number, number>();
  for (const stream of chosen) {
    perTrack.set(stream.track.index, (perTrack.get(stream.track.index) ?? 0) + 1);
  }
  const seen = new Map<number, number>();

  const melodies: MidiMelody[] = [];
  for (const stream of chosen) {
    const voice = (seen.get(stream.track.index) ?? 0) + 1;
    seen.set(stream.track.index, voice);
    const collapsed = collapseChords(stream.notes);
    if (collapsed.notes.length === 0) continue;

    const base = stream.track.name || `Part ${stream.track.index + 1}`;
    const name = (perTrack.get(stream.track.index) ?? 1) > 1 ? `${base} (voice ${voice})` : base;
    const notes = collapsed.notes.slice(0, MAX_MELODY_NOTES);
    melodies.push({
      id: `${stream.track.index}:${stream.channel}`,
      trackIndex: stream.track.index,
      channel: stream.channel,
      name,
      notes,
      chordFraction: collapsed.chordFraction,
      truncated: collapsed.notes.length > notes.length,
      durationSec: notes.reduce((total, note) => total + note.durSec, 0),
    });
  }
  return melodies;
}

/**
 * One stream of possibly-overlapping notes → one line of melody.
 *
 * **Top note of each chord**, which is the standard reduction and the right one
 * here: in nearly all western music the tune is the top voice, and it is what a
 * listener would hum back — which is precisely what practice mode is going to
 * ask for. The user is told when this mattered (see {@link chordWarning})
 * rather than silently handed an arrangement's inner voice.
 *
 * Durations are real: each slot lasts as long as its note actually sounded,
 * capped at the next slot's onset so a legato overlap cannot make the melody
 * longer than the file. Rests are *not* represented — a practice target is a
 * list of notes with lengths and has nowhere to put one. That costs less than
 * it looks: alignment is pitch-ordered, so silence between notes changes
 * nothing about which attempt note answers which slot, and rhythm is scored
 * only as coarse relative classes. What it does cost is honest to state — a
 * melody with a long rest in it plays back tighter than the file.
 */
function collapseChords(notes: readonly MidiNote[]): {
  notes: TargetNote[];
  chordFraction: number;
} {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  const groups: { startSec: number; top: MidiNote; size: number }[] = [];
  for (const note of sorted) {
    const last = groups[groups.length - 1];
    if (last && note.startSec - last.startSec <= CHORD_WINDOW_SEC) {
      last.size++;
      if (note.midi > last.top.midi) last.top = note;
      continue;
    }
    groups.push({ startSec: note.startSec, top: note, size: 1 });
  }

  const out: TargetNote[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const next = groups[i + 1];
    const end = next ? Math.min(group.top.endSec, next.startSec) : group.top.endSec;
    out.push({ midi: group.top.midi, durSec: Math.max(MIN_NOTE_SEC, end - group.startSec) });
  }
  const chords = groups.filter((group) => group.size > 1).length;
  return { notes: out, chordFraction: groups.length === 0 ? 0 : chords / groups.length };
}

/**
 * The sentence a part earns when it is not really a single line.
 *
 * `null` below a twentieth, because one accidental double-stop in a violin part
 * is not something to warn anybody about — and a warning that fires on
 * everything is a warning nobody reads.
 */
export function chordWarning(melody: Pick<MidiMelody, "chordFraction">): string | null {
  if (melody.chordFraction < 0.05) return null;
  const percent = Math.round(melody.chordFraction * 100);
  return `More than one note at a time in ${percent}% of this part — the app kept the highest each time.`;
}

/** The picker row's second line: shape and length, never a pitch. */
export function melodySummary(melody: MidiMelody): string {
  const count = `${melody.notes.length} note${melody.notes.length === 1 ? "" : "s"}`;
  const length = `${melody.durationSec.toFixed(1)} s`;
  const cut = melody.truncated ? ` · first ${MAX_MELODY_NOTES} kept` : "";
  return `${count} · ${length}${cut}`;
}
