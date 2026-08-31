/**
 * Figure generator for the README.
 *
 *   npx tsx tools/plot-frames.ts trail --frames f.csv --notes t.json --out fig.svg
 *   npx tsx tools/plot-frames.ts parabola --out fig.svg
 *
 * Two pictures, both of which are easier to look at than to describe:
 *
 * **trail** — the frame-level pitch trail of a real take drawn against a
 * semitone grid, with the notes the segmenter committed drawn over it. The
 * wobble is the point: the trail is what a human whistle actually does, and the
 * rectangles are what had to be decided about it. Inputs are exactly what
 * `tools/transcribe-file.ts --frames` and `--json` already emit, so the figure
 * is reproducible from any recording without a browser.
 *
 * **parabola** — three bins around a spectral peak and the parabola fitted
 * through them, computed from a synthetic sine through the *real* analysis
 * settings, so the numbers printed on it are the ones the pipeline gets.
 *
 * The output is a self-contained SVG with a transparent background and no
 * pure black or white anywhere, so it reads on GitHub's light and dark themes
 * alike. Never commit the audio a figure came from — the SVG is fine, the
 * recording is not. See CLAUDE.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RealFft } from "../src/dsp/fft.js";
import { DEFAULT_CONFIG, midiToName, type Note } from "../src/dsp/index.js";
import { hannWindow } from "../src/dsp/window.js";

// ---------------------------------------------------------------------------
// Palette
//
// Every colour has to survive both GitHub themes, which means avoiding the two
// extremes: nothing near white (invisible on the light theme) and nothing near
// black (invisible on the dark one). Mid-luminance hues sit comfortably against
// both #ffffff and #0d1117, and the background stays transparent so the page's
// own colour shows through instead of a card of the wrong shade.
// ---------------------------------------------------------------------------

/** Neutral grey for labels and axes — GitHub's muted foreground, split. */
const INK = "#79818c";
/** The grid: same neutral, carried by opacity rather than by a lighter tint. */
const GRID = "#8b949e";
/** The measured pitch trail — a human whistling. Warm, so it reads as the
 *  organic half of the picture. */
const TRAIL = "#dd6b34";
/** What the segmenter decided. Cool, so the two never blur together. */
const NOTE = "#4183d7";

const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

// ---------------------------------------------------------------------------
// Tiny SVG helpers
// ---------------------------------------------------------------------------

/** Two decimals is well under a device pixel at any sane render size, and it
 *  keeps a 2500-point polyline in the tens of kilobytes rather than hundreds. */
function n2(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface TextOptions {
  size?: number;
  anchor?: "start" | "middle" | "end";
  fill?: string;
  weight?: number;
  opacity?: number;
}

function text(x: number, y: number, s: string, o: TextOptions = {}): string {
  const parts = [
    `x="${n2(x)}"`,
    `y="${n2(y)}"`,
    `font-size="${o.size ?? 10}"`,
    `fill="${o.fill ?? INK}"`,
  ];
  if (o.anchor && o.anchor !== "start") parts.push(`text-anchor="${o.anchor}"`);
  if (o.weight) parts.push(`font-weight="${o.weight}"`);
  if (o.opacity !== undefined) parts.push(`opacity="${o.opacity}"`);
  return `<text ${parts.join(" ")}>${escapeText(s)}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, attrs: string): string {
  return `<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}" ${attrs}/>`;
}

