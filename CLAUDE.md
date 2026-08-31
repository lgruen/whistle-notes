# whistle-notes — maintainer guide

A phone-installable PWA that turns a whistled melody into piano note names.
Vanilla TypeScript + Vite at the repo root, no framework, deployed to GitHub
Pages by Actions. Runtime dependencies: `fft.js` and nothing else.

The README's "How it works" section is the explanation of the algorithm; this
file is the set of invariants and gotchas that are not obvious from the code.

## Hard rules

### Never commit recordings

`.gitignore` blankets `*.m4a`, `*.wav` and `test/fixtures/local/`. These are
deliberately broad so that an absent-minded `git add -A` cannot leak audio into
a public repo. **Do not narrow them**, and do not add an audio file with
`git add -f`. Run `git status` before every commit.

CI never needs a recording: `test/fixtures/synth.ts` generates signals in
process, with ground truth true by construction. `test/golden.test.ts` is the
only file that touches `test/fixtures/local/`, and it `describe.skipIf`s the
whole suite when the fixture is missing.

Figures **derived** from a recording (the SVGs in `docs/`) are fine and are
committed; the audio they came from is not. `tools/plot-frames.ts` regenerates
them from harness output — see the README's development section.

Recordings arrive as m4a and are converted with macOS `afconvert`:

```sh
afconvert -f WAVE -d LEI16@48000 -c 1 take.m4a test/fixtures/local/take.wav
```

**ffmpeg is broken on this machine** (missing `libx265` dylib). Do not use it
and do not try to fix it; `afconvert` is a built-in and does everything needed.

### `src/dsp/` is pure

Everything under `src/dsp/` must run unchanged in a browser, in a Node harness,
and in vitest — that is what makes the live path and the offline path provably
the same code. So: no browser globals (`window`, `document`, `navigator`,
`globalThis`, `localStorage`/`sessionStorage`, `AudioContext`,
`OfflineAudioContext`, the `AudioWorklet*` family, `MediaStream`,
`requestAnimationFrame`, `fetch`, `XMLHttpRequest`), no `require(`, no `node:`
imports static or dynamic, and no imports from `src/audio`, `src/ui` or
`src/notes`. It may import `fft.js` and its own siblings, and nothing else.

`test/architecture.test.ts` enforces this by grepping the sources; the exact
token list lives there, along with a positive-control test that proves the
detector still bites (and that legitimate DSP vocabulary like `windowSize` and
`hannWindow` still passes). Note its scope: it inspects **`src/dsp` only** — it
does not police `src/ui`, `src/audio` or `tools/`.

The payoff is concrete: `transcribe(samples, sampleRate, cfg)` produces
bit-identical output in the app and in `tools/transcribe-file.ts`, so a bad
transcription on the phone can be reproduced and swept offline.

Because the dependency may only point that way, the Hz↔MIDI↔cents maths lives in
`src/dsp/tuning.ts` — segmentation needs it to fill in `Note.midi` and
`Note.noteName`. `src/notes/format.ts` re-exports it and adds the display-only
concerns (octave transposition, staff geometry), so there is exactly one
implementation of the pitch maths in the repo and the UI still has one place to
import from. Everything else outside `src/dsp` imports from `src/dsp/index.ts`,
not from modules inside it; `src/notes/format.ts` and `test/voicing.test.ts`
(which needs the intermediate `prepare()` stages) are the two deliberate
exceptions.

### Practice mode is ear-first

The app plays, the user whistles back. **No exercise, prompt or library row may
present a written or named target**, because the user this is built for has
minimal music theory and reading "whistle a C6" is a different — and much
harder — skill than the one the mode is teaching. Note and interval names appear
only as *passive labels about something already played*: the measured range
readout, and a verdict after an attempt.

