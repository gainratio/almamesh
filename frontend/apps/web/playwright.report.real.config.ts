import { defineConfig } from '@playwright/test';

/**
 * Real report-v2 check. Library-level: no app build, no browser, no webServer.
 * OPENROUTER_API_KEY comes from the parent shell and is never bundled.
 * Run: bun run test:e2e:report:real   (from apps/web)
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /report\.real\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 2_400_000,
  projects: [{ name: 'node' }],
});
