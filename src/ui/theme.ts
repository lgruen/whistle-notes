/**
 * The palette, read back out of CSS.
 *
 * `src/app.css` owns every colour as a custom property. The SVG staff can just
 * use `var(--accent)` in a stylesheet, but a canvas cannot: `fillStyle` wants a
 * resolved colour string. Rather than keep a second copy of the palette in
 * TypeScript — which would drift from the CSS on the first theme tweak and be
 * wrong only in dark mode — the canvas asks the browser what the properties
 * currently resolve to.
 *
 * `getComputedStyle` forces a style flush, so the result is cached and thrown
 * away whenever the colour scheme changes.
 */

export interface Palette {
  bg: string;
  surface: string;
  text: string;
  textDim: string;
  accent: string;
  accentDim: string;
  danger: string;
}

let cached: Palette | null = null;
let watching = false;

function property(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/** The palette as it currently resolves on `element`. */
export function readPalette(element: Element): Palette {
  if (cached) return cached;

  if (!watching && typeof matchMedia === "function") {
    watching = true;
    // The user can flip their system theme with the app open; anything drawn
    // imperatively has to be told, because CSS repaints itself and canvas
    // pixels do not.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      cached = null;
    });
  }

  const styles = getComputedStyle(element);
  cached = {
    bg: property(styles, "--bg", "#0e1116"),
    surface: property(styles, "--surface", "#161b22"),
    text: property(styles, "--text", "#e6edf3"),
    textDim: property(styles, "--text-dim", "#8b949e"),
    accent: property(styles, "--accent", "#14b8a6"),
    accentDim: property(styles, "--accent-dim", "#0f766e"),
    danger: property(styles, "--danger", "#f85149"),
  };
  return cached;
}

/** Drop the cache — call after anything that could change resolved colours. */
export function invalidatePalette(): void {
  cached = null;
}