There is exactly one place where notes are written out, and its boundary is
worth stating precisely: **a draft is a transcript under review; a target is a
melody you are about to be asked for.** The draft screen (`src/ui/practice.ts`)
names its chips because that is the only moment the user can catch the *app*
being wrong — a scoop that became a note, or the octave error the detector makes
on the deepest piano keys — and because the trim and move controls would
otherwise have nothing to aim at. The moment it is saved, the library, the
detail screen and every exercise say only its name, its length and its source.

`test/practice-ui.test.ts` enforces this against the real copy, not against
intent: it greps the practice half of `index.html` and the exported sentences of
`src/ui/practice.ts` for pitch names and interval words, and pins both sides of
the draft/target boundary. If you add copy there, it has to pass — which also
means avoiding the word "octave" (say "higher"/"lower") and "seconds" (write
`2.1 s`) in practice-mode strings.

### Thresholds live in segmentation, not in pitch detection

The pitch stage emits raw per-frame metrics (`clarity`, `snrDb`,
`peakToSecondDb`, `bandRmsDb`, …) and never decides whether a frame is voiced.
All gating happens in segmentation. This is what lets the harness cache frames
to JSON once and then re-run a parameter sweep in milliseconds — and it is the
reason `--from-cache` refuses to re-segment under changed `analysis.*` settings,
which *produce* the frames rather than interpret them.

Every constant in `src/dsp/config.ts` carries the measurement or the argument
that set it. If you change one, change the comment too, and check the
transcription is stable across neighbouring values with `--sweep` — a value that
only works at one exact setting is fitted to one recording.

## Layout

```
index.html            entry; src/main.ts is the only script; holds the whole
                      layout — header (mode tabs + transpose toggle), then two
                      sibling views: #transcribe-view (live readout, roll, note
                      list, staff, tools/debug) and #practice-view (library,
                      draft, MIDI picker, range screens), plus the dock with
                      record/play/voice/import — which belongs to the
                      transcriber alone and is hidden in practice mode, whose
                      actions live on whichever screen is showing
src/
  main.ts             boot, phase transitions, the rAF hot loop, take-intent
                      routing, import (audio and MIDI), transcription, WAV save,
                      playback, SW update policy, build stamp, fft.js self-check
  app.css             theme custom properties (canvas/SVG read these back)
  vite-env.d.ts       declares __BUILD__
  dsp/                PURE island. types config tuning fft window pitch tracker
                      segment index
  notes/format.ts     re-exports dsp/tuning + display transposition, staff steps
  practice/           PURE island (except store.ts). align (the diagnosis DP),
                      stats, range, target (+ drafts), midi (SMF parser),
                      bundled (starter melodies), store (the only storage)
  audio/              browser-only: capture (mic + worklet), decode (file
                      import), synth (playback voices), wav-export (debug
                      download)
  ui/                 controls state theme live notelist pianoroll staff debug
                      sw-update practice
public/
  pcm-recorder.worklet.js   plain-JS AudioWorklet forwarder (not bundled)
  icons/                    generated PNGs — commit them (192/512/maskable/
                            apple-touch-180)
assets/icon.svg       hand-written icon source
scripts/gen-icons.mjs `npm run icons` → public/icons/*.png (sharp)
docs/                 committed SVG figures for the README
tools/                tsx CLIs: wav.ts (RIFF read/write), transcribe-file.ts
                      (the tuning harness), compare-detectors.ts (FFT vs
                      pitchy), plot-frames.ts (README figures), smoke.ts
                      (fft.js interop under tsx)
test/
  *.test.ts           vitest; roughly one file per concern (dsp contract, pitch,
                      segmentation, voicing, glide, music theory, synth
                      fixtures, wav, harness, architecture, fft interop, golden,
                      ui-* for the app modules, and practice-* for the
                      diagnosis engine, the store, the sources and the screens)
  fixtures/synth.ts   synthetic signal generator
  fixtures/local/     gitignored; the real recordings live here
```

The golden test's expected sequence is currently marked **PROPOSED, not yet
verified at a piano** in `test/golden.test.ts`. Until a human confirms it, treat
it as a change detector rather than as ground truth.

