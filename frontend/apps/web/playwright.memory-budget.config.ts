import { defineConfig, devices } from '@playwright/test';

/**
 * Memory-budget lane (e2e/memory-budget.e2e.spec.ts): boot-to-ready memory of
 * the PRODUCTION build on a phone-sized Chromium with an iPhone user agent.
 *
 * No webServer: point MEMORY_BUDGET_E2E_BASE_URL at a `vite preview` of a
 * production build (Dagger's browser gate serves dist-real on :4199).
 *
 * Full Chromium (channel "chromium"), not the headless shell: the shell does
 * not expose performance.measureUserAgentSpecificMemory.
 */
const BASE_URL = process.env.MEMORY_BUDGET_E2E_BASE_URL ?? 'http://127.0.0.1:4199';
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13'];

export default defineConfig({
  testDir: './e2e',
  testMatch: /memory-budget\.e2e\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 420_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-iphone',
      use: {
        ...iPhone,
        browserName: 'chromium',
        channel: 'chromium',
        launchOptions: {
          args: ['--enable-precise-memory-info', '--enable-blink-features=ForceEagerMeasureMemory'],
        },
      },
    },
  ],
});
