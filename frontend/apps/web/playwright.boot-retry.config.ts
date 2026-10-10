import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * One automatic engine boot retry, driven live (e2e/boot-retry.spec.ts): the
 * exit-gate switch makes the FIRST boot's Pyodide Worker throw a real
 * WebAssembly RuntimeError, and the real onboarding must still reach a chart.
 *
 * Point BOOT_RETRY_E2E_BASE_URL at an existing hooked preview (CI's
 * browserJourneys lane serves one on :4199) to skip the local build.
 *
 * Chromium runs in CI. WebKit needs an on-disk profile with working OPFS,
 * which Linux Playwright WebKit cannot open, so the webkit project runs on
 * macOS (locally, or a macOS lane).
 */
const PORT = Number(process.env.BOOT_RETRY_E2E_PORT ?? 4217);
const EXTERNAL_BASE_URL = process.env.BOOT_RETRY_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /boot-retry\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // No retries: the property under test IS a retry; a second run would hide a miss.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 240_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"], serviceWorkers: "block" } },
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
