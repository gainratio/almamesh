import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

/**
 * Dedicated Playwright config for the chat-grounding "human test"
 * (e2e/chat.grounding.spec.ts). Mirrors playwright.interpretation.config.ts.
 *
 * WHY a separate config: this gate boots the REAL in-browser Pyodide engine,
 * seeds a real Delhi chart, lets the dashboard auto-generate the six-section
 * reading from a STUBBED OpenAI-compatible LLM (page.route), then sends a chat
 * turn — asserting on the OUTBOUND chat request body (fast chat model override +
 * reused-reading block). It is self-contained: it builds a production bundle and
 * serves it via `vite preview` — NO auth, NO backend, NO real API key.
 *
 * WHY build+preview (not `vite dev`): the Pyodide chart Worker only resolves in a
 * production build, and VITE_EXIT_GATE_HOOKS=1 exposes window.__almameshGenerate /
 * window.__ALMAMESH_STAGE__ for chart seeding (same gate the exit-gate uses).
 *
 * Run:  bun run test:e2e:chat:grounding   (from apps/web)
 */

const PORT = Number(process.env.CHAT_GROUNDING_E2E_PORT ?? 4192);
// A Dagger lane that already serves the hooked build passes CHAT_GROUNDING_E2E_BASE_URL;
// then this suite drives it instead of rebuilding the same bundle.
const EXTERNAL_BASE_URL = process.env.CHAT_GROUNDING_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Only this spec — keep the gate fast and decoupled from the legacy suite.
  testMatch: /chat\.grounding\.spec\.ts/,
  // The engine boot (Pyodide + OPFS bundle sync) is heavy; one worker at a time
  // keeps OPFS/IndexedDB state from colliding across parallel contexts.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // The cold engine boot can take ~60-90s under headless Chromium.
  timeout: 240_000,
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
  // Build with the exit-gate hooks ON (so window.__almameshGenerate exists),
  // then serve the bundle. `VITE_API_URL=` keeps the app in zero-backend mode.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        cwd: __dirname,
      },
});
