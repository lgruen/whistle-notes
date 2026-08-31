/**
 * A/B the shipped FFT peak-picker against `pitchy`'s McLeod Pitch Method.
 *
 *   npx tsx tools/compare-detectors.ts <file.wav>
 *   npx tsx tools/compare-detectors.ts --synthetic
 *
 * The plan predicted the spectral method would win on whistling, and gave
 * reasons: a whistle is nearly a pure sine, so MPM's real advantage (tracking
 * a periodicity whose fundamental is missing) buys nothing, while its
 * weakness at high f0 bites hard — autocorrelation locates a period in whole
 * samples, and at 4 kHz on a 48 kHz signal one sample of lag is 144 cents.
 * A prediction with reasons is still a prediction, so this measures it.
 *
 * `pitchy` is a devDependency and is imported nowhere but here: nothing in
 * `src/` may depend on it.
 */

import { readFileSync } from "node:fs";
import { PitchDetector } from "pitchy";
import { DEFAULT_CONFIG, PitchTracker, hzToMidiFloat, midiToName } from "../src/dsp/index.js";
import { decodeWav } from "./wav.js";
import { sequence } from "../test/fixtures/synth.js";

interface Reading {
  tSec: number;
  hz: number | null;
  confidence: number;
}

/** Run pitchy on exactly the same window grid the FFT detector uses, so the
 *  two are compared frame for frame rather than through different clocks. */
function runPitchy(samples: Float32Array, sampleRate: number): Reading[] {
  const { windowSize, hopSize, minHz, maxHz } = DEFAULT_CONFIG.analysis;
  const detector = PitchDetector.forFloat32Array(windowSize);
  const block = new Float32Array(windowSize);
  const out: Reading[] = [];

  for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
    block.set(samples.subarray(start, start + windowSize));
    const [hz, clarity] = detector.findPitch(block, sampleRate);
    const inBand = hz >= minHz && hz <= maxHz;
    out.push({
      tSec: (start + windowSize / 2) / sampleRate,
      hz: inBand && hz > 0 ? hz : null,
      confidence: clarity,
    });
  }
  return out;
}

function quantile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

function summarise(label: string, values: number[]): string {
  if (values.length === 0) return `${label.padEnd(22)} (no data)`;
  return (
    `${label.padEnd(22)} n=${String(values.length).padStart(5)}` +
    `  p50=${quantile(values, 0.5).toFixed(2)}` +
    `  p90=${quantile(values, 0.9).toFixed(2)}` +
    `  p99=${quantile(values, 0.99).toFixed(2)}` +
    `  max=${Math.max(...values).toFixed(2)}`
  );
}

/** Ground-truth comparison: both detectors against a known synthetic pitch. */
function syntheticAccuracy(): void {
  console.log("=== ground truth: pure tones, 48 kHz, no noise ===");
  console.log("  midi |  FFT median err |  MPM median err | FFT octave errs | MPM octave errs");

  for (const midi of [71, 79, 84, 88, 91, 96, 100, 107]) {
    const signal = sequence([{ midi, durSec: 0.4 }], { sampleRate: 48000 });
    const guard = 0.07;

    const fftErrors: number[] = [];
    let fftOctaves = 0;
    for (const f of new PitchTracker(48000).push(signal.samples)) {
      if (f.tSec < guard || f.tSec > 0.4 - guard || f.hz === null) continue;
      const error = 100 * (hzToMidiFloat(f.hz) - midi);
      if (Math.abs(error) > 600) fftOctaves++;
      else fftErrors.push(error);
    }

    const mpmErrors: number[] = [];
    let mpmOctaves = 0;
    for (const r of runPitchy(signal.samples, 48000)) {
      if (r.tSec < guard || r.tSec > 0.4 - guard || r.hz === null) continue;
      const error = 100 * (hzToMidiFloat(r.hz) - midi);
      if (Math.abs(error) > 600) mpmOctaves++;
      else mpmErrors.push(error);
    }

    console.log(
      `  ${String(midi).padStart(4)} | ${(quantile(fftErrors.map(Math.abs), 0.5) || 0).toFixed(3).padStart(15)}` +
        ` | ${(quantile(mpmErrors.map(Math.abs), 0.5) || 0).toFixed(3).padStart(15)}` +
        ` | ${String(fftOctaves).padStart(15)} | ${String(mpmOctaves).padStart(15)}`,
    );
  }
  console.log("");
}

