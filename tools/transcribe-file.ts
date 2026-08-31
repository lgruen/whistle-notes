/**
 * Offline transcription harness.
 *
 *   npx tsx tools/transcribe-file.ts <file.wav> [flags]
 *
 * This is how the DSP gets tuned against real recordings without a browser in
 * the loop. It runs `transcribe()` — the *same* function the app calls, byte
 * for byte — so anything seen here reproduces on the phone and vice versa.
 *
 * Flags:
 *   --json                Print the whole TranscriptionResult as JSON.
 *   --frames <out.csv>    Write per-frame measurements as CSV.
 *   --frames-cache <f>    Run the FFT stage and cache its frames to <f>.
 *   --from-cache <f>      Load frames from <f> and only re-segment. This is
 *                         the point of the threshold-free pitch stage: a sweep
 *                         over segmentation parameters costs milliseconds. The
 *                         cache records the analysis settings it was produced
 *                         with, and refuses to be re-segmented under different
 *                         ones — pass the audio file too if a sweep needs to
 *                         move them.
 *   --set <k.k=v>         Override any config value, e.g.
 *                         --set segment.toleranceCents=80. Repeatable.
 *   --sweep <k.k=a,b,c>   Re-segment once per value and print each sequence,
 *                         so neighbouring settings can be compared for
 *                         stability. Repeatable (nested loops). Sweeping an
 *                         `analysis.*` key re-runs the FFT stage for each
 *                         value, and says so — those settings *produce* the
 *                         frames rather than interpreting them.
 *   --preset <name>       strict | normal | forgiving.
 *   --plot                ASCII pitch trail — the go/no-go eyeball test.
 *   --stats               Per-second frame statistics.
 *   --histogram           Metric distributions, split by voiced/unvoiced, for
 *                         setting the voicing thresholds from data.
 *   --quiet               Suppress the note table (for sweeps).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CONFIG,
  PitchTracker,
  mergeConfig,
  midiToName,
  presetConfig,
  segmentNotes,
  type DspConfig,
  type DspConfigOverrides,
  type Note,
  type PitchFrame,
  type PresetName,
} from "../src/dsp/index.js";
import { decodeWav } from "./wav.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Options {
  file?: string;
  json: boolean;
  framesCsv?: string;
  framesCache?: string;
  fromCache?: string;
  sets: string[];
  sweeps: string[];
  preset?: PresetName;
  plot: boolean;
  stats: boolean;
  histogram: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    json: false,
    sets: [],
    sweeps: [],
    plot: false,
    stats: false,
    histogram: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--json": options.json = true; break;
      case "--frames": options.framesCsv = next(); break;
      case "--frames-cache": options.framesCache = next(); break;
      case "--from-cache": options.fromCache = next(); break;
      case "--set": options.sets.push(next()); break;
      case "--sweep": options.sweeps.push(next()); break;
      case "--preset": options.preset = next() as PresetName; break;
      case "--plot": options.plot = true; break;
      case "--stats": options.stats = true; break;
      case "--histogram": options.histogram = true; break;
      case "--quiet": options.quiet = true; break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        options.file = arg;
    }
  }
  return options;
}

/**
 * `"segment.toleranceCents=80"` → a one-key config override.
 *
 * The value is parsed against the *type of the default*, and a mismatch is a
 * hard error. This matters more than it looks: `--set segment.toleranceCents=60c`
 * used to sail through as `NaN`, and every comparison against `NaN` is false,
 * so the run produced a different — and silently wrong — transcription rather
 * than a complaint. A sweep is only worth anything if the numbers in it are the
 * numbers you asked for.
 */
function parseSetting(setting: string): DspConfigOverrides {
  const eq = setting.indexOf("=");
  if (eq < 0) throw new Error(`--set needs group.key=value, got ${setting}`);
  const path = setting.slice(0, eq);
  const raw = setting.slice(eq + 1);
  const [group, key] = path.split(".");
  if (!group || !key || !(group in DEFAULT_CONFIG)) {
    throw new Error(`unknown config path ${path}`);
  }
  const groupKey = group as keyof DspConfig;
  if (!(key in DEFAULT_CONFIG[groupKey])) throw new Error(`unknown config key ${path}`);

  const fallback = (DEFAULT_CONFIG[groupKey] as unknown as Record<string, unknown>)[key];
  let value: unknown;
  if (typeof fallback === "boolean") {
    if (raw !== "true" && raw !== "false") {
      throw new Error(`${path} is a boolean (true|false), got "${raw}"`);
    }
    value = raw === "true";
  } else if (typeof fallback === "number") {
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) {
      throw new Error(`${path} is a number, got "${raw}"`);
    }
    value = parsed;
  } else {
    value = raw;
  }

  return { [groupKey]: { [key]: value } } as DspConfigOverrides;
}

