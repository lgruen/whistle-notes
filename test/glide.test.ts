import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, presetConfig, transcribe, type Note } from "../src/dsp/index.js";
import { sequence, type SynthNote } from "./fixtures/synth.js";

/**
 * Scoops, glides and wobbles — the three things a whistler does to a note that
 * are not the note.
 *
 * The distinction between them is the hardest judgement in this pipeline and
 * the one with the least room for a threshold. A scoop into a note, a
 * portamento between two notes and a wide vibrato are all "the pitch slid
 * about a semitone over about a tenth of a second"; what tells them apart is
 * shape, not rate. This file is the evidence for that claim, swept densely
 * enough to catch the boundaries — an earlier version of the scoop test
 * sampled two shapes, both of which happened to pass, while a third of the
 * grid around them silently produced a phantom note a semitone flat.
 *
 * Everything here is synthetic and seeded, so a failure is a regression rather
 * than a bad afternoon.
 */

const SR = 48000;
const MIDIS = (notes: Note[]): number[] => notes.map((n) => n.midi);

/** Deterministic PRNG. `Math.random` in a fuzz test means a failure nobody can
 *  reproduce, which is worse than no fuzz test. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("scoops into a note", () => {
  it("names the note, not the pitch it was approached from", () => {
    // The three shapes an adversarial review found broken. Each is a single
    // whistled note reached from below; none of them is two notes, and the one
    // it is *not* is the semitone underneath.
    for (const [cents, ms] of [
      [150, 160],
      [100, 200],
      [200, 250],
    ] as const) {
      const signal = sequence([{ midi: 88, durSec: 0.5, glideInCents: -cents, glideInMs: ms }], {
        leadInSec: 0.4,
        tailSec: 0.4,
      });
      const notes = transcribe(signal.samples, signal.sampleRate).notes;
      expect(MIDIS(notes), `scoop ${cents}c over ${ms}ms`).toEqual([88]);
      expect(Math.abs(notes[0].centsOffset), `scoop ${cents}c over ${ms}ms`).toBeLessThan(20);
      expect(notes[0].flags.glidedIn, `scoop ${cents}c over ${ms}ms`).toBe(true);
    }
  });

  it("holds up across a dense grid of scoop shapes", () => {
    // 150 combinations of depth, duration and superimposed wobble. The rate
    // covered runs from 5 to 37 semitones per second, which straddles every
    // threshold in the file, and the wobble is what makes it hard: a ±50-cent
    // vibrato at 5.5 Hz swings the pitch backwards twice a second while the
    // scoop underneath climbs, so nothing that looks only at consecutive frames
    // can see the scoop as one movement.
    //
    // Measured: 149 of 150. Before the movement-based glide detector it was
    // 107 of 150 — and the eight-way band that failed (shallow, slow, wobbly)
    // is exactly the population this comment describes.
    let wrong = 0;
    const failures: string[] = [];
    for (const cents of [100, 150, 200, 250, 300]) {
      for (const ms of [80, 100, 120, 140, 160, 200]) {
        for (const vibratoCents of [0, 20, 30, 40, 50]) {
          const signal = sequence(
            [{ midi: 88, durSec: 0.5, glideInCents: -cents, glideInMs: ms, vibratoCents, vibratoHz: 5.5 }],
            { leadInSec: 0.4, tailSec: 0.4 },
          );
          const midis = MIDIS(transcribe(signal.samples, signal.sampleRate).notes);
          if (midis.length !== 1 || midis[0] !== 88) {
            wrong++;
            failures.push(`${cents}c/${ms}ms/vib${vibratoCents} → ${midis.join(",") || "none"}`);
          }
        }
      }
    }
    expect(wrong, failures.join("; ")).toBeLessThanOrEqual(2);
  });

  // 120 synthesized melodies push this well past the default 5 s on CI runners.
  it("survives a fuzz of random melodies with random scoops", { timeout: 30_000 }, () => {
    // Isolated notes are the easy case: the interesting failure was a scoop in
    // the *middle* of a melody, where the phantom lands between two real notes
    // and looks entirely plausible. 120 seeded melodies, each note approached
    // from a random distance below at a random speed.
    //
    // Measured: 120 of 120 exact. Before the movement-based glide detector, 12
    // of 120 — every note here is scooped into, and the shapes drawn from this
    // distribution sit squarely in the band that used to fail.
    const random = rng(0x5eed1);
    let wrong = 0;
    const failures: string[] = [];
    for (let take = 0; take < 120; take++) {
      const length = 4 + Math.floor(random() * 3);
      const melody: number[] = [];
      let midi = 84 + Math.floor(random() * 6);
      for (let i = 0; i < length; i++) {
        melody.push(midi);
        // Steps of one to five semitones, either way, kept inside the whistle
        // register. Repeated notes are excluded: two identical notes in a row
        // separated by a gap are a different test (see segment.test.ts).
        const step = 1 + Math.floor(random() * 5);
        midi = Math.max(79, Math.min(95, midi + (random() < 0.5 ? -step : step)));
        if (melody.length > 0 && midi === melody[melody.length - 1]) midi += 1;
      }
      const notes: SynthNote[] = melody.map((m) => ({
        midi: m,
        durSec: 0.3 + random() * 0.25,
        gapSec: 0.08 + random() * 0.12,
        glideInCents: -Math.round(80 + random() * 180),
        glideInMs: Math.round(80 + random() * 170),
      }));
      const signal = sequence(notes, { leadInSec: 0.3, tailSec: 0.3 });
      const heard = MIDIS(transcribe(signal.samples, signal.sampleRate).notes);
      if (heard.join(",") !== melody.join(",")) {
        wrong++;
        failures.push(`take ${take}: want ${melody.join(",")} got ${heard.join(",")}`);
      }
    }
    expect(wrong, failures.slice(0, 5).join(" | ")).toBeLessThanOrEqual(2);
  });

  it("still splits a genuine slow step between two notes", () => {
    // The mirror image, and the reason the fix above cannot simply be "treat
    // anything gentle as an approach". A whistler moving deliberately from one
    // note to the next, slowly and without a gap, has played two notes — and a
    // semitone step taken over 100 ms is *slower* than most of the scoops in
    // the grid above. What separates them is that this one has a sustained
    // note on each side of the movement and a scoop does not.
    for (const [from, to] of [
      [88, 89],
      [88, 87],
      [84, 86],
    ] as const) {
      const signal = sequence(
        [
          { midi: from, durSec: 0.45 },
          { midi: to, durSec: 0.45, glideInCents: 100 * (from - to), glideInMs: 100 },
        ],
        { leadInSec: 0.3, tailSec: 0.3 },
      );
      expect(MIDIS(transcribe(signal.samples, signal.sampleRate).notes), `${from} → ${to}`).toEqual([
        from,
        to,
      ]);
    }
  });
});

/** One held note with a wobble on it, and nothing else. */
const wobble = (cents: number, hz: number, cfg = DEFAULT_CONFIG): Note[] =>
  transcribe(
    sequence([{ midi: 88, durSec: 1.2, vibratoCents: cents, vibratoHz: hz }], {
      leadInSec: 0.3,
      tailSec: 0.3,
    }).samples,
    SR,
    cfg,
  ).notes;

