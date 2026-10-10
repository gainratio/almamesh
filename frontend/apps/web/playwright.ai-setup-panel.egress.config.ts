// frontend/apps/web/playwright.ai-setup-panel.egress.config.ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { ENSURE_DEV_ASSETS } from './e2e/ai-setup-panel.devAssets';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

/**
 * Settings → AI egress gate: "Your key stays on this device and goes only to
 * the provider you choose." Chromium only, no screenshots, so it runs in CI
 * (Dagger `browserSuites`, against the lane's hooked build via
 * AI_PANEL_EGRESS_E2E_BASE_URL). The pixel half is playwright.ai-setup-panel.config.ts
 * (local-only; its baselines are gitignored).
 *
 * Locally it builds and previews the hooks-off production build itself,
 * regenerating missing dev assets first.
 *
 * Run:  bun run test:e2e:ai-panel:egress
 */
const PORT = Number(process.env.AI_PANEL_EGRESS_E2E_PORT ?? 4190);
const EXTERNAL_BASE_URL = process.env.AI_PANEL_EGRESS_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /ai-setup-panel\.(egress|recorder)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: BASE_URL, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `${ENSURE_DEV_ASSETS} && VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 600_000,
        cwd: __dirname,
      },
});
