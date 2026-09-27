import { defineConfig, devices } from '@playwright/test';

/**
 * Post-deploy live smoke (e2e/live/live-smoke.live.spec.ts).
 *
 * Drives a DEPLOYED origin (default https://almamesh.com; LIVE_SMOKE_ORIGIN
 * overrides), so it lives outside every other config's testMatch and no PR or
 * nightly suite can reach production by accident. Run by Dagger `deploy`
 * (both passes) and `liveProbe` (`--grep @fresh`):
 *
 *   LIVE_SMOKE_PREVIOUS_URL=https://<id>.almamesh.pages.dev bun run test:e2e:live-smoke
 */
export default defineConfig({
  testDir: './e2e/live',
  testMatch: /live-smoke\.live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
