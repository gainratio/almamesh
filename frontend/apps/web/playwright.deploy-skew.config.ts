import { defineConfig, devices } from '@playwright/test';

/**
 * Deploy-skew gate (e2e/deploy-skew.e2e.spec.ts): a tab opened on release A
 * stays open while release B goes live, then lazy-imports one of A's hashed
 * chunks. With A's assets carried into B's upload (scripts/carryForwardAssets.mjs,
 * what the production deploy does) the import must load; without them the app
 * must say "AlmaMesh was updated", never report an AI failure.
 *
 * Like the sw-update lane it needs TWO builds and one origin that swaps between
 * them mid-test, so there is no `webServer` (the spec owns e2e/swUpdateServer.ts).
 * Build the fixtures first (two hooked builds, well under a minute each):
 *
 *   node scripts/build-skew-fixtures.mjs
 *   bunx playwright test --config=playwright.deploy-skew.config.ts
 */
const PORT = Number(process.env.DEPLOY_SKEW_E2E_PORT ?? 4230);

export default defineConfig({
  testDir: './e2e',
  testMatch: /deploy-skew\.e2e\.spec\.ts/,
  // Own output dir (gitignored): other lanes' runs wipe the shared test-results/.
  outputDir: './dist-sw-update/deploy-skew/test-results',
  // One origin whose served build is mutable global state: never overlap tests.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
