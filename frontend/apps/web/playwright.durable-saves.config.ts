import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Durable saves — live-journey config.
 *
 * Each journey makes a save the app then reports as done (the AI key's
 * status badge, a finished chat turn) and does a full page load straight
 * away. The data must still be there. The chat journey seeds a real chart, so
 * this needs the hooked build (window.__almameshGenerate).
 *
 * Run:  bun run test:e2e:durable-saves
 */

const PORT = Number(process.env.DURABLE_SAVES_E2E_PORT ?? 4197);
// A Dagger lane that already serves the hooked build passes DURABLE_SAVES_E2E_BASE_URL.
const EXTERNAL_BASE_URL = process.env.DURABLE_SAVES_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /durable-saves\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // The cold engine boot can take ~60-90s under headless Chromium.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        cwd: __dirname,
      },
});
