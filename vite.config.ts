import { execSync } from "node:child_process";
import process from "node:process";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Visible build stamp: the one-glance answer to "is the browser running the
// code I just pushed, or a stale service-worker cache?". CI has the SHA in the
// environment; locally we ask git; if neither works we're in a tarball.
function buildStamp(): string {
  const ci = process.env.GITHUB_SHA?.slice(0, 7);
  if (ci) return ci;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

// Served from https://lgruen.github.io/whistle-notes/ — a relative base keeps
// dev, `vite preview` and the Pages subpath all working with one config.
export default defineConfig({
  base: "./",
  build: { target: "es2022", sourcemap: true },
  define: { __BUILD__: JSON.stringify(buildStamp()) },
  plugins: [
    VitePWA({
      /*
       * `prompt`, not `autoUpdate` — and nothing actually prompts.
       *
       * `autoUpdate` compiles to `window.location.reload()` the moment a new
       * worker activates. A deploy landing while the user is whistling would
       * then throw the take away mid-recording, with no warning and no way to
       * get it back. In `prompt` mode the new worker parks itself in `waiting`
       * and `main.ts` applies it at the first moment a reload is free (idle or
       * a finished result, nothing playing). Same freshness, no lost takes.
       */
      registerType: "prompt",
      workbox: {
        // `js` matters: public/pcm-recorder.worklet.js is copied through
        // unhashed, so it only gets a precache revision (and therefore works
        // offline, and updates when it changes) if the glob catches it.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        // First install still takes over immediately, so the app is offline-
        // ready without a reload; only *updates* wait for a safe moment.
        clientsClaim: true,
        /*
         * No `navigateFallback` — and it has to be turned off explicitly,
         * because the plugin defaults it to `index.html`.
         *
         * With `base: "./"` every asset URL in index.html is relative, so
         * serving that page for a deeper URL — a mis-shared or mistyped
         * `…/whistle-notes/foo/` — resolves every script and stylesheet against
         * the wrong directory. The result is a blank page with a fistful of
         * silent 404s, which is a far worse answer than the server's own 404.
         *
         * Nothing is lost: this is a single-page app with no client-side
         * routing, and the app's own URL is served straight out of the precache
         * (Workbox's `directoryIndex` maps `…/` to the precached `index.html`),
         * so an offline reload still works.
         */
        navigateFallback: undefined,
      },
      manifest: {
        name: "Whistle Notes",
        short_name: "Whistle",
        description: "Whistle a melody, see the piano notes to play",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#0e1116",
        background_color: "#0e1116",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});
