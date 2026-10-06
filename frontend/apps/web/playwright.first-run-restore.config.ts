import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * First-run restore (e2e/first-run-restore.spec.ts): a person moving to a new
 * browser restores their backup from the landing page, before ever creating a
 * chart, and lands on the dashboard.
 *
 * Real onboarding in browser A (real engine), real export, then a brand-new
 * persistent profile that has never loaded AlmaMesh. A production build is
 * required (the Pyodide + SQLite module Workers only resolve there). Point
 * FIRST_RUN_RESTORE_E2E_BASE_URL at an existing preview to skip the build.
 */
const PORT = Number(process.env.FIRST_RUN_RESTORE_E2E_PORT ?? 4213);
const EXTERNAL_BASE_URL = process.env.FIRST_RUN_RESTORE_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /first-run-restore\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 480_000,
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
