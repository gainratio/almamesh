import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * The onboarding AI step and the chat's no-AI prompt
 * (e2e/onboarding-ai-step.spec.ts), through the real onboarding UI and the real
 * in-browser engine, on desktop Chromium, desktop WebKit and an iPhone 15.
 *
 * Point ONBOARDING_AI_E2E_BASE_URL at an existing preview (CI's browserJourneys
 * lane serves its build on :4199) to skip the local build.
 */
const PORT = Number(process.env.ONBOARDING_AI_E2E_PORT ?? 4218);
const EXTERNAL_BASE_URL = process.env.ONBOARDING_AI_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /onboarding-ai-step\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 420_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "iphone-15-webkit", use: { ...devices["iPhone 15"] } },
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
