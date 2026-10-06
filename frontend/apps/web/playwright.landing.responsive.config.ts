import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Landing page — responsive-header config.
 *
 * Geometry only: happy-dom (vitest) computes no layout, so a header wider than
 * a phone can only be caught in a real engine. Runs the spec at the four phone
 * widths the low-end-first policy cares about (320/360/390/414), with real
 * mobile emulation (isMobile, touch, DPR), not a resized desktop window.
 *
 * Chromium only: it is the engine provisioned in CI and the dev images; the
 * device METRICS are what the assertions depend on.
 *
 * Run:  bun run test:e2e:landing-responsive
 * CI:   LANDING_RESPONSIVE_E2E_BASE_URL points at the Dagger browser lane's
 *       already-running production preview, so no server is started here.
 */

const PORT = Number(process.env.LANDING_RESPONSIVE_E2E_PORT ?? 4214);
const EXTERNAL_BASE_URL = process.env.LANDING_RESPONSIVE_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const PHONE_WIDTHS = [320, 360, 390, 414] as const;

export default defineConfig({
  testDir: './e2e',
  testMatch: /landing\.responsive\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: PHONE_WIDTHS.map((width) => ({
    name: `phone-${width}`,
    use: {
      ...devices['iPhone 13'],
      browserName: 'chromium' as const,
      viewport: { width, height: 740 },
      screen: { width, height: 740 },
    },
  })),
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 300_000,
        cwd: __dirname,
      },
});
