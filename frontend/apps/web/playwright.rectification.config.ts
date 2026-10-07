import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Dedicated Playwright config for the birth-time-rectification "human test"
 * (e2e/rectification.spec.ts). Mirrors playwright.interpretation.config.ts.
 *
 * WHY a separate config: this gate boots the REAL in-browser Pyodide engine,
 * seeds a real Bengaluru reference chart as the primary, opens /settings/profile,
 * and drives the LIVE Ascendant preview by nudging the rectified time. It uses
 * NO LLM — the preview calls the chart engine only — so it is deterministic and
 * keyless (CI-safe). Self-contained: builds a production bundle, serves it via
 * `vite preview`. NO auth, NO backend, NO API key.
 *
 * WHY build+preview (not `vite dev`): the Pyodide chart Worker only resolves in
 * a production build, and VITE_EXIT_GATE_HOOKS=1 exposes window.__almameshGenerate
 * / window.__ALMAMESH_STAGE__ for booting + seeding (same gate the exit-gate uses).
 *
 * Run:  bun run test:e2e:rectification   (from apps/web)
 */

const PORT = Number(process.env.RECTIFY_E2E_PORT ?? 4193);
// A Dagger lane that already serves the hooked build passes RECTIFY_E2E_BASE_URL;
// then this suite drives it instead of rebuilding the same bundle.
const EXTERNAL_BASE_URL = process.env.RECTIFY_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Only this spec — keep the gate fast and decoupled from the legacy suite.
  testMatch: /rectification\.spec\.ts/,
  // The engine boot (Pyodide + OPFS bundle sync) is heavy; one worker at a time
  // keeps OPFS/IndexedDB state from colliding across parallel contexts.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // The cold engine boot can take ~60-90s under headless Chromium.
  timeout: 180_000,
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
  // Build with the exit-gate hooks ON (so window.__almameshGenerate exists),
  // then serve the bundle. `VITE_API_URL=` keeps the app in zero-backend mode.
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
