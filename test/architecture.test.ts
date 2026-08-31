import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Enforces the one structural rule the whole project leans on: `src/dsp` is
 * pure. It must run unchanged in a browser, in a `tsx` harness and in vitest,
 * because that is what makes the live path and the offline path provably the
 * same code — a bad transcription on the phone can then be reproduced and
 * swept offline instead of being debugged through a phone.
 *
 * A dependency on `window`, an `AudioContext` or a `node:` built-in would
 * break exactly one of those three environments, and it would break it
 * silently and much later.
 */

const DSP_DIR = fileURLToPath(new URL("../src/dsp", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Strip comments and count nothing inside them.
 *
 * The brief called for a blunt grep, but a module about *windowed* FFTs cannot
 * avoid the word "window" in prose or in `windowSize`, so a raw match would
 * make the rule unsatisfiable. Instead: remove comments, then require whole
 * word boundaries. `windowSize` and `noiseFloorWindowSec` survive (no boundary
 * after `window`); a bare `window.foo`, `typeof window`, or a variable called
 * `document` does not.
 *
 * This is deliberately naive about strings containing `//` — it can only ever
 * over-strip, which would make the test *more* permissive, so the positive
 * control below guards against it rotting into a no-op.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Blank out module specifiers before looking for globals.
 *
 * `src/dsp/window.ts` is a legitimate module name — a spectral pipeline has to
 * have an analysis window somewhere — but `from "./window.js"` puts the bare
 * word `window` next to a non-word character, which the globals regex below
 * cannot tell apart from a reference to the browser's `window` object. A module
 * *path* is not a global reference, and paths already have their own rule two
 * tests down, so exempting them here loses no coverage.
 */
function stripModuleSpecifiers(source: string): string {
  return source.replace(/from\s+['"][^'"]*['"]/g, "from ''");
}

const FORBIDDEN_GLOBALS =
  /\b(window|document|navigator|globalThis|localStorage|sessionStorage|AudioContext|OfflineAudioContext|AudioWorklet|AudioWorkletNode|AudioWorkletProcessor|MediaStream|requestAnimationFrame|fetch|XMLHttpRequest)\b|require\s*\(|from\s+['"]node:|import\s*\(\s*['"]node:/;

/** `src/dsp` may import `fft.js` and its own siblings, and nothing else. */
const FORBIDDEN_IMPORTS = /from\s+['"][^'"]*\/(audio|ui|notes)\//;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js|mts|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = sourceFiles(DSP_DIR);

describe("src/dsp purity", () => {
  it("actually found the DSP sources", () => {
    // Guards the whole suite against passing vacuously if the directory moves.
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it("has a working detector (positive control)", () => {
    // If the comment stripper or the regex ever stopped matching real code,
    // every test below would silently pass forever. So prove they still bite.
    expect(FORBIDDEN_GLOBALS.test(stripComments("const el = document.body;"))).toBe(true);
    expect(FORBIDDEN_GLOBALS.test(stripComments("if (typeof window !== 'undefined') {}"))).toBe(true);
    expect(FORBIDDEN_GLOBALS.test(stripComments('import { readFileSync } from "node:fs";'))).toBe(true);
    // ...and the specifier stripper must not become a way to smuggle one in.
    expect(FORBIDDEN_IMPORTS.test('import { x } from "../ui/staff.js";')).toBe(true);
    expect(FORBIDDEN_GLOBALS.test(stripModuleSpecifiers("const el = window.x;"))).toBe(true);
    expect(FORBIDDEN_GLOBALS.test(stripModuleSpecifiers('import { hannWindow } from "./window.js";'))).toBe(
      false,
    );
    expect(FORBIDDEN_GLOBALS.test(stripComments("const x = require('fft.js');"))).toBe(true);
    expect(FORBIDDEN_GLOBALS.test(stripComments("new AudioContext()"))).toBe(true);
    expect(FORBIDDEN_IMPORTS.test('import { x } from "../notes/format.js";')).toBe(true);

    // ...and that the legitimate DSP vocabulary still gets through.
    expect(FORBIDDEN_GLOBALS.test("const windowSize = 2048;")).toBe(false);
    expect(FORBIDDEN_GLOBALS.test("noiseFloorWindowSec: 3,")).toBe(false);
    expect(FORBIDDEN_GLOBALS.test("function hannWindow(n: number) {}")).toBe(false);
    expect(FORBIDDEN_GLOBALS.test(stripComments("// the analysis window is 2048 samples"))).toBe(false);
  });

  it.each(files.map((f) => [relative(SRC_DIR, f), f]))(
    "%s touches no browser or Node globals",
    (_name, file) => {
      const match = FORBIDDEN_GLOBALS.exec(stripModuleSpecifiers(stripComments(readFileSync(file, "utf8"))));
      expect(match?.[0] ?? null).toBeNull();
    },
  );

  it.each(files.map((f) => [relative(SRC_DIR, f), f]))(
    "%s imports nothing from src/audio, src/ui or src/notes",
    (_name, file) => {
      const match = FORBIDDEN_IMPORTS.exec(readFileSync(file, "utf8"));
      expect(match?.[0] ?? null).toBeNull();
    },
  );

  it.each(files.map((f) => [relative(SRC_DIR, f), f]))(
    "%s imports only fft.js and its own siblings",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        const allowed = spec === "fft.js" || spec.startsWith("./");
        expect(allowed, `disallowed import ${spec}`).toBe(true);
      }
    },
  );
});
