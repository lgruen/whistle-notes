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

Notes get written out in exactly two places, and both boundaries are worth
stating precisely.

**A draft is a transcript under review; a target is a melody you are about to be
asked for.** The draft screen (`src/ui/practice.ts`) names its chips because
that is the only moment the user can catch the *app* being wrong — a scoop that
became a note, or the octave error the detector makes on the deepest piano keys
— and because the trim and move controls would otherwise have nothing to aim at.
The moment it is saved, the library, the detail screen and every exercise say
only its name, its length and its source.

**A prompt is not a report.** After an attempt, names and interval words are
allowed: they describe something already whistled. The recall result screen uses
that licence, and holds to a narrower line of its own that is easier to keep
than a judgement call — **the app names what you did, never what it wanted.** A
wrong note and an extra note are named; a missed slot, and the ghost behind every
target rectangle, are drawn as a position and a distance. So the melody's own
notes are never spelled out on a screen with a Try-again button two inches below
it. The screen *before* an attempt shows nothing whatsoever: no roll, no staff,
no name, no "starts on a low note" hint.

`test/practice-ui.test.ts` enforces all of this against the real copy, not
against intent: it greps the practice half of `index.html` and the exported
sentences of `src/ui/practice.ts` for pitch names and interval words, checks
every string the pre-attempt recall screen writes, and pins both boundaries from
both sides. If you add copy there, it has to pass — which also means avoiding the
word "octave" (say "higher"/"lower") and "seconds" (write `2.1 s`) in
practice-mode strings. The exempt strings are the ones only reachable after an
attempt: `transpositionText`, `takeawayText` and the verdict chips in
`practice/recall.ts`.

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
                      draft, MIDI picker, range, target detail, the two drills
                      #practice-hold and #practice-echo, the follow-along
                      #practice-follow, and the two halves of an echo exercise:
                      #practice-recall / #practice-echo before an attempt and
                      the shared #practice-result after it), plus the dock with
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
                      stats (+ attempt history + hold averages), range, target
                      (+ drafts), recall (the exercise: playback layout, diff
                      overlay layout, verdict strip, the sentences), drill (the
                      two echo drills: seeded RNG, hold scoring, the adaptive
                      phrase generator), follow (warm-up layout + timing), midi
                      (SMF parser), bundled (starter melodies), store (the only
                      storage)
  audio/              browser-only: capture (mic + worklet), decode (file
                      import), synth (playback voices), wav-export (debug
                      download)
  ui/                 controls state theme live notelist pianoroll diffroll
                      followroll holdmeter staff debug sw-update practice
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
                      diagnosis engine, the store, the sources, the recall
                      exercise, the drills, the warm-up and the screens)
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

The second half of the app: a library of target melodies, and the exercises
that play them at you and score what comes back. See the ear-first hard rule
above before touching any of its copy.

Four exercises, and they are deliberately not four flavours of the same thing —
each removes a different cause of failure so the remaining one can be measured:

| exercise | screen | asks | writes |
| --- | --- | --- | --- |
| Melody recall | `recall` → `result` | memory + intervals + production | interval ledger + per-target history |
| Hold a note | `hold` | production alone | two hold averages |
| Echo a phrase | `echo` → `result` | intervals, memory removed | interval ledger only |
| Follow along | `follow` | nothing — a warm-up | nothing |

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
recorded as a target, an attempt at one — goes through the same `startRecording`
/ `stopRecording` / `transcribe()` path in `src/main.ts`. The only thing that differs is where the
notes go afterwards, and that is carried by one variable:

```ts
type TakeIntent =
  | "transcribe" | RangeStep | "target" | "attempt" | "hold" | "echo" | "follow";
```

It is **read once, when the analysis is scheduled**, so a mode switch or a fresh
tap mid-analysis cannot redirect a take already in flight. Every failure path
(start refused, session interrupted, no audio captured, segmenter crash) routes
by intent through `practiceTakeFailed`, because the transcriber's message line is
not on screen in practice mode — and each of those store calls also clears the
flag the screen uses to decide whether a Stop button belongs over an open
microphone. If you add a new kind of take, add an arm here; do not fork the
record path — and add a `TAKE_SUBJECTS` entry, which is exhaustive over the
intents so a new one has to say what it is about.

`"follow"` is the one arm that never reaches `analyze`: `finishRecording` drops
its samples outright, because the warm-up scores nothing and a minute of FFTs
for a screen that never had a result is pure heat.

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

Adding the per-attempt history to the stats document **did not bump its
version**, deliberately: the field is additive, a build that predates it ignores
it, and a bump would have made that build discard the lifetime counts as well.
Losing the recent rows is a disappointment; losing a year of practice is not.

### `src/practice/` is an island too

`align`, `stats`, `range`, `target`, `recall`, `midi` and `bundled` are pure: no
DOM, no storage, no imports from `src/ui` or `src/audio`. **`store.ts` is the
only module in the feature that touches `localStorage`**, and
`test/practice-store.test.ts` enforces both halves by grepping the sources (with
a positive control, so it cannot rot into a no-op). The payoff is the same as
`src/dsp`'s: the aligner can be fuzzed, the SMF parser can be driven from byte
fixtures built in a test, and none of it needs a browser to be true.