function applySettings(base: DspConfig, settings: string[]): DspConfig {
  return settings.reduce((cfg, s) => mergeConfig(cfg, parseSetting(s)), base);
}

// ---------------------------------------------------------------------------
// Frame cache
// ---------------------------------------------------------------------------

interface FrameCache {
  sampleRate: number;
  /** The analysis settings the frames were produced with. Segmentation reads
   *  `hopSize` back out of here, so a cache made with different analysis
   *  parameters must not be silently re-used under new ones. */
  analysis: DspConfig["analysis"];
  frames: PitchFrame[];
}

function computeFrames(file: string, cfg: DspConfig): FrameCache {
  const { samples, sampleRate } = decodeWav(readFileSync(file));
  const frames = new PitchTracker(sampleRate, cfg).push(samples);
  return { sampleRate, analysis: cfg.analysis, frames };
}

/** Stable identity for a set of analysis settings, key order and all. */
function analysisKey(analysis: DspConfig["analysis"]): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(analysis).sort(([a], [b]) => a.localeCompare(b))),
  );
}

/**
 * Which analysis settings differ, for an error message a human can act on.
 *
 * Over the *union* of both key sets, not over one of them: a cache written by
 * an older build can be missing a key the current config has, or carry one it
 * has dropped, and iterating either side alone reports "unknown difference" for
 * exactly the case that needs explaining most.
 */
function analysisDifferences(a: DspConfig["analysis"], b: DspConfig["analysis"]): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort() as (keyof DspConfig["analysis"])[]) {
    if (a[key] !== b[key]) {
      const was = key in b ? String(b[key]) : "(absent)";
      const now = key in a ? String(a[key]) : "(absent)";
      out.push(`analysis.${key} ${was} → ${now}`);
    }
  }
  return out;
}

/**
 * Frames for whatever analysis settings a sweep asks for.
 *
 * The cached-frame trick is what makes a fifty-point sweep cost milliseconds,
 * and it is sound for every threshold in segmentation — but `analysis.*` is not
 * a segmentation threshold, it is what *produced* the frames. Sweeping it
 * against a cache re-segments the old frames under new labels: a `windowSize`
 * sweep then reports perfect stability because nothing actually changed, and a
 * `hopSize` sweep reports pure fiction, because segmentation converts frame
 * indices to seconds through the hop while the frames stay on the old grid.
 *
 * So: one cache per distinct analysis config, re-running the FFT stage when a
 * sweep moves it, and a loud refusal when that is impossible because the frames
 * came from a file that is no longer at hand.
 */
class FrameSource {
  private readonly byAnalysis = new Map<string, FrameCache>();

  constructor(
    private readonly file: string | undefined,
    loaded?: FrameCache,
  ) {
    if (loaded) this.byAnalysis.set(analysisKey(loaded.analysis), loaded);
  }

  /** True when this config needs an FFT pass that has not been run yet. */
  needsAnalysis(cfg: DspConfig): boolean {
    return !this.byAnalysis.has(analysisKey(cfg.analysis));
  }

  /**
   * Throw now if this config could never be served.
   *
   * Separate from `frames()` so a sweep can check *every* combination before it
   * prints anything. A sweep that discovers the problem halfway through has
   * already put a screenful of perfectly formatted results on the terminal, and
   * a run that answers most of the question and then errors is a run whose
   * output invites being used — the failure scrolls away and the numbers stay.
   */
  check(cfg: DspConfig): void {
    if (!this.needsAnalysis(cfg) || this.file) return;
    const [known] = [...this.byAnalysis.values()];
    const changes = known ? analysisDifferences(cfg.analysis, known.analysis) : [];
    throw new Error(
      `the cached frames were computed with different analysis settings ` +
        `(${changes.join(", ") || "unknown difference"}). Frames cannot be re-segmented under ` +
        `analysis settings they were not produced with — re-run against the audio file instead ` +
        `of --from-cache.`,
    );
  }

