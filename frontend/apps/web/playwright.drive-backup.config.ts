import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

const PORT = Number(process.env.DRIVE_BACKUP_E2E_PORT ?? 4219);
const EXTERNAL_BASE_URL = process.env.DRIVE_BACKUP_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const BUILD_ENV =
  'VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 VITE_DRIVE_BACKUP=1 VITE_GOOGLE_CLIENT_ID_OVERRIDE=e2e-google-client-id.apps.googleusercontent.com';

export default defineConfig({
  testDir: './e2e',
  testMatch: /drive-backup\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 480_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    acceptDownloads: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `${BUILD_ENV} bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 300_000,
        cwd: __dirname,
      },
});
