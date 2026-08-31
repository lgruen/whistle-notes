import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CONFIG,
  PitchTracker,
  mergeConfig,
  presetConfig,
  segmentNotes,
  transcribe,
  type DspConfig,
  type PitchFrame,
} from "../src/dsp/index.js";
import { decodeWav } from "../tools/wav.js";

/**
 * The end-to-end regression test, run against a real whistled recording.
 *
 * The recording is the user's own and is deliberately **not** in this
 * repository — `.gitignore` blankets `test/fixtures/local/`, `*.wav` and
 * `*.m4a` so that an absent-minded `git add -A` cannot leak audio into a
 * public repo. CI therefore skips this file entirely and gets its coverage
 * from the synthetic fixtures, where the right answer is true by construction.
 * Locally it is the only test that can catch a regression that every synthetic
 * case is blind to, which is most of the interesting ones: real whistling
 * wobbles, scoops, runs out of breath and sits between two keys.
 *
 * To recreate the fixture from the source recording:
 *
 *   afconvert -f WAVE -d LEI16@48000 -c 1 ~/Desktop/tron_reconfigured.m4a \
 *     test/fixtures/local/tron_reconfigured.wav
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STATUS: **PROPOSED**, not yet verified.
 *
 * The sequence below is what the pipeline currently hears, and it is stable
 * (see the parameter sweeps recorded beneath it). What it is *not*, yet, is
 * confirmed to be what was whistled: that requires the user to play it at a
 * piano and say whether it sounds like the tune they had in mind. Until then
 * this test guards against unintended change, not against being wrong. Once
 * verified, delete this notice — and if the verification says otherwise,
 * change the expectation rather than defending it.
 * ────────────────────────────────────────────────────────────────────────────
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/local/tron_reconfigured.wav", import.meta.url));

/** PROPOSED — pending verification at a piano. 38 notes. */
const EXPECTED_SEQUENCE =
  "C#6 F6 D6 G#6 D#6 C6 D#6 C#6 C#6 E6 C#6 F6 G6 D6 F6 D6 C6 G5 " +
  "C#6 F6 D#6 G#6 D#6 C#6 D#6 C#6 C#6 E6 F6 D6 F#6 G6 D#6 F6 D#6 B5 G5 G#5";

/**
 * Frames are computed once and re-segmented for every parameter combination
 * below — the same trick the Node harness's `--from-cache` uses, and the
 * concrete payoff of keeping the pitch stage threshold-free. Re-running the
 * FFT for each of the fifty-odd settings swept here would take ten seconds;
 * this takes a fraction of one, which is the difference between a sweep being
 * a test and a sweep being a chore.
 */
let cached: { frames: PitchFrame[]; sampleRate: number } | null = null;

function fixtureFrames(): { frames: PitchFrame[]; sampleRate: number } {
  if (!cached) {
    const { samples, sampleRate } = decodeWav(readFileSync(FIXTURE));
    cached = { frames: new PitchTracker(sampleRate, DEFAULT_CONFIG).push(samples), sampleRate };
  }
  return cached;
}

/** Levenshtein distance in whole notes: how many insertions, deletions or
 *  substitutions separate two transcriptions. "One note different" and "the
 *  same notes shifted by one" are worlds apart, and only this tells them
 *  apart. */
function editDistance(a: string[], b: string[]): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length][b.length];
}

/** Re-segment the cached frames. Only valid for configs that leave
 *  `analysis` alone — every sweep here does. */
function resegment(cfg: DspConfig): string {
  const { frames, sampleRate } = fixtureFrames();
  return segmentNotes(frames, cfg, sampleRate)
    .notes.map((n) => n.noteName)
    .join(" ");
}