function compareOnFile(file: string): void {
  const { samples, sampleRate } = decodeWav(readFileSync(file));
  const ours = new PitchTracker(sampleRate, DEFAULT_CONFIG).push(samples);
  const theirs = runPitchy(samples, sampleRate);

  console.log(`=== ${file} — ${(samples.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz ===`);
  console.log(`  frames: FFT ${ours.length}, MPM ${theirs.length}`);

  const n = Math.min(ours.length, theirs.length);
  // Compare only where *we* are confident, which is where a disagreement would
  // actually change a transcription. Comparing on frames both call noise would
  // measure how two random-number generators differ.
  const v = DEFAULT_CONFIG.voicing;
  const confident = (i: number): boolean =>
    ours[i].hz !== null &&
    ours[i].clarity >= v.minClarity &&
    ours[i].snrDb >= v.minSnrDb &&
    ours[i].peakToSecondDb >= v.minPeakToSecondDb;

  const disagreement: number[] = [];
  let octaveErrors = 0;
  let mpmSilent = 0;
  let compared = 0;

  for (let i = 0; i < n; i++) {
    if (!confident(i)) continue;
    compared++;
    const mpmHz = theirs[i].hz;
    if (mpmHz === null) {
      mpmSilent++;
      continue;
    }
    const cents = 100 * (hzToMidiFloat(mpmHz) - hzToMidiFloat(ours[i].hz as number));
    if (Math.abs(Math.abs(cents) - 1200) < 100) octaveErrors++;
    disagreement.push(Math.abs(cents));
  }

  console.log(`  frames where the FFT detector is confident: ${compared}`);
  console.log(`  ...of those, MPM found nothing in band:     ${mpmSilent} (${((100 * mpmSilent) / compared).toFixed(1)}%)`);
  console.log(`  ...of those, MPM was a full octave away:    ${octaveErrors} (${((100 * octaveErrors) / compared).toFixed(1)}%)`);
  console.log(`  ${summarise("|disagreement| cents", disagreement)}`);
  console.log("");

  // Both note sequences, since a per-frame statistic can hide a difference that
  // does or does not survive segmentation.
  console.log(`  FFT note sequence:\n    ${sequenceOf(ours.map(toReading))}`);
  console.log(`  MPM note sequence (same segmentation, MPM pitches):\n    ${sequenceOf(theirs)}`);
}

function toReading(f: { tSec: number; hz: number | null; clarity: number }): Reading {
  return { tSec: f.tSec, hz: f.hz, confidence: f.clarity };
}

/**
 * A deliberately crude note sequence: group consecutive confident readings by
 * rounded MIDI. Segmentation proper needs the full frame metrics, which pitchy
 * does not produce, so this is the only apples-to-apples comparison available
 * — it is a shape check, not a transcription.
 */
function sequenceOf(readings: Reading[]): string {
  const names: string[] = [];
  let currentMidi: number | null = null;
  let held = 0;
  const MIN_FRAMES = 8;

  const flush = (): void => {
    if (currentMidi !== null && held >= MIN_FRAMES) names.push(midiToName(currentMidi));
    currentMidi = null;
    held = 0;
  };

  for (const r of readings) {
    if (r.hz === null || r.confidence < 0.5) {
      flush();
      continue;
    }
    const midi = Math.round(hzToMidiFloat(r.hz));
    if (midi !== currentMidi) {
      flush();
      currentMidi = midi;
    }
    held++;
  }
  flush();
  return names.join(" ");
}

const args = process.argv.slice(2);
syntheticAccuracy();
for (const file of args.filter((a) => !a.startsWith("--"))) compareOnFile(file);
if (args.filter((a) => !a.startsWith("--")).length === 0) {
  console.log("(no file given — pass a .wav to compare on real audio)");
}
