import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Dedicated Playwright config for the SELF-HEAL real-integration gate.
 *
 * Mirrors playwright.interpretation.real.config.ts (build + preview the
 * production bundle with VITE_EXIT_GATE_HOOKS=1 so window.__almameshGenerate
 * exists), but runs interpretation.heal.real.spec.ts — which seeds the STALE
 * `anthropic/claude-3.5-sonnet` config the user had, then proves the app
 * self-heals it to the recommended model (`openai/gpt-6-luna`) and renders a real reading
 * against a LIVE OpenRouter endpoint.
 *
 * Runs on its own port (4174) so it never collides with the other real config.
 *
 * IMPORTANT: OPENROUTER_API_KEY is read from the parent shell env (Playwright
 * forwards it to the test process automatically). It is NOT in webServer.env and
 * is NOT a VITE_ var, so the key is never bundled into the app.
 *
 * Run:  bun run test:e2e:interp:heal:real   (from apps/web)
 */

const PORT = Number(process.env.INTERP_HEAL_E2E_PORT ?? 4174);
const BASE_URL = process.env.INTERP_HEAL_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /interpretation\.heal\.real\.spec\.ts/,
  // The engine boot (Pyodide + OPFS bundle sync) is heavy; one worker at a time
  // keeps OPFS/IndexedDB state from colliding across parallel contexts.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // Cold engine boot + a live (possibly slow) LLM round-trip per section.
  timeout: 600_000,
  expect: { timeout: 180_000 },
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
  // OPENROUTER_API_KEY is intentionally NOT listed here — it stays in the parent
  // shell env (forwarded to the test process) and must never be bundled.
  webServer: {
    command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 300_000,
    cwd: __dirname,
  },
});
