import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * Reload-durability journey (e2e/chart-durable-reload.spec.ts).
 *
 * Onboards (and rectifies) through the real UI, reloads the moment /dashboard
 * appears, and proves the chart is still there. Real in-browser engine on a
 * persistent profile in Chromium and WebKit. A production build is required.
 * RELOAD_DELAYS (default "0") lists the reload delays in ms. Point
 * CHART_RELOAD_E2E_BASE_URL at an existing preview to skip the local build.
 */
const PORT = Number(process.env.CHART_RELOAD_E2E_PORT ?? 4212);
const EXTERNAL_BASE_URL = process.env.CHART_RELOAD_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /chart-durable-reload\.spec\.ts/,
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
