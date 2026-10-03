import { defineConfig } from "vitest/config";

// `@gainratio/browser` is an exact-Git-SHA package with compiled ESM exports.
// The consumer-owned `?worker` entry is transformed by Vite/Vitest normally.
export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
  },
});
