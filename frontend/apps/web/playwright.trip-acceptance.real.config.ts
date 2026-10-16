import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * The real-LLM trip/today acceptance matrix (e2e/trip-acceptance.real.spec.ts): every question,
 * on every model in TRIP_ACCEPTANCE_MODELS, TRIP_ACCEPTANCE_RUNS times (default 3), against live
 * OpenRouter. Each run appends one JSONL line per question; scripts/trip-acceptance-report.mjs
 * prints the pass table.
 *
 * The build has the exit-gate hooks (seedChart needs window.__almameshGenerate), so it lives in its
 * own outDir and port (4192) and is never the dist anyone serves. OPENROUTER_API_KEY stays in the
 * parent shell env and is never bundled.
 *
 * Run:  bun run test:e2e:trip:acceptance   (from apps/web)
 */
const PORT = Number(process.env.TRIP_ACCEPTANCE_PORT ?? 4192);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = 'dist-trip-acceptance';

export default defineConfig({
  testDir: './e2e',
  testMatch: /trip-acceptance\.real\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Each test is its own browser context (its own OPFS); two engines at a time fit a dev machine.
  workers: Number(process.env.TRIP_ACCEPTANCE_WORKERS ?? 2),
  reporter: 'list',
  timeout: 1_800_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    // "Today" is the viewer's day and zone: pin both so the expected months are the app's.
    timezoneId: 'America/Los_Angeles',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bunx tsc -b && VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bunx vite build --outDir ${OUT_DIR} && bunx vite preview --outDir ${OUT_DIR} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: Boolean(process.env.TRIP_ACCEPTANCE_REUSE),
    timeout: 400_000,
    cwd: __dirname,
  },
});
