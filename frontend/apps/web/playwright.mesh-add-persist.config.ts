import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Mesh add-person durability — live-journey config.
 *
 * Drives the REAL production build: add a person on /mesh, then do a full
 * page load straight away. The person must still be there. Zero store
 * seeding and zero engine hooks, so this lane stays fast.
 *
 * Run:  bun run playwright test --config=playwright.mesh-add-persist.config.ts
 */

const PORT = Number(process.env.MESH_PERSIST_E2E_PORT ?? 4199);
// A Dagger lane that already serves a build passes MESH_PERSIST_E2E_BASE_URL;
// then this suite drives it instead of starting its own server.
const EXTERNAL_BASE_URL = process.env.MESH_PERSIST_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /mesh-add-persist\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 120_000,
  expect: { timeout: 30_000 },
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
  // Plain production build — this journey needs no exit-gate hooks.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        cwd: __dirname,
      },
});