`recall.ts` is the sharpest case: it lays a melody out for the synth it may not
import and lays a diff out on a canvas it may not touch. Both work by
**structural** types rather than shared imports — `PlayableNote` in
`audio/synth.ts` is the four fields playback reads, and `HeardNote` in
`recall.ts` is the five fields a transcription already has — so `result.notes`
goes straight into the aligner and the overlay with no adapter anywhere, and the
arithmetic stays checkable without a browser.

### Melody recall (T3)

From a target's detail screen, "Practice this" opens `screen: "recall"`, which is
two elements switched on `recall.attempt`: `#practice-recall` before the attempt
and `#practice-result` after it. One `RecallSession` lives in the practice store
and is never persisted; the history it produces is.

**The melody is transposed into the whistler's range once, in `beginRecall`**,
and that array is what the synth plays, what `alignAttempt` scores against, and
what `recordAttempt` reads its intervals from. This is the load-bearing line of
the whole exercise: scoring against the written pitch while playing the
transposed one would report a register error the app itself introduced. A range
measured again mid-session deliberately does not change what the user already
heard.

Playback goes through the same `startPlayback` the transcriber uses, at the
stored voice preference (its toggle lives in the dock, which practice mode
hides). Targets carry durations and no start times, so `targetPlayback` lays them
end to end with an **80 ms gap** — without it two identical notes in a row are
one long note, and the app asks for a melody it did not play. Listening is
optional and unlimited: the difficulty knob is the user's own, and the count is
reported without a word of judgement.

**The diff overlay** (`ui/diffroll.ts` draws, `practice/recall.ts` lays out) is a
piano roll in the *attempt's* register, and its whole claim is one vertical
distance: *at this moment you were here, and the melody wanted you there.*

- The x axis is the attempt's own clock, and each target slot is drawn as a ghost
  outline occupying **the span of the note that answered it**. That is what lets
  the measured pitch trail — the layer that tells a badly-aimed note from a scoop
  that never settled — share the picture with the diff.
- Every pitch has the alignment's `transposition` *subtracted*, so a melody
  echoed a 5th up is drawn where the user should have whistled it rather than
  moved somewhere they never sang. The alignment's `offsetCents` comes off with
  it, for the same reason and one more: the verdicts were decided around that
  reference, so a ghost drawn without it would put a row of ✓ chips over a
  picture of every note sitting above its box.
- Slots nobody sang have no span to borrow, so they are wedged into the silence
  between their neighbours and allowed to overhang it slightly — reading as
  squeezed in between, which is truer than being hidden.
- Verdict colours come from the stylesheet's custom properties (`--accent`,
  `--warn`, `--danger`) through `ui/theme.ts`, so the canvas and the verdict
  chips are one palette in both themes. `--warn` is warm rather than red because
  forty cents flat is the normal condition of a beginner's whistle.

**The history**, per target, is `TargetTally.history`: the last
`MAX_ATTEMPT_HISTORY` (20) attempts, newest first, each as its verdicts in order.
It exists because a sum cannot answer the question that matters — three wrong
notes across ten attempts and three in one disastrous attempt add up identically.
The detail screen draws them as strips, and the shape answers it at a glance: the
same cell red six times is a trouble spot, a different cell each time is ordinary
bad luck. `troubleSpots()` needs **two** failures at a slot before it says a
word, because an app that announced one after a single miss would be reporting
noise. Both the history and the slot tallies reset when the target's note count
changes, since slot 4 of a five-note melody is a different place from slot 4 of a
three-note one.

Stats are recorded **only on a completed attempt**. A take the app heard nothing
in gets a friendly retry and no row: it is not evidence about the whistler, and a
phantom failure in the heatmap is worse than no data at all.

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

### The echo drills (T4)

Both open from the library and neither needs a target. `src/practice/drill.ts` is
pure and takes an **injected `Rng`** — the impure `Math.random` default lives in
`store.ts`, where the rest of the platform does — which is what makes a phrase
reproducible from a seed and the adaptive bias measurable in a test rather than
by eye.

**Hold a note.** A reference plays for 2.5 s, then *stops*, and the user holds it
back into silence: there is no echo cancellation anywhere in this app, so a
reference still sounding would be measured as part of the take. While the take
runs, `ui/holdmeter.ts` drives a needle centred on **the reference**, not on the
nearest semitone — the transcriber's readout would snap to the note below for
someone 60 cents flat and then congratulate them at +40. The bar spans ±100 cents
rather than the transcriber's ±50, because a beginner's first holds land 40–80
cents out and a needle jammed against the wall shows no improvement.

`scoreHold` takes the longest continuously-voiced stretch, drops the first 25% (a
whistle *scoops* into its note; including the approach reports a hold as flat),
and reports the median offset and half the interquartile range. Median and IQR
because one cracked frame where the breath ran out would move a mean by tens of
cents and a standard deviation by hundreds.

