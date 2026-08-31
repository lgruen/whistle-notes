import { registerSW } from "virtual:pwa-register";
import FFT from "fft.js";
import "./app.css";

/**
 * Third leg of the fft.js interop smoke test (vitest and tsx being the other
 * two): importing it from the entry module means `vite build` has to resolve
 * and bundle this CommonJS package for real. The result is written to the DOM
 * so nothing here can be tree-shaken away and quietly stop proving anything.
 */
function fftPeakBin(): number {
  const N = 16;
  const cycles = 2;
  const fft = new FFT(N);
  const spectrum = fft.createComplexArray();
  fft.realTransform(
    spectrum,
    Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * cycles * i) / N)),
  );
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
  return peakBin;
}

const status = document.getElementById("status");
if (status) {
  status.textContent =
    fftPeakBin() === 2
      ? "Scaffold ready — fft.js linked. Audio pipeline lands in a later milestone."
      : "fft.js self-check FAILED — the FFT backend is not behaving.";
}

const stamp = document.getElementById("build-stamp");
if (stamp) stamp.textContent = `build ${__BUILD__}`;

/*
 * Service-worker staleness defence. `autoUpdate` + `immediate: true` installs
 * and activates a new worker as soon as one is found, but the browser only
 * *looks* on navigation — which an installed PWA resumed from the background
 * may not do for days. Re-checking whenever the app comes to the foreground is
 * what turns "deployed" into "actually running on the phone"; the build stamp
 * in the footer is how you confirm it did.
 */
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void registration.update();
    });
  },
});
