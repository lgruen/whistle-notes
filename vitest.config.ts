import { defineConfig } from "vitest/config";

// Deliberately standalone: no `plugins`, so vitest never instantiates
// vite-plugin-pwa (which wants to emit a service worker) just to run pure
// functions. Tests run in a plain node environment with no jsdom: the src/ui
// and src/audio tests stub the few browser globals they need themselves.
export default defineConfig({
  define: { __BUILD__: JSON.stringify("test") },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
