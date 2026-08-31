# whistle-notes — maintainer guide

A phone-installable PWA that turns a whistled melody into piano note names.
Vanilla TypeScript + Vite at the repo root, no framework, deployed to GitHub
Pages by Actions. Runtime dependencies: `fft.js` and nothing else.

## Hard rules

### Never commit recordings

`.gitignore` blankets `*.m4a`, `*.wav` and `test/fixtures/local/`. These are
deliberately broad so that an absent-minded `git add -A` cannot leak audio
into a public repo. **Do not narrow them**, and do not add an audio file with
`git add -f`. Run `git status` before every commit.

CI never needs a recording: `test/fixtures/synth.ts` generates signals in
process, with ground truth true by construction. The one test that wants the
real recording `skipIf`s itself when the fixture is missing.

### `src/dsp/` is pure

Everything under `src/dsp/` must run unchanged in a browser, in a Node
harness, and in vitest — that is what makes the live path and the offline path
provably the same code. So no `window`, `document`, `navigator`,
`AudioContext`, `AudioWorklet`, `require(`, and no `node:` imports; it may
import only `fft.js` and other `src/dsp` modules. `test/architecture.test.ts`
greps for violations and fails the build. Browser concerns live in
`src/audio/`, display concerns (including octave transposition) in `src/ui/`
and `src/notes/`.

The payoff is concrete: `transcribe(samples, sampleRate, cfg)` produces
bit-identical output in the app and in `tools/transcribe-file.ts`, so a bad
transcription on the phone can be reproduced and swept offline.

### Thresholds live in segmentation, not in pitch detection

The pitch stage emits raw per-frame metrics (`clarity`, `snrDb`,
`peakToSecondDb`, `bandRmsDb`, …) and never decides whether a frame is voiced.
All gating happens in segmentation. This is what lets the harness cache frames
to JSON once and then re-run a parameter sweep in milliseconds.

## Layout

```
index.html            entry; src/main.ts is the only script
src/
  main.ts             boot, SW registration, build stamp
  app.css             theme custom properties (canvas/SVG read these back)
  dsp/                PURE. types.ts config.ts index.ts (+ fft/pitch/segment)
  notes/format.ts     note naming, cents, display transposition, staff steps
  audio/              browser-only: mic, recorder, file import
  ui/                 views
public/
  pcm-recorder.worklet.js   plain-JS AudioWorklet forwarder (not bundled)
  icons/                    generated PNGs — commit them
assets/icon.svg       hand-written icon source
scripts/gen-icons.mjs `npm run icons` → public/icons/*.png (sharp)
tools/                tsx CLIs: wav.ts, transcribe-file.ts, compare-detectors.ts
test/
  *.test.ts           vitest
  fixtures/synth.ts   synthetic signal generator
  fixtures/local/     gitignored; the real recording lives here
```

## Dev loop

```sh
npm run dev       # desktop Chrome on localhost covers ~90% of the work
npm test          # vitest run
npm run build     # tsc --noEmit && vite build
npm run preview   # serve dist/ — the only way to exercise the service worker
```

Note that the service worker is disabled in `npm run dev`; SW behaviour is only
observable via `npm run preview` or the deployed site.

### On an Android phone

Plain `http://localhost` is a secure context, so the mic works there without
certificates. USB-connect the phone, open `chrome://inspect` on the desktop,
use **Port forwarding** to map `localhost:5173` to the dev server, then load
`http://localhost:5173` on the phone. That gives HMR, microphone access, and
full remote DevTools with no mkcert, no tunnel, no self-signed certificate.

The installed-PWA path (manifest, icons, offline, SW update) can only be tested
against the deployed site — `git push` and wait ~40–60 s.

### fft.js interop

`fft.js` is CommonJS with `export = FFT` and no `exports` field. The default
import works because `moduleResolution: "bundler"` implies
`allowSyntheticDefaultImports`. `test/fft-interop.test.ts` and the FFT
self-check in `src/main.ts` keep all three environments (vitest, tsx, vite
build) honest; if one ever breaks, fix the build config rather than sprinkling
`require` through `src/dsp`.

## Deploy

Pushing to `main` runs `.github/workflows/ci.yml`: a test job (`tsc --noEmit`
+ `vitest run` on Node 24) **gates** the deploy job, which builds and publishes
`dist/` to GitHub Pages. Pages is configured with `build_type=workflow`; there
is no `gh-pages` branch.

`base: "./"` in `vite.config.ts` is what makes the same build work at
`/whistle-notes/`, under `vite preview`, and from a `file://` sanity check.
Absolute paths will 404 on Pages.

**Staleness is the classic footgun here.** Defences, all of which must stay:
`registerType: 'autoUpdate'`, `registerSW({ immediate: true })`, a
`visibilitychange` re-check in `src/main.ts`, and a visible build stamp in the
footer (`__BUILD__`, defined from `GITHUB_SHA`). If the deployed page shows a
stamp that is not the pushed SHA, you are looking at a cached worker, not a
broken build. Workbox's `globPatterns` must keep `js` so the unhashed
`pcm-recorder.worklet.js` is revisioned and precached; drop it and the
installed app breaks offline.

## Conventions

- No ESLint or Prettier. `strict` tsc plus `noUnusedLocals`/`noUnusedParameters`
  is the whole quality gate; keep the build clean.
- `vitest.config.ts` is standalone and loads **no plugins** — tests must never
  drag in vite-plugin-pwa.
- Commit at milestone granularity, push regularly.