  frames(cfg: DspConfig): FrameCache {
    const key = analysisKey(cfg.analysis);
    const hit = this.byAnalysis.get(key);
    if (hit) return hit;

    this.check(cfg);
    const computed = computeFrames(this.file as string, cfg);
    this.byAnalysis.set(key, computed);
    return computed;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function centsString(cents: number): string {
  const rounded = Math.round(cents);
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function noteTable(notes: Note[]): string {
  const header = "  # |  start |   dur | note | midi | cents | conf |     Hz";
  const rule = "-".repeat(header.length);
  const rows = notes.map((n, i) =>
    [
      String(i + 1).padStart(3),
      n.startSec.toFixed(2).padStart(6),
      n.durationSec.toFixed(2).padStart(5),
      n.noteName.padStart(4),
      String(n.midi).padStart(4),
      centsString(n.centsOffset).padStart(5),
      n.confidence.toFixed(2).padStart(4),
      n.pitchHz.toFixed(1).padStart(6),
      Object.keys(n.flags).length > 0 ? ` ${Object.keys(n.flags).join(",")}` : "",
    ].join(" | "),
  );
  return [header, rule, ...rows].join("\n");
}

/** One line anyone can paste into a chat: the melody, and nothing else. */
function sequenceLine(notes: Note[]): string {
  return notes.map((n) => n.noteName).join(" ");
}

function framesCsv(frames: PitchFrame[], a4Hz: number): string {
  const lines = ["t,hz,midiFloat,clarity,snrDb,peakToSecondDb,bandRmsDb"];
  for (const f of frames) {
    const midiFloat = f.hz !== null && f.hz > 0 ? 69 + 12 * Math.log2(f.hz / a4Hz) : NaN;
    lines.push(
      [
        f.tSec.toFixed(4),
        f.hz === null ? "" : f.hz.toFixed(3),
        Number.isFinite(midiFloat) ? midiFloat.toFixed(4) : "",
        f.clarity.toFixed(4),
        f.snrDb.toFixed(2),
        f.peakToSecondDb.toFixed(2),
        f.bandRmsDb.toFixed(2),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/**
 * The go/no-go picture: frequency against time, in ASCII.
 *
 * A melody looks like flat plateaus at distinct heights with gaps between
 * them. Noise looks like confetti. This distinction is obvious to an eye and
 * expensive to encode in an assertion, which is exactly what a debug plot is
 * for.
 */
function plotTrail(frames: PitchFrame[], a4Hz: number, columns = 150, rows = 30): string {
  const pitched = frames.filter((f) => f.hz !== null && f.hz > 0);
  if (pitched.length === 0) return "(no pitched frames)";

  const midi = pitched.map((f) => 69 + 12 * Math.log2((f.hz as number) / a4Hz));
  const strong = pitched.filter((f) => f.clarity >= 0.5 && f.snrDb >= 12);
  const reference = strong.length > 20 ? strong : pitched;
  const referenceMidi = reference.map((f) => 69 + 12 * Math.log2((f.hz as number) / a4Hz)).sort((a, b) => a - b);
  // Clip the axis to the bulk of the *confident* frames: a handful of noise
  // frames at the band edges would otherwise squash the melody into one row.
  const lo = Math.floor(referenceMidi[Math.floor(0.02 * (referenceMidi.length - 1))]) - 2;
  const hi = Math.ceil(referenceMidi[Math.floor(0.98 * (referenceMidi.length - 1))]) + 2;

  const tEnd = frames[frames.length - 1].tSec;
  const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(columns).fill(" "));

  for (let i = 0; i < pitched.length; i++) {
    const f = pitched[i];
    const x = Math.min(columns - 1, Math.max(0, Math.round((f.tSec / tEnd) * (columns - 1))));
    const y = Math.round(((hi - midi[i]) / (hi - lo)) * (rows - 1));
    if (y < 0 || y >= rows) continue;
    // Confident frames print solid, marginal ones faint: the shape of the
    // melody and the confidence in it are the same picture.
    const mark = f.clarity >= 0.5 && f.snrDb >= 12 ? "#" : f.clarity >= 0.25 ? "+" : ".";
    const existing = grid[y][x];
    if (existing === " " || (existing === "." && mark !== ".") || (existing === "+" && mark === "#")) {
      grid[y][x] = mark;
    }
  }

  const lines = grid.map((row, y) => {
    const midiAt = hi - (y / (rows - 1)) * (hi - lo);
    const label = y % 3 === 0 ? midiToName(Math.round(midiAt)).padStart(4) : "    ";
    return `${label} |${row.join("")}`;
  });
  lines.push(`     +${"-".repeat(columns)}`);
  lines.push(`      0s${" ".repeat(Math.max(0, columns - 10))}${tEnd.toFixed(1)}s`);
  return lines.join("\n");
}

function quantiles(values: number[], points: number[]): number[] {
  if (values.length === 0) return points.map(() => NaN);
  const sorted = [...values].sort((a, b) => a - b);
  return points.map((p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]);
}

/**
 * Metric distributions, split into "looks like a tone" and "does not".
 *
 * The split is deliberately made by a *different* criterion than the one being
 * calibrated — a strong, unambiguous peak — so that reading a threshold off
 * these numbers is not circular. What we want to see is two well-separated
 * populations; where they separate is where the threshold belongs.
 */
function histogram(frames: PitchFrame[], notes: Note[]): string {
  const points = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99];
  const labels = ["p1", "p5", "p10", "p25", "p50", "p75", "p90", "p99"];

  // A frame is provisionally "tonal" if its peak dominates the band by a wide
  // margin — 20 dB of peak-to-second is not something breath noise produces.
  const tonal = frames.filter((f) => f.hz !== null && f.peakToSecondDb >= 20 && f.clarity >= 0.6);
  const background = frames.filter((f) => f.peakToSecondDb < 10);

  // A second, independent split: frames that landed inside a transcribed note
  // versus everything else. Circular in principle — the notes came from the
  // thresholds being calibrated — but when the pitch trail visibly matches the
  // melody, "inside a note" is a decent stand-in for ground truth, and it is
  // the split that actually answers "how far can I tighten this before I start
  // cutting into real whistling?".
  const inNote = (f: PitchFrame): boolean =>
    notes.some((n) => f.tSec >= n.startSec && f.tSec < n.endSec);
  const whistle = frames.filter(inNote);
  const other = frames.filter((f) => !inNote(f));

  const section = (name: string, group: PitchFrame[]): string => {
    const metrics: [string, number[]][] = [
      ["clarity", group.map((f) => f.clarity)],
      ["snrDb", group.map((f) => f.snrDb)],
      ["peakToSecondDb", group.map((f) => f.peakToSecondDb)],
      ["bandRmsDb", group.map((f) => f.bandRmsDb)],
      ["broadbandRmsDb", group.map((f) => f.broadbandRmsDb)],
    ];
    const rows = metrics.map(([metric, values]) => {
      const qs = quantiles(values, points);
      return `  ${metric.padEnd(16)}${qs.map((q) => q.toFixed(2).padStart(9)).join("")}`;
    });
    return [`${name} (${group.length} frames)`, `  ${"".padEnd(16)}${labels.map((l) => l.padStart(9)).join("")}`, ...rows].join("\n");
  };

  return [
    section("TONAL   [peakToSecond ≥ 20 dB and clarity ≥ 0.6]", tonal),
    "",
    section("BACKGROUND [peakToSecond < 10 dB]", background),
    "",
    section("INSIDE A TRANSCRIBED NOTE", whistle),
    "",
    section("OUTSIDE EVERY NOTE (breath, silence, transitions)", other),
    "",
    section("ALL", frames),
  ].join("\n");
}

function perSecondStats(frames: PitchFrame[], a4Hz: number): string {
  const buckets = new Map<number, PitchFrame[]>();
  for (const f of frames) {
    const second = Math.floor(f.tSec);
    const bucket = buckets.get(second);
    if (bucket) bucket.push(f);
    else buckets.set(second, [f]);
  }
  const lines = ["  t | frames | tonal | med.hz | med.note | med.clarity | med.snr | med.bandRms"];
  for (const [second, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const tonal = group.filter((f) => f.hz !== null && f.clarity >= 0.5 && f.snrDb >= 12);
    const [medianHz] = quantiles(tonal.map((f) => f.hz as number), [0.5]);
    const [medianClarity] = quantiles(group.map((f) => f.clarity), [0.5]);
    const [medianSnr] = quantiles(group.map((f) => f.snrDb), [0.5]);
    const [medianRms] = quantiles(group.map((f) => f.bandRmsDb), [0.5]);
    const note = Number.isFinite(medianHz) ? midiToName(Math.round(69 + 12 * Math.log2(medianHz / a4Hz))) : "-";
    lines.push(
      [
        String(second).padStart(3),
        String(group.length).padStart(6),
        String(tonal.length).padStart(5),
        (Number.isFinite(medianHz) ? medianHz.toFixed(1) : "-").padStart(6),
        note.padStart(8),
        medianClarity.toFixed(3).padStart(11),
        medianSnr.toFixed(1).padStart(7),
        medianRms.toFixed(1).padStart(11),
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  let cfg = options.preset ? presetConfig(options.preset) : DEFAULT_CONFIG;
  cfg = applySettings(cfg, options.sets);

  // Everything a `--sweep` will ask for, resolved and checked before a single
  // line of output. See `sweepPlan`.
  let source: FrameSource;
  if (options.fromCache) {
    const loaded = JSON.parse(readFileSync(options.fromCache, "utf8")) as FrameCache;
    if (!loaded.analysis) {
      throw new Error(
        `${options.fromCache} predates analysis-aware caching and cannot be trusted; ` +
          `re-create it with --frames-cache.`,
      );
    }
    source = new FrameSource(options.file, loaded);
  } else {
    if (!options.file) throw new Error("usage: transcribe-file.ts <file.wav> [flags]");
    source = new FrameSource(options.file);
  }
  const plan = options.sweeps.length > 0 ? sweepPlan(cfg, options.sweeps) : [];
  for (const step of plan) source.check(step.cfg);
  const cache = source.frames(cfg);

  if (options.framesCache) {
    writeFileSync(options.framesCache, JSON.stringify(cache));
    console.log(`frames cached → ${options.framesCache} (${cache.frames.length} frames)`);
  }
  if (options.framesCsv) {
    writeFileSync(options.framesCsv, framesCsv(cache.frames, cfg.tuning.a4Hz));
    console.log(`frames written → ${options.framesCsv} (${cache.frames.length} frames)`);
  }
  if (options.plot) {
    console.log(plotTrail(cache.frames, cfg.tuning.a4Hz));
    console.log("");
  }
  if (options.stats) {
    console.log(perSecondStats(cache.frames, cfg.tuning.a4Hz));
    console.log("");
  }
  const { notes, tuningOffsetCents } = segmentNotes(cache.frames, cfg, cache.sampleRate);

  if (options.histogram) {
    console.log(histogram(cache.frames, notes));
    console.log("");
  }

  if (plan.length > 0) {
    runSweep(source, plan);
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify({ notes, frames: cache.frames, sampleRate: cache.sampleRate, tuningOffsetCents }, null, 2),
    );
    return;
  }
  if (options.quiet) return;

  console.log(noteTable(notes));
  console.log("");
  console.log(`${notes.length} notes, tuning offset ${centsString(tuningOffsetCents)} cents`);
  console.log("");
  console.log(sequenceLine(notes));
}

/**
 * Cartesian product of every `--sweep key=a,b,c`, re-segmenting each time —
 * and re-running the FFT stage for any combination that changes `analysis.*`,
 * which is announced in the output so that a sweep's cost is never a mystery.
 *
 * Every combination is parsed and checked for serveability *before* the first
 * line is printed. A sweep that fails halfway leaves a screenful of correct
 * answers on the terminal above an error that scrolls away, and those answers
 * are exactly the kind of thing that ends up quoted in a commit message.
 */
function sweepPlan(base: DspConfig, sweeps: string[]): { combination: string; cfg: DspConfig }[] {
  const axes = sweeps.map((sweep) => {
    const eq = sweep.indexOf("=");
    if (eq < 0) throw new Error(`--sweep needs group.key=v1,v2,…, got ${sweep}`);
    return { path: sweep.slice(0, eq), values: sweep.slice(eq + 1).split(",") };
  });

  const combinations: string[][] = [[]];
  for (const axis of axes) {
    const next: string[][] = [];
    for (const prefix of combinations) {
      for (const value of axis.values) next.push([...prefix, `${axis.path}=${value}`]);
    }
    combinations.splice(0, combinations.length, ...next);
  }

  return combinations.map((parts) => ({
    combination: parts.join(" "),
    cfg: applySettings(base, parts),
  }));
}

function runSweep(source: FrameSource, plan: { combination: string; cfg: DspConfig }[]): void {
  for (const { combination, cfg } of plan) {
    const refft = source.needsAnalysis(cfg);
    const cache = source.frames(cfg);
    const { notes, tuningOffsetCents } = segmentNotes(cache.frames, cfg, cache.sampleRate);
    console.log(
      `${combination.padEnd(38)} → ${String(notes.length).padStart(3)} notes, ` +
        `tune ${centsString(tuningOffsetCents).padStart(3)}c : ${sequenceLine(notes)}` +
        `${refft ? `\n  (FFT stage re-run: ${cache.frames.length} frames)` : ""}`,
    );
  }
}

// Run only when invoked as a script, so the argument parsing and the frame
// cache can be unit-tested. They are worth testing: both have silently
// produced *plausible* wrong answers, which is the expensive kind.
export { FrameSource, parseSetting, sweepPlan };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    // A stack trace for a typo in `--set segment.tolerence=60` helps nobody.
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
