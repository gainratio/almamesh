import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Task 16 — Phase-2 wizard live-validation config.
 *
 * Validates the /rectify/:profileId wizard end-to-end using the project's
 * standard Playwright + Pyodide boot infrastructure (VITE_EXIT_GATE_HOOKS=1
 * build, same as all other AlmaMesh e2e specs). The wizard itself is the real
 * production code; only the chart-seeding step uses the hook.
 *
 * Run:  bun run playwright test --config=playwright.wizard-phase2.config.ts
 */

const PORT = Number(process.env.WIZARD_E2E_PORT ?? 4195);
// A Dagger lane that already serves the hooked build passes WIZARD_E2E_BASE_URL;
// then this suite drives it instead of rebuilding the same bundle.
const EXTERNAL_BASE_URL = process.env.WIZARD_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /wizard-phase2\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // The engine boot + rectification compute can take 90–120s.
  timeout: 300_000,
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
  // Build with exit-gate hooks so bootEngine + seedChart work, then preview.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        cwd: __dirname,
      },
});
