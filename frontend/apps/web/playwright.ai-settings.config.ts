import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Dedicated Playwright config for the AI / OpenRouter settings e2e gate.
 *
 * WHY a separate config (not the SaaS-era `playwright.config.ts`):
 *   The legacy config still wires Supabase auth (`global.setup.ts` +
 *   `auth.setup.ts`), points at `bun run dev` on :3000, and drives
 *   authenticated dashboard flows — all dead infrastructure for the current
 *   local-first, no-backend app. This config is self-contained: it builds a
 *   production bundle and serves it via `vite preview` (mirroring the proven
 *   `scripts/verify-exit-gate.mjs` harness), with NO auth and NO mocks.
 *
 * WHY a build+preview (not `vite dev`):
 *   The app's module Workers only resolve in a production build. This test does
 *   does not touch the chart engine, but it does exercise the canonical OPFS
 *   SQLite adapter. The production build therefore keeps the harness identical
 *   to the shipped runtime and avoids the dev-server Worker-resolution caveat.
 *
 * Run:  bun run test:e2e:ai   (from apps/web)
 */

const PORT = Number(process.env.AI_E2E_PORT ?? 4188);
const BASE_URL = process.env.AI_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Only this spec — keep the gate fast and decoupled from the legacy suite.
  testMatch: /ai-settings\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
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
  // Build a production bundle, then serve it. `VITE_API_URL=` keeps the app in
  // its zero-backend mode (no SaaS egress). reuseExistingServer lets a dev
  // iterate against an already-running `vite preview` on the same port.
  webServer: {
    command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    cwd: __dirname,
  },
});
