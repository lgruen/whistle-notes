/**
 * Minimal `tsx` harness: proves fft.js default-imports under the Node/tsx
 * runtime that tools/transcribe-file.ts will use in M2. Run with:
 *   npx tsx tools/smoke.ts
 */
import FFT from "fft.js";

const N = 16;
const cycles = 2;
const input = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * cycles * i) / N));

const fft = new FFT(N);
const spectrum = fft.createComplexArray();
fft.realTransform(spectrum, input);
fft.completeSpectrum(spectrum);

let peakBin = 0;
let peakMag = -Infinity;
for (let bin = 0; bin <= N / 2; bin++) {
  const mag = Math.hypot(spectrum[2 * bin], spectrum[2 * bin + 1]);
  if (mag > peakMag) {
    peakMag = mag;
    peakBin = bin;
  }
}

console.log(`fft.js ok under tsx: size=${fft.size} peakBin=${peakBin} peakMag=${peakMag.toFixed(3)}`);
if (peakBin !== cycles) throw new Error(`expected peak at bin ${cycles}, got ${peakBin}`);
