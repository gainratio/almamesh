import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PORT = Number(process.env.REPORT_REGRESSION_PORT ?? 4191);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * PR 2 live regression: a NO-HOOKS production build, the real onboarding
 * journey, then the dashboard reading against a stubbed provider. WebKit
 * needs macOS and an on-disk profile (e2e/webkitProfile.ts); its service
 * worker is blocked so page.route sees the provider calls.
 *
 * Run:  bun run test:e2e:report:regression   (from apps/web)
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /report-regression\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 120_000 },
  reporter: 'list',
  use: { baseURL: BASE_URL, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone-15-webkit', use: { ...devices['iPhone 15'], serviceWorkers: 'block' } },
  ],
  webServer: {
    command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 600_000,
    cwd: __dirname,
  },
});