function svgDocument(width: number, height: number, title: string, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeText(title)}" font-family="${FONT}">`,
    `<title>${escapeText(title)}</title>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The pitch-trail figure
// ---------------------------------------------------------------------------

interface FrameRow {
  tSec: number;
  midiFloat: number;
  clarity: number;
  snrDb: number;
  peakToSecondDb: number;
}

/** Parse the CSV `transcribe-file.ts --frames` writes. Rows with no peak in
 *  band have empty `hz`/`midiFloat` fields and are dropped here. */
function readFrames(path: string): FrameRow[] {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`${path}: no "${name}" column — is this a --frames CSV?`);
    return index;
  };
  const [t, midi, clarity, snr, p2s] = [
    column("t"),
    column("midiFloat"),
    column("clarity"),
    column("snrDb"),
    column("peakToSecondDb"),
  ];

  const rows: FrameRow[] = [];
  for (const raw of lines.slice(1)) {
    const cells = raw.split(",");
    const midiFloat = Number(cells[midi]);
    if (cells[midi] === "" || !Number.isFinite(midiFloat)) continue;
    rows.push({
      tSec: Number(cells[t]),
      midiFloat,
      clarity: Number(cells[clarity]),
      snrDb: Number(cells[snr]),
      peakToSecondDb: Number(cells[p2s]),
    });
  }
  return rows;
}

/**
 * Split the frames into the stretches worth drawing.
 *
 * The trail is drawn where the *shape* tests say there was a tone — the same
 * `clarity`/`snrDb`/`peakToSecondDb` thresholds segmentation uses, read from
 * `DEFAULT_CONFIG` rather than guessed at, so the figure cannot drift away from
 * the code. The level test is deliberately left out: it needs the adaptive
 * noise floor, which the CSV does not carry, and its absence only ever admits a
 * few extra frames of a fading tail. A run also breaks whenever a frame is
 * missing, so the line never bridges a silence with a pitch nobody whistled.
 */
function trailRuns(rows: FrameRow[], framePeriod: number): FrameRow[][] {
  const v = DEFAULT_CONFIG.voicing;
  const runs: FrameRow[][] = [];
  let current: FrameRow[] = [];

  const flush = (): void => {
    if (current.length >= DEFAULT_CONFIG.smoothing.minVoicedRunFrames) runs.push(current);
    current = [];
  };

  for (const row of rows) {
    const tonal =
      row.clarity >= v.minClarity &&
      row.snrDb >= v.minSnrDb &&
      row.peakToSecondDb >= v.minPeakToSecondDb;
    const previous = current[current.length - 1];
    if (!tonal || (previous && row.tSec - previous.tSec > 1.5 * framePeriod)) flush();
    if (tonal) current.push(row);
  }
  flush();
  return runs;
}

interface TrailOptions {
  /** How many stacked panels the take is cut into. A 27-second single panel
   *  squeezes the wobble — the thing the figure exists to show — into noise. */
  rows: number;
  /** Keep every n-th trail point. 1 keeps them all, which is usually right:
   *  the wobble *is* the high-frequency detail. */
  decimate: number;
  width: number;
  /** Height of one panel's plot area, in pixels. */
  panelHeight: number;
}

const TRAIL_DEFAULTS: TrailOptions = { rows: 2, decimate: 1, width: 900, panelHeight: 210 };

function renderTrail(
  rows: FrameRow[],
  notes: Note[],
  sampleRate: number,
  options: TrailOptions,
): string {
  if (notes.length === 0) throw new Error("no notes to plot");
  const framePeriod = DEFAULT_CONFIG.analysis.hopSize / sampleRate;
  const runs = trailRuns(rows, framePeriod);

  const marginLeft = 34;
  const marginRight = 10;
  const marginTop = 14;
  const marginBottom = 22;
  const legendHeight = 22;
  const plotWidth = options.width - marginLeft - marginRight;
  const panelPitch = options.panelHeight + marginTop + marginBottom;
  const height = legendHeight + options.rows * panelPitch;

  // The vertical range is set by the notes, not by the trail: a scoop that
  // undershoots by an octave for two frames must not squash the melody flat.
  const midiLo = Math.floor(Math.min(...notes.map((x) => x.midi))) - 2;
  const midiHi = Math.ceil(Math.max(...notes.map((x) => x.midi))) + 2;
  const tEnd = Math.max(notes[notes.length - 1].endSec, rows[rows.length - 1]?.tSec ?? 0);
  const span = tEnd / options.rows;

  const body: string[] = [];

  // ---- legend ------------------------------------------------------------
  body.push(
    line(marginLeft, 12, marginLeft + 20, 12, `stroke="${TRAIL}" stroke-width="1.6"`),
    text(marginLeft + 26, 15, `what was whistled (one point every ${(framePeriod * 1000).toFixed(1)} ms)`, { size: 10 }),
  );
  const legendX = marginLeft + 262;
  body.push(
    `<rect x="${n2(legendX)}" y="6" width="20" height="11" rx="2" fill="${NOTE}" fill-opacity="0.2" stroke="${NOTE}" stroke-opacity="0.8"/>`,
    text(legendX + 26, 15, "the note the segmenter committed", { size: 10 }),
  );

  for (let panel = 0; panel < options.rows; panel++) {
    const t0 = panel * span;
    const t1 = (panel + 1) * span;
    const top = legendHeight + panel * panelPitch + marginTop;
    const bottom = top + options.panelHeight;

    const x = (t: number): number => marginLeft + ((t - t0) / span) * plotWidth;
    const y = (m: number): number => bottom - ((m - midiLo) / (midiHi - midiLo)) * options.panelHeight;

    // ---- semitone grid, with the C lines carrying the octave -------------
    const gridlines: string[] = [];
    const labels: string[] = [];
    for (let m = midiLo; m <= midiHi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      gridlines.push(
        line(marginLeft, y(m), marginLeft + plotWidth, y(m), `stroke-opacity="${isC ? 0.5 : 0.16}"${isC ? ' stroke-width="1"' : ""}`),
      );
      labels.push(
        text(marginLeft - 5, y(m) + 3, midiToName(m), {
          size: 8.5,
          anchor: "end",
          opacity: isC ? 1 : 0.75,
          weight: isC ? 600 : undefined,
        }),
      );
    }
    body.push(`<g stroke="${GRID}" stroke-width="0.6">`, ...gridlines, "</g>", ...labels);

    // ---- time axis --------------------------------------------------------
    const tickEvery = span > 12 ? 5 : span > 5 ? 2 : 1;
    const ticks: string[] = [];
    for (let t = Math.ceil(t0 / tickEvery) * tickEvery; t <= t1 + 1e-9; t += tickEvery) {
      // The very first tick sits on the axis itself, where a centred label
      // would run into the pitch names; hang it off the corner instead.
      const atOrigin = x(t) < marginLeft + 4;
      ticks.push(
        line(x(t), bottom, x(t), bottom + 3, `stroke="${GRID}" stroke-width="0.8" stroke-opacity="0.6"`),
        text(x(t) + (atOrigin ? 2 : 0), bottom + 13, `${t.toFixed(0)}s`, {
          size: 9,
          anchor: atOrigin ? "start" : "middle",
          opacity: 0.85,
        }),
      );
    }
    body.push(
      line(marginLeft, bottom, marginLeft + plotWidth, bottom, `stroke="${GRID}" stroke-width="0.8" stroke-opacity="0.6"`),
      ...ticks,
    );

    // ---- the notes, under the trail so the trail stays legible -------------
    const rects: string[] = [];
    const noteLabels: string[] = [];
    let labelledTo = -Infinity;
    for (const note of notes) {
      if (note.endSec <= t0 || note.startSec >= t1) continue;
      const left = x(Math.max(note.startSec, t0));
      const right = x(Math.min(note.endSec, t1));
      rects.push(
        `<rect x="${n2(left)}" y="${n2(y(note.midi + 0.42))}" width="${n2(Math.max(1.5, right - left))}" height="${n2(y(note.midi - 0.42) - y(note.midi + 0.42))}" rx="1.5"/>`,
      );
      // Skip a label rather than let two overlap: an unreadable smear of
      // overprinted names is worse than a gap.
      const centre = 0.5 * (left + right);
      const halfWidth = 0.5 * (note.noteName.length * 5.4 + 2);
      if (centre - halfWidth > labelledTo) {
        noteLabels.push(
          text(centre, y(note.midi + 0.5) - 2.5, note.noteName, {
            size: 8.5,
            anchor: "middle",
            fill: NOTE,
          }),
        );
        labelledTo = centre + halfWidth;
      }
    }
    body.push(
      `<g fill="${NOTE}" fill-opacity="0.18" stroke="${NOTE}" stroke-opacity="0.75" stroke-width="0.9">`,
      ...rects,
      "</g>",
      ...noteLabels,
    );

    // ---- the trail ---------------------------------------------------------
    const polylines: string[] = [];
    for (const run of runs) {
      let points: string[] = [];
      const flush = (): void => {
        if (points.length >= 2) polylines.push(`<polyline points="${points.join(" ")}"/>`);
        points = [];
      };
      for (let i = 0; i < run.length; i++) {
        const row = run[i];
        // Always keep the endpoints of a run, whatever the decimation, so a
        // short note does not lose its start or its finish.
        if (i % options.decimate !== 0 && i !== run.length - 1) continue;
        if (row.tSec < t0 || row.tSec > t1 || row.midiFloat < midiLo || row.midiFloat > midiHi) {
          flush();
          continue;
        }
        points.push(`${n2(x(row.tSec))},${n2(y(row.midiFloat))}`);
      }
      flush();
    }
    body.push(
      `<g fill="none" stroke="${TRAIL}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">`,
      ...polylines,
      "</g>",
    );
  }

  return svgDocument(
    options.width,
    height,
    "Frame-level pitch trail of a whistled melody with the transcribed notes overlaid",
    body,
  );
}

// ---------------------------------------------------------------------------
// The parabolic-interpolation figure
// ---------------------------------------------------------------------------

/** The same three-point fit `pitch.ts` performs, on log power. Duplicated
 *  rather than exported from the DSP island: the figure has to show the
 *  intermediate parabola, which the pipeline has no reason to return. */
function parabolaCoefficients(a: number, b: number, c: number): { delta: number; peakDb: number } {
  const denominator = a - 2 * b + c;
  const delta = (0.5 * (a - c)) / denominator;
  return { delta, peakDb: b - 0.25 * (a - c) * delta };
}

/**
 * One windowed frame of a pure sine, transformed exactly as the pipeline would.
 *
 * The default frequency is deliberately half a bin above a bin centre: the
 * worst case for reading the peak off the bin index, and therefore the case
 * where interpolation has the most to prove.
 */
function renderParabola(sampleRate: number, hz: number | undefined): string {
  const { windowSize, zeroPadFactor } = DEFAULT_CONFIG.analysis;
  const fftSize = windowSize * zeroPadFactor;
  const binHz = sampleRate / fftSize;
  const f0 = hz ?? (Math.round(1120 / binHz) + 0.5) * binHz;

  const window = hannWindow(windowSize);
  const block = new Float64Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    block[i] = Math.sin((2 * Math.PI * f0 * i) / sampleRate + 0.3) * window[i];
  }
  const power = new RealFft(fftSize).powerSpectrum(block);

  let kPeak = 1;
  for (let k = 1; k < fftSize / 2; k++) if (power[k] > power[kPeak]) kPeak = k;

  const shown = 5; // bins either side of the peak
  const db = (k: number): number => 10 * Math.log10(Math.max(power[k], 1e-30));
  const peakDb = db(kPeak);
  const relative = (k: number): number => db(k) - peakDb;

  const { delta } = parabolaCoefficients(relative(kPeak - 1), 0, relative(kPeak + 1));
  const naiveHz = kPeak * binHz;
  const refinedHz = (kPeak + delta) * binHz;
  const cents = (f: number): number => 1200 * Math.log2(f / f0);

  // ---- geometry ----------------------------------------------------------
  const width = 620;
  const height = 310;
  const left = 52;
  const right = width - 16;
  const top = 46;
  const bottom = height - 58;
  const dbLo = -16;

  const x = (bin: number): number => left + ((bin - (kPeak - shown)) / (2 * shown)) * (right - left);
  const y = (value: number): number => bottom - ((value - dbLo) / (0 - dbLo)) * (bottom - top);

  const body: string[] = [];

  body.push(
    text(left, 14, "Three bins decide the frequency", { size: 12, weight: 600, fill: INK }),
    text(left, 28, `${fftSize}-point transform at ${(sampleRate / 1000).toFixed(0)} kHz: one bin is ${binHz.toFixed(2)} Hz wide.`, { size: 9.5, opacity: 0.9 }),
    text(left, 40, `Zero padding samples the mainlobe ${zeroPadFactor}× more densely, so the three points near its apex lie on a parabola.`, { size: 9.5, opacity: 0.9 }),
    text(right, 28, `true tone: ${f0.toFixed(2)} Hz`, { size: 9.5, anchor: "end", opacity: 0.9 }),
  );

  // dB grid.
  const grid: string[] = [];
  for (let value = 0; value >= dbLo; value -= 4) {
    grid.push(
      line(left, y(value), right, y(value), `stroke="${GRID}" stroke-width="0.6" stroke-opacity="0.2"`),
      text(left - 6, y(value) + 3, `${value} dB`, { size: 8.5, anchor: "end", opacity: 0.8 }),
    );
  }
  body.push(...grid);

  // The mainlobe, as the transform actually sampled it. Zero padding is what
  // puts this many points on one lobe — without it there would be four.
  const stems: string[] = [];
  const dots: string[] = [];
  for (let k = kPeak - shown; k <= kPeak + shown; k++) {
    const used = Math.abs(k - kPeak) <= 1;
    const value = Math.max(relative(k), dbLo);
    stems.push(
      line(x(k), bottom, x(k), y(value), `stroke="${used ? NOTE : GRID}" stroke-width="${used ? 2 : 1.2}" stroke-opacity="${used ? 0.85 : 0.45}"`),
    );
    dots.push(
      `<circle cx="${n2(x(k))}" cy="${n2(y(value))}" r="${used ? 3 : 2}" fill="${used ? NOTE : GRID}" fill-opacity="${used ? 1 : 0.55}"/>`,
    );
  }
  body.push(...stems, ...dots);

  // The fitted parabola, drawn only over the span its three points support.
  const curve: string[] = [];
  const { delta: d, peakDb: apex } = parabolaCoefficients(relative(kPeak - 1), 0, relative(kPeak + 1));
  const a = 0.5 * (relative(kPeak - 1) + relative(kPeak + 1));
  for (let step = 0; step <= 60; step++) {
    const bin = kPeak - 1.35 + (step / 60) * 2.7;
    const u = bin - kPeak - d;
    curve.push(`${n2(x(bin))},${n2(y(Math.max(apex + a * u * u, dbLo)))}`);
  }
  body.push(
    `<polyline points="${curve.join(" ")}" fill="none" stroke="${TRAIL}" stroke-width="1.8" stroke-linecap="round"/>`,
  );

  // Which bins the fit actually used, and where each of the two answers lands.
  // The winning bin is marked with a wedge on the axis rather than a dashed
  // rule, which would hide behind its own stem.
  for (const offset of [-1, 0, 1]) {
    const label = offset === 0 ? "k" : offset < 0 ? "k−1" : "k+1";
    body.push(text(x(kPeak + offset), bottom + 17, label, { size: 9, anchor: "middle", fill: NOTE }));
  }
  const wedge = 4;
  body.push(
    `<path d="M ${n2(x(kPeak) - wedge)} ${n2(bottom + 8)} L ${n2(x(kPeak) + wedge)} ${n2(bottom + 8)} L ${n2(x(kPeak))} ${n2(bottom)} Z" fill="${NOTE}"/>`,
    line(x(kPeak + delta), y(apex), x(kPeak + delta), bottom + 34, `stroke="${TRAIL}" stroke-width="1.4" stroke-opacity="0.9"`),
    `<circle cx="${n2(x(kPeak + delta))}" cy="${n2(y(apex))}" r="3.4" fill="${TRAIL}"/>`,
  );

  body.push(
    text(x(kPeak) + 8, bottom + 33, `highest bin: ${naiveHz.toFixed(1)} Hz (${cents(naiveHz).toFixed(1)} cents off)`, { size: 9.5, fill: NOTE }),
    text(x(kPeak + delta) - 6, bottom + 47, `parabola vertex: ${refinedHz.toFixed(2)} Hz (${cents(refinedHz).toFixed(2)} cents off)`, { size: 9.5, anchor: "end", fill: TRAIL }),
  );

  return svgDocument(width, height, "Parabolic interpolation of a spectral peak", body);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  mode: "trail" | "parabola";
  frames?: string;
  notes?: string;
  out?: string;
  hz?: number;
  sampleRate: number;
  trail: TrailOptions;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "trail", sampleRate: 48000, trail: { ...TRAIL_DEFAULTS } };
  if (argv[0] === "trail" || argv[0] === "parabola") args.mode = argv.shift() as Args["mode"];

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    const number = (): number => {
      const value = Number(next());
      if (!Number.isFinite(value)) throw new Error(`${flag} needs a number`);
      return value;
    };
    switch (flag) {
      case "--frames": args.frames = next(); break;
      case "--notes": args.notes = next(); break;
      case "--out": args.out = next(); break;
      case "--hz": args.hz = number(); break;
      case "--sample-rate": args.sampleRate = number(); break;
      case "--rows": args.trail.rows = Math.max(1, Math.round(number())); break;
      case "--decimate": args.trail.decimate = Math.max(1, Math.round(number())); break;
      case "--width": args.trail.width = number(); break;
      case "--panel-height": args.trail.panelHeight = number(); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) throw new Error("--out <file.svg> is required");

  let svg: string;
  if (args.mode === "parabola") {
    svg = renderParabola(args.sampleRate, args.hz);
  } else {
    if (!args.frames || !args.notes) {
      throw new Error("trail mode needs --frames <csv> and --notes <json>");
    }
    const parsed = JSON.parse(readFileSync(args.notes, "utf8")) as {
      notes?: Note[];
      sampleRate?: number;
    };
    if (!Array.isArray(parsed.notes)) {
      throw new Error(`${args.notes}: no "notes" array — pass the file from --json`);
    }
    svg = renderTrail(
      readFrames(args.frames),
      parsed.notes,
      parsed.sampleRate ?? args.sampleRate,
      args.trail,
    );
  }

  writeFileSync(args.out, svg);
  console.log(`${args.out} (${(svg.length / 1024).toFixed(1)} kB)`);
}

export { readFrames, renderParabola, renderTrail, TRAIL_DEFAULTS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
