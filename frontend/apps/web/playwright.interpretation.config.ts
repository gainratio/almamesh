import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Dedicated Playwright config for the structured-interpretation "human test".
 *
 * WHY a separate config (mirrors playwright.ai-settings.config.ts):
 *   This gate boots the REAL in-browser Pyodide engine (the exit-gate harness
 *   proves charts generate there), seeds a real Delhi chart, and drives the
 *   dashboard with a STUBBED OpenAI-compatible LLM (page.route). It is
 *   self-contained: it builds a production bundle and serves it via
 *   `vite preview` — NO auth, NO backend.
 *
 * WHY a build+preview (not `vite dev`):
 *   The app's module Workers (Pyodide chart worker) only RESOLVE in a production
 *   build — `vite dev`'s ESM module workers fail to resolve the `pyodide` import
 *   in worker scope. The build MUST also set `VITE_EXIT_GATE_HOOKS=1` so the
 *   `window.__almameshGenerate` / `window.__ALMAMESH_STAGE__` observability
 *   hooks exist for chart seeding (same gate the exit-gate script relies on).
 *
 * Run:  bun run test:e2e:interp   (from apps/web)
 */

const PORT = Number(process.env.INTERP_E2E_PORT ?? 4191);
// A Dagger lane that already serves the hooked build passes INTERP_E2E_BASE_URL;
// then this suite drives it instead of rebuilding the same bundle.
const EXTERNAL_BASE_URL = process.env.INTERP_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Only this spec — keep the gate fast and decoupled from the legacy suite.
  testMatch: /interpretation\.spec\.ts/,
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
        // This suite is a release gate for the production bundle. Reusing a local
        // preview can silently exercise stale assets after source changes.
        reuseExistingServer: false,
        timeout: 240_000,
        cwd: __dirname,
      },
});