describe.skipIf(!existsSync(FIXTURE))("golden: tron_reconfigured.wav", () => {
  test("transcribes to the proposed sequence", () => {
    // Through the full public entry point, so this also proves that
    // `transcribe()` and the cached-frame path below cannot disagree.
    const { samples, sampleRate } = decodeWav(readFileSync(FIXTURE));
    const sequence = transcribe(samples, sampleRate)
      .notes.map((n) => n.noteName)
      .join(" ");
    expect(sequence).toBe(EXPECTED_SEQUENCE);
    expect(resegment(DEFAULT_CONFIG)).toBe(EXPECTED_SEQUENCE);
  });

  test("is stable across the whole neighbourhood of its tuning parameters", () => {
    // A transcription that only survives one exact set of thresholds is a
    // transcription that was fitted to this recording rather than derived from
    // it. This is the test that says otherwise — and it is worth saying exactly
    // what it can and cannot claim.
    //
    // It used to sweep three parameters at three values each and demand an
    // identical sequence from all twenty-seven, which it got. That was a
    // stronger-looking claim than the evidence supported: swept more finely,
    // the *same* code gave 39 notes at a tolerance of 44 and 48 cents, and the
    // grid's 40/50/60 stepped straight over the boundary. Three points that
    // happen to agree do not establish a plateau.
    //
    // So: sweep finely, one axis at a time, over a range wider than anyone
    // would plausibly set — and measure how far the answer moves rather than
    // demanding it not move at all.
    //
    // ── What actually moves, and why ────────────────────────────────────────
    // 49 of these 66 settings reproduce the sequence exactly. An earlier
    // version of this comment described the other 17 as "the two boundaries
    // described above", which was wrong in three ways, so here is the real
    // list. Nearly all of it is *five specific notes* in this recording, each
    // borderline in a way that has nothing to do with the threshold being
    // swept:
    //
    //   #9   E6 at 7.62 s, 37 cents sharp — 13 cents from being an F6. Splits
    //        or renames when the attack trim moves (attackTrimFraction 0.1 and
    //        0.4, medianFilterFrames 9).
    //   #10  C#6 at 8.03 s, 170 ms. Splits at toleranceCents 52 — an interior
    //        hole, not a boundary; 48 and 56 are both exact.
    //   #11  F6 at 8.23 s, 150 ms: the scoop into the G6 that follows it. Gets
    //        absorbed into that G6 at glideMinSlopeStPerSec 2 and at
    //        attackTrimMinMs 90.
    //   #27  E6 at 20.74 s, 90 ms. Disappears the moment the shortest
    //        reportable note is raised past its length (minNoteMs ≥ 90) and
    //        also at medianFilterFrames 3 and minPeakToSecondDb 9.
    //   #30  F#6 at 21.36 s, measured at 1440.5 Hz — 47 cents flat of F#6 and
    //        53 cents sharp of F6, a coin flip between two piano keys.
    //        Renamed at glideMinSlopeStPerSec 4 and medianFilterFrames 7;
    //        swallowed by the G6 after it at toleranceCents 68 and 72.
    //
    // The one genuine break-down is `voicing.minPeakToSecondDb` at 12, where a
    // whole phrase re-organises: that gate is doing real work on this take and
    // 12 dB is past where it can. It is included precisely so that the range
    // over which the shape gates are safe is on the record rather than assumed.
    //
    // Each axis therefore carries its own bound, and the bound is what was
    // measured, not what would look best. A regression on any one of them
    // shows up as a failure here.
    const golden = EXPECTED_SEQUENCE.split(" ");
    const axes: [string, string, number[], number][] = [
      ["segment", "toleranceCents", [36, 40, 44, 48, 52, 56, 60, 64, 68, 72], 1],
      ["segment", "minNoteMs", [50, 60, 70, 80, 90, 100, 110, 120], 1],
      ["segment", "gapMergeMs", [40, 60, 80, 100, 120], 0],
      ["segment", "maskedGapMs", [200, 300, 400, 600, 900], 0],
      ["segment", "glideSlopeStPerSec", [12, 15, 18, 21, 24, 30], 0],
      ["segment", "glideMinSemitones", [0.6, 0.7, 0.8, 0.9, 1.0], 0],
      ["segment", "glideMinSlopeStPerSec", [2, 3, 4, 5], 1],
      ["segment", "confirmFrames", [3, 5, 7], 0],
      ["segment", "driftCapSemitones", [1.2, 1.5, 1.8], 0],
      ["segment", "attackTrimMinMs", [90, 120, 160, 220], 2],
      ["segment", "attackTrimFraction", [0.1, 0.2, 0.25, 0.3, 0.4], 2],
      ["smoothing", "medianFilterFrames", [3, 5, 7, 9], 1],
      ["voicing", "minPeakToSecondDb", [3, 6, 9, 12], 2],
    ];

    let exact = 0;
    let total = 0;
    for (const [group, key, values, allowed] of axes) {
      for (const value of values) {
        const cfg = mergeConfig(DEFAULT_CONFIG, { [group]: { [key]: value } });
        const sequence = resegment(cfg).split(" ");
        total++;
        if (sequence.join(" ") === EXPECTED_SEQUENCE) exact++;
        expect(editDistance(sequence, golden), `${group}.${key} = ${value}`).toBeLessThanOrEqual(
          allowed,
        );
      }
    }
    // ...and the great majority is not merely close but identical.
    expect(exact / total).toBeGreaterThan(0.7);
  });

  test("is stable across the voicing thresholds too", () => {
    // The whistle sits 30–50 dB above the adaptive noise floor in this take, so
    // the level gate does no work at all here and the shape gates have wide
    // margins. Worth pinning: it means the sequence is not balanced on a
    // threshold, and it is the evidence behind leaving the plan's voicing
    // numbers alone.
    for (const [group, key, values] of [
      ["voicing", "minClarity", [0.4, 0.5, 0.6, 0.7]],
      ["voicing", "minSnrDb", [12, 18, 24, 30]],
      ["voicing", "onsetAboveFloorDb", [4, 12, 20]],
      ["voicing", "sustainAboveFloorDb", [2, 6, 10]],
      ["segment", "glideSlopeStPerSec", [12, 15, 18, 21, 24]],
      ["segment", "confirmFrames", [3, 5, 7]],
    ] as const) {
      for (const value of values) {
        const cfg = mergeConfig(DEFAULT_CONFIG, { [group]: { [key]: value } });
        expect(resegment(cfg), `${group}.${key} = ${value}`).toBe(EXPECTED_SEQUENCE);
      }
    }
  });

  test("the wobble-snap presets differ only in how much they merge", () => {
    // The presets are a taste knob. Strict may split more and Forgiving fewer,
    // but neither may invent a pitch the Normal transcription never heard.
    const normal = resegment(DEFAULT_CONFIG).split(" ");
    const strict = resegment(presetConfig("strict")).split(" ");
    const forgiving = resegment(presetConfig("forgiving")).split(" ");

    expect(strict.length).toBeGreaterThanOrEqual(normal.length);
    expect(forgiving.length).toBeLessThanOrEqual(normal.length);
    for (const name of new Set(forgiving)) expect(new Set(strict)).toContain(name);
  });

  test("reports plausible physical properties for a whistled melody", () => {
    const { samples, sampleRate } = decodeWav(readFileSync(FIXTURE));
    const { notes, frames, tuningOffsetCents } = transcribe(samples, sampleRate);

    expect(sampleRate).toBe(48000);
    expect(samples.length / sampleRate).toBeCloseTo(27.0, 0);

    // Whistling lives between roughly 500 Hz and 4 kHz; this take is a
    // comfortable octave and a bit inside that, around G5–G#6.
    for (const note of notes) {
      expect(note.pitchHz).toBeGreaterThan(700);
      expect(note.pitchHz).toBeLessThan(1800);
      expect(note.durationSec).toBeGreaterThanOrEqual(DEFAULT_CONFIG.segment.minNoteMs / 1000);
      expect(note.confidence).toBeGreaterThan(0.5);
    }

    // The whistler's pitch scatters rather than sitting at a consistent
    // offset, so auto-tuning correctly declines to move anything.
    expect(tuningOffsetCents).toBe(0);

    // Roughly three quarters of the file is whistling and the rest is breath
    // and pauses — a sanity check that voicing is neither swallowing the take
    // nor accepting the room.
    const inside = frames.filter((f) => notes.some((n) => f.tSec >= n.startSec && f.tSec < n.endSec));
    expect(inside.length / frames.length).toBeGreaterThan(0.6);
    expect(inside.length / frames.length).toBeLessThan(0.9);
  });
});