**The trail must be uncorrected**: `applyHoldTake` calls
`trailFromFrames(frames, 0)`, deliberately dropping the take's global tuning
offset. That correction exists to rescue a consistently-sharp whistler from
coin-flip note names, and it works by measuring exactly the bias this drill
reports. Pass it in and the drill congratulates the person it is supposed to be
diagnosing. There is a test named after this.

**...and so must recall's** (decision, 2026-09-01). `applyAttemptTake` and
`applyEchoTake` put the correction *back* on with `undoTuningCorrection` before
they align, and build their trail with a zero offset to match. Two reasons, and
the second is the one that made it urgent:

1. Handed corrected notes, the aligner measures residuals the DSP has already
   removed — a flawless score for someone 45 cents sharp on every note, from the
   same take the hold drill calls 45 cents sharp.
2. The DSP's correction is **gated** on concentration, so it stops firing
   somewhere around ±25 cents of jitter. That was a scoring cliff: seven clean
   notes on one side of it, two clean and one wrong with 48-cent residuals on
   the other, from whistling that changed by ten cents.

`align.ts` then estimates the reference itself, continuously (`offsetCents` — a
tapered mean of the paired residuals, no gate anywhere), scores the shape around
it, and the result screen says so in a sentence. So **recall scores shape and
the deviation around the whistler's own reference; the hold drill scores
absolute aim** — and both describe the number through `distanceText`, so 45
cents is "45 cents sharp" wherever the app says it.

**Echo a phrase.** `echoPhrase` walks the drill register in steps drawn from
weighted candidates: ±1–4 semitones common, ±5–7 occasional, ±8–12 rare. The
third tier is a deliberate extension of the original plan sketch, which stopped
at 7 — this user's measured weaknesses are 3rds, 6ths and 7ths, and a 6th is nine
semitones, so a generator that stopped there could never once drill the thing it
exists for.

`stepWeights` multiplies a weak interval's weight by `1 + 3 × weakness`
(`intervalWeakness` tops out near 1.5, so ×5.5 at worst). It is a **bias, not a
filter**, and the fallback is not a branch: with no history every multiplier is 1
and the generator is exactly the plain random walk. A test asserts that as an
*identity* on seeded output, so a second code path cannot appear unnoticed.
`ECHO_MIN_OBSERVATIONS` (5) is higher than `weakestIntervals`' own default,
because a drill that decided your rising 4th is a weakness after two unlucky
attempts would keep asking for it for a week.

The ramp moves one note per attempt inside 3–6, and counts `clean` **or** `off`
as a success: demanding 30-cent accuracy from a beginner's whistle before the
phrase grows would mean it never moved. Aim is the other drill's question.

**One ledger.** `foldIntervals` in `stats.ts` is the only place directed-interval
statistics are written, and both `recordAttempt` (recall) and `recordDrillAttempt`
(the drill) go through it. This matters more than it looks: the drill *reads those
same numbers back* to choose the next phrase, so a second accumulator with its
own idea of what a `missing` slot means would show up as a drill quietly
practising the wrong thing for months without ever throwing. A generated phrase
keeps **no** per-slot history — a heatmap of "the third note of whatever it was"
is not a fact about anything.

The hold drill's two EWMAs live in `PracticeStats.holds` and were added
**without a version bump**, for the reason `history` was: the field is additive,
and a bump would make an older build discard a year of interval statistics rather
than ignore four numbers.

### Follow along (T5), and the one place the mic/speaker rule is broken

`startPlayback` refuses while the microphone is open, enforced at the resource
rather than by a disabled button. The warm-up needs both, so it calls a
*different* exported function — `startPlaybackOverMicrophone` — chosen over a
flag so the exemption is greppable and provably has one caller.

What makes it safe is not anything the synth does. The microphone really does
hear the speaker. It is what the caller does with the audio: **nothing**. No
transcription, no alignment, no statistics; `finishRecording` drops the samples
on the `"follow"` intent. The worst the echo can do is trace the melody faintly
under the user's own line, and the screen says so and suggests headphones. **If
follow-along ever grows a score, the exemption has to go with it** — that is
written on both sides of the call.

Device caveat, untested rather than asserted: two `AudioContext`s coexist fine on
Android, but on iOS the audio session is still record-capable while the mic is
open, which is what the earpiece-routing trap actually keys off. A warm-up may
come out quiet on an iPhone.

**One clock.** The playhead runs on the animation clock offset by
`PLAYBACK_LEAD_SEC`, and each trail point is placed wherever the playhead is that
frame, carrying whatever pitch the microphone last reported. So the trail lags by
the analysis latency (a 43 ms window plus a block or two) and nothing has to
reconcile the capture context's clock with the playback context's. That trade is
only honest because nothing here is measured.

The roll is **fixed with a moving playhead** rather than scrolling: to show a
note early enough to prepare for it, a scrolling window would have to be about
two seconds wide at phone width, and then there is nothing to anticipate beyond
two seconds — which is the opposite of what a warm-up wants.

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
