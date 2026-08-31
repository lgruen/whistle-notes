# Whistle Notes

Whistle a melody into your phone and get back the piano notes to play. A
small, fully client-side PWA for beginner pianists: it listens, tracks the
pitch of your whistle, snaps it to the nearest semitones, and shows you the
result as note names, a piano roll, and a rhythm-free staff you can play back
to check by ear. Nothing is uploaded — there is no backend, and the audio
never leaves the device.

**Live: <https://lgruen.github.io/whistle-notes/>**

## How it works

_Coming soon._ This section will explain the algorithm end to end — why a
whistle is unusually easy to track, how the windowed FFT and parabolic peak
interpolation turn air into a frequency, and how the segmentation state
machine turns a wobbly frequency trail into discrete notes — with diagrams and
a figure built from a real recording.

## Development

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # vitest
npm run build   # tsc --noEmit && vite build
```

See [CLAUDE.md](CLAUDE.md) for the repository layout and maintainer notes.

## License

[MIT](LICENSE)
