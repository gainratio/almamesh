import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * Portable-state invariants: every entity a user can create must survive
 * Export -> Import into a fresh browser (new OPFS root), in Chromium AND WebKit.
 *
 * Production build + vite preview, like playwright.portable-sqlite.config.ts:
 * the engine and SQLite module Workers only load from a build, and preview
 * applies the real CSP and COOP/COEP headers from public/_headers.
 *
 * The build is hooked (VITE_EXIT_GATE_HOOKS=1), like the hooked build every
 * Dagger browser shard serves: the Day-pin round-trip reads
 * window.__almameshPinnedThreads.
 *
 * Dagger passes its own preview through PORTABLE_INVARIANTS_E2E_BASE_URL and
 * picks a browser with `--project`. Locally the config builds and serves.
 */
const PORT = Number(process.env.PORTABLE_INVARIANTS_E2E_PORT ?? 4208);
const EXTERNAL_BASE_URL = process.env.PORTABLE_INVARIANTS_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /portable-invariants\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  // The full journey boots the ~38 MB engine twice and drives ~30 screens.
  timeout: 600_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    acceptDownloads: true,
    actionTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    // An iPhone: the export/import journeys at phone size with an iOS UA.
    // The Day pin is full-tier only and iOS is always the minimal tier
    // (packages/browser/src/deviceTier.ts), so that journey does not exist on
    // an iPhone and is not run there.
    { name: "iphone-webkit", use: { ...devices["iPhone 13"] }, grepInvert: /a Day pin with a place/ },
  ],
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
