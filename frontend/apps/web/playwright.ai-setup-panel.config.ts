// frontend/apps/web/playwright.ai-setup-panel.config.ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

/**
 * Settings → AI visual + egress gate for the shared AiSetupPanel (PR 1).
 *
 * Hooks-OFF production build (the real app, no exit-gate hooks) served by
 * `vite preview`. Baselines live in gitignored `shots/`: capture them from the
 * pre-change code with `--update-snapshots`, then run without it after the
 * change; any pixel difference fails. The iPhone 15 WebKit project needs macOS
 * (see e2e/webkitProfile.ts) and blocks the service worker so page.route stubs
 * are not bypassed.
 *
 * Run:  bun run test:e2e:ai-panel
 */
const PORT = Number(process.env.AI_PANEL_E2E_PORT ?? 4189);
const BASE_URL = process.env.AI_PANEL_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /ai-setup-panel\.spec\.ts/,
  snapshotPathTemplate: '{testDir}/../shots/pr1-ai-setup-panel/baseline/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled', caret: 'hide' } },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { baseURL: BASE_URL, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone-15-webkit', use: { ...devices['iPhone 15'], serviceWorkers: 'block' } },
  ],
  webServer: {
    command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    cwd: __dirname,
  },
});
