import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * Time-travel journeys (e2e/time-travel.spec.ts, spec 2026-10-08 Inc A): a
 * dated question typed into plain Dashboard chat, a stubbed provider that
 * calls get_timing with dates, and the REAL in-browser engine.
 *
 * Point TIME_TRAVEL_E2E_BASE_URL at an existing preview (CI's browserJourneys
 * lane serves its hooked build on :4199) to skip the local build.
 */
const PORT = Number(process.env.TIME_TRAVEL_E2E_PORT ?? 4216);
const EXTERNAL_BASE_URL = process.env.TIME_TRAVEL_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /time-travel\.spec\.ts/,
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
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  // Build with the exit-gate hooks ON (bootEngine/seedChart need
  // window.__almameshGenerate), as CI's hookedBuild() does, then serve it.
  // `VITE_API_URL=` keeps the app in zero-backend mode.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 300_000,
        cwd: __dirname,
      },
});