`src/dsp/config.ts` exports `PRESETS` (strict / normal / forgiving) and
`presetConfig()`. They are reachable from the harness (`--preset`) and from
tests, but **no UI control calls them today** — the "wobble snap" knob described
in the config comments does not exist on screen yet.

## Practice mode

The second half of the app: a library of target melodies, and (from T3 on) the
exercises that play them at you and score what comes back. See the ear-first
hard rule above before touching any of its copy.

### One microphone, two modes

`src/ui/state.ts` owns `mode` (`"transcribe" | "practice"`) and the `phase`
machine; `src/practice/store.ts` owns everything practice-shaped. They are two
stores because they have different lifetimes — `AppState` is about the take on
screen right now, the practice store is a library and a history that outlive the
session — but they deliberately share **one** `phase`, because `capture.ts` is a
singleton and routing every take through the same phase machine is what makes it
impossible for the two halves of the app to open the microphone at once.
`setMode` refuses a switch while audio is running, and `ui/controls.ts` renders
that refusal as a disabled tab.

### Take-intent routing (the thing to extend, not to fork)

Every take — a transcription, either end of the range check, a melody being
recorded as a target — goes through the same `startRecording` / `stopRecording` /
`transcribe()` path in `src/main.ts`. The only thing that differs is where the
notes go afterwards, and that is carried by one variable:

```ts
type TakeIntent = "transcribe" | RangeStep | "target";
```

It is **read once, when the analysis is scheduled**, so a mode switch or a fresh
tap mid-analysis cannot redirect a take already in flight. Every failure path
(start refused, session interrupted, no audio captured, segmenter crash) routes
by intent through `practiceTakeFailed`, because the transcriber's message line is
not on screen in practice mode — and each of those store calls also clears the
flag the screen uses to decide whether a Stop button belongs over an open
microphone. If you add a new kind of take, add an arm here; do not fork the
record path.

### Storage

Five keys, all under `whistle-notes:`, all read inside `try`/`catch` (some
privacy modes make `localStorage` throw on access, and a library nobody can read
must never be a mode nobody can open):

| key | written by | holds |
| --- | --- | --- |
| `whistle-notes:transpose` | `ui/state.ts` | display octave |
| `whistle-notes:mode` | `ui/state.ts` | which tab was last open |
| `whistle-notes:voice` | `ui/state.ts` | playback voice |
| `whistle-notes:practice:v1` | `practice/store.ts` | target library + measured range |
| `whistle-notes:practice-stats:v1` | `practice/store.ts` | attempt history |

The two practice keys are versioned and separate on purpose: an unknown version
is a document a future build wrote and is left alone rather than half-read, and a
quota failure while writing the growing history must not take the library it is a
history *of* with it. Each key is one complete document written with one
`setItem`, which is atomic — a refused write leaves the previous document intact
and surfaces as `storageError` on screen rather than being swallowed.

### `src/practice/` is an island too

`align`, `stats`, `range`, `target`, `midi` and `bundled` are pure: no DOM, no
storage, no imports from `src/ui` or `src/audio`. **`store.ts` is the only module
in the feature that touches `localStorage`**, and `test/practice-store.test.ts`
enforces both halves by grepping the sources (with a positive control, so it
cannot rot into a no-op). The payoff is the same as `src/dsp`'s: the aligner can
be fuzzed, the SMF parser can be driven from byte fixtures built in a test, and
none of it needs a browser to be true.

### Target sources

All three land on `addTarget()` in the store, and the model they produce is the
same `{name, source, notes: {midi, durSec}[]}` whatever they came from:

- **Recorded** — a `"target"` take through the transcriber. Works for whistling
  *and* for a piano: a real piano take comes back within a couple of cents on
  every note. **The limit is the register, and the failure is a missing note,
  not a wrong one.** The pitch search starts at 400 Hz (`minHz`), so a note
  whose fundamental is below roughly the middle of a keyboard has only its
  harmonics in band, and the clarity gate reads that as unvoiced. Measured on
  synthetic piano tones: at middle C and below, *no notes at all*; straddling
  the band edge, a correct melody with the low notes silently missing; an octave
  above middle C, exact. So the advice in the draft hint is "play it further up
  the keyboard", **not** "use the move buttons" — those are for putting a melody
  where the user wants to whistle it. Widening `minHz` is not a free fix: that
  band is why speech and hum are rejected for nothing, and it would need its own
  sweep against the golden recording.
