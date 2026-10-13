import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * Safari Private Browsing (OPFS refused) runs on in-memory SQLite with an
 * honest notice, never the block screen (e2e/private-mode.spec.ts). The webkit
 * project uses Playwright's default ephemeral context, which refuses OPFS the
 * way a Safari private window does.
 *
 * Point PRIVATE_MODE_E2E_BASE_URL at an existing hook-free preview to skip
 * the local build.
 */
const PORT = Number(process.env.PRIVATE_MODE_E2E_PORT ?? 4218);
const EXTERNAL_BASE_URL = process.env.PRIVATE_MODE_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /private-mode\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 120_000,
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
        command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 300_000,
        cwd: __dirname,
      },
});
