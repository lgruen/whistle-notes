/**
 * Renders assets/icon.svg into the PWA icon set. Run once (`npm run icons`)
 * and commit the PNGs — this is not part of the build, so neither CI nor a
 * fresh clone needs sharp's native binaries to produce a deployable site.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "public/icons");

const rounded = await readFile(resolve(root, "assets/icon.svg"), "utf8");

// Square-cornered variant. Flattening the rounded art onto a flat colour would
// leave a visible seam where the corner paint meets the gradient, so instead
// we let the gradient itself run to the edge and hand the silhouette to the
// platform — which is exactly what maskable and apple-touch-icon expect.
const square = rounded.replace('rx="104" ry="104"', 'rx="0" ry="0"');
if (square === rounded) throw new Error("icon.svg corner radius not found — update this script");

const targets = [
  // Transparent corners are fine (and look better) for `purpose: "any"`.
  { file: "icon-192.png", size: 192, svg: rounded },
  { file: "icon-512.png", size: 512, svg: rounded },
  // Maskable + Apple both need paint in every pixel: the platform decides the
  // silhouette, and transparency there turns into black or white fringing.
  { file: "maskable-512.png", size: 512, svg: square },
  { file: "apple-touch-icon-180.png", size: 180, svg: square },
];

await mkdir(outDir, { recursive: true });

for (const { file, size, svg } of targets) {
  const png = await sharp(Buffer.from(svg), { density: 512 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(resolve(outDir, file), png);
  console.log(`${file.padEnd(26)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`);
}