- **MIDI** — `practice/midi.ts`, a hand-rolled SMF parser (running status,
  velocity-0 note-offs, merged tempo map for format 1, per-track for format 2,
  SMPTE divisions). Splits by track *and* channel, collapses chords to the top
  note, warns when that mattered. **The target model has no rests**: durations
  are the notes' own sounding lengths capped at the next onset, so a melody with
  a long rest plays back tighter than the file. Alignment is pitch-ordered, so
  this costs nothing in scoring.
- **Bundled** — `practice/bundled.ts`, five public-domain tunes as data,
  easiest first. One tap, no draft: they are already trimmed and named.

Recorded and MIDI melodies stop at a **draft** (`TargetDraft` in `target.ts`),
which holds the untouched notes plus a kept range and an octave shift, so
trimming is always undoable. The chips *are* the trim control — tapping one
moves the nearer end of the kept range to it, which cuts when the note is kept
and restores when it is dropped; the Drop buttons are the fine adjustment. Both
exist because a whistled take needs one note off each end and a MIDI import
needs sixty. Drafts are never persisted — restoring a half-made
target on the next launch would confront the user with notes they no longer
remember recording.

## Dev loop

```sh
npm run dev        # desktop Chrome on localhost covers ~90% of the work
npm test           # vitest run
npm run test:watch # vitest, watching
npm run build      # tsc --noEmit && vite build
npm run preview    # serve dist/ — the only way to exercise the service worker
```

`tsconfig.json` is `strict` plus `noUnusedLocals`, `noUnusedParameters` and
`noFallthroughCasesInSwitch`, and its `include` covers `src`, `test` and
`tools` — so `npm run build` typechecks the harness and the tests too.

The service worker is disabled in `npm run dev` (no `devOptions` is passed to
`VitePWA`, and the plugin defaults it off). SW behaviour is only observable via
`npm run preview` or the deployed site.

`vitest.config.ts` is standalone and loads **no plugins**: tests must never drag
in vite-plugin-pwa, which wants to emit a service worker. It runs under
`environment: "node"` with no jsdom — the `ui-*` tests stub the two or three
globals they need (`localStorage`, `window.devicePixelRatio`,
`getComputedStyle`) rather than pulling in a DOM. It also defines `__BUILD__`,
which is what makes `src/ui/debug.ts` importable from a test.

### On an Android phone

Plain `http://localhost` is a secure context, so the mic works there without
certificates. USB-connect the phone, open `chrome://inspect` on the desktop, use
**Port forwarding** to map `localhost:5173` to the dev server, then load
`http://localhost:5173` on the phone. That gives HMR, microphone access, and
full remote DevTools with no mkcert, no tunnel, no self-signed certificate.

The installed-PWA path (manifest, icons, offline, SW update) can only be tested
against the deployed site — `git push` and wait ~40–60 s.

### The debug panel

`<details id="debug">` in `index.html`, rendered by `src/ui/debug.ts`. It exists
because a laptop cannot verify the things that actually break on a phone. It
shows four rows:

- **Mic** — the granted sample rate and whether noise suppression, echo
  cancellation and gain control are really off, read from the track's
  `getSettings()`. Noise suppression is the dangerous one: speech NS treats a
  sustained pure tone as stationary noise and gates the whistle out entirely.
- **Frame** — live `clarity · snr · peak-to-second · dBFS`, plus `CLIPPED`.
  Throttled to 10 Hz, and skipped entirely while the panel is collapsed, so it
  costs nothing on the hot path.
