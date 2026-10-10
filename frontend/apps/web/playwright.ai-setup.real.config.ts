import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

/**
 * REAL (unstubbed) key test for the shared AI setup panel. Hooks-off build; no
 * chart is generated. OPENROUTER_API_KEY is read by the test process from the
 * parent env and is never bundled into the app. Part of the nightly
 * (NIGHTLY_REPORTED_E2E "ai:real"): a skip there fails the nightly.
 *
 * Run:  bun run test:e2e:ai:real
 */
const PORT = Number(process.env.AI_REAL_E2E_PORT ?? 4190);
const BASE_URL = process.env.AI_REAL_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /ai-setup-panel\.real\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 180_000,
  use: { baseURL: BASE_URL, headless: true, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    cwd: __dirname,
  },
});