describe("vibrato", () => {
  it("hears one note through a wobble far wider than the tolerance", () => {
    // ±90 cents peaks at 1.8 semitones peak to peak — three times the 60-cent
    // wobble tolerance, and wide enough that each extreme dwells long enough to
    // look like a note in its own right. All four of these used to come out
    // wrong in one of two ways: as a trill between the two extremes (up to
    // twelve notes), or as one note named after an extreme rather than the
    // centre — D#6 for a whistle that was unmistakably centred on E6, which is
    // the worse failure of the two because it is confidently wrong.
    for (const [cents, hz] of [
      [60, 5],
      [70, 4],
      [80, 4],
      [90, 4],
      [90, 5],
    ] as const) {
      const notes = wobble(cents, hz);
      expect(notes.map((n) => n.noteName), `±${cents}c at ${hz} Hz`).toEqual(["E6"]);
      expect(notes[0].durationSec, `±${cents}c at ${hz} Hz`).toBeGreaterThan(1.0);
      // The reported pitch is the centre of the wobble, not one of its edges.
      expect(Math.abs(notes[0].centsOffset), `±${cents}c at ${hz} Hz`).toBeLessThan(30);
    }
  });

  it("is not fixed by simply refusing to ever split", () => {
    // The wobble rule must not be a licence to merge: a real trill between two
    // notes a whole tone apart, held long enough to be deliberate, is still two
    // alternating notes. What makes the vibrato above one note is that its
    // extremes are *not* sustained — the pitch turns around the moment it gets
    // there.
    const notes = transcribe(
      sequence(
        [88, 90, 88, 90, 88].map((midi) => ({ midi, durSec: 0.3 })),
        { leadInSec: 0.3, tailSec: 0.3 },
      ).samples,
      SR,
    ).notes;
    expect(MIDIS(notes)).toEqual([88, 90, 88, 90, 88]);
  });

  it("documents where the wobble tolerance stops working", () => {
    // Honest limitation, pinned rather than papered over. The wobble rule
    // reunites an oscillation of up to roughly two semitones either side of its
    // centre — ±200 cents at 4 Hz still comes out as one correct E6 — and
    // beyond that it comes apart into pieces that are individually plausible
    // and collectively wrong. Nobody wobbles by half an octave, but the
    // boundary is real and this is where it is, so that a future change moving
    // it shows up as a failing test rather than as a surprise.
    expect(wobble(200, 4).map((n) => n.noteName)).toEqual(["E6"]);
    const wide = wobble(300, 4);
    expect(wide.length).toBeGreaterThan(1);
    expect(new Set(wide.map((n) => n.noteName)).size).toBeGreaterThan(1);

    // And the knob does move it, in the documented direction.
    expect(wobble(90, 4, presetConfig("forgiving")).map((n) => n.noteName)).toEqual(["E6"]);
    expect(wobble(60, 5, mergeConfig(DEFAULT_CONFIG, { segment: { toleranceCents: 40 } })).length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * A melody with vibrato on it — the case where reuniting a wobble and reading a
 * melody are the *same* evidence pointing opposite ways.
 *
 * Under a wobble as wide as the interval, the two notes' pitch ranges overlap
 * by more than half: every frame of the arriving note is individually within
 * the departing note's tolerance, and every swing of the arriving note's
 * vibrato "undoes" the step by more than half of it. So both of the pipeline's
 * repairs fire on it — the state machine's reference slides across the boundary
 * and stage G reunites what it did split — and an adversarial review measured
 * exactly that: 73 of these 125 came out wrong, a *worse* score than before the
 * repairs existed. What was missing was the one measurement that is not
 * ambiguous, the pitch the wobble is centred on.
 */
describe("a wobble on a melody", () => {
  const MELODIES = [
    [88, 90, 88, 91, 88],
    [84, 86, 88, 89, 91],
    [88, 87, 88, 87, 88],
    [91, 89, 88, 86, 84],
    [88, 91, 88, 91, 88],
  ];

  /** Legato: no gaps at all, so nothing but pitch marks the boundaries. */
  const legato = (melody: number[], vibratoCents: number, vibratoHz: number, durSec = 0.4): number[] =>
    MIDIS(
      transcribe(
        sequence(
          melody.map((midi) => ({ midi, durSec, vibratoCents, vibratoHz })),
          { leadInSec: 0.3, tailSec: 0.3 },
        ).samples,
        SR,
      ).notes,
    );

  // 125 signals is well past the default 5 s budget on a CI runner.
  it("reads five legato melodies through vibrato of 40–80 cents at 4–6 Hz", { timeout: 60_000 }, () => {
    let wrong = 0;
    const failures: string[] = [];
    for (const melody of MELODIES) {
      for (const vibratoCents of [40, 50, 60, 70, 80]) {
        for (const vibratoHz of [4, 4.5, 5, 5.5, 6]) {
          const heard = legato(melody, vibratoCents, vibratoHz);
          if (heard.join(",") !== melody.join(",")) {
            wrong++;
            failures.push(`${melody.join(",")} ±${vibratoCents}c@${vibratoHz}Hz → ${heard.join(",")}`);
          }
        }
      }
    }
    // Measured: 125 of 125. Before the centre track, 52 — and 67 with both
    // repairs removed, which is the number that says the repairs were the
    // problem rather than an incomplete solution.
    expect(wrong, failures.slice(0, 8).join(" | ")).toBeLessThanOrEqual(5);
  });

  it("does not let a merge chain walk up a scale", () => {
    // The failure this pins is a *chain*: merging two fragments moves the
    // running median a little, which brings the next fragment within reach,
    // which moves it again. Twelve merges once walked from 84.4 to 86.6 and
    // reported six chromatic notes as two. Nothing local can catch that, which
    // is why the bound is on the whole chain and the test is on the whole run.
    expect(legato([84, 85, 86, 87, 88, 89], 60, 5, 0.3)).toEqual([84, 85, 86, 87, 88, 89]);

    // And the mirror image: the *first* note being absorbed into the second.
    for (const cents of [50, 60, 70]) {
      expect(legato([88, 90, 88, 91, 88], cents, 5), `±${cents}c`).toEqual([88, 90, 88, 91, 88]);
    }
  });

  it("still hears a lone wobbling note as one note", () => {
    // The other half of the same rule, and the reason it cannot simply be "stop
    // merging". Nothing here changed: a wobble whose centre holds still is one
    // note however wide it is.
    for (const [cents, hz] of [
      [60, 5],
      [70, 4],
      [80, 4],
    ] as const) {
      const notes = wobble(cents, hz);
      expect(notes.map((n) => n.noteName), `±${cents}c at ${hz} Hz`).toEqual(["E6"]);
      expect(Math.abs(notes[0].centsOffset), `±${cents}c at ${hz} Hz`).toBeLessThan(30);
    }
  });

  /**
   * The grid that pins `CENTRE_WINDOW_MS`, which has no config key and so no
   * entry in the golden sweep.
   *
   * Thirteen legato runs with nothing but pitch marking the boundaries: nine
   * whole-tone runs of 350 ms notes, four chromatic runs of 300 ms notes. The
   * short chromatic ones are the load-bearing half — the centre window is
   * 300 ms, and the constant's binding constraint is that it stay under the
   * note it has to fit inside, not merely over a vibrato cycle.
   *
   * Measured by sweeping the constant against this grid: 200–300 ms all pass,
   * 320 fails 2 (the 300 ms cells), 340 fails 4 (all of them), 360 fails 12,
   * 450 fails 9; going the other way, 160 fails 1 and 120 fails 3 as the wobble
   * starts leaking into the centre. A 7 % change either side of the default is
   * therefore visible here, which is the whole point of writing it down.
   */
  const CENTRE_WINDOW_GRID: [number[], number, number, number][] = [
    ...[50, 60, 70].flatMap((cents) =>
      [4.5, 5, 5.5].map(
        (hz) => [[84, 86, 88, 90, 92, 94], cents, hz, 0.35] as [number[], number, number, number],
      ),
    ),
    ...[50, 60, 70, 80].map(
      (cents) => [[84, 85, 86, 87, 88, 89], cents, 5, 0.3] as [number[], number, number, number],
    ),
  ];

  it("holds the centre window inside the shortest note on the grid", () => {
    for (const [melody, cents, hz, durSec] of CENTRE_WINDOW_GRID) {
      expect(
        legato(melody, cents, hz, durSec),
        `${melody.join(",")} ±${cents}c@${hz}Hz ${durSec * 1000}ms`,
      ).toEqual(melody);
    }
  });

  it("reads an ascending legato run rather than collapsing it", () => {
    // Runs are the worst case for a chain: every merge moves the median the
    // same way as the melody. Six notes, two-semitone steps, wobble up to
    // ±70 cents. Before this round, ten of these twelve came out short — one
    // of them as `84 88 92 94`.
    for (const vibratoCents of [50, 60, 70]) {
      for (const vibratoHz of [4.5, 5, 5.5]) {
        const melody = [84, 86, 88, 90, 92, 94];
        expect(
          legato(melody, vibratoCents, vibratoHz, 0.35),
          `±${vibratoCents}c@${vibratoHz}Hz`,
        ).toEqual(melody);
      }
    }
  });
});