- **Result** — note count and the tuning offset that was applied.
- **Build** — `__BUILD__` again, so a screenshot of the panel is self-contained.

The **Save recording (.wav)** button next to it is a sibling, not part of the
panel. It appears only after a *live* take (never after an import) and turns any
real-world failure into a fixture for the harness.

### fft.js interop

`fft.js` is CommonJS with `export = FFT` and no `exports` field. The default
import works because `moduleResolution: "bundler"` implies
`allowSyntheticDefaultImports`. Three legs keep the three environments honest:
`test/fft-interop.test.ts` (vitest), `tools/smoke.ts` (tsx) and the
`fftPeakBin()` self-check in `src/main.ts`, which puts the app into an error
state if the FFT backend misbehaves in a real build. If one ever breaks, fix the
build config rather than sprinkling `require` through `src/dsp`.

## Deploy

Pushing to `main` runs `.github/workflows/ci.yml`: a `test` job (`tsc --noEmit`,
`vitest run`, **and `npm run build`** — the build is the only thing that
exercises the PWA plugin, the Rollup pass and the CommonJS fft.js interop, so it
runs on PRs and branches too, on Node 24) **gates** the `deploy` job, which
publishes `dist/` to GitHub Pages. Concurrency is per job: `test` cancels
in-progress runs on the same ref, `deploy` does **not** — cancelling
`actions/deploy-pages` mid-flight can wedge the Pages deployment. Pages is
configured with `build_type=workflow`; there is no `gh-pages` branch.

`base: "./"` in `vite.config.ts` is what makes the same build work at
`/whistle-notes/`, under `vite preview`, and from a `file://` sanity check.
Absolute paths will 404 on Pages.

### Service-worker staleness

The classic footgun, and the defences are subtler than "always update".

`registerType: "prompt"`, **not** `autoUpdate`. `autoUpdate` compiles to
`window.location.reload()` the moment a new worker activates, so a deploy
landing mid-recording throws the take away with no warning. In `prompt` mode the
new worker parks itself in `waiting` and the app applies it at the first moment
a reload is free. Nothing actually prompts the user — the policy decides.

That policy is `shouldApplyUpdate()` in `src/ui/sw-update.ts`, and it is
deliberately small and tested (`test/ui-update.test.ts`):

- never while recording or playing, checked against both the store *and* the
  audio modules' own state, because a reload must lose to either;
- never in the `recording` or `analyzing` phases;
- freely in `idle` and `error`;
- in `result` only when the tab is *foregrounded*, because a finished transcript
  is a document and yanking it away while someone is reading it is rude.

`src/main.ts` wires three chances to apply a pending update: `onNeedRefresh`,
every store notification (`subscribe`), and `visibilitychange` — which also
calls `registration.update()` to poll for a new worker in the first place.
`registerSW({ immediate: true })` and the visible build stamp in the footer stay
as they are. If the deployed page shows a stamp that is not the pushed SHA, you
are looking at a cached worker, not a broken build.

Two Workbox settings that must not drift:

- `globPatterns` must keep `js`, so the unhashed `pcm-recorder.worklet.js` is
  revisioned and precached; drop it and the installed app breaks offline.
- `navigateFallback: undefined` is set **explicitly**, because the plugin
  defaults it to `index.html`. With `base: "./"` every asset URL is relative, so
  serving that page for a deeper URL resolves every script against the wrong
  directory — a blank page and a fistful of silent 404s, which is worse than the
  server's own 404. Nothing is lost: there is no client-side routing, and
  Workbox's `directoryIndex` still serves the app's own URL from the precache
  offline.
- `clientsClaim: true` so a *first* install is offline-ready without a reload;
  only updates wait for a safe moment.

## Conventions

- No ESLint or Prettier. Strict tsc is the whole quality gate; keep the build
  clean.
- Comments explain *why*, and especially why-not: the constants in
  `src/dsp/config.ts` and the rationale blocks in `src/dsp/segment.ts` are load-
  bearing documentation, not decoration.
- Commit at milestone granularity, push regularly.
