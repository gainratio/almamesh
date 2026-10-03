import { defineConfig } from "vitest/config";

// `@almamesh/browser` consumes the compiled, exact-SHA `@gainratio/browser`
// package, so no workspace aliases are needed here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
