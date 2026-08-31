import { defineConfig } from "vitest/config";

// Deliberately standalone: no `plugins`, so vitest never instantiates
// vite-plugin-pwa (which wants to emit a service worker) just to run pure
// functions. Tests only ever exercise src/dsp, src/notes, test/ and tools/ —
// all of which are plain TypeScript with no browser dependencies.
export default defineConfig({
  define: { __BUILD__: JSON.stringify("test") },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
