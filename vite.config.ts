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
      registerType: "autoUpdate",
      workbox: {
        // `js` matters: public/pcm-recorder.worklet.js is copied through
        // unhashed, so it only gets a precache revision (and therefore works
        // offline, and updates when it changes) if the glob catches it.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        navigateFallback: "index.html",
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
