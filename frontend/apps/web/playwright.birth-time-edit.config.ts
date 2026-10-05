import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * Settings → Profile birth-time edit journey (e2e/birth-time-edit.spec.ts).
 *
 * Onboards through the real UI, edits ONLY the birth time in Settings, and
 * proves the screen never says "Chart Updated!" unless the stored chart really
 * changed — then runs an Export to prove the dataset is still exportable.
 *
 * Real in-browser engine, no LLM, no key. A production build is required
 * (the Pyodide + SQLite module Workers only resolve there). Point
 * BIRTH_TIME_E2E_BASE_URL at an existing preview (or at production for the
 * old → new live smoke) to skip the local build.
 */
const PORT = Number(process.env.BIRTH_TIME_E2E_PORT ?? 4211);
const EXTERNAL_BASE_URL = process.env.BIRTH_TIME_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /birth-time-edit\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 420_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    acceptDownloads: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 300_000,
        cwd: __dirname,
      },
});
