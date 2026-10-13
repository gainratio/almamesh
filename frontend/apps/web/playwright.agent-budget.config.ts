import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Agent-loop context budget stress (e2e/agent-budget.stress.spec.ts, plan
 * 2026-10-13 Phase 1). A stubbed OpenRouter drives every turn to its maximum
 * tool rounds; the suite measures each outbound request's prompt footprint
 * against half the configured chat model's context window, for a 1M and an 8k
 * model, on the REAL in-browser engine.
 *
 * WHY build+preview: the Pyodide chart Worker only resolves in a production
 * build, and VITE_EXIT_GATE_HOOKS=1 exposes the chart-seeding hooks.
 *
 * Run (from apps/web): bunx playwright test --config=playwright.agent-budget.config.ts
 * Point AGENT_BUDGET_E2E_BASE_URL at an already-served hooked build to skip the build.
 */
const PORT = Number(process.env.AGENT_BUDGET_E2E_PORT ?? 4182);
const EXTERNAL_BASE_URL = process.env.AGENT_BUDGET_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /agent-budget\.stress\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 900_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Chromium only. The service worker is blocked so every provider fetch reaches page.route.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], serviceWorkers: 'block' } },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 300_000,
        cwd: __dirname,
      },
});
