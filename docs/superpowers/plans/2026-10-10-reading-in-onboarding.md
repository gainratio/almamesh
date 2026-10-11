# Your Reading, Right After Your Chart: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI reading the step after the chart in onboarding, and make it a five-chapter structured report (Overview, Your current period, The year ahead, Life areas, Remedies and guidance) where the engine draws every date, band and window and the model writes the prose.

**Architecture:** Four PRs. PR 1 turns the Settings AI form into one shared `AiSetupPanel`. PR 2 adds four timeline report sections, app-computed quarters, a deterministic date guard, and a cost estimate to `@almamesh/llm` (library only). PR 3 moves the interpretation store to v7, teaches the streaming hook to run the full report from one user action, and renders it with `ReadingReport` on the dashboard. PR 4 adds the `/onboarding/reading` route (unlock step, your-reading step, rectify hand-off, cost line). All compute stays on the device; the only new network calls are the user-tapped completions and OpenRouter-only price and balance reads.

**Tech Stack:** TypeScript, React + Vite PWA, Zustand + the SQLite-backed interpretation store (`@almamesh/store`), `@almamesh/llm` (OpenAI-compatible HTTP, OpenRouter preset), react-i18next (en/es/pt), Vitest, Playwright (desktop Chromium + iPhone 15 WebKit profile), Bun workspace, `make gate`.

**Spec:** `docs/superpowers/specs/2026-10-10-reading-in-onboarding-design.md` (approved on PR #325; rulings for the eight open questions are at its end).

## PR order

| PR | Branch | Depends on | Can run in parallel with |
| --- | --- | --- | --- |
| 1 | `feat/ai-setup-panel` | `main` | PR 2 |
| 2 | `feat/report-sections-llm` | `main` | PR 1 |
| 3 | `claude/reading-pr3-store-report` | PR 2 merged | (none) |
| 4 | `feat/onboarding-reading-route` | PR 1 and PR 3 merged | (none) |

Each PR is its own worktree under `.worktrees/`, branched from a fresh `origin/main`, merged then deleted with its worktree and remote branch in the same step.

## Global Constraints

- Paid AI calls happen only after an explicit UI action: `intent: 'user-request'`, never from a `useEffect` or route mount.
- The API key stays on the device and goes only to the provider the person chose. Price and balance reads go only to OpenRouter (`fetchOpenRouterModels`, `fetchOpenRouterCredits` refuse other hosts). A local endpoint makes zero requests to `openrouter.ai`.
- LLM input is PII-redacted and month precision only (`sanitize.ts` path). No `YYYY-MM-DD` reaches a prompt or the screen.
- Natal prose never mentions dates; timeline prose is the only place dates appear (`TIMING OWNERSHIP` rule kept).
- Engine math lives in Python. The app only slices and reshapes engine output (quarters are calendar arithmetic on the as-of month, not astrology).
- SQLite is the only system of record; navigation state is a hint, never data.
- "Free forever": no payment code; copy says the provider charges and AlmaMesh does not.
- Product default model stays `deepseek/deepseek-v4.1-flash` (`RECOMMENDED_CLOUD_MODEL`). Real-model tests use `E2E_REAL_MODEL` (`deepseek/deepseek-v4-pro`, cheapest at live price on 2026-10-10).
- Report sections send `reasoning.max_tokens = 6,000` (`REPORT_SECTION_REASONING_MAX_TOKENS`) on OpenRouter only. Never cap visible output with `max_tokens`.
- Latency budget: full report P90 under 150 s on the default model, measured in the real spec.
- Report targets (words per voice, full): Overview 900-1,200; Current period 550-700; Year ahead 800-1,100; each natal life-area guidance 120-160; each "This year" 120-160; remedies 300-400. Lite about 1,000 total.
- Copy ships in en, es and pt in the same PR.
- Every PR: TDD, `frontend-quality` skill, mutation red runs, live e2e in desktop Chromium and the iPhone 15 WebKit profile with screenshots and a clean console, `make gate` green locally and in CI (including the memory-budget lane), northstar grade A before merge.
- Stage named files only (`git add <path>`, never `-A`); use `git add -f` for anything under `docs/superpowers/`.

## Review Focus

The spec does not test these directly. Each one has a test in the task named after it.

1. **The as-of month crosses a year boundary, or is December.** `computeQuarters('2026-11')` must produce `2026-11..2027-01`, `2027-02..04`, `2027-05..07`, `2027-08..10`, and quarter titles must read "Nov 2026-Jan 2027". Pinned in PR 2, Task 2.2 (quarters tests include a November and a December start, and `quarterTitle`).
2. **A date in the prose in a format other than `YYYY-MM`**: a day-precision date like `2027-03-14`, a month name with a year ("March 2027"), or a date inside a `technical` voice only. The guard must remove the sentence in both voices and count each removal. Pinned in PR 2, Task 2.3 (date-guard tests cover all three shapes, in en, es and pt).
3. **The person reloads `/onboarding/reading` mid-stream, or opens it directly with no navigation state.** The page must re-derive its step from stored data (chart, report, LLM status), never from `location.state`, and must not start a paid call on load. Pinned in PR 4, Task 4.10 (unit) and the reload step in Task 4.14 (e2e).
4. **The model list from OpenRouter has the configured model missing, or `pricing` fields as strings like `"0"` or `"-1"`.** Missing → no cost line; `"0"` for both → "Free on this model"; negative or non-numeric → no cost line, never a made-up number. Pinned in PR 2, Tasks 2.11 (pricing parse) and 2.12 (estimate), and PR 4, Task 4.7 (cost-line component).
5. **A stored v6 reading plus a v1 timeline, then the person taps "Get the full year ahead" and the run fails halfway.** The v1 content must still be on screen and in the store afterwards; a failed v2 run never overwrites the v1 entry. Pinned in PR 3, Task 3.4 (hook test "a failed v2 refresh keeps the v1 timeline": a v2 timeline commits only when `current_period` and `year_ahead` both parsed) and Task 3.12 (on screen).

---
## PR 1: one shared AI setup panel

**Branch:** `feat/ai-setup-panel` (off `main`, in a worktree under `almamesh/.worktrees/ai-setup-panel`)

**Claim touched:** "Your key stays on this device and goes only to the provider you choose." Unchanged; this PR proves it stays true after the move (e2e egress assertions in both profiles, plus the onboarding-variant disclosure test).

**Depends on:** nothing. Runs in parallel with PR 2. PR 4 consumes `AiSetupPanel`.

**Deviations:**

1. The spec's privacy table names the disclosure `ai.privacy_warning`. In the real code that key is the *local-only refusal warning* (`data-testid="llm-privacy-warning"`, shown only when `privacyMode` is `local_only` and the endpoint is not local). The disclosure that says "planet positions and period dates ... can reveal your birth date" is `tiers.cloud_body`, rendered as `data-testid="tier-cloud-honesty"` (LlmModelSettings.tsx:399-401). The plan tests BOTH in the onboarding variant: the honesty line is the disclosure that must render (and is what the mutation hides); `llm-privacy-warning` must still appear there when its condition holds. PR 4 should repeat `tiers.cloud_body`, not `ai.privacy_warning`, above **Get my reading**.
2. `AiSetupPanelProps` carries the three contract props AND keeps the five existing injectable test seams of `LlmModelSettingsProps` (`resolveConfig`, `testConnection`, `fetchCredits`, `fetchModels`, `flushSettings`). Dropping them would break every moved test.
3. The red run for "skip the `probeGen` check" targets a new deterministic test ("does not report connected when a newer save superseded the probe") instead of the existing probe-race test. The existing test asserts after a single `await Promise.resolve()`, which may not flush React's re-render, so it is not a reliable red signal. The existing test stays and still runs.
4. The spec's red-run table has 3 rows. A 4th row (hide the disclosure in the onboarding variant) is added from the spec's privacy table, which assigns that component test to PR 1.
5. `AiSettings.tsx` keeps its **default** export. `App.tsx:56` lazy-loads it via `lazyWithRetry(() => import('./pages/settings/AiSettings'))`, which needs a default export.
6. The WebKit project uses `devices['iPhone 15']` on a persistent on-disk profile (`e2e/webkitProfile.ts`) with `serviceWorkers: 'block'`. It runs on macOS only (Linux Playwright WebKit cannot open SQLite's nested-Worker OPFS, see `playwright.time-travel.config.ts:41-47`). So the new panel e2e config runs locally in this PR and is not wired into the Linux PR lane. The real-model spec IS wired into the nightly (Chromium).

Interface names otherwise match CONTRACT.md: `apps/web/src/components/features/ai/AiSetupPanel.tsx`, named export `AiSetupPanel`, `onConnected?: (status: LlmStatus) => void` (`LlmStatus` from `@almamesh/llm`, `packages/llm/src/settings.ts:76`), `showOffChoice?: boolean` (default `true`), `intro?: ReactNode`.

### File map

| Path (under `frontend/apps/web/` unless rooted) | Action | Responsibility |
| --- | --- | --- |
| `src/components/features/settings/LlmModelSettings.tsx` | delete (git mv) | Becomes `AiSetupPanel.tsx` |
| `src/components/features/ai/AiSetupPanel.tsx` | create (git mv + modify) | The only AI setup UI. Adds `onConnected`, `showOffChoice`, `intro` |
| `src/components/features/settings/LlmModelSettings.test.tsx` | delete (git mv) | Becomes `AiSetupPanel.test.tsx` |
| `src/components/features/ai/AiSetupPanel.test.tsx` | create (git mv + modify) | Moved tests, plus the new onConnected / showOffChoice / intro / disclosure tests |
| `src/components/features/settings/LlmModelSettings.tiers.test.tsx` | delete (git mv) | Becomes `AiSetupPanel.tiers.test.tsx` |
| `src/components/features/ai/AiSetupPanel.tiers.test.tsx` | create (git mv + modify) | Moved tier tests |
| `src/components/features/settings/AiModelSettings.tsx` | delete | Its `<section><Card>` wrapper moves inline into `AiSettings.tsx` |
| `src/pages/settings/AiSettings.tsx` | modify | Renders `<AiSetupPanel />` inside the same `section[data-testid=ai-model-settings] > Card.p-5` |
| `src/pages/settings/__tests__/AiSettings.test.tsx` | create | Settings renders the shared panel with the AI-off choice and no intro |
| `e2e/aiSetupPanel.helpers.ts` | create | OpenRouter + local-endpoint stubs, egress recorder |
| `e2e/ai-setup-panel.spec.ts` | create | Screenshot diff of Settings → AI (3 states) + egress claim, Chromium + iPhone 15 WebKit |
| `playwright.ai-setup-panel.config.ts` | create | Hooks-off build + preview, two projects, baseline snapshot dir under gitignored `shots/` |
| `e2e/ai-setup-panel.real.spec.ts` | create | `[real]` live OpenRouter key test on `E2E_REAL_MODEL` |
| `playwright.ai-setup.real.config.ts` | create | Config for the real spec |
| `package.json` | modify | Scripts `test:e2e:ai-panel`, `test:e2e:ai:real` |
| `dagger/src/index.ts` (repo root) | modify (`:105-112`) | Add `"ai:real"` to `NIGHTLY_REPORTED_E2E` |
| `tests/dagger-nightly-real-skips.test.ts` (repo root) | modify (`:142`) | Pin `"ai:real"` in the nightly suite list |
| `scripts/mutations/pr1-ai-setup-panel.sh` | create | Mutation red runs (no harness exists in the repo; this creates `scripts/mutations/`) |

All commands below run from `frontend/apps/web` unless they say otherwise.

---

### Task 1.1: Capture the Settings → AI baseline before touching anything

The screenshot diff needs a "before" image from untouched code. This task adds the e2e spec and runs it on `main`'s code to write the baselines into gitignored `shots/`.

**Files**
- Create: `frontend/apps/web/e2e/aiSetupPanel.helpers.ts`
- Create: `frontend/apps/web/e2e/ai-setup-panel.spec.ts`
- Create: `frontend/apps/web/playwright.ai-setup-panel.config.ts`
- Modify: `frontend/apps/web/package.json` (scripts block, after `"test:e2e:ai"` at line 17)

**Interfaces**
- Consumes: `test` from `e2e/webkitProfile.ts`; `collectConsoleErrors(page: Page): string[]` from `e2e/live/liveJourney.ts:61`.
- Produces: `stubOpenRouter(page: Page): Promise<void>`, `stubLocalEndpoint(page: Page): Promise<void>`, `recordEgress(page: Page, appOrigin: string): EgressLog`, `interface EgressEntry { host: string; path: string; authorization: string | null }`, `interface EgressLog { settle(): Promise<readonly EgressEntry[]> }`.

- [ ] **Step 1: Write the helpers**

```ts
// frontend/apps/web/e2e/aiSetupPanel.helpers.ts
import type { Page, Request } from '@playwright/test';

/**
 * Stubs for the AI setup panel e2e. Every OpenRouter surface the panel can touch
 * is answered locally; anything else to openrouter.ai is refused loudly (418) so
 * a new egress cannot sneak in. CORS preflights are answered so the same stub
 * works in Chromium and WebKit.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

export async function stubOpenRouter(page: Page): Promise<void> {
  await page.route('https://openrouter.ai/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const url = request.url();
    if (url.includes('/chat/completions')) {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
      });
      return;
    }
    if (url.includes('/credits')) {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ data: { total_credits: 10, total_usage: 2 } }),
      });
      return;
    }
    if (url.includes('/models')) {
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"data":[]}' });
      return;
    }
    await route.fulfill({ status: 418, headers: CORS, body: 'unexpected OpenRouter call in e2e' });
  });
}

/** A local Ollama-style endpoint that answers only the connectivity probe. */
export async function stubLocalEndpoint(page: Page): Promise<void> {
  await page.route('http://localhost:11434/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (request.url().includes('/chat/completions')) {
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }),
      });
      return;
    }
    await route.fulfill({ status: 418, headers: CORS, body: 'unexpected local-endpoint call in e2e' });
  });
}

export interface EgressEntry {
  host: string;
  path: string;
  authorization: string | null;
}

export interface EgressLog {
  /** Every cross-origin request seen so far, with its Authorization header. */
  settle(): Promise<readonly EgressEntry[]>;
}

/** Record every request that leaves the app's own origin. */
export function recordEgress(page: Page, appOrigin: string): EgressLog {
  const pending: Promise<EgressEntry>[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === appOrigin || url.protocol === 'data:' || url.protocol === 'blob:') return;
    pending.push(
      request.headerValue('authorization').then((authorization) => ({
        host: url.host,
        path: url.pathname,
        authorization,
      })),
    );
  });
  return { settle: () => Promise.all(pending) };
}
```

- [ ] **Step 2: Write the spec**

```ts
// frontend/apps/web/e2e/ai-setup-panel.spec.ts
import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

import { test } from './webkitProfile';
import { collectConsoleErrors } from './live/liveJourney';
import { recordEgress, stubLocalEndpoint, stubOpenRouter } from './aiSetupPanel.helpers';

/**
 * Settings → AI after the move to the shared AiSetupPanel (PR 1).
 *
 * 1. It looks exactly as before: element screenshots are compared pixel-for-pixel
 *    against baselines captured from the pre-move code (Task 1.1), in desktop
 *    Chromium and the iPhone 15 WebKit profile.
 * 2. The claim still holds: the key is sent only to the provider the user chose.
 *
 * Run:  bun run test:e2e:ai-panel   (macOS for the WebKit project)
 */

const DUMMY_KEY = 'sk-or-test-panel-key-0000000000';
const SHOTS = 'shots/pr1-ai-setup-panel';

async function openAiSettings(page: Page): Promise<void> {
  await page.goto('/settings/ai');
  await expect(page.getByRole('heading', { name: 'AI Model' })).toBeVisible();
  await expect(page.getByTestId('ai-model-settings')).toBeVisible();
}

async function evidence(page: Page, name: string): Promise<void> {
  const dir = `${SHOTS}/${test.info().project.name}`;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.describe('Settings → AI renders the shared panel unchanged', () => {
  test('AI off (the default) looks exactly as before', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    await openAiSettings(page);
    await expect(page.getByTestId('tier-none-active')).toBeVisible();
    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-off.png');
    await evidence(page, 'settings-ai-off');
    expect(errors).toEqual([]);
  });

  test('connecting OpenRouter looks as before and sends the key only to openrouter.ai', async ({
    page,
    baseURL,
  }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    const egress = recordEgress(page, new URL(baseURL ?? '').origin);
    await openAiSettings(page);

    await page.getByTestId('llm-openrouter-key').fill(DUMMY_KEY);
    await page.getByTestId('llm-save').click();
    await expect(page.getByTestId('llm-connection-result')).toContainText(/Connected/, { timeout: 15_000 });
    await expect(page.getByTestId('llm-credits-value')).toContainText('$8.00');

    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-connected.png');
    await evidence(page, 'settings-ai-connected');

    const sent = await egress.settle();
    const keyed = sent.filter((entry) => entry.authorization?.includes(DUMMY_KEY));
    expect(sent.every((entry) => entry.host === 'openrouter.ai')).toBe(true);
    expect(keyed.map((entry) => entry.path)).toContain('/api/v1/chat/completions');
    expect(keyed.every((entry) => entry.host === 'openrouter.ai')).toBe(true);
    // The model catalog is a public read: it never carries the key.
    expect(sent.filter((e) => e.path.endsWith('/models')).every((e) => e.authorization === null)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a local endpoint is probed locally and nothing goes to openrouter.ai', async ({ page, baseURL }) => {
    const errors = collectConsoleErrors(page);
    await stubOpenRouter(page);
    await stubLocalEndpoint(page);
    const egress = recordEgress(page, new URL(baseURL ?? '').origin);
    await openAiSettings(page);

    await page.getByTestId('llm-advanced-summary').click();
    await page.getByTestId('llm-api-base').fill('http://localhost:11434/v1');
    await page.getByTestId('llm-model').fill('llama3.1');
    await page.keyboard.press('Escape');
    await page.getByTestId('llm-save-advanced').click();
    await expect(page.getByTestId('llm-connection-result').last()).toContainText(/Connected/, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('llm-credits')).toHaveCount(0);

    await expect(page.getByTestId('ai-model-settings')).toHaveScreenshot('settings-ai-local-connected.png');
    await evidence(page, 'settings-ai-local-connected');

    const sent = await egress.settle();
    expect(sent.filter((entry) => entry.host === 'openrouter.ai')).toEqual([]);
    expect(sent.map((entry) => `${entry.host}${entry.path}`)).toContain('localhost:11434/v1/chat/completions');
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 3: Write the config**

```ts
// frontend/apps/web/playwright.ai-setup-panel.config.ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

/**
 * Settings → AI visual + egress gate for the shared AiSetupPanel (PR 1).
 *
 * Hooks-OFF production build (the real app, no exit-gate hooks) served by
 * `vite preview`. Baselines live in gitignored `shots/`: capture them from the
 * pre-change code with `--update-snapshots`, then run without it after the
 * change; any pixel difference fails. The iPhone 15 WebKit project needs macOS
 * (see e2e/webkitProfile.ts) and blocks the service worker so page.route stubs
 * are not bypassed.
 *
 * Run:  bun run test:e2e:ai-panel
 */
const PORT = Number(process.env.AI_PANEL_E2E_PORT ?? 4189);
const BASE_URL = process.env.AI_PANEL_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /ai-setup-panel\.spec\.ts/,
  snapshotPathTemplate: '{testDir}/../shots/pr1-ai-setup-panel/baseline/{projectName}/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled', caret: 'hide' } },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { baseURL: BASE_URL, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone-15-webkit', use: { ...devices['iPhone 15'], serviceWorkers: 'block' } },
  ],
  webServer: {
    command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    cwd: __dirname,
  },
});
```

Add to `package.json` scripts, after line 17 (`"test:e2e:ai"`):

```json
    "test:e2e:ai-panel": "playwright test --config=playwright.ai-setup-panel.config.ts",
```

- [ ] **Step 4: Capture the baselines on untouched code**

```bash
cd frontend/apps/web
bunx playwright test --config=playwright.ai-setup-panel.config.ts --update-snapshots
ls shots/pr1-ai-setup-panel/baseline/chromium shots/pr1-ai-setup-panel/baseline/iphone-15-webkit
```

Expected: 6 passed (3 tests x 2 projects). Each `baseline/<project>/` holds `settings-ai-off.png`, `settings-ai-connected.png`, `settings-ai-local-connected.png`. These are the "before" images. Do not regenerate them later in this PR.

- [ ] **Step 5: Prove the diff can fail**

```bash
cp shots/pr1-ai-setup-panel/baseline/chromium/settings-ai-off.png /tmp/ai-off.bak
perl -0pi -e "s/\{t\('tiers.none_body'\)\}/{t('tiers.none_body')} MUTATION_PIXEL/" src/components/features/settings/LlmModelSettings.tsx
grep -q MUTATION_PIXEL src/components/features/settings/LlmModelSettings.tsx || exit 1
bunx playwright test --config=playwright.ai-setup-panel.config.ts --project=chromium -g "AI off"; echo "exit=$?"
git checkout -- src/components/features/settings/LlmModelSettings.tsx
cmp /tmp/ai-off.bak shots/pr1-ai-setup-panel/baseline/chromium/settings-ai-off.png
```

Expected: `exit=1` (screenshot mismatch), then the baseline is byte-identical (`cmp` prints nothing). Keep the diff image Playwright writes under `test-results/` as PR evidence.

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/e2e/aiSetupPanel.helpers.ts frontend/apps/web/e2e/ai-setup-panel.spec.ts frontend/apps/web/playwright.ai-setup-panel.config.ts frontend/apps/web/package.json
git commit -m "test(e2e): pin Settings → AI visuals and key egress before the panel move"
```

---

### Task 1.2: Move `LlmModelSettings` to `features/ai/AiSetupPanel` (named export)

A pure move. The existing tests are the safety net: moved first, they go red until the component follows.

**Files**
- Move: `src/components/features/settings/LlmModelSettings.test.tsx` → `src/components/features/ai/AiSetupPanel.test.tsx`
- Move: `src/components/features/settings/LlmModelSettings.tiers.test.tsx` → `src/components/features/ai/AiSetupPanel.tiers.test.tsx`
- Move: `src/components/features/settings/LlmModelSettings.tsx` → `src/components/features/ai/AiSetupPanel.tsx` (modify lines 1-3, 93-119)
- Modify: `src/components/features/settings/AiModelSettings.tsx:12,18` (temporary; deleted in Task 1.3)

**Interfaces**
- Produces: `export function AiSetupPanel(props?: AiSetupPanelProps): JSX.Element`; `export interface AiSetupPanelProps` (the five seams, unchanged types).
- Relative imports inside the panel (`../../ui`, `../../../lib/...`, `../../../hooks/...`) stay valid: `features/ai` is at the same depth as `features/settings`.

- [ ] **Step 1: Move the tests and point them at the new module**

```bash
cd frontend/apps/web
mkdir -p src/components/features/ai
git mv src/components/features/settings/LlmModelSettings.test.tsx src/components/features/ai/AiSetupPanel.test.tsx
git mv src/components/features/settings/LlmModelSettings.tiers.test.tsx src/components/features/ai/AiSetupPanel.tiers.test.tsx
perl -pi -e "s#import LlmModelSettings from './LlmModelSettings';#import { AiSetupPanel } from './AiSetupPanel';#; s/<LlmModelSettings\b/<AiSetupPanel/g; s/LlmModelSettings —/AiSetupPanel —/g" \
  src/components/features/ai/AiSetupPanel.test.tsx src/components/features/ai/AiSetupPanel.tiers.test.tsx
grep -c "LlmModelSettings" src/components/features/ai/AiSetupPanel.test.tsx src/components/features/ai/AiSetupPanel.tiers.test.tsx
```

Expected: both counts `0`.

- [ ] **Step 2: Run, watch it fail for the right reason**

```bash
bunx vitest run src/components/features/ai/
```

Expected: FAIL, 2 suites, `Failed to resolve import "./AiSetupPanel"`.

- [ ] **Step 3: Move the component and rename the export**

```bash
git mv src/components/features/settings/LlmModelSettings.tsx src/components/features/ai/AiSetupPanel.tsx
```

In `src/components/features/ai/AiSetupPanel.tsx`, line 2:

```ts
 * AiSetupPanel — the one AI setup UI (Settings → AI, and onboarding from PR 4).
```

Lines 93-119 become:

```ts
/**
 * Injectable seams so the component is unit-testable without a network round-trip
 * — default to the real interpretation-config resolver + connectivity probe +
 * OpenRouter balance reader.
 */
export interface AiSetupPanelProps {
  resolveConfig?: () => ProviderConfig;
  testConnection?: (opts: { config: ProviderConfig; signal?: AbortSignal }) => Promise<void>;
  fetchCredits?: (opts: {
    config: ProviderConfig;
    signal?: AbortSignal;
  }) => Promise<OpenRouterCredits>;
  fetchModels?: (opts: {
    config: ProviderConfig;
    signal?: AbortSignal;
  }) => Promise<OpenRouterModel[]>;
  /** Await the canonical SQLite write before reporting a saved configuration. */
  flushSettings?: () => Promise<void>;
}

export function AiSetupPanel({
  resolveConfig = resolveInterpretationConfig,
  testConnection = testProviderConnection,
  fetchCredits = fetchOpenRouterCredits,
  fetchModels = fetchOpenRouterModels,
  flushSettings = flushPortablePersistence,
}: AiSetupPanelProps = {}) {
```

In `src/components/features/settings/AiModelSettings.tsx`, line 12 becomes `import { AiSetupPanel } from '../ai/AiSetupPanel';` and line 18 becomes `<AiSetupPanel />`.

- [ ] **Step 4: Run to green, plus types**

```bash
bunx vitest run src/components/features/ai/
bun run typecheck
```

Expected: 2 files, 27 tests pass (23 in `AiSetupPanel.test.tsx`, 4 in `AiSetupPanel.tiers.test.tsx`), the same 27 that ran before the move. `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/features/ai/AiSetupPanel.tsx src/components/features/ai/AiSetupPanel.test.tsx src/components/features/ai/AiSetupPanel.tiers.test.tsx src/components/features/settings/AiModelSettings.tsx
git commit -m "refactor(web): move LlmModelSettings to features/ai/AiSetupPanel"
```

(`git mv` already staged the deletions of the old paths.)

---

### Task 1.3: Settings renders the panel directly; delete `AiModelSettings`

**Files**
- Create: `src/pages/settings/__tests__/AiSettings.test.tsx`
- Modify: `src/pages/settings/AiSettings.tsx:1-11, 24`
- Delete: `src/components/features/settings/AiModelSettings.tsx`

**Interfaces**
- Consumes: `AiSetupPanel` (no props), `Card` from `src/components/ui/index.ts:7`.
- Produces: unchanged default export `AiSettings` (lazy-loaded at `App.tsx:56`).

- [ ] **Step 1: Write the characterization test**

This test describes the composition Settings must keep. It passes on the current code (via `AiModelSettings`) and must stay green after the inline move; it is the refactor's safety net, not a red-first test.

```tsx
// src/pages/settings/__tests__/AiSettings.test.tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import '../../../i18n/config';
import { configureLlmSettingsPersistence, hydrateLlmSettings } from '@almamesh/llm';
import AiSettings from '../AiSettings';

describe('AiSettings — Settings → AI renders the shared AI setup panel', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    configureLlmSettingsPersistence(undefined);
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    configureLlmSettingsPersistence(undefined);
  });

  it('renders the panel inside the AI Model card, with the AI-off choice and no intro', () => {
    render(<AiSettings />);
    expect(screen.getByRole('heading', { name: 'AI Model' })).toBeTruthy();
    const card = screen.getByTestId('ai-model-settings');
    expect(card.querySelector('[data-testid="tier-none"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="tier-cloud"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="tier-cloud-honesty"]')).not.toBeNull();
    expect(screen.queryByTestId('ai-setup-intro')).toBeNull();
  });
});
```

(Unconfigured settings resolve to the local default base, so neither the credits nor the catalog read fires; no network stub is needed.)

- [ ] **Step 2: Run it on the current code**

```bash
bunx vitest run src/pages/settings/__tests__/AiSettings.test.tsx
```

Expected: PASS (1 test).

- [ ] **Step 3: Inline the wrapper and delete `AiModelSettings`**

`src/pages/settings/AiSettings.tsx` lines 1-11 become:

```tsx
/**
 * AiSettings — the dedicated "AI Model" settings tab.
 *
 * Renders the shared AiSetupPanel (the only AI setup UI in the app): AI off
 * (the default — the chart is pure calculation) and Connect AI (an OpenRouter
 * key, or any OpenAI-compatible endpoint under "Advanced"). Saving runs a real
 * connectivity probe and reports Connected or a specific error. Linked from the
 * header AI-status badge.
 */

import { useTranslation } from 'react-i18next';
import { Card } from '../../components/ui';
import { AiSetupPanel } from '../../components/features/ai/AiSetupPanel';
```

Line 24 (`<AiModelSettings />`) becomes the same DOM `AiModelSettings` produced:

```tsx
      <section data-testid="ai-model-settings">
        <Card className="p-5">
          <AiSetupPanel />
        </Card>
      </section>
```

```bash
git rm src/components/features/settings/AiModelSettings.tsx
git grep -n "AiModelSettings\|LlmModelSettings" -- src e2e
```

Expected: no matches.

- [ ] **Step 4: Run unit tests, types, lint, knip**

```bash
bunx vitest run src/pages/settings/__tests__/AiSettings.test.tsx src/components/features/ai/
bun run typecheck && bun run lint
cd ../.. && bun run knip && cd apps/web
```

Expected: all green; knip reports no unused file or export.

- [ ] **Step 5: Screenshot diff and the unchanged e2e**

```bash
bunx playwright test --config=playwright.ai-setup-panel.config.ts
bun run test:e2e:ai
git diff --quiet main -- e2e/ai-settings.spec.ts && echo "ai-settings.spec.ts unchanged"
```

Expected: 6 passed with zero pixel difference against the Task 1.1 baselines; `ai-settings.spec.ts` 1 passed; the spec file is byte-identical to `main`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/settings/AiSettings.tsx src/pages/settings/__tests__/AiSettings.test.tsx
git commit -m "refactor(web): Settings → AI renders AiSetupPanel directly; drop AiModelSettings"
```

---

### Task 1.4: `showOffChoice` and `intro`

**Files**
- Modify: `src/components/features/ai/AiSetupPanel.tsx` (props interface; destructure; render block at old lines 350-382)
- Modify: `src/components/features/ai/AiSetupPanel.test.tsx` (append a describe block)

**Interfaces**
- Produces: `AiSetupPanelProps.showOffChoice?: boolean` (default `true`), `AiSetupPanelProps.intro?: ReactNode`. New test id `ai-setup-intro`.

- [ ] **Step 1: Write the failing tests** (append to `AiSetupPanel.test.tsx`)

```tsx
describe('AiSetupPanel — surface props (showOffChoice, intro)', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });

  const renderPanel = (props: Partial<AiSetupPanelProps> = {}) =>
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={fetchModels}
        testConnection={vi.fn()}
        {...props}
      />,
    );

  it('shows the AI-off choice by default, so Settings needs no props', () => {
    renderPanel();
    expect(screen.getByTestId('tier-none')).toBeTruthy();
  });

  it('hides the AI-off choice when showOffChoice is false', () => {
    renderPanel({ showOffChoice: false });
    expect(screen.queryByTestId('tier-none')).toBeNull();
    expect(screen.getByTestId('tier-cloud')).toBeTruthy();
    expect(screen.getByTestId('llm-openrouter-key')).toBeTruthy();
  });

  it('renders the intro above the choices', () => {
    renderPanel({ intro: <p>Your reading is a full report.</p> });
    const intro = screen.getByTestId('ai-setup-intro');
    expect(intro.textContent).toBe('Your reading is a full report.');
    const order = intro.compareDocumentPosition(screen.getByTestId('tier-cloud'));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no intro wrapper when none is given', () => {
    renderPanel();
    expect(screen.queryByTestId('ai-setup-intro')).toBeNull();
  });
});
```

Also change the import at the top of the file to `import { AiSetupPanel, type AiSetupPanelProps } from './AiSetupPanel';`.

- [ ] **Step 2: Run, watch it fail**

```bash
bunx vitest run src/components/features/ai/AiSetupPanel.test.tsx -t "surface props"
```

Expected: FAIL. Vitest does not type-check, so the unknown props still render: "hides the AI-off choice" fails (`tier-none` still present) and "renders the intro" fails (`Unable to find ... ai-setup-intro`). The two "default" tests pass.

- [ ] **Step 3: Implement**

Add `import type { ReactNode } from 'react';` next to the React import. Extend the interface:

```ts
export interface AiSetupPanelProps {
  /**
   * Called once per save whose connectivity probe passed AND whose settings were
   * durably written to SQLite. Never on save alone, never on a failed probe,
   * never for a probe a newer save or edit superseded.
   */
  onConnected?: (status: LlmStatus) => void;
  /** Show the "AI off" choice. Settings: true (default). Onboarding: false. */
  showOffChoice?: boolean;
  /** Surface-specific copy above the choices. Settings passes none. */
  intro?: ReactNode;
  // ...the five existing seams, unchanged
}
```

Destructure `showOffChoice = true, intro,` (and `onConnected,` for Task 1.5) in the signature. In the render, replace the opening of the section and the AI-off block:

```tsx
  return (
    <section className="space-y-4">
      {intro ? (
        <div className="space-y-2 text-sm text-text-secondary" data-testid="ai-setup-intro">
          {intro}
        </div>
      ) : null}

      {/* ── AI off (the default). Onboarding offers "Skip for now" outside the panel instead. ── */}
      {showOffChoice && (
        <div
          data-testid="tier-none"
          ...existing className and children unchanged...
        </div>
      )}
```

With no `intro` and the default `showOffChoice`, the DOM is identical to before.

- [ ] **Step 4: Run to green**

```bash
bunx vitest run src/components/features/ai/ src/pages/settings/__tests__/AiSettings.test.tsx
bun run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/features/ai/AiSetupPanel.tsx src/components/features/ai/AiSetupPanel.test.tsx
git commit -m "feat(web): AiSetupPanel takes showOffChoice and intro for the onboarding surface"
```

---

### Task 1.5: `onConnected` fires only after a passing probe on durable settings

**Files**
- Modify: `src/components/features/ai/AiSetupPanel.tsx` (`saveAndTest`, old lines 274-319)
- Modify: `src/components/features/ai/AiSetupPanel.test.tsx` (append a describe block)

**Interfaces**
- Consumes: `describeLlmStatus(settings: LlmSettings): LlmStatus` (`packages/llm/src/settings.ts:90`), already imported.
- Produces: `onConnected(status)` called with `describeLlmStatus(persisted)`, e.g. `{ kind: 'openrouter', label: 'OpenRouter', configured: true }`.

- [ ] **Step 1: Write the failing tests**

```tsx
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued promise continuation and timer-0 task run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('AiSetupPanel — onConnected', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });

  const renderPanel = (props: Partial<AiSetupPanelProps>) =>
    render(
      <AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} {...props} />,
    );
  const saveKey = (key: string) => {
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: key } });
    fireEvent.click(screen.getByTestId('llm-save'));
  };

  it('reports connected once, with the saved status, after a passing probe', async () => {
    const onConnected = vi.fn();
    renderPanel({ onConnected, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(onConnected).toHaveBeenCalledWith({ kind: 'openrouter', label: 'OpenRouter', configured: true });
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it('does not report connected on a failed probe', async () => {
    const onConnected = vi.fn();
    renderPanel({
      onConnected,
      testConnection: vi.fn().mockRejectedValue(requestError('returned 401 Unauthorized', 401)),
    });
    saveKey('bad-key');
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('API key rejected'),
    );
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('reports connected only after the settings are durable', async () => {
    const onConnected = vi.fn();
    const flush = deferred();
    const flushSettings = vi.fn(() => flush.promise);
    renderPanel({ onConnected, flushSettings, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(flushSettings).toHaveBeenCalledOnce());
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    flush.resolve();
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it('does not report connected when the settings write fails', async () => {
    const onConnected = vi.fn();
    renderPanel({
      onConnected,
      flushSettings: vi.fn().mockRejectedValue(new Error('canonical SQLite write failed')),
      testConnection: vi.fn().mockResolvedValue(undefined),
    });
    saveKey('sk-or-abc');
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain("Couldn't save"),
    );
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('does not report connected when a newer save superseded the probe', async () => {
    const onConnected = vi.fn();
    const first = deferred();
    const testConnection = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    renderPanel({ onConnected, testConnection });

    saveKey('sk-or-first');
    await waitFor(() => expect(testConnection).toHaveBeenCalledOnce());
    saveKey('sk-or-second');
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());

    first.resolve();
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(readSaved().apiKey).toBe('sk-or-second');
  });

  it('does not report connected when the config is edited mid-probe', async () => {
    const onConnected = vi.fn();
    const probe = deferred();
    renderPanel({ onConnected, testConnection: vi.fn(() => probe.promise) });
    saveKey('sk-or-abc');
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('Testing'),
    );
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-edited' } });
    probe.resolve();
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, watch it fail**

```bash
bunx vitest run src/components/features/ai/AiSetupPanel.test.tsx -t "onConnected"
```

Expected: FAIL on "reports connected once" (`expected "spy" to be called once, but got 0 times`) and "reports connected only after the settings are durable" (same). The four "does not report" tests pass already (nothing calls `onConnected` yet); they become meaningful guards once the call exists, and Task 1.8 proves each can go red.

- [ ] **Step 3: Implement**

Replace the probe block of `saveAndTest` (old lines 299-318) with:

```ts
    setConn({ phase: 'testing', source });
    try {
      await testConnection({ config: resolveConfig(), signal: controller.signal });
    } catch (err) {
      // A superseded probe (the user edited or re-saved) must not overwrite the
      // current verdict; ignore its result.
      if (gen !== probeGen.current) {
        return;
      }
      // Never swallow — the specific verdict below is all the user sees.
      safeError('provider.connection_test_failed', err);
      const kind = classifyConnectionError(err);
      // When the failure is otherwise unclassifiable (a 400/429/5xx, e.g. a model
      // rejecting a request param), surface the PROVIDER'S OWN reason so the user
      // isn't stuck on a blind "couldn't connect" with no next step.
      const detail = kind === 'unknown' ? connectionErrorDetail(err) : undefined;
      setConn({ phase: 'error', source, kind, ...(detail ? { detail } : {}) });
      return;
    }
    // Probe-race guard: a superseded probe (edit, re-save, or remote Replace)
    // must never paint Connected or report a connection for a config that is gone.
    if (gen !== probeGen.current) {
      return;
    }
    // Reached only after `await flushSettings()` above resolved (SQLite has the
    // config) AND the probe passed. Called outside the try so a throwing caller
    // can never be misreported as a connection error.
    setConn({ phase: 'connected', source });
    onConnected?.(describeLlmStatus(persisted));
  };
```

The write → `await flushSettings()` → probe order at old lines 283-292 is unchanged; that order is what makes "after the settings are durable" true.

- [ ] **Step 4: Run to green**

```bash
bunx vitest run src/components/features/ai/ src/pages/settings/__tests__/AiSettings.test.tsx
bun run typecheck && bun run lint
```

Expected: all pass, including the original probe-race test "ignores a stale probe result after the config is edited mid-test".

- [ ] **Step 5: Commit**

```bash
git add src/components/features/ai/AiSetupPanel.tsx src/components/features/ai/AiSetupPanel.test.tsx
git commit -m "feat(web): AiSetupPanel onConnected fires only after a passing probe on durable settings"
```

---

### Task 1.6: The AI disclosure renders in the onboarding variant

**Files**
- Modify: `src/components/features/ai/AiSetupPanel.test.tsx` (append to the "surface props" describe)

**Interfaces**
- Consumes: test ids `tier-cloud-honesty` (`tiers.cloud_body`) and `llm-privacy-warning` (`ai.privacy_warning`). See Deviation 1.

- [ ] **Step 1: Write the tests**

```tsx
  it('shows the AI disclosure in the onboarding variant', () => {
    renderPanel({ showOffChoice: false, intro: <p>Your key stays on this device.</p> });
    const disclosure = screen.getByTestId('tier-cloud-honesty');
    expect(disclosure.textContent).toContain('can reveal your birth date');
    expect(disclosure.textContent).toContain('without your name or birth date');
  });

  it('keeps the local-only refusal warning in the onboarding variant', () => {
    renderPanel({ showOffChoice: false });
    fireEvent.change(screen.getByTestId('llm-api-base'), { target: { value: 'https://example.com/v1' } });
    expect(screen.getByTestId('llm-privacy-warning').textContent).toContain('local-only');
  });
```

- [ ] **Step 2: Run**

```bash
bunx vitest run src/components/features/ai/AiSetupPanel.test.tsx -t "onboarding variant"
```

Expected: PASS (2 tests). The disclosure already renders unconditionally; this test pins it so a later "simplify onboarding" change cannot drop it. Task 1.8 shows it going red when the disclosure is hidden.

- [ ] **Step 3: Commit**

```bash
git add src/components/features/ai/AiSetupPanel.test.tsx
git commit -m "test(web): pin the AI disclosure in the onboarding variant of AiSetupPanel"
```

---

### Task 1.7: Real-model key test, wired into the nightly

**Files**
- Create: `frontend/apps/web/e2e/ai-setup-panel.real.spec.ts`
- Create: `frontend/apps/web/playwright.ai-setup.real.config.ts`
- Modify: `frontend/apps/web/package.json` (scripts)
- Modify: `dagger/src/index.ts:105-112`
- Modify: `tests/dagger-nightly-real-skips.test.ts:142`

**Interfaces**
- Consumes: `E2E_REAL_MODEL` (`e2e/realModel.ts`), checked by `src/test/realModelSpecs.contract.test.ts`.

- [ ] **Step 1: Pin the nightly entry first (red)**

In `tests/dagger-nightly-real-skips.test.ts:142` add `"ai:real"` to the list:

```ts
    for (const suite of ["dual-voice", "interp:real", "interp:heal:real", "chat:rag:real", "dashboard:agentic:real", "timeline:real", "ai:real"]) {
```

```bash
cd "$(git rev-parse --show-toplevel)" && bun test tests/dagger-nightly-real-skips.test.ts
```

Expected: FAIL in "the nightly function runs the check after every key-dependent suite" (`expect(source).toContain('  "ai:real",\n')`).

- [ ] **Step 2: Add the suite to the nightly**

`dagger/src/index.ts:105-112`:

```ts
const NIGHTLY_REPORTED_E2E = [
  "dual-voice",
  "interp:real",
  "interp:heal:real",
  "chat:rag:real",
  "dashboard:agentic:real",
  "timeline:real",
  "ai:real",
]
```

Add to `frontend/apps/web/package.json` scripts:

```json
    "test:e2e:ai:real": "playwright test --config=playwright.ai-setup.real.config.ts",
```

- [ ] **Step 3: Write the real spec and its config**

```ts
// frontend/apps/web/e2e/ai-setup-panel.real.spec.ts
import { mkdirSync } from 'node:fs';
import { expect, test, type Request } from '@playwright/test';

import { collectConsoleErrors } from './live/liveJourney';
import { E2E_REAL_MODEL } from './realModel';

/**
 * The shared AI setup panel against LIVE OpenRouter: paste a real key, Save,
 * and the real connectivity probe reports Connected on the cheapest e2e model.
 * No route stubs. The key comes only from the runner's env (never a VITE_ var).
 *
 * Run:  OPENROUTER_API_KEY=... bun run test:e2e:ai:real
 */
const KEY = process.env.OPENROUTER_API_KEY ?? '';

test.describe('AI setup panel — live OpenRouter', () => {
  test.skip(!KEY, 'OPENROUTER_API_KEY is not set: the live key test needs a real OpenRouter key');

  test('[real] Settings → AI connects a live key on the e2e model', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const probes: Request[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/chat/completions')) probes.push(request);
    });

    await page.goto('/settings/ai');
    await expect(page.getByRole('heading', { name: 'AI Model' })).toBeVisible();
    await page.getByTestId('llm-advanced-summary').click();
    await page.getByTestId('llm-model').fill(E2E_REAL_MODEL);
    await page.keyboard.press('Escape');
    await page.getByTestId('llm-openrouter-key').fill(KEY);
    await page.getByTestId('llm-save').click();

    await expect(page.getByTestId('llm-connection-result').first()).toContainText(/Connected/, {
      timeout: 90_000,
    });
    await expect(page.getByTestId('llm-credits-value')).toBeVisible({ timeout: 30_000 });
    expect(probes).toHaveLength(1);
    expect(new URL(probes[0].url()).host).toBe('openrouter.ai');
    expect((probes[0].postDataJSON() as { model: string }).model).toBe(E2E_REAL_MODEL);

    mkdirSync('shots/pr1-ai-setup-panel/real', { recursive: true });
    await page.screenshot({ path: 'shots/pr1-ai-setup-panel/real/settings-ai-live-connected.png', fullPage: true });
    expect(errors).toEqual([]);
  });
});
```

```ts
// frontend/apps/web/playwright.ai-setup.real.config.ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

/**
 * REAL (unstubbed) key test for the shared AI setup panel. Hooks-off build; no
 * chart is generated. OPENROUTER_API_KEY is read by the test process from the
 * parent env and is never bundled into the app. Part of the nightly
 * (NIGHTLY_REPORTED_E2E "ai:real"): a skip there fails the nightly.
 *
 * Run:  bun run test:e2e:ai:real
 */
const PORT = Number(process.env.AI_REAL_E2E_PORT ?? 4190);
const BASE_URL = process.env.AI_REAL_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /ai-setup-panel\.real\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 180_000,
  use: { baseURL: BASE_URL, headless: true, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    cwd: __dirname,
  },
});
```

- [ ] **Step 4: Run the contracts and the spec**

```bash
cd "$(git rev-parse --show-toplevel)" && bun test tests/dagger-nightly-real-skips.test.ts
cd frontend/apps/web
bunx vitest run src/test/realModelSpecs.contract.test.ts
env -u OPENROUTER_API_KEY bun run test:e2e:ai:real    # expect: 1 skipped, reason names OPENROUTER_API_KEY
OPENROUTER_API_KEY=... bun run test:e2e:ai:real                 # the real key, from the runner's env only
```

Expected: dagger test passes; the real-model contract passes (the spec names no model literal); with no key the test skips with the stated reason; with the key it passes (1 passed) and `shots/pr1-ai-setup-panel/real/settings-ai-live-connected.png` exists. If no key is available locally, say so in the PR and point at the nightly run instead.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/e2e/ai-setup-panel.real.spec.ts frontend/apps/web/playwright.ai-setup.real.config.ts frontend/apps/web/package.json dagger/src/index.ts tests/dagger-nightly-real-skips.test.ts
git commit -m "test(e2e): live OpenRouter key test for the AI setup panel, in the nightly"
```

---

### Task 1.8: Mutation red runs

**Files**
- Create: `frontend/apps/web/scripts/mutations/pr1-ai-setup-panel.sh` (chmod +x)

The repo has no mutation harness yet; this creates `scripts/mutations/`. Verdicts come from Vitest's exit code plus its JSON report (a structured count, not grepped output). Each mutation is first proven to apply, and each named test is first proven green and present on the real code, so a red run cannot come from a missing test or a crash.

| Mutation | Marker | Test that must go red |
| --- | --- | --- |
| Fire `onConnected` before `testConnection` resolves | `MUTATION_EARLY_CONNECTED` | "does not report connected on a failed probe" |
| Do not await `flushSettings` before probing | `MUTATION_NO_FLUSH_AWAIT` | "reports connected only after the settings are durable" |
| Skip the `probeGen` check on success | `MUTATION_PROBEGEN` | "does not report connected when a newer save superseded the probe" |
| Hide the disclosure when `showOffChoice` is false | `MUTATION_HIDE_DISCLOSURE` | "shows the AI disclosure in the onboarding variant" |

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# PR 1 mutation red runs for the shared AiSetupPanel.
#
# For each mutation: prove the named test exists and is green on the real code,
# apply the mutation, prove it applied, run the test and require a non-zero exit
# with at least one FAILED test in Vitest's JSON report (a crash is not a red),
# then restore. Ends by requiring a clean tree and no leftover markers.
#
# Run from anywhere:  frontend/apps/web/scripts/mutations/pr1-ai-setup-panel.sh
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$WEB_DIR"

PANEL=src/components/features/ai/AiSetupPanel.tsx
TEST=src/components/features/ai/AiSetupPanel.test.tsx
MARKERS=(MUTATION_EARLY_CONNECTED MUTATION_NO_FLUSH_AWAIT MUTATION_PROBEGEN MUTATION_HIDE_DISCLOSURE)
REPORTS="$(mktemp -d)"
trap 'git checkout -- "$PANEL"; rm -rf "$REPORTS"' EXIT

if ! git diff --quiet; then
  echo "refusing: the working tree has uncommitted changes" >&2
  exit 1
fi

# run_named NAME REPORT -> returns Vitest's exit code
run_named() {
  local code=0
  bunx vitest run "$TEST" -t "$1" --reporter=json --outputFile="$2" >/dev/null 2>&1 || code=$?
  return "$code"
}

# count REPORT FIELD -> prints a number from Vitest's JSON report
count() {
  node -e 'const r = require(process.argv[1]); process.stdout.write(String(r[process.argv[2]] ?? 0))' "$1" "$2"
}

restore_and_fail() {
  git checkout -- "$PANEL"
  echo "FAIL $1" >&2
  exit 1
}

# expect_red LABEL MARKER PERL_EXPR TEST_NAME
expect_red() {
  local label="$1" marker="$2" expr="$3" name="$4"
  local base="$REPORTS/$marker.base.json" mut="$REPORTS/$marker.mut.json"

  run_named "$name" "$base" || restore_and_fail "$label: '$name' is not green on the real code"
  [ "$(count "$base" numPassedTests)" -ge 1 ] || restore_and_fail "$label: '$name' matched no test"

  perl -0pi -e "$expr" "$PANEL"
  grep -q "$marker" "$PANEL" || restore_and_fail "$label: the mutation did not apply"

  if run_named "$name" "$mut"; then
    restore_and_fail "$label: '$name' stayed GREEN under the mutation"
  fi
  local failed
  failed="$(count "$mut" numFailedTests)"
  [ "$failed" -ge 1 ] || restore_and_fail "$label: the run errored without a failing test"

  git checkout -- "$PANEL"
  printf '| %s | %s | RED (exit != 0, %s failed) |\n' "$label" "$name" "$failed"
}

echo '| Mutation | Test | Result |'
echo '| --- | --- | --- |'

expect_red "onConnected before the probe resolves" MUTATION_EARLY_CONNECTED \
  's{(\n    setConn\(\{ phase: \x27testing\x27, source \}\);)}{\n    onConnected?.(describeLlmStatus(persisted)); /* MUTATION_EARLY_CONNECTED */$1}' \
  "does not report connected on a failed probe"

expect_red "probe before flushSettings resolves" MUTATION_NO_FLUSH_AWAIT \
  's{(writeLlmSettings\(\{ \.\.\.next, engine: \x27\x27 \}\);\n\s*)await flushSettings\(\);}{${1}void flushSettings(); /* MUTATION_NO_FLUSH_AWAIT */}' \
  "reports connected only after the settings are durable"

expect_red "skip the probeGen check" MUTATION_PROBEGEN \
  's{(for a config that is gone\.\n\s*)if \(gen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_PROBEGEN */) \{}' \
  "does not report connected when a newer save superseded the probe"

expect_red "hide the disclosure in the onboarding variant" MUTATION_HIDE_DISCLOSURE \
  's{\{t\(\x27tiers\.cloud_body\x27\)\}}{\{showOffChoice ? t(\x27tiers.cloud_body\x27) : null /* MUTATION_HIDE_DISCLOSURE */\}}' \
  "shows the AI disclosure in the onboarding variant"

# Restored: the tree is clean and no marker survives anywhere in the source.
git diff --quiet || { echo "FAIL: the working tree is not clean after restore" >&2; exit 1; }
for marker in "${MARKERS[@]}"; do
  if git grep -q "$marker" -- src; then
    echo "FAIL: $marker left in src" >&2
    exit 1
  fi
done
echo "all ${#MARKERS[@]} mutations went RED; tree restored and clean"
```

- [ ] **Step 2: Run it**

```bash
chmod +x frontend/apps/web/scripts/mutations/pr1-ai-setup-panel.sh
frontend/apps/web/scripts/mutations/pr1-ai-setup-panel.sh | tee /tmp/pr1-red-runs.md; echo "exit=${PIPESTATUS[0]}"
git status --short
```

Expected: a 4-row table, every row `RED`, the final line `all 4 mutations went RED; tree restored and clean`, `exit=0`, and an empty `git status`. Paste `/tmp/pr1-red-runs.md` into the PR body.

If a row stays green: the test or the mutation is wrong. Fix the test (never weaken the mutation) and rerun.

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/web/scripts/mutations/pr1-ai-setup-panel.sh
git commit -m "test(web): PR 1 mutation red runs for AiSetupPanel"
```

---

### Task 1.9: Live end-to-end

PR 1 changes only the Settings → AI journey. The onboarding variant (`showOffChoice={false}`, `intro`, `onConnected`) has no production caller until PR 4; in this PR it is verified by unit tests and the red runs only. Say that in the PR body.

**Files:** none new (uses Task 1.1 and 1.7 specs).

- [ ] **Step 1: Build and preview with no hooks, and look at it yourself**

```bash
cd frontend/apps/web
bun run build && bun run preview --host 127.0.0.1 --port 4189 --strictPort
```

Open `http://127.0.0.1:4189/settings/ai`. Check by eye: heading "AI Model", the AI-off card with "Active", the Connect AI card with the honesty line, the key link, the Advanced panel. Click the header "Set up AI" badge from `/dashboard` or `/` and confirm it lands here (reachability).

- [ ] **Step 2: Drive the journey in both profiles (stubbed provider), screenshot diff included**

With the preview from Step 1 still running (the config reuses it):

```bash
bunx playwright test --config=playwright.ai-setup-panel.config.ts
ls shots/pr1-ai-setup-panel/chromium shots/pr1-ai-setup-panel/iphone-15-webkit
```

Expected: 6 passed. Each test asserts a clean console (`collectConsoleErrors` → `[]`) and a zero-pixel diff against the pre-move baselines. Evidence screenshots:

| Screen | Chromium | iPhone 15 WebKit |
| --- | --- | --- |
| Settings → AI, AI off | `shots/pr1-ai-setup-panel/chromium/settings-ai-off.png` | `shots/pr1-ai-setup-panel/iphone-15-webkit/settings-ai-off.png` |
| Settings → AI, OpenRouter connected | `.../chromium/settings-ai-connected.png` | `.../iphone-15-webkit/settings-ai-connected.png` |
| Settings → AI, local endpoint connected | `.../chromium/settings-ai-local-connected.png` | `.../iphone-15-webkit/settings-ai-local-connected.png` |

- [ ] **Step 3: The unchanged existing e2e**

```bash
bun run test:e2e:ai
git diff --quiet main -- e2e/ai-settings.spec.ts && echo "unchanged"
```

Expected: 1 passed; `unchanged`.

- [ ] **Step 4: The real-model check**

```bash
OPENROUTER_API_KEY=... bun run test:e2e:ai:real
```

Expected: 1 passed, screenshot at `shots/pr1-ai-setup-panel/real/settings-ai-live-connected.png`. Without a key: 1 skipped with the reason, and the PR says "real-model check unverified locally; covered by the nightly".

- [ ] **Step 5: Stop the preview** (Ctrl-C). Nothing to commit; `shots/` is gitignored. Attach the screenshots to the PR.

---

### Task 1.10: Full gate and northstar

- [ ] **Step 1: Quality skills**

Run the `frontend-quality` skill over the changed frontend files. Fix any finding (named exports, `interface` over `type`, hook hygiene, a11y) and rerun the focused tests.

- [ ] **Step 2: The gate**

```bash
cd "$(git rev-parse --show-toplevel)"
make gate; echo "gate exit=$?"
```

Expected: `gate exit=0` (backend poe gate + frontend `bun run gate`, which includes typecheck, lint, knip, all unit suites, build, prerender check).

- [ ] **Step 3: Branch hygiene, push, PR**

```bash
git branch --merged main | grep -v '^\*\|main' || true      # delete any merged branches found
git push -u origin feat/ai-setup-panel
gh pr create --title "refactor(web): one shared AI setup panel (AiSetupPanel)" --body-file /tmp/pr1-body.md
gh pr merge --auto --squash --delete-branch
```

`/tmp/pr1-body.md` contains:

- **Claim touched:** "Your key stays on this device and goes only to the provider you choose." Unchanged; proven by the egress assertions in `e2e/ai-setup-panel.spec.ts` (both profiles) and the onboarding-variant disclosure test.
- What changed: the move, the three new props, `AiModelSettings` deleted, Settings unchanged.
- The deviation that the disclosure is `tiers.cloud_body`, not `ai.privacy_warning` (so PR 4 repeats the right line).
- Red-run table: the output of Task 1.8 (`/tmp/pr1-red-runs.md`), plus the Task 1.1 Step 5 screenshot-diff red run.
- Evidence table: unit test counts, `make gate` exit 0, `test:e2e:ai-panel` 6 passed with zero-pixel diff (both profiles), `test:e2e:ai` 1 passed and the spec unchanged, `test:e2e:ai:real` result (or "unverified locally, nightly covers it"), clean console in every run.
- Screenshots from Task 1.9.
- Unverified in this PR: the onboarding variant has no screen until PR 4.
- Ends with the Claude Code attribution footer.

- [ ] **Step 4: CI green**

```bash
gh pr checks --watch
```

Expected: the required `Dagger` check (and every gate job) green. If a job fails, dispatch `github-actions-agent` with the run id, fix, push.

- [ ] **Step 5: Northstar**

Dispatch the `northstar` agent on the PR, against the named claim, with: the diff, the red-run table, the screenshots, the gate output. Require grade **A**. Fix every punch-list item that blocks A, rerun the affected gate, re-grade.

- [ ] **Step 6: Merge and clean up in the same breath**

After CI green and grade A, the auto-merge lands. Then:

```bash
git -C "$(git rev-parse --show-toplevel)/.." worktree remove .worktrees/ai-setup-panel   # adjust to the actual worktree path
git branch -D feat/ai-setup-panel
gh run list --branch main --limit 1     # CI on main green
```

Expected: worktree gone, local and remote branch gone, `main` CI green. PR 1 is done only at this point.

---

## PR 2: report sections in `@almamesh/llm`

**Branch:** `feat/report-sections-llm` (worktree `almamesh/.worktrees/report-sections-llm`, off `main`)

**Claim touched:** "Readings use month precision only, and every date comes from the engine."

**Depends on:** nothing (runs in parallel with PR 1). PR 3 consumes everything exported here.

**Coordinator test placement (requested extras):**
(a) `computeQuarters` November and December starts + `quarterTitle` "Nov 2026-Jan 2027" -> Task 2.2.
(b) date guard: day-precision `2027-03-14`, month names `March 2027` / `marzo de 2027` / `março de 2027`, technical-voice-only date, removal counting -> Task 2.3.
(c) OpenRouter pricing: model missing -> no estimate; `"0"`/`"0"` -> `{ lowUsd: 0, highUsd: 0 }`; negative / non-numeric -> `pricing` undefined -> `null` estimate -> Task 2.11 (parse) and Task 2.12 (estimate).

**Deviations from CONTRACT.md (names are kept; these are behaviour/placement calls the real code forced):**

1. **v1 generation is not deleted in PR 2.** `apps/web/src/hooks/useStreamingInterpretation.ts` still calls `streamCurrentTimeline` and stores `upcoming_periods`/`current_sky`. Deleting that generator in a library-only PR would break the live dashboard between PR 2 and PR 3. PR 2 adds `streamReportTimeline` (the four new sections) beside it. `streamCurrentTimeline`, `CURRENT_TIMELINE_SECTIONS`, `CurrentTimelineContent`, `CurrentTimelineSectionKey`, `CurrentTimelineEvent` stay exported, marked `@deprecated` for generation. PR 3 switches the hook, then deletes `streamCurrentTimeline` + `UPCOMING_PERIODS_TASK*` + `CURRENT_SKY_TASK` and keeps `CurrentTimelineContent` as the v1 reader type (its `TimelineContentV1` = `{ shape: 'v1' } & CurrentTimelineContent`).
2. **Natal prompts are opt-in.** The longer natal targets and `family_guidance` only apply when the caller passes `promptSet: REPORT_PROMPT_SET` to `streamNatalInterpretation` (new optional param). Without it the five natal prompts stay byte-identical (the existing `prompt-snapshots.test.ts` snapshot proves it). PR 3 passes it. This keeps "User sees: nothing yet".
3. **P90 is asserted only when `REPORT_P90_BUDGET_MS` is set.** `src/test/realModelSpecs.contract.test.ts` forbids a real spec from configuring `PRODUCT_DEFAULT_MODEL`. So the spec reads `process.env.REPORT_REAL_MODEL ?? E2E_REAL_MODEL`; the default-model run is a manual run with `REPORT_REAL_MODEL=deepseek/deepseek-v4.1-flash REPORT_P90_BUDGET_MS=150000`. The nightly runs `E2E_REAL_MODEL` and records P90 without asserting it (v4-pro was 2-3x slower in the 2026-10-01 benchmark).
4. **House-lord facts for `life_outlook_*`** come from a new `SanitizedPredictive.domain_houses` (the engine's own `LifeDomainForecast.houses` rows), not from `SanitizedDomainForecast`. Adding them to `domains` would grow the chat `get_timing` tool payload (`apps/web/src/lib/timingTool.ts:161-164` returns `chart.predictive.domains` as-is, under `AGENT_LIMITS.maxResultChars`).
5. **Additional exports** (new names, no renames): `ReportSectionKey`, `ReportTimelineContent`, `ReportTimelineEvent`, `ReportTimelineParams`, `ReportPromptSet`, `REPORT_SECTIONS`, `REPORT_SECTION_ORDER`, `REPORT_TIMELINE_SECTIONS`, `LIFE_OUTLOOK_GROUPS`, `REPORT_WORD_TARGETS`, `quarterTitle`, `quarterEvents`, `reportAsOfMonth`, `currentPeriodSlice`, `yearAheadSlice`, `lifeOutlookSlice`, `monthsIn`, `ReportParseError`, `parseModelPricing`, `findModelPricing`, `streamReportTimeline`, `SanitizedHouseLord`.
6. **`family_guidance`** is added to `VedicInterpretation` in `@almamesh/shared-types` (optional), because `NatalInterpretation` is `Omit<VedicInterpretation, ...>`. One-line type change outside `@almamesh/llm`.

### File map

| Path (under `frontend/`) | Action | Responsibility |
| --- | --- | --- |
| `apps/web/e2e/sectionUsage.ts` | create | Section marker from a request body; words per voice; per-section usage rows (baseline + real spec) |
| `apps/web/src/test/sectionUsage.test.ts` | create | Unit tests for the helper above |
| `apps/web/e2e/interpretation.real.spec.ts` | modify | Record per-section words + `usage.cost` (baseline); `INTERP_REAL_MODEL` override |
| `apps/web/e2e/timeline.real.spec.ts` | modify | Record per-section words (baseline) |
| `packages/llm/src/quarters.ts` | create | `computeQuarters`, `quarterTitle` |
| `packages/llm/src/date-guard.ts` | create | `validateTimelineDates`, `monthsIn` |
| `packages/llm/src/layman-jargon.ts` | modify | Export `dropSentences`; `stripLaymanJargon` uses it |
| `packages/llm/src/sanitize.ts` | modify | `SanitizedHouseLord`, `SanitizedPredictive.domain_houses` |
| `packages/llm/src/report-sections.ts` | create | Report section keys, types, groups, input slices, `quarterEvents`, parsers |
| `packages/llm/src/report-targets.ts` | create | `REPORT_PROMPT_SET`, `REPORT_WORD_TARGETS`, per-field target sentences |
| `packages/llm/src/predictive-facts.ts` | modify | `buildReportFactsBlock` |
| `packages/llm/src/structured-interpretation.ts` | modify | Report tasks (full + lite), report-v2 natal tasks, `buildSectionMessages` branch, `streamReportTimeline`, `promptSet`, lite ordering, date guard wiring, `buildReportMessages` |
| `packages/llm/src/reasoning.ts` | modify | `REPORT_SECTION_REASONING_MAX_TOKENS = 6_000` |
| `packages/llm/src/cost-estimate.ts` | create | `ModelPricing`, `parseModelPricing`, `findModelPricing`, `READING_OUTPUT_BUDGET`, `estimateReadingCost` |
| `packages/llm/src/client.ts` | modify | `OpenRouterModel.pricing` |
| `packages/llm/src/index.ts` | modify | Export the new surface; keep v1 exports |
| `packages/shared-types/src/index.ts` | modify | `FamilyGuidance`, `VedicInterpretation.family_guidance?` |
| `packages/llm/src/__tests__/report-fixture.ts` | create | Real engine golden chart + predictive, sanitized at a pinned instant |
| `packages/llm/src/__tests__/quarters.test.ts` | create | |
| `packages/llm/src/__tests__/date-guard.test.ts` | create | |
| `packages/llm/src/__tests__/report-slices.test.ts` | create | Input slices, `quarterEvents`, "only domain forecasts" |
| `packages/llm/src/__tests__/report-parsers.test.ts` | create | Unknown quarter keys / domains rejected |
| `packages/llm/src/__tests__/report-prompt-snapshots.test.ts` | create | 9 sections x full/lite x en/es/pt snapshots; no `YYYY-MM-DD` |
| `packages/llm/src/__tests__/report-timeline.test.ts` | create | Generator: events, date guard count, reasoning cap, lite order, family |
| `packages/llm/src/__tests__/report-messages.test.ts` | create | `buildReportMessages` equals what is sent |
| `packages/llm/src/__tests__/cost-estimate.test.ts` | create | |
| `packages/llm/src/client.test.ts` | modify | `pricing` parse on `fetchOpenRouterModels` |
| `packages/llm/src/__tests__/sanitize.test.ts` | modify | `domain_houses` |
| `packages/llm/src/__tests__/report-exports.test.ts` | create | Pins the public surface incl. kept v1 names |
| `apps/web/e2e/report.real.spec.ts` | create | Live 9-section report, 3 runs: P90, cost in range, words +/-30 % |
| `apps/web/playwright.report.real.config.ts` | create | Node-only config for the spec above |
| `apps/web/package.json` | modify | `test:e2e:report:real`, `test:e2e:report:regression` |
| `apps/web/src/test/realModelSpecs.contract.test.ts` | modify | Expect `report.real.spec.ts` in the guarded list |
| `../dagger/src/index.ts` | modify | `"report:real"` in `NIGHTLY_REPORTED_E2E` |
| `../tests/dagger-nightly-real-skips.test.ts` | modify | Same suite in the pinned list |
| `apps/web/e2e/report-regression.spec.ts` | create | Live dashboard journey (no hooks), Chromium + iPhone 15 WebKit, stubbed provider |
| `apps/web/playwright.report-regression.config.ts` | create | Config for the spec above |
| `apps/web/scripts/mutations/pr2-report-sections.sh` | create | Mutation red runs (no harness exists in the repo; this creates the location) |

All commands below run from `frontend/` unless a `cd` says otherwise. The vitest runner for the llm package is `cd packages/llm && bunx vitest run <file>`.

---

### Task 2.1: Baseline - per-section words and `usage.cost` from today's real specs

Record what today's seven sections actually produce before any prompt changes. Numbers go in the PR body.

**Files**
- Create `apps/web/e2e/sectionUsage.ts`
- Create `apps/web/src/test/sectionUsage.test.ts`
- Modify `apps/web/e2e/interpretation.real.spec.ts` (OpenRouter test, lines 183-257: model constant at :193, response capture added before `bootEngine`, JSON write next to the existing `writeFileSync` at :250)
- Modify `apps/web/e2e/timeline.real.spec.ts` (lines 57-75 response listener; lines 116-133 JSON write)

**Interfaces**
- Consumes: `completionUsage(body): CompletionUsage` (`e2e/openrouterUsage.ts`).
- Produces:
  - `sectionOf(requestBody: string): string | null`
  - `wordsPerVoice(content: string): { layman: number; technical: number }`
  - `countWords(text: string): number`
  - `interface SectionUsageRow { section: string; status: number; layman: number; technical: number; costUsd: number; promptTokens: number; completionTokens: number; reasoningTokens: number; provider: string }`
  - `sectionUsageRow(requestBody: string, status: number, responseBody: string): SectionUsageRow | null`

- [ ] **Step 1: failing test** `apps/web/src/test/sectionUsage.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { countWords, sectionOf, sectionUsageRow, wordsPerVoice } from '../../e2e/sectionUsage';

describe('sectionOf', () => {
  it('reads the SECTION marker the structured generator embeds', () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'SECTION:guidance1\n\nTASK' }] });
    expect(sectionOf(body)).toBe('guidance1');
  });

  it('tells current_period from current_sky', () => {
    expect(sectionOf('"SECTION:current_period\\n"')).toBe('current_period');
    expect(sectionOf('"SECTION:current_sky\\n"')).toBe('current_sky');
  });

  it('returns null for a body with no marker', () => {
    expect(sectionOf('{"messages":[]}')).toBeNull();
  });
});

describe('wordsPerVoice', () => {
  it('sums every layman and every technical string, at any depth', () => {
    const content = JSON.stringify({
      summary: { layman: 'one two three', technical: 'four five' },
      strengths: [{ title: 'Ignored title', layman: 'six', technical: 'seven eight nine ten' }],
    });
    expect(wordsPerVoice(content)).toEqual({ layman: 4, technical: 6 });
  });

  it('counts a quarter object (key + layman + technical) by voice', () => {
    const content = JSON.stringify({ quarters: [{ key: 'Q1', layman: 'a b', technical: 'c' }] });
    expect(wordsPerVoice(content)).toEqual({ layman: 2, technical: 1 });
  });

  it('is zero for content that is not JSON', () => {
    expect(wordsPerVoice('not json')).toEqual({ layman: 0, technical: 0 });
  });
});

describe('countWords', () => {
  it('splits on whitespace and ignores empties', () => {
    expect(countWords('  a  b\n c ')).toBe(3);
  });
});

describe('sectionUsageRow', () => {
  it('joins the marker, the voices and OpenRouter usage', () => {
    const request = JSON.stringify({ messages: [{ role: 'user', content: 'SECTION:remedial' }] });
    const response = JSON.stringify({
      provider: 'DeepSeek',
      usage: { cost: 0.0012, prompt_tokens: 900, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 } },
      choices: [{ message: { content: JSON.stringify({ remedial_measures: { layman: 'walk daily', technical: 'Saturn' } }) } }],
    });
    expect(sectionUsageRow(request, 200, response)).toEqual({
      section: 'remedial', status: 200, layman: 2, technical: 1, costUsd: 0.0012,
      promptTokens: 900, completionTokens: 300, reasoningTokens: 100, provider: 'DeepSeek',
    });
  });
});
```

- [ ] **Step 2: run, expect failure**
`cd apps/web && bunx vitest run src/test/sectionUsage.test.ts`
Expected: FAIL, `Failed to resolve import "../../e2e/sectionUsage"`.

- [ ] **Step 3: implement** `apps/web/e2e/sectionUsage.ts`

```ts
/**
 * Per-section numbers for the [real] specs: which section a request was,
 * how many words each voice got, and what OpenRouter charged for it.
 */
import { completionUsage } from './openrouterUsage';

const SECTION_MARKER = /SECTION:([a-z0-9_]+)/;

export function sectionOf(requestBody: string): string | null {
  return SECTION_MARKER.exec(requestBody)?.[1] ?? null;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

type Voices = { layman: number; technical: number };

function addVoices(value: unknown, into: Voices): void {
  if (Array.isArray(value)) {
    for (const item of value) addVoices(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'layman' && typeof child === 'string') into.layman += countWords(child);
    else if (key === 'technical' && typeof child === 'string') into.technical += countWords(child);
    else addVoices(child, into);
  }
}

export function wordsPerVoice(content: string): Voices {
  const voices = { layman: 0, technical: 0 };
  try {
    addVoices(JSON.parse(content) as unknown, voices);
  } catch {
    return voices;
  }
  return voices;
}

export interface SectionUsageRow {
  readonly section: string;
  readonly status: number;
  readonly layman: number;
  readonly technical: number;
  readonly costUsd: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly provider: string;
}

export function sectionUsageRow(requestBody: string, status: number, responseBody: string): SectionUsageRow | null {
  const section = sectionOf(requestBody);
  if (section === null) return null;
  const usage = completionUsage(responseBody);
  return {
    section,
    status,
    ...wordsPerVoice(usage.content),
    costUsd: usage.cost,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    provider: usage.provider,
  };
}
```

- [ ] **Step 4: run, expect pass** - same command. Expected: 8 passed.

- [ ] **Step 5: record in the two real specs**

`interpretation.real.spec.ts`: add at the top `import { sectionUsageRow, type SectionUsageRow } from './sectionUsage';` and below the existing constants `const MODEL = process.env.INTERP_REAL_MODEL ?? E2E_REAL_MODEL;`. In the OpenRouter test replace `model: E2E_REAL_MODEL,` (:193) with `model: MODEL,`, and before `await bootEngine(page);` add:

```ts
  const usageRows: SectionUsageRow[] = [];
  page.on('response', async (res) => {
    if (!res.url().includes('openrouter.ai/api/v1/chat/completions')) return;
    const request = res.request().postData() ?? '';
    const body = await res.text().catch(() => '');
    const row = sectionUsageRow(request, res.status(), body);
    if (row) usageRows.push(row);
  });
```

and next to the existing `writeFileSync(fullTextPath, ...)` (:250):

```ts
  writeFileSync(
    `test-results/interpretation-real-sections-${MODEL.replace(/\W/g, '_')}.json`,
    JSON.stringify({ model: MODEL, sections: usageRows, costUsd: usageRows.reduce((s, r) => s + r.costUsd, 0) }, null, 2),
  );
```

`timeline.real.spec.ts`: import `sectionUsageRow, type SectionUsageRow`; add `const usageRows: SectionUsageRow[] = [];` beside `sectionUsage`, and inside the existing response listener after `sectionUsage.push(...)` add `const row = sectionUsageRow(body, res.status(), text); if (row) usageRows.push(row);`. Add `sections: usageRows,` to the JSON written at :119.

- [ ] **Step 6: typecheck + contract test**
`cd apps/web && bunx tsc --noEmit -p e2e/tsconfig.json && bunx vitest run src/test/realModelSpecs.contract.test.ts src/test/sectionUsage.test.ts`
Expected: no type errors; contract passes (`INTERP_REAL_MODEL ?? E2E_REAL_MODEL` names no slug).

- [ ] **Step 7: run the baseline on both models (3 runs each)**

```bash
cd apps/web
for run in 1 2 3; do
  OPENROUTER_API_KEY=$OPENROUTER_API_KEY bunx playwright test --config=playwright.interpretation.real.config.ts -g 'live OpenRouter'
  cp test-results/interpretation-real-sections-deepseek_deepseek_v4_pro.json /tmp/baseline-interp-v4pro-$run.json
  OPENROUTER_API_KEY=$OPENROUTER_API_KEY INTERP_REAL_MODEL=deepseek/deepseek-v4.1-flash bunx playwright test --config=playwright.interpretation.real.config.ts -g 'live OpenRouter'
  cp test-results/interpretation-real-sections-deepseek_deepseek_v4_1_flash.json /tmp/baseline-interp-flash-$run.json
  OPENROUTER_API_KEY=$OPENROUTER_API_KEY bunx playwright test --config=playwright.timeline.real.config.ts
  cp test-results/timeline-real-timing-deepseek_deepseek_v4_pro.json /tmp/baseline-timeline-v4pro-$run.json
  OPENROUTER_API_KEY=$OPENROUTER_API_KEY TIMELINE_REAL_MODEL=deepseek/deepseek-v4.1-flash bunx playwright test --config=playwright.timeline.real.config.ts
  cp test-results/timeline-real-timing-deepseek_deepseek_v4_1_flash.json /tmp/baseline-timeline-flash-$run.json
done
node -e '
const fs=require("fs");const rows={};
for (const f of fs.readdirSync("/tmp").filter(f=>f.startsWith("baseline-"))) {
  const j=JSON.parse(fs.readFileSync("/tmp/"+f));const m=f.includes("flash")?"flash":"v4pro";
  for (const r of j.sections??[]) { const k=m+" "+r.section; (rows[k]??=[]).push(r); }
}
console.log("| model | section | layman words (median) | technical words (median) | usage.cost USD (median) |");
console.log("|---|---|---|---|---|");
const med=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
for (const [k,rs] of Object.entries(rows).sort()) { const [m,s]=k.split(" ");
  console.log(`| ${m} | ${s} | ${med(rs.map(r=>r.layman))} | ${med(rs.map(r=>r.technical))} | ${med(rs.map(r=>r.costUsd)).toFixed(5)} |`); }'
```

Expected: a 14-row table (7 sections x 2 models). Paste it into the PR body under "Baseline (before)".

- [ ] **Step 8: commit**
```bash
git add apps/web/e2e/sectionUsage.ts apps/web/src/test/sectionUsage.test.ts apps/web/e2e/interpretation.real.spec.ts apps/web/e2e/timeline.real.spec.ts
git commit -m "test(e2e): record words per voice and usage.cost per section in the real specs"
```

---

### Task 2.2: App-computed quarters (`quarters.ts`)

**Files**
- Create `packages/llm/src/quarters.ts`
- Create `packages/llm/src/__tests__/quarters.test.ts`

**Interfaces**
- Consumes: `PromptLanguage` (`language.ts:13`).
- Produces: `type QuarterKey = 'Q1'|'Q2'|'Q3'|'Q4'`; `interface Quarter { key: QuarterKey; months: readonly [string, string, string] }`; `computeQuarters(asOfMonth: string): readonly Quarter[]` (throws on non-`YYYY-MM`); `quarterTitle(quarter: Quarter, language?: PromptLanguage): string`.

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/quarters.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { computeQuarters, quarterTitle } from "../quarters";

const months = (asOf: string) => computeQuarters(asOf).map((q) => [q.key, ...q.months]);

describe("computeQuarters", () => {
  it("counts four quarters from the as-of month", () => {
    expect(months("2026-10")).toEqual([
      ["Q1", "2026-10", "2026-11", "2026-12"],
      ["Q2", "2027-01", "2027-02", "2027-03"],
      ["Q3", "2027-04", "2027-05", "2027-06"],
      ["Q4", "2027-07", "2027-08", "2027-09"],
    ]);
  });

  it("crosses the year inside Q1 for a November start", () => {
    expect(months("2026-11")).toEqual([
      ["Q1", "2026-11", "2026-12", "2027-01"],
      ["Q2", "2027-02", "2027-03", "2027-04"],
      ["Q3", "2027-05", "2027-06", "2027-07"],
      ["Q4", "2027-08", "2027-09", "2027-10"],
    ]);
  });

  it("handles a December start", () => {
    expect(months("2026-12")).toEqual([
      ["Q1", "2026-12", "2027-01", "2027-02"],
      ["Q2", "2027-03", "2027-04", "2027-05"],
      ["Q3", "2027-06", "2027-07", "2027-08"],
      ["Q4", "2027-09", "2027-10", "2027-11"],
    ]);
  });

  it.each(["2026-13", "2026-00", "2026-1", "2026-10-01", "", "Oct 2026"])("refuses %j", (bad) => {
    expect(() => computeQuarters(bad)).toThrow(/YYYY-MM/);
  });
});

describe("quarterTitle", () => {
  it("names a same-year quarter once", () => {
    expect(quarterTitle(computeQuarters("2026-10")[0])).toBe("Oct-Dec 2026");
  });

  it("names both years when the quarter crosses one", () => {
    expect(quarterTitle(computeQuarters("2026-11")[0])).toBe("Nov 2026-Jan 2027");
  });

  it("localizes month names", () => {
    expect(quarterTitle(computeQuarters("2026-11")[0], "es")).toBe("nov 2026-ene 2027");
    expect(quarterTitle(computeQuarters("2026-11")[0], "pt")).toBe("nov. 2026-jan. 2027");
  });
});
```

- [ ] **Step 2: run, expect failure**
`cd packages/llm && bunx vitest run src/__tests__/quarters.test.ts` -> FAIL, cannot resolve `../quarters`.

- [ ] **Step 3: implement** `packages/llm/src/quarters.ts`

```ts
// The year ahead is four quarters counted from the reading's as-of month. The
// app computes them (pure calendar arithmetic, no astrology) and sends the
// keys in the prompt; the parser rejects any key it did not send.

import type { PromptLanguage } from "./language";

export type QuarterKey = "Q1" | "Q2" | "Q3" | "Q4";

export interface Quarter {
  readonly key: QuarterKey;
  /** The quarter's three months, `YYYY-MM`. */
  readonly months: readonly [string, string, string];
}

const QUARTER_KEYS: readonly QuarterKey[] = ["Q1", "Q2", "Q3", "Q4"];
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthAt(year: number, monthIndex: number, offset: number): string {
  const total = year * 12 + monthIndex + offset;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export function computeQuarters(asOfMonth: string): readonly Quarter[] {
  const match = YEAR_MONTH.exec(asOfMonth);
  if (!match) {
    throw new Error(`computeQuarters: expected YYYY-MM, got ${JSON.stringify(asOfMonth)}`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return QUARTER_KEYS.map((key, q) => ({
    key,
    months: [
      monthAt(year, monthIndex, q * 3),
      monthAt(year, monthIndex, q * 3 + 1),
      monthAt(year, monthIndex, q * 3 + 2),
    ] as const,
  }));
}

const LOCALES: Readonly<Record<PromptLanguage, string>> = { en: "en-US", es: "es-ES", pt: "pt-BR" };

function monthParts(yearMonth: string, language: PromptLanguage): { month: string; year: string } {
  const [year, month] = yearMonth.split("-").map(Number);
  const label = new Intl.DateTimeFormat(LOCALES[language], { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
  return { month: label, year: String(year) };
}

/** "Oct-Dec 2026", or "Nov 2026-Jan 2027" when the quarter crosses a year. */
export function quarterTitle(quarter: Quarter, language: PromptLanguage = "en"): string {
  const first = monthParts(quarter.months[0], language);
  const last = monthParts(quarter.months[2], language);
  return first.year === last.year
    ? `${first.month}-${last.month} ${last.year}`
    : `${first.month} ${first.year}-${last.month} ${last.year}`;
}
```

- [ ] **Step 4: run, expect pass** (13 tests). If Node's ICU spells an es/pt short month differently, the failure prints the actual string: pin that literal, do not loosen the assertion.

- [ ] **Step 5: commit**
```bash
git add packages/llm/src/quarters.ts packages/llm/src/__tests__/quarters.test.ts
git commit -m "feat(llm): compute the year-ahead quarters from the as-of month"
```

---

### Task 2.3: The date guard (`date-guard.ts`)

**Files**
- Modify `packages/llm/src/layman-jargon.ts:37-48` (extract `dropSentences`)
- Create `packages/llm/src/date-guard.ts`
- Create `packages/llm/src/__tests__/date-guard.test.ts`

**Interfaces**
- Produces: `dropSentences(text: string, drop: (sentence: string) => boolean): { text: string; dropped: number }` (layman-jargon.ts); `validateTimelineDates<T>(section: T, allowedMonths: ReadonlySet<string>): { section: T; removals: number }`; `monthsIn(value: unknown): ReadonlySet<string>`.

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/date-guard.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { monthsIn, validateTimelineDates } from "../date-guard";

const ALLOWED = new Set(["2027-03", "2027-06"]);

describe("validateTimelineDates", () => {
  it("removes a month the engine did not supply", () => {
    const { section, removals } = validateTimelineDates(
      { layman: "Things open up. A new door appears in 2031-01. Keep going.", technical: "Jupiter." },
      ALLOWED,
    );
    expect(section.layman).toBe("Things open up. Keep going.");
    expect(removals).toBe(1);
  });

  it("keeps a month the engine supplied", () => {
    const input = { layman: "Momentum builds around 2027-03.", technical: "Sun antar from 2027-06." };
    expect(validateTimelineDates(input, ALLOWED)).toEqual({ section: input, removals: 0 });
  });

  it("removes day-precision dates", () => {
    // 2027-03 IS allowed: only the day rule can remove this sentence.
    const { section, removals } = validateTimelineDates(
      { layman: "Mark 2027-03-14 in your calendar. Rest well.", technical: "" },
      ALLOWED,
    );
    expect(section.layman).toBe("Rest well.");
    expect(removals).toBe(1);
  });

  it.each([
    ["en", "A shift comes in March 2028. Stay steady."],
    ["es", "Un cambio llega en marzo de 2028. Mantente firme."],
    ["pt", "Uma mudança chega em março de 2028. Mantenha-se firme."],
  ])("removes a %s month name with a year the engine did not supply", (_lang, text) => {
    const { section, removals } = validateTimelineDates({ layman: text, technical: "" }, ALLOWED);
    expect(section.layman).not.toMatch(/2028/);
    expect(section.layman.length).toBeGreaterThan(0);
    expect(removals).toBe(1);
  });

  it("keeps a month name that matches a supplied month", () => {
    const input = { layman: "Plans firm up in March 2027 and again in junio de 2027.", technical: "" };
    expect(validateTimelineDates(input, ALLOWED).removals).toBe(0);
  });

  it("guards the technical voice on its own", () => {
    const { section, removals } = validateTimelineDates(
      { layman: "A good season for steady work.", technical: "Saturn ingress 2029-11. Mars antar from 2027-06." },
      ALLOWED,
    );
    expect(section.layman).toBe("A good season for steady work.");
    expect(section.technical).toBe("Mars antar from 2027-06.");
    expect(removals).toBe(1);
  });

  it("counts every removal across nested arrays and fields", () => {
    const { section, removals } = validateTimelineDates(
      {
        quarters: [
          { key: "Q1", layman: "Fine in 2027-03. Bad in 2030-01.", technical: "On 2027-03-02 exact." },
          { key: "Q2", layman: "Quiet.", technical: "Also 2030-02. And 2030-03." },
        ],
      },
      ALLOWED,
    );
    expect(removals).toBe(4);
    expect(section.quarters[0]).toEqual({ key: "Q1", layman: "Fine in 2027-03.", technical: "" });
    expect(section.quarters[1].technical).toBe("");
  });

  it("does not mutate its input", () => {
    const input = { layman: "Gone in 2031-01." };
    validateTimelineDates(input, ALLOWED);
    expect(input.layman).toBe("Gone in 2031-01.");
  });
});

describe("monthsIn", () => {
  it("collects every YYYY-MM the engine put in a slice", () => {
    const slice = { a: "2027-03", b: [{ month: "2027-06" }], c: "birth", d: 2027 };
    expect([...monthsIn(slice)].sort()).toEqual(["2027-03", "2027-06"]);
  });
});
```

- [ ] **Step 2: run, expect failure** `cd packages/llm && bunx vitest run src/__tests__/date-guard.test.ts` -> cannot resolve `../date-guard`.

- [ ] **Step 3: extract `dropSentences`** - replace `layman-jargon.ts:37-48` (`stripLaymanJargon`) with:

```ts
/**
 * Drop every sentence for which `drop` is true; everything else is kept
 * byte-for-byte. Text with nothing dropped is returned unchanged. Shared by
 * the jargon guard and the date guard (date-guard.ts).
 */
export function dropSentences(
  text: string,
  drop: (sentence: string) => boolean,
): { text: string; dropped: number } {
  const pieces = text.match(SENTENCE_OR_BREAK) ?? [];
  const kept = pieces.filter((piece) => !drop(piece));
  const dropped = pieces.length - kept.length;
  if (dropped === 0) return { text, dropped: 0 };
  const joined = kept
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: joined, dropped };
}

export function stripLaymanJargon(text: string): string {
  if (!LAYMAN_JARGON.test(text)) return text;
  return dropSentences(text, (piece) => LAYMAN_JARGON.test(piece)).text;
}
```

Run `cd packages/llm && bunx vitest run src/__tests__/layman-jargon.test.ts src/__tests__/structured-layman-guard.test.ts` -> still green (refactor guard).

- [ ] **Step 4: implement** `packages/llm/src/date-guard.ts`

```ts
// The deterministic date guard. Prompt rules ask for month precision and
// engine-only months; this check does not trust them. After a timeline
// section is parsed, any sentence carrying a day-precision date, or a month
// (YYYY-MM or a month name with a year, en/es/pt) that is not in the months
// the engine put in that section's input, is removed. Removals are counted so
// a model that keeps inventing dates is visible.

import { dropSentences } from "./layman-jargon";

const DAY_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const YEAR_MONTH = /\b(\d{4})-(\d{2})\b/g;

const MONTH_NUMBER: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  janeiro: 1, fevereiro: 2, "março": 3, marco: 3, maio: 5, junho: 6, julho: 7,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

const NAMED_MONTH = new RegExp(
  `(?<![\\p{L}])(${Object.keys(MONTH_NUMBER).join("|")})\\.?(?:\\s+de)?\\s+(\\d{4})\\b`,
  "giu",
);

function monthsMentioned(sentence: string): string[] {
  const out: string[] = [];
  for (const [, year, month] of sentence.matchAll(YEAR_MONTH)) out.push(`${year}-${month}`);
  for (const [, name, year] of sentence.matchAll(NAMED_MONTH)) {
    const month = MONTH_NUMBER[name.toLowerCase()];
    if (month !== undefined) out.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return out;
}

function offends(sentence: string, allowed: ReadonlySet<string>): boolean {
  if (DAY_DATE.test(sentence)) return true;
  return monthsMentioned(sentence).some((month) => !allowed.has(month));
}

export function validateTimelineDates<T>(
  section: T,
  allowedMonths: ReadonlySet<string>,
): { section: T; removals: number } {
  let removals = 0;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = dropSentences(value, (sentence) => offends(sentence, allowedMonths));
      removals += result.dropped;
      return result.text;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    }
    return value;
  };
  const guarded = visit(section) as T;
  return { section: guarded, removals };
}

/** Every `YYYY-MM` that appears anywhere in an engine input slice. */
export function monthsIn(value: unknown): ReadonlySet<string> {
  const months = new Set<string>();
  for (const [, year, month] of JSON.stringify(value).matchAll(YEAR_MONTH)) months.add(`${year}-${month}`);
  return months;
}
```

(`visit(section) as T` is the one cast: `visit` rebuilds the same shape with only string values changed.)

- [ ] **Step 5: run, expect pass** -> 11 tests green. Also re-run the jargon suites from Step 3.

- [ ] **Step 6: commit**
```bash
git add packages/llm/src/layman-jargon.ts packages/llm/src/date-guard.ts packages/llm/src/__tests__/date-guard.test.ts
git commit -m "feat(llm): deterministic date guard for timeline prose"
```

---

### Task 2.4: Engine house-lord rows on the sanitized predictive block

**Files**
- Modify `packages/llm/src/sanitize.ts:195-226` (types) and `:557-573` (`sanitizePredictive`)
- Modify `packages/llm/src/__tests__/sanitize.test.ts` (new `it` after :410)

**Interfaces**
- Produces: `interface SanitizedHouseLord { house: number; sign: string; lord: string; lord_house: number; lord_sign: string; lord_dignity: string }`; `SanitizedPredictive.domain_houses?: Readonly<Record<string, readonly SanitizedHouseLord[]>>`.

- [ ] **Step 1: failing test** (append inside the `"sanitizeChartForLlm — predictive contexts"` describe):

```ts
  it("carries each life area's engine house-lord rows, without the rule text", () => {
    const predictive = sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW }).predictive;
    expect(predictive?.domain_houses?.career).toEqual([
      { house: 10, sign: "leo", lord: "sun", lord_house: 11, lord_sign: "virgo", lord_dignity: "neutral" },
    ]);
    // The chat timing tool reads `domains`; the new rows must not grow it.
    expect(JSON.stringify(predictive?.domains)).not.toContain("lord_house");
  });
```

- [ ] **Step 2: run** `cd packages/llm && bunx vitest run src/__tests__/sanitize.test.ts` -> FAIL (`domain_houses` undefined).

- [ ] **Step 3: implement.** After `SanitizedDomainForecast` (:218) add:

```ts
/** One engine house-lord row for a life area (LifeDomainForecast.houses, minus its rule text). */
export interface SanitizedHouseLord {
  readonly house: number;
  readonly sign: string;
  readonly lord: string;
  readonly lord_house: number;
  readonly lord_sign: string;
  readonly lord_dignity: string;
}
```

In `SanitizedPredictive` add `readonly domain_houses?: Readonly<Record<string, readonly SanitizedHouseLord[]>>;`. After `sanitizeDomains` add:

```ts
function sanitizeDomainHouses(ctx: LifeDomainsContext): Readonly<Record<string, readonly SanitizedHouseLord[]>> {
  return Object.fromEntries(
    Object.values(ctx.forecasts).map((forecast) => [
      forecast.domain,
      // `houses` is required by the engine type; a hand-built forecast in an
      // older test may omit it, and an absent list is simply no rows.
      (forecast.houses ?? []).map(({ house, sign, lord, lord_house, lord_sign, lord_dignity }) => ({
        house, sign, lord, lord_house, lord_sign, lord_dignity,
      })),
    ]),
  );
}
```

and in `sanitizePredictive` replace the domains spread with
`...(domains ? { domains: sanitizeDomains(domains), domain_houses: sanitizeDomainHouses(domains) } : {}),`.

- [ ] **Step 4: run** the sanitize suite plus `facts.test.ts`, `predictive-prompt.test.ts`, `prompt-snapshots.test.ts` -> all green (the facts block does not print `domain_houses`, so no snapshot moves). Then `cd ../../apps/web && bunx vitest run src/lib/__tests__/timingTool.test.ts` -> green.

- [ ] **Step 5: commit**
```bash
git add packages/llm/src/sanitize.ts packages/llm/src/__tests__/sanitize.test.ts
git commit -m "feat(llm): carry each life area's engine house-lord rows through the sanitizer"
```

---

### Task 2.5: Report section keys, types and input slices (`report-sections.ts`)

**Files**
- Create `packages/llm/src/report-sections.ts`
- Modify `packages/llm/src/predictive-facts.ts` (append `buildReportFactsBlock` after `buildPredictiveFactsBlock`, :154-174)
- Create `packages/llm/src/__tests__/report-fixture.ts`
- Create `packages/llm/src/__tests__/report-slices.test.ts`

**Interfaces**
- Consumes: `SanitizedChart`, `SanitizedDomainForecast`, `SanitizedHouseLord`, `SanitizedCurrentPeriod`, `SanitizedDatedPeriod`, `SanitizedFusion`, `SanitizedSadeSati` (sanitize.ts); `Persona`, `TitledPersona`, `LifeDomain` (`@almamesh/shared-types`); `computeQuarters`, `Quarter`, `QuarterKey`.
- Produces:
  - `type ReportTimelineSectionKey = 'current_period'|'year_ahead'|'life_outlook_1'|'life_outlook_2'`; `REPORT_TIMELINE_SECTIONS` (that order); `isReportTimelineSection(key: string): key is ReportTimelineSectionKey`
  - `interface CurrentPeriodSection { maha: Persona; antar: Persona; activates: TitledPersona[]; next_change: Persona }`
  - `interface QuarterProse { key: QuarterKey; layman: string; technical: string }`
  - `interface YearAheadSection { headline: Persona; quarters: QuarterProse[]; focus?: Persona }`
  - `interface LifeOutlookDomain { domain: LifeDomain; outlook: Persona; lean_into?: string; watch_for?: string }`; `interface LifeOutlookSection { domains: LifeOutlookDomain[] }`
  - `interface ReportTimelineContent { current_period: CurrentPeriodSection | null; year_ahead: YearAheadSection | null; life_outlook: { life_outlook_1: LifeOutlookSection | null; life_outlook_2: LifeOutlookSection | null } }` (nullable per section, so a failed call is visible after reload)
  - `LIFE_OUTLOOK_GROUPS: { life_outlook_1: readonly ['career','finances','relationships','family']; life_outlook_2: readonly ['health','education','spiritual'] }`
  - `reportAsOfMonth(chart: SanitizedChart): string`
  - `currentPeriodSlice(chart): CurrentPeriodInput`, `yearAheadSlice(chart): YearAheadInput`, `lifeOutlookSlice(chart, section: 'life_outlook_1'|'life_outlook_2'): LifeOutlookInput`, `reportSlice(section, chart): CurrentPeriodInput | YearAheadInput | LifeOutlookInput`
  - `quarterEvents(chart: SanitizedChart, quarter: Quarter): readonly QuarterEvent[]` (PR 3 draws these under each quarter, so the screen and the prompt share one list)
  - `buildReportFactsBlock(slice: object): string` (predictive-facts.ts)

- [ ] **Step 1: fixture** `packages/llm/src/__tests__/report-fixture.ts` (real engine output, sanitized at a pinned instant):

```ts
import type { SiderealChart } from "@almamesh/browser/types";

import chartGolden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import predictiveGolden from "../../../../../backend/tests/fixtures/predictive_golden_de421.json";
import { sanitizeChartForLlm, type AnalysisInstant, type SanitizedChart } from "../sanitize";

const KEY = "1990-01-15T12:00:00+00:00";
const natal = (chartGolden as Record<string, SiderealChart>)[KEY];
const predictive = (predictiveGolden as unknown as Record<string, Partial<SiderealChart>>)[KEY];

/** The engine golden chart with its predictive contexts, as the app holds it. */
export const REPORT_RAW_CHART: SiderealChart = { ...natal, ...predictive };
/** The predictive golden's own instant (2026-06-09T12:00Z), so dashas and transits agree. */
export const REPORT_AS_OF: AnalysisInstant = { basis: "chart", instant: new Date("2026-06-09T12:00:00Z") };
export const REPORT_CHART: SanitizedChart = sanitizeChartForLlm(REPORT_RAW_CHART, REPORT_AS_OF);
```

- [ ] **Step 2: failing test** `packages/llm/src/__tests__/report-slices.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { buildReportFactsBlock } from "../predictive-facts";
import { computeQuarters } from "../quarters";
import {
  currentPeriodSlice,
  lifeOutlookSlice,
  quarterEvents,
  reportAsOfMonth,
  yearAheadSlice,
} from "../report-sections";
import type { SanitizedChart } from "../sanitize";
import { REPORT_CHART } from "./report-fixture";

const DAY = /\b\d{4}-\d{2}-\d{2}\b/;

// Small hand-built chart for exact event placement.
const SMALL: SanitizedChart = {
  ...REPORT_CHART,
  as_of: { date: "2026-10-10", basis: "chart" },
  dashas: {
    maha_dasha_sequence: [
      {
        lord: "saturn", status: "current (3 years remaining)", start_month: "2010-05", end_month: "2029-05",
        antar_sequence: [
          { lord: "mercury", start_month: "2025-02", end_month: "2026-12" },
          { lord: "ketu", start_month: "2026-12", end_month: "2028-01" },
        ],
      },
      { lord: "mercury", status: "future (starts in 3 years)", start_month: "2029-05", end_month: "2046-05" },
    ],
    current_maha: { lord: "saturn", months_remaining: 31, start_month: "2010-05", end_month: "2029-05" },
    current_antar: { lord: "mercury", months_remaining: 2, start_month: "2025-02", end_month: "2026-12" },
    current_pratyantar: null,
  },
  predictive: {
    transits: {
      gochara: [],
      sade_sati: { is_active: true, current_phase: "setting", natal_moon_sign: "aquarius", until_month: "2027-02" },
      fusion: {
        maha_lord: "saturn", antar_lord: "mercury", maha_lord_transit_house_from_moon: 2,
        maha_lord_transit_house_from_lagna: 11, reinforcing: [], afflicting: ["mars"], severity: "mixed",
      },
      slow_hits: [{ graha: "jupiter", kind: "return", natal_point: "jupiter", month: "2027-05", severity: "supportive" }],
      timeline: [
        { month: "2026-11", kind: "sign_ingress", graha: "mars", from_sign: "libra", to_sign: "scorpio",
          station_direction: null, station_sign: null, severity: "neutral", descriptor: "Mars changes sign" },
        { month: "2028-01", kind: "sign_ingress", graha: "saturn", from_sign: "pisces", to_sign: "aries",
          station_direction: null, station_sign: null, severity: "challenging", descriptor: "Outside the year" },
      ],
    },
    domains: REPORT_CHART.predictive?.domains ?? [],
    domain_houses: REPORT_CHART.predictive?.domain_houses ?? {},
    strength: { sav_total: 337, shadbala: [] },
  },
};

describe("reportAsOfMonth", () => {
  it("is the month of the chart's as-of date", () => {
    expect(reportAsOfMonth(SMALL)).toBe("2026-10");
  });
});

describe("currentPeriodSlice", () => {
  it("carries the running periods, the current maha's antars, the next maha, fusion and lord facts", () => {
    const slice = currentPeriodSlice(SMALL);
    expect(slice.as_of_month).toBe("2026-10");
    expect(slice.current_maha?.lord).toBe("saturn");
    expect(slice.antar_sequence.map((r) => r.lord)).toEqual(["mercury", "ketu"]);
    expect(slice.next_maha).toEqual({ lord: "mercury", start_month: "2029-05", end_month: "2046-05" });
    expect(slice.fusion?.severity).toBe("mixed");
    expect(slice.lord_facts.map((f) => f.lord)).toEqual(["saturn", "mercury"]);
  });

  it("carries nothing else from the predictive block", () => {
    const json = JSON.stringify(currentPeriodSlice(SMALL));
    for (const needle of ["gochara", "slow_hits", "sav_total", "\"domain\"", "descriptor"]) {
      expect(json).not.toContain(needle);
    }
  });
});

describe("quarterEvents / yearAheadSlice", () => {
  it("files each engine event under the quarter whose months contain it", () => {
    const [q1, q2, q3] = computeQuarters("2026-10");
    expect(quarterEvents(SMALL, q1).map((e) => `${e.month} ${e.source}`)).toEqual([
      "2026-11 transit",
      "2026-12 dasha",
    ]);
    expect(quarterEvents(SMALL, q2).map((e) => `${e.month} ${e.source}`)).toEqual(["2027-02 sade_sati"]);
    expect(quarterEvents(SMALL, q3).map((e) => `${e.month} ${e.source}`)).toEqual(["2027-05 slow_hit"]);
  });

  it("leaves events outside the twelve months out", () => {
    expect(JSON.stringify(yearAheadSlice(SMALL))).not.toContain("Outside the year");
  });

  it("sends the four quarter keys and their months", () => {
    const slice = yearAheadSlice(SMALL);
    expect(slice.quarters.map((q) => q.key)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(slice.quarters[0].months).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
});

describe("lifeOutlookSlice", () => {
  it("passes life_outlook_1 only its four domain forecasts plus their house-lord rows", () => {
    const slice = lifeOutlookSlice(REPORT_CHART, "life_outlook_1");
    expect(slice.domains.map((d) => d.domain)).toEqual(["career", "finances", "relationships", "family"]);
    expect(slice.domains[0].house_lords.length).toBeGreaterThan(0);
    const json = JSON.stringify(slice);
    for (const needle of ["gochara", "sade_sati\"", "fusion", "slow_hits", "sav_total", "vimshopaka", "\"timeline\""]) {
      expect(json).not.toContain(needle);
    }
    for (const other of ["health", "education", "spiritual"]) {
      expect(json).not.toContain(`"domain":"${other}"`);
    }
  });

  it("passes life_outlook_2 the other three", () => {
    expect(lifeOutlookSlice(REPORT_CHART, "life_outlook_2").domains.map((d) => d.domain)).toEqual([
      "health", "education", "spiritual",
    ]);
  });
});

describe("buildReportFactsBlock", () => {
  it("wraps a slice in the engine-facts delimiters with no day-precision date", () => {
    for (const slice of [currentPeriodSlice(REPORT_CHART), yearAheadSlice(REPORT_CHART), lifeOutlookSlice(REPORT_CHART, "life_outlook_1")]) {
      const block = buildReportFactsBlock(slice);
      expect(block.startsWith("=== ENGINE REPORT FACTS")).toBe(true);
      expect(block).toContain("=== END ENGINE REPORT FACTS ===");
      expect(block).not.toMatch(DAY);
    }
  });
});
```

- [ ] **Step 3: run, expect failure** `cd packages/llm && bunx vitest run src/__tests__/report-slices.test.ts` -> cannot resolve `../report-sections`.

- [ ] **Step 4: implement** `packages/llm/src/report-sections.ts` (types, groups, slices; parsers come in Task 2.6):

```ts
// The four timeline sections of the report (Section 2 of the 2026-10-10
// reading-in-onboarding spec): their keys, their output types, and the slice
// of the ALREADY-SANITIZED chart each one may see. Slices are reshapes of
// sanitize.ts output only: no astrology is computed here.

import type { LifeDomain, Persona, TitledPersona } from "@almamesh/shared-types";

import { computeQuarters, type Quarter, type QuarterKey } from "./quarters";
import type {
  SanitizedChart,
  SanitizedCurrentPeriod,
  SanitizedDatedPeriod,
  SanitizedDomainForecast,
  SanitizedFusion,
  SanitizedHouseLord,
  SanitizedSadeSati,
} from "./sanitize";

export type ReportTimelineSectionKey = "current_period" | "year_ahead" | "life_outlook_1" | "life_outlook_2";

/** Run order: the two life-outlook calls go last (owner ruling 7). */
export const REPORT_TIMELINE_SECTIONS = [
  "current_period",
  "year_ahead",
  "life_outlook_1",
  "life_outlook_2",
] as const satisfies readonly ReportTimelineSectionKey[];

export function isReportTimelineSection(key: string): key is ReportTimelineSectionKey {
  return (REPORT_TIMELINE_SECTIONS as readonly string[]).includes(key);
}

export interface CurrentPeriodSection {
  readonly maha: Persona;
  readonly antar: Persona;
  readonly activates: TitledPersona[];
  readonly next_change: Persona;
}

export interface QuarterProse {
  readonly key: QuarterKey;
  readonly layman: string;
  readonly technical: string;
}

export interface YearAheadSection {
  readonly headline: Persona;
  readonly quarters: QuarterProse[];
  readonly focus?: Persona;
}

export interface LifeOutlookDomain {
  readonly domain: LifeDomain;
  readonly outlook: Persona;
  readonly lean_into?: string;
  readonly watch_for?: string;
}

export interface LifeOutlookSection {
  readonly domains: LifeOutlookDomain[];
}

/** What `streamReportTimeline` completes with (PR 3 stores it as timeline `shape: 'v2'`). */
export interface ReportTimelineContent {
  readonly current_period: CurrentPeriodSection | null;
  readonly year_ahead: YearAheadSection | null;
  /** One entry per outlook call; null = that call failed or never ran. Cards render in LIFE_DOMAIN_ORDER. */
  readonly life_outlook: {
    readonly life_outlook_1: LifeOutlookSection | null;
    readonly life_outlook_2: LifeOutlookSection | null;
  };
}

export const LIFE_OUTLOOK_GROUPS = {
  life_outlook_1: ["career", "finances", "relationships", "family"],
  life_outlook_2: ["health", "education", "spiritual"],
} as const satisfies Record<"life_outlook_1" | "life_outlook_2", readonly LifeDomain[]>;

export type LifeOutlookSectionKey = keyof typeof LIFE_OUTLOOK_GROUPS;

/** The life-area card order on screen. */
export const LIFE_DOMAIN_ORDER: readonly LifeDomain[] = [
  ...LIFE_OUTLOOK_GROUPS.life_outlook_1,
  ...LIFE_OUTLOOK_GROUPS.life_outlook_2,
];

// --- input slices --------------------------------------------------------------

export function reportAsOfMonth(chart: SanitizedChart): string {
  return chart.as_of.date.slice(0, 7);
}

export interface LordFacts {
  readonly lord: string;
  readonly sign?: string;
  readonly house?: number;
  readonly dignity?: string;
  readonly houses_ruled?: readonly number[];
  readonly is_yogakaraka?: boolean;
  readonly is_combust?: boolean;
  readonly is_retrograde?: boolean;
  /** Names of LISTED yogas this graha takes part in. */
  readonly yogas: readonly string[];
}

function lordFacts(chart: SanitizedChart, lord: string): LordFacts {
  const yogas = chart.yogas.filter((yoga) => yoga.planets_involved.includes(lord)).map((yoga) => yoga.name);
  const planet = chart.planets[lord];
  if (!planet) return { lord, yogas };
  return {
    lord,
    sign: planet.sign,
    house: planet.house,
    dignity: planet.dignity,
    houses_ruled: planet.houses_ruled,
    is_yogakaraka: planet.is_yogakaraka,
    is_combust: planet.is_combust,
    is_retrograde: planet.is_retrograde,
    yogas,
  };
}

export interface NextMaha {
  readonly lord: string;
  readonly start_month: string | null;
  readonly end_month: string | null;
}

export interface CurrentPeriodInput {
  readonly as_of_month: string;
  readonly current_maha: SanitizedCurrentPeriod | null;
  readonly current_antar: SanitizedCurrentPeriod | null;
  readonly current_pratyantar: SanitizedCurrentPeriod | null;
  readonly antar_sequence: readonly SanitizedDatedPeriod[];
  readonly pratyantar_sequence: readonly SanitizedDatedPeriod[];
  readonly next_maha: NextMaha | null;
  readonly fusion: SanitizedFusion | null;
  readonly lord_facts: readonly LordFacts[];
}

function currentMahaIndex(chart: SanitizedChart): number {
  return (chart.dashas?.maha_dasha_sequence ?? []).findIndex((row) => row.status.startsWith("current"));
}

export function currentPeriodSlice(chart: SanitizedChart): CurrentPeriodInput {
  const dashas = chart.dashas;
  const sequence = dashas?.maha_dasha_sequence ?? [];
  const index = currentMahaIndex(chart);
  const current = index >= 0 ? sequence[index] : undefined;
  const next = index >= 0 ? sequence[index + 1] : undefined;
  const lords = [dashas?.current_maha?.lord, dashas?.current_antar?.lord, dashas?.current_pratyantar?.lord, next?.lord]
    .filter((lord): lord is string => typeof lord === "string");
  return {
    as_of_month: reportAsOfMonth(chart),
    current_maha: dashas?.current_maha ?? null,
    current_antar: dashas?.current_antar ?? null,
    current_pratyantar: dashas?.current_pratyantar ?? null,
    antar_sequence: current?.antar_sequence ?? [],
    pratyantar_sequence: dashas?.pratyantar_sequence ?? [],
    next_maha: next ? { lord: next.lord, start_month: next.start_month ?? null, end_month: next.end_month ?? null } : null,
    fusion: chart.predictive?.transits?.fusion ?? null,
    lord_facts: [...new Set(lords)].map((lord) => lordFacts(chart, lord)),
  };
}

export interface QuarterEvent {
  readonly month: string;
  readonly source: "dasha" | "transit" | "slow_hit" | "sade_sati";
  readonly what: string;
  readonly severity: string | null;
}

function dashaEvents(chart: SanitizedChart): QuarterEvent[] {
  const slice = currentPeriodSlice(chart);
  const antars = slice.antar_sequence.map((row) => ({
    month: row.start_month, source: "dasha" as const, what: `${row.lord} antardasha begins`, severity: null,
  }));
  const next = slice.next_maha?.start_month
    ? [{ month: slice.next_maha.start_month, source: "dasha" as const, what: `${slice.next_maha.lord} mahadasha begins`, severity: null }]
    : [];
  return [...antars, ...next];
}

function transitEvents(chart: SanitizedChart): QuarterEvent[] {
  const transits = chart.predictive?.transits;
  if (!transits) return [];
  const timeline = transits.timeline.map((event) => ({
    month: event.month,
    source: "transit" as const,
    what: [event.kind, event.graha, event.from_sign && event.to_sign ? `${event.from_sign} -> ${event.to_sign}` : null, event.descriptor]
      .filter(Boolean)
      .join(" "),
    severity: event.severity,
  }));
  const slow = transits.slow_hits.map((hit) => ({
    month: hit.month, source: "slow_hit" as const, what: `${hit.graha} ${hit.kind} on natal ${hit.natal_point}`, severity: hit.severity,
  }));
  const sadeSati = transits.sade_sati.is_active && transits.sade_sati.until_month
    ? [{ month: transits.sade_sati.until_month, source: "sade_sati" as const, what: `Sade Sati (${transits.sade_sati.current_phase} phase) ends`, severity: null }]
    : [];
  return [...timeline, ...slow, ...sadeSati];
}

/** The engine's events inside one quarter, by month (stable within a month). */
export function quarterEvents(chart: SanitizedChart, quarter: Quarter): readonly QuarterEvent[] {
  const months = new Set<string>(quarter.months);
  return [...dashaEvents(chart), ...transitEvents(chart)]
    .filter((event) => months.has(event.month))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export interface YearAheadInput {
  readonly as_of_month: string;
  readonly sade_sati: SanitizedSadeSati | null;
  readonly quarters: readonly { readonly key: QuarterKey; readonly months: Quarter["months"]; readonly events: readonly QuarterEvent[] }[];
}

export function yearAheadSlice(chart: SanitizedChart): YearAheadInput {
  const asOf = reportAsOfMonth(chart);
  return {
    as_of_month: asOf,
    sade_sati: chart.predictive?.transits?.sade_sati ?? null,
    quarters: computeQuarters(asOf).map((quarter) => ({
      key: quarter.key,
      months: quarter.months,
      events: quarterEvents(chart, quarter),
    })),
  };
}

export interface LifeOutlookDomainInput extends SanitizedDomainForecast {
  readonly house_lords: readonly SanitizedHouseLord[];
}

export interface LifeOutlookInput {
  readonly as_of_month: string;
  readonly domains: readonly LifeOutlookDomainInput[];
}

export function lifeOutlookSlice(chart: SanitizedChart, section: LifeOutlookSectionKey): LifeOutlookInput {
  const forecasts = chart.predictive?.domains ?? [];
  const houses = chart.predictive?.domain_houses ?? {};
  const group: readonly string[] = LIFE_OUTLOOK_GROUPS[section];
  return {
    as_of_month: reportAsOfMonth(chart),
    domains: group.flatMap((domain) => {
      const forecast = forecasts.find((row) => row.domain === domain);
      return forecast ? [{ ...forecast, house_lords: houses[domain] ?? [] }] : [];
    }),
  };
}

export function reportSlice(
  section: ReportTimelineSectionKey,
  chart: SanitizedChart,
): CurrentPeriodInput | YearAheadInput | LifeOutlookInput {
  switch (section) {
    case "current_period":
      return currentPeriodSlice(chart);
    case "year_ahead":
      return yearAheadSlice(chart);
    case "life_outlook_1":
    case "life_outlook_2":
      return lifeOutlookSlice(chart, section);
  }
}
```

Append to `predictive-facts.ts`:

```ts
export const REPORT_FACTS_START = "=== ENGINE REPORT FACTS (deterministic engine output) ===";
export const REPORT_FACTS_END = "=== END ENGINE REPORT FACTS ===";

/** One report section's engine slice (report-sections.ts) as a delimited, narrate-only block. */
export function buildReportFactsBlock(slice: object): string {
  return [REPORT_FACTS_START, PREDICTIVE_GUARD, "", JSON.stringify(slice), REPORT_FACTS_END].join("\n");
}
```

- [ ] **Step 5: run, expect pass** -> all `report-slices.test.ts` green. If the golden chart's dashas carry no `antar_sequence`, the `report-fixture` is wrong for this purpose: regenerate nothing, but switch `KEY` to the first golden key whose current maha has `antar_sequence` and say so in the commit message.

- [ ] **Step 6: commit**
```bash
git add packages/llm/src/report-sections.ts packages/llm/src/predictive-facts.ts packages/llm/src/__tests__/report-fixture.ts packages/llm/src/__tests__/report-slices.test.ts
git commit -m "feat(llm): report timeline section types and per-section engine slices"
```

---

### Task 2.6: Parsers that reject unknown quarter keys and domains

**Files**
- Modify `packages/llm/src/report-sections.ts` (append parsers)
- Create `packages/llm/src/__tests__/report-parsers.test.ts`

**Interfaces**
- Consumes: `asPersona`-style coercion. The private helpers in `structured-interpretation.ts:805-861` (`asString`, `asLayman`, `asPersona`, `parsePersona`, `parseTitledPersonas`) move to a new internal module `packages/llm/src/persona-parse.ts` (exported from there, not from the package index) so both files share them; `structured-interpretation.ts` imports them back. No behaviour change.
- Produces: `class ReportParseError extends Error`; `parseCurrentPeriod(json: unknown): CurrentPeriodSection`; `parseYearAhead(json: unknown, sent: readonly QuarterKey[]): YearAheadSection`; `parseLifeOutlook(json: unknown, group: readonly LifeDomain[]): LifeOutlookDomain[]`.

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/report-parsers.test.ts`

```ts
import { describe, expect, it } from "vitest";

import {
  LIFE_OUTLOOK_GROUPS,
  parseCurrentPeriod,
  parseLifeOutlook,
  parseYearAhead,
  ReportParseError,
} from "../report-sections";

const KEYS = ["Q1", "Q2", "Q3", "Q4"] as const;
const p = (text: string) => ({ layman: text, technical: text });

describe("parseYearAhead", () => {
  it("keeps the sent quarters and the optional focus", () => {
    const parsed = parseYearAhead(
      { headline: p("A building year."), quarters: KEYS.map((key) => ({ key, ...p(`${key} prose.`) })), focus: p("Focus.") },
      KEYS,
    );
    expect(parsed.quarters.map((q) => q.key)).toEqual(KEYS);
    expect(parsed.focus).toEqual(p("Focus."));
  });

  it("omits focus when the model sent none (lite)", () => {
    expect(parseYearAhead({ headline: p("h"), quarters: [] }, KEYS)).not.toHaveProperty("focus");
  });

  it("rejects a quarter key it did not send", () => {
    expect(() => parseYearAhead({ headline: p("h"), quarters: [{ key: "Q5", ...p("x") }] }, KEYS)).toThrow(ReportParseError);
    expect(() => parseYearAhead({ headline: p("h"), quarters: [{ key: "2027-01", ...p("x") }] }, KEYS)).toThrow(/not sent/);
  });

  it("rejects a repeated quarter key", () => {
    expect(() => parseYearAhead({ headline: p("h"), quarters: [{ key: "Q1", ...p("a") }, { key: "Q1", ...p("b") }] }, KEYS)).toThrow(ReportParseError);
  });

  it("strips jargon from the layman voice of a quarter", () => {
    const parsed = parseYearAhead({ headline: p("h"), quarters: [{ key: "Q1", layman: "Saturn moves. Rest.", technical: "Saturn." }] }, KEYS);
    expect(parsed.quarters[0].layman).toBe("Rest.");
  });
});

describe("parseLifeOutlook", () => {
  it("keeps the group's domains with their one-liners", () => {
    const parsed = parseLifeOutlook(
      { domains: [{ domain: "career", outlook: p("Good."), lean_into: "Ask for more.", watch_for: "Overwork." }] },
      LIFE_OUTLOOK_GROUPS.life_outlook_1,
    );
    expect(parsed).toEqual([{ domain: "career", outlook: p("Good."), lean_into: "Ask for more.", watch_for: "Overwork." }]);
  });

  it("rejects an unknown domain", () => {
    expect(() => parseLifeOutlook({ domains: [{ domain: "luck", outlook: p("x") }] }, LIFE_OUTLOOK_GROUPS.life_outlook_1)).toThrow(ReportParseError);
  });

  it("rejects a real domain that belongs to the other call", () => {
    expect(() => parseLifeOutlook({ domains: [{ domain: "health", outlook: p("x") }] }, LIFE_OUTLOOK_GROUPS.life_outlook_1)).toThrow(/not in this section/);
  });

  it("drops empty one-liners instead of storing blanks (lite)", () => {
    expect(parseLifeOutlook({ domains: [{ domain: "health", outlook: "Rest." }] }, LIFE_OUTLOOK_GROUPS.life_outlook_2)).toEqual([
      { domain: "health", outlook: { layman: "Rest.", technical: "Rest." } },
    ]);
  });
});

describe("parseCurrentPeriod", () => {
  it("parses all four parts; lite has no activates", () => {
    expect(parseCurrentPeriod({ maha: p("m"), antar: p("a"), next_change: p("n") })).toEqual({
      maha: p("m"), antar: p("a"), activates: [], next_change: p("n"),
    });
  });
});
```

- [ ] **Step 2: run** `cd packages/llm && bunx vitest run src/__tests__/report-parsers.test.ts` -> FAIL (`parseYearAhead` is not exported).

- [ ] **Step 3: move the shared helpers.** Create `packages/llm/src/persona-parse.ts` containing `asString`, `asLayman`, `asPersona`, `asRecord`, `parsePersona`, `parseTitledPersonas`, moved verbatim from `structured-interpretation.ts:805-861` and each marked `export`; delete them there and add `import { asLayman, asPersona, asRecord, asString, parsePersona, parseTitledPersonas } from "./persona-parse";`. Run `bunx vitest run src/__tests__/structured-interpretation.test.ts src/__tests__/structured-layman-guard.test.ts` -> green.

- [ ] **Step 4: implement parsers** (append to `report-sections.ts`; add `import { asLayman, asPersona, asRecord, asString, parsePersona, parseTitledPersonas } from "./persona-parse";`):

```ts
/** A model reply that names a quarter or a life area the app did not send. */
export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportParseError";
  }
}

export function parseCurrentPeriod(json: unknown): CurrentPeriodSection {
  const rec = asRecord(json);
  return {
    maha: asPersona(rec.maha),
    antar: asPersona(rec.antar),
    activates: parseTitledPersonas(rec.activates),
    next_change: asPersona(rec.next_change),
  };
}

function isSentQuarter(key: string, sent: readonly QuarterKey[]): key is QuarterKey {
  return (sent as readonly string[]).includes(key);
}

export function parseYearAhead(json: unknown, sent: readonly QuarterKey[]): YearAheadSection {
  const rec = asRecord(json);
  const rows = Array.isArray(rec.quarters) ? rec.quarters.map(asRecord) : [];
  const seen = new Set<QuarterKey>();
  const quarters = rows.map((row): QuarterProse => {
    const key = asString(row.key);
    if (!isSentQuarter(key, sent) || seen.has(key)) {
      throw new ReportParseError(`year_ahead: quarter key ${JSON.stringify(key)} was not sent (or repeated)`);
    }
    seen.add(key);
    return { key, layman: asLayman(row.layman), technical: asString(row.technical) };
  });
  const focus = parsePersona(rec.focus);
  return { headline: asPersona(rec.headline), quarters, ...(focus ? { focus } : {}) };
}

function isGroupDomain(domain: string, group: readonly LifeDomain[]): domain is LifeDomain {
  return (group as readonly string[]).includes(domain);
}

export function parseLifeOutlook(json: unknown, group: readonly LifeDomain[]): LifeOutlookDomain[] {
  const rows = asRecord(json).domains;
  return (Array.isArray(rows) ? rows.map(asRecord) : []).map((row) => {
    const domain = asString(row.domain);
    if (!isGroupDomain(domain, group)) {
      throw new ReportParseError(`life_outlook: domain ${JSON.stringify(domain)} is not in this section`);
    }
    const leanInto = asLayman(row.lean_into);
    const watchFor = asLayman(row.watch_for);
    return {
      domain,
      outlook: asPersona(row.outlook),
      ...(leanInto ? { lean_into: leanInto } : {}),
      ...(watchFor ? { watch_for: watchFor } : {}),
    };
  });
}
```

- [ ] **Step 5: run, expect pass** (report-parsers + the two structured suites).

- [ ] **Step 6: commit**
```bash
git add packages/llm/src/persona-parse.ts packages/llm/src/structured-interpretation.ts packages/llm/src/report-sections.ts packages/llm/src/__tests__/report-parsers.test.ts
git commit -m "feat(llm): report section parsers reject quarters and life areas the app did not send"
```

---

### Task 2.7: Natal `family_guidance` in `guidance1` (optional on read)

**Files**
- Modify `packages/shared-types/src/index.ts:1015-1022` (add the field) and next to the other `*Guidance` interfaces
- Modify `packages/llm/src/structured-interpretation.ts:886-901` (`Guidance1Slice`, `parseGuidance1`), `:956-961` (`emptyResults`), `:1029-1045` (`mergeNatalResults`), `:1006-1026` (`mergeResults`)
- Test lands in Task 2.9's `report-timeline.test.ts` (it needs the generator); this task adds the unit-level check below to `structured-interpretation-split.test.ts`.

**Interfaces**
- Produces: `interface FamilyGuidance extends Persona {}`; `VedicInterpretation.family_guidance?: FamilyGuidance | null`.

- [ ] **Step 1: failing test** (append to `packages/llm/src/__tests__/structured-interpretation-split.test.ts`):

```ts
describe("family_guidance (natal, optional)", () => {
  it("is kept when guidance1 returns it", async () => {
    payloads.guidance1 = { family_guidance: { layman: "Home is your anchor.", technical: "4th lord Moon own sign." } };
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => response(sectionFrom(String(init.body))));
    const events: NatalInterpretationEvent[] = [];
    for await (const event of streamNatalInterpretation({ chart, config, fetchImpl: fetchImpl as unknown as typeof fetch })) events.push(event);
    const complete = events.find((e) => e.type === "complete");
    expect(complete?.type === "complete" && complete.interpretation.family_guidance).toEqual({
      layman: "Home is your anchor.", technical: "4th lord Moon own sign.",
    });
    payloads.guidance1 = {};
  });

  it("is absent (not null) when the reply has none, so old readings and legacy prompts are unchanged", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => response(sectionFrom(String(init.body))));
    const events: NatalInterpretationEvent[] = [];
    for await (const event of streamNatalInterpretation({ chart, config, fetchImpl: fetchImpl as unknown as typeof fetch })) events.push(event);
    const complete = events.find((e) => e.type === "complete");
    expect(complete?.type === "complete" && "family_guidance" in complete.interpretation).toBe(false);
  });
});
```

(Uses the file's existing `payloads`, `sectionFrom`, `response`, `chart`, `config`.)

- [ ] **Step 2: run** `cd packages/llm && bunx vitest run src/__tests__/structured-interpretation-split.test.ts` -> first test FAILS (`family_guidance` undefined).

- [ ] **Step 3: implement.** shared-types: add `export interface FamilyGuidance extends Persona {}` beside `HealthGuidance`, and in `VedicInterpretation` after `life_evolution_guidance` add:

```ts
  // Family (natal): added with the report-v2 prompts. Optional: readings saved
  // before it have none, and the family card then shows engine data only.
  family_guidance?: FamilyGuidance | null;
```

structured-interpretation.ts: import `FamilyGuidance`; add `readonly family_guidance: FamilyGuidance | null;` to `Guidance1Slice`, `family_guidance: parsePersona(rec.family_guidance),` to `parseGuidance1`, `family_guidance: null,` to `emptyResults().guidance1`; in BOTH `mergeNatalResults` and `mergeResults` add after `relationship_guidance`:

```ts
    ...(results.guidance1.family_guidance ? { family_guidance: results.guidance1.family_guidance } : {}),
```

- [ ] **Step 4: run, expect pass**; also `bunx vitest run src/__tests__/structured-interpretation.test.ts` (no `toEqual` on a merged reading moves, because the key is absent when empty). Then `cd ../.. && bunx tsc -b packages/shared-types packages/llm --force` -> clean.

- [ ] **Step 5: commit**
```bash
git add packages/shared-types/src/index.ts packages/llm/src/structured-interpretation.ts packages/llm/src/__tests__/structured-interpretation-split.test.ts
git commit -m "feat(llm): optional natal family_guidance in guidance1"
```

---

### Task 2.8: Report prompts (full + lite) and longer natal targets

**Files**
- Create `packages/llm/src/report-targets.ts`
- Modify `packages/llm/src/structured-interpretation.ts`: `SYSTEM_PROMPT` (:189-259, TIMING OWNERSHIP at :234-237) and `SYSTEM_PROMPT_LITE` (:273-314, :300-302) become functions of the timeline section names; new task constants after `UPCOMING_PERIODS_TASK_LITE` (:604); `chartJsonForSection` param type (:693-696); `buildSectionMessages` (:709-741) gains the report branch.
- Create `packages/llm/src/__tests__/report-prompt-snapshots.test.ts`

**Interfaces**
- Produces: `REPORT_PROMPT_SET = 'report-v2' as const`; `type ReportPromptSet = typeof REPORT_PROMPT_SET`; `type ReportSectionKey = NatalInterpretationSectionKey | ReportTimelineSectionKey`; `REPORT_SECTIONS: readonly ReportSectionKey[]` (natal five then `REPORT_TIMELINE_SECTIONS`); `REPORT_WORD_TARGETS: Readonly<Record<ReportSectionKey, { low: number; high: number }>>` (words per voice); `buildSectionMessages(section: InterpretationSectionKey | ReportTimelineSectionKey, chart, mode, lite = false, language = "en", promptSet?: ReportPromptSet): ChatMessage[]` (widened; old calls unchanged).

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/report-prompt-snapshots.test.ts`

```ts
// Report-v2 prompt golden snapshots: every report section, full and lite, in
// en/es/pt, on the real engine golden chart sanitized at a pinned instant.
// Review a diff for the honesty blocks before updating with -u.

import { describe, expect, it } from "vitest";

import { REPORT_PROMPT_SET, REPORT_SECTIONS, REPORT_WORD_TARGETS } from "../report-targets";
import { isReportTimelineSection } from "../report-sections";
import { buildSectionMessages } from "../structured-interpretation";
import { REPORT_CHART } from "./report-fixture";

const LANGS = ["en", "es", "pt"] as const;
const VARIANTS = [["full", false], ["lite", true]] as const;
const DAY = /\b\d{4}-\d{2}-\d{2}\b/;

const cases = REPORT_SECTIONS.flatMap((section) =>
  VARIANTS.flatMap(([variant, lite]) => LANGS.map((lang) => [section, variant, lite, lang] as const)),
);

describe("report-v2 prompts", () => {
  it.each(cases)("%s / %s / %s snapshot", (section, _variant, lite, lang) => {
    expect(buildSectionMessages(section, REPORT_CHART, "layman", lite, lang, REPORT_PROMPT_SET)).toMatchSnapshot();
  });

  it.each(cases)("%s / %s / %s carries no day-precision date", (section, _variant, lite, lang) => {
    expect(JSON.stringify(buildSectionMessages(section, REPORT_CHART, "layman", lite, lang, REPORT_PROMPT_SET))).not.toMatch(DAY);
  });

  it("states each full section's word targets per voice", () => {
    for (const section of REPORT_SECTIONS) {
      const user = buildSectionMessages(section, REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1].content;
      expect(user).toContain("Word targets PER VOICE");
    }
  });

  it("asks guidance1 for family_guidance, full and lite", () => {
    for (const lite of [false, true]) {
      expect(buildSectionMessages("guidance1", REPORT_CHART, "layman", lite, "en", REPORT_PROMPT_SET)[1].content).toContain("family_guidance");
    }
  });

  it("sends the year-ahead quarter keys and no focus field in lite", () => {
    const full = buildSectionMessages("year_ahead", REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1].content;
    const lite = buildSectionMessages("year_ahead", REPORT_CHART, "layman", true, "en", REPORT_PROMPT_SET)[1].content;
    expect(full).toContain('"key":"Q1"');
    expect(full).toContain('"focus"');
    expect(lite).not.toContain('"focus"');
  });

  it("gives timeline sections only their engine slice, never the full chart JSON", () => {
    for (const section of REPORT_SECTIONS.filter(isReportTimelineSection)) {
      const user = buildSectionMessages(section, REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1].content;
      expect(user).toContain("=== ENGINE REPORT FACTS");
      expect(user).not.toContain('"ayanamsa_value"');
      expect(user).not.toContain("=== ENGINE PREDICTIVE CONTEXT");
    }
  });

  it("life_outlook_1 sees only its own domain forecasts", () => {
    const user = buildSectionMessages("life_outlook_1", REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1].content;
    for (const needle of ['"gochara"', '"slow_hits"', '"sav_total"', '"vimshopaka"', '"fusion"']) expect(user).not.toContain(needle);
    for (const domain of ["health", "education", "spiritual"]) expect(user).not.toContain(`"domain":"${domain}"`);
    for (const domain of ["career", "finances", "relationships", "family"]) expect(user).toContain(`"domain":"${domain}"`);
  });

  it("natal report prompts keep the stable-natal fence and drop the as-of date", () => {
    const [system, user] = buildSectionMessages("core", REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET);
    expect(system.content).toContain("STABLE NATAL ONLY");
    expect(system.content).toContain("Current Period / Year Ahead / This Year");
    expect(user.content).not.toContain('"as_of"');
    expect(user.content).not.toContain('"dashas"');
  });

  it("pins the word targets the cost estimate and the real spec rely on", () => {
    expect(REPORT_WORD_TARGETS).toEqual({
      core: { low: 660, high: 970 },
      yoga: { low: 250, high: 350 },
      guidance1: { low: 600, high: 800 },
      guidance2: { low: 390, high: 520 },
      remedial: { low: 300, high: 400 },
      current_period: { low: 490, high: 770 },
      year_ahead: { low: 800, high: 1110 },
      life_outlook_1: { low: 480, high: 640 },
      life_outlook_2: { low: 360, high: 480 },
    });
  });
});
```

The existing `prompt-snapshots.test.ts` "core section, full prompt, en" snapshot is the guard that the legacy prompts did not move.

- [ ] **Step 2: run, expect failure** `cd packages/llm && bunx vitest run src/__tests__/report-prompt-snapshots.test.ts` -> cannot resolve `../report-targets`.

- [ ] **Step 3: implement `report-targets.ts`**

```ts
// The report-v2 prompt set: one version stamp for provenance (PR 3 stores it)
// and the length targets the prompts ask for, the cost estimate budgets for,
// and the real spec checks (+/-30 %). Words are PER VOICE (layman and
// technical each).

import { REPORT_TIMELINE_SECTIONS, type ReportTimelineSectionKey } from "./report-sections";
import type { NatalInterpretationSectionKey } from "./structured-interpretation";

export const REPORT_PROMPT_SET = "report-v2" as const;
export type ReportPromptSet = typeof REPORT_PROMPT_SET;

export type ReportSectionKey = NatalInterpretationSectionKey | ReportTimelineSectionKey;

export const REPORT_SECTIONS: readonly ReportSectionKey[] = [
  "core", "yoga", "guidance1", "guidance2", "remedial", ...REPORT_TIMELINE_SECTIONS,
];

/** Run order for nine requests: natal first, the two life-outlook calls last (ruling 7). */
export const REPORT_SECTION_ORDER: readonly ReportSectionKey[] = REPORT_SECTIONS;

export const REPORT_WORD_TARGETS: Readonly<Record<ReportSectionKey, { readonly low: number; readonly high: number }>> = {
  core: { low: 660, high: 970 }, //            summary 120-160 + 9 items x 60-90
  yoga: { low: 250, high: 350 },
  guidance1: { low: 600, high: 800 }, //       5 guidances x 120-160
  guidance2: { low: 390, high: 520 }, //       2 x 120-160 + life_evolution 150-200
  remedial: { low: 300, high: 400 },
  current_period: { low: 490, high: 770 }, // maha 150-200, antar 120-160, 2-3 x 60-90, next 100-140
  year_ahead: { low: 800, high: 1110 }, //    headline 100-140, 4 x 160-220, focus 60-90
  life_outlook_1: { low: 480, high: 640 }, //  4 x 120-160
  life_outlook_2: { low: 360, high: 480 }, //  3 x 120-160
};

/** The per-field targets the full prompt states, one sentence per section. */
export const REPORT_FIELD_TARGETS: Readonly<Record<ReportSectionKey, string>> = {
  core: "summary 120-160 words; each strengths, challenges and life_themes item 60-90 words, 3 items each",
  yoga: "integrated_yoga_narrative 250-350 words",
  guidance1: "each of the five guidances 120-160 words",
  guidance2: "finances_guidance and spiritual_guidance 120-160 words each; life_evolution_guidance 150-200 words",
  remedial: "remedial_measures 300-400 words",
  current_period: "maha 150-200 words; antar 120-160; each activates item 60-90 (2-3 items); next_change 100-140",
  year_ahead: "headline 100-140 words; each quarter 160-220; focus 60-90",
  life_outlook_1: "each area's outlook 120-160 words; lean_into and watch_for one plain sentence each, under 25 words",
  life_outlook_2: "each area's outlook 120-160 words; lean_into and watch_for one plain sentence each, under 25 words",
};
```

(`report-targets.ts` imports a type from `structured-interpretation.ts` and `structured-interpretation.ts` imports values from `report-targets.ts`; the type-only edge is erased, so there is no runtime cycle.)

- [ ] **Step 4: implement the prompts in `structured-interpretation.ts`.**

(a) System prompts become functions of the timeline names. Replace `const SYSTEM_PROMPT = [` with `function systemPrompt(timelineNames: string): string { return [`, change :236 to `` `  only to the separate ${timelineNames} timeline sections. Never infer age,`, `` and close with `].join("\n"); }`. Then:

```ts
const LEGACY_TIMELINE_NAMES = "Road Ahead / Current Sky";
const REPORT_TIMELINE_NAMES = "Current Period / Year Ahead / This Year";
const SYSTEM_PROMPT = systemPrompt(LEGACY_TIMELINE_NAMES);
```

Same for the lite prompt (`systemPromptLite(timelineNames)`, :301 becomes `` `    dates, ages, or transits. Only ${timelineNames} may use timing fields,` ``), `const SYSTEM_PROMPT_LITE = systemPromptLite(LEGACY_TIMELINE_NAMES);`. The legacy snapshot proves byte-identity.

(b) Natal report-v2 tasks (after :614):

```ts
const GUIDANCE1_TASK_V2 = [
  "TASK: Life Guidance Part 1 — practical application across five life areas.",
  "Return JSON with FIVE persona objects, each { layman, technical }:",
  "  health_guidance, education_guidance, career_guidance, relationship_guidance, family_guidance.",
  "",
  ...GUIDANCE1_TASK.split("\n").slice(3, 9),
  "  Family = 2nd, 4th, 5th & 9th (home, lineage, children, elders).",
  "PER-AREA KARAKA CONDITION: also read the area's natural significator and report its",
  "  `dignity`, `is_combust`, `is_retrograde` — Health: Sun & Mars; Education: Mercury &",
  "  Jupiter; Career: Saturn & the Sun; Relationships: Venus & the Moon; Family: Jupiter.",
  "  If a karaka is debilitated/combust, be honest that the area asks for more effort before it flowers.",
  ...GUIDANCE1_TASK.split("\n").slice(13),
  "  Family = belonging, home life, children, parents and elders.",
].join("\n");

const GUIDANCE1_TASK_LITE_V2 = [
  "TASK: Life Guidance Part 1 — five life areas. Return JSON with EXACTLY these FIVE",
  "top-level keys, each a persona object with its own layman + technical fields. Copy",
  "this skeleton EXACTLY — do NOT collapse it into a single { layman, technical }:",
  "{",
  '  "health_guidance":       { "layman": "...", "technical": "..." },',
  '  "education_guidance":    { "layman": "...", "technical": "..." },',
  '  "career_guidance":       { "layman": "...", "technical": "..." },',
  '  "relationship_guidance": { "layman": "...", "technical": "..." },',
  '  "family_guidance":       { "layman": "...", "technical": "..." }',
  "}",
  ...GUIDANCE1_TASK_LITE.split("\n").slice(9),
  "    Family = 2nd/4th/5th/9th.",
].join("\n");

const REPORT_NATAL_TASKS: Record<NatalInterpretationSectionKey, string> = {
  core: CORE_TASK, yoga: YOGA_TASK, guidance1: GUIDANCE1_TASK_V2, guidance2: GUIDANCE2_TASK, remedial: REMEDIAL_TASK,
};
const REPORT_NATAL_TASKS_LITE: Record<NatalInterpretationSectionKey, string> = {
  core: CORE_TASK_LITE, yoga: YOGA_TASK_LITE, guidance1: GUIDANCE1_TASK_LITE_V2, guidance2: GUIDANCE2_TASK_LITE, remedial: REMEDIAL_TASK_LITE,
};
```

Check the `slice` indices against the arrays at :380-402 and :544-559 when editing: the snapshot in Step 6 shows the assembled text, and it must read as one coherent task with every legacy rule present once. If slicing reads badly, write the five-area task out in full instead (same rules, Family added).

(c) Timeline tasks (full + lite):

```ts
const REPORT_DATES_RULE =
  "DATES: cite only months that appear in the ENGINE REPORT FACTS block, verbatim as YYYY-MM. Never write a day. A sentence with any other date is deleted before it reaches the screen.";

const CURRENT_PERIOD_TASK = [
  "TASK: Your Current Period — the chapter the person is living in NOW.",
  'Return JSON: { "maha": {layman, technical}, "antar": {layman, technical}, "activates": [ {title, layman, technical} ], "next_change": {layman, technical} }.',
  "  - maha: the running mahadasha. What its lord's OWN facts in lord_facts (sign, house, dignity, houses_ruled,",
  "    yogakaraka/combust/retrograde flags, listed yogas) make this long chapter about, and how the fusion",
  "    row (reinforcing / afflicting, severity) colors it now.",
  "  - antar: the running antardasha inside it: the sub-theme, and how its lord's facts combine with the maha lord's.",
  "  - activates: 2-3 items, one per life area this period switches on, chosen from the houses the maha and antar",
  "    lords rule or occupy (career for the 10th, partnership for the 7th, money for the 2nd and 11th, home for",
  "    the 4th, learning for the 5th, health for the 6th). title = the plain area name.",
  "  - next_change: the next change in the facts: the current antar's end_month and the antar after it in",
  "    antar_sequence, or next_maha when the maha ends first. The app draws every window; do not list the",
  "    remaining antardashas one by one.",
  "DEBILITY HONESTY: a debilitated, combust, or retrograde lord's period is a growth-through-effort chapter; name the condition.",
  REPORT_DATES_RULE,
].join("\n");

const YEAR_AHEAD_TASK = [
  "TASK: The Year Ahead — the next twelve months in four quarters.",
  'Return JSON: { "headline": {layman, technical}, "quarters": [ { "key": "Q1", "layman": string, "technical": string } ], "focus": {layman, technical} }.',
  "  - quarters: EXACTLY one entry for each quarter in the facts (Q1, Q2, Q3, Q4), in that order, key verbatim.",
  "    Never add, rename, or skip a key.",
  "  - Each quarter speaks to the events listed under it (dasha changes, transit windows, slow-planet hits,",
  "    Sade Sati) and what they ask of the person. A quarter with no events is a consolidation season: say so",
  "    plainly; never invent an event.",
  "  - headline: the shape of the whole year. focus: the one practical focus the events point to.",
  REPORT_DATES_RULE,
].join("\n");

function lifeOutlookTask(domains: readonly string[]): string {
  return [
    `TASK: This Year, by life area — ${domains.join(", ")}.`,
    'Return JSON: { "domains": [ { "domain": string, "outlook": {layman, technical}, "lean_into": string, "watch_for": string } ] }.',
    `  - EXACTLY one entry per area in the facts, in that order; "domain" is the key verbatim (${domains.join(", ")}).`,
    "    Never add another area.",
    "  - outlook: this year for that area from ITS facts only: band, key graha and whether it meets its minimum,",
    "    SAV bindus, active dasha significator (levels, lords), Sade Sati, transit severity, its windows, and its",
    "    house_lords rows. The band is the engine's convention, not a verdict.",
    "  - lean_into / watch_for: one plain sentence each, no astrology terms.",
    REPORT_DATES_RULE,
  ].join("\n");
}

const CURRENT_PERIOD_TASK_LITE = [
  "TASK: Your Current Period — the chapter the person is living in now.",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{ "maha": { "layman": "...", "technical": "..." }, "antar": { "layman": "...", "technical": "..." }, "next_change": { "layman": "...", "technical": "..." } }',
  "  Keep each layman and technical to 1-2 short sentences.",
  "  - technical: name the period lord and one of its facts (sign, house, or dignity) from the facts block.",
  "  - next_change: the next change month exactly as written in the facts (YYYY-MM).",
].join("\n");

const YEAR_AHEAD_TASK_LITE = [
  "TASK: The Year Ahead — four quarters.",
  "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
  '{ "headline": { "layman": "...", "technical": "..." }, "quarters": [ { "key": "Q1", "layman": "...", "technical": "..." } ] }',
  "  One quarters entry per key in the facts (Q1-Q4), key verbatim. 1-2 short sentences each.",
  "  Use only months written in the facts (YYYY-MM).",
].join("\n");

function lifeOutlookTaskLite(domains: readonly string[]): string {
  return [
    `TASK: This Year, by life area — ${domains.join(", ")}.`,
    "Fill in this EXACT JSON shape (replace the ... with real content; keep these keys):",
    '{ "domains": [ { "domain": "...", "outlook": { "layman": "...", "technical": "..." } } ] }',
    `  One entry per area (${domains.join(", ")}), domain key verbatim. 1-2 short sentences per field.`,
  ].join("\n");
}

const REPORT_TIMELINE_TASKS: Record<ReportTimelineSectionKey, string> = {
  current_period: CURRENT_PERIOD_TASK,
  year_ahead: YEAR_AHEAD_TASK,
  life_outlook_1: lifeOutlookTask(LIFE_OUTLOOK_GROUPS.life_outlook_1),
  life_outlook_2: lifeOutlookTask(LIFE_OUTLOOK_GROUPS.life_outlook_2),
};
const REPORT_TIMELINE_TASKS_LITE: Record<ReportTimelineSectionKey, string> = {
  current_period: CURRENT_PERIOD_TASK_LITE,
  year_ahead: YEAR_AHEAD_TASK_LITE,
  life_outlook_1: lifeOutlookTaskLite(LIFE_OUTLOOK_GROUPS.life_outlook_1),
  life_outlook_2: lifeOutlookTaskLite(LIFE_OUTLOOK_GROUPS.life_outlook_2),
};

const REPORT_FACTS_EXCEPTION = [
  "",
  "ENGINE REPORT FACTS — USE THEM (REQUIRED):",
  "The block below is this section's slice of the deterministic engine's timing output. It is the",
  "ONLY timing that exists. Ground every statement in it; quote months verbatim as YYYY-MM; never",
  "write a day, an age, or a month that is not in the block. Bands and severities are the engine's",
  "convention, not a verdict.",
].join("\n");

function reportLengthHint(section: ReportSectionKey, mode: ViewMode, lite: boolean): string {
  if (lite) return modeHint(mode, true);
  const audience =
    mode === "expert"
      ? "The reader is an astrologer; make the technical fields especially rigorous."
      : "The reader is a layperson; make the layman fields especially warm and clear.";
  return `${audience} Word targets PER VOICE (layman and technical each): ${REPORT_FIELD_TARGETS[section]}. Depth over length; never pad to reach a target.`;
}
```

(d) Builders. Change `chartJsonForSection`'s `chart` param type to `Omit<SanitizedChart, "predictive" | "as_of">` (it never reads `as_of`; legacy callers still pass a chart that has it). Then at the top of `buildSectionMessages` (signature widened to `section: InterpretationSectionKey | ReportTimelineSectionKey`, new last param `promptSet?: ReportPromptSet`):

```ts
  if (isReportTimelineSection(section)) return buildReportTimelineMessages(section, chart, mode, lite, language);
  if (promptSet === REPORT_PROMPT_SET && isNatalSection(section)) {
    return buildReportNatalMessages(section, chart, mode, lite, language);
  }
  // ...legacy body unchanged...
```

with:

```ts
function isNatalSection(section: InterpretationSectionKey): section is NatalInterpretationSectionKey {
  return (NATAL_SECTIONS as readonly string[]).includes(section);
}

function buildReportNatalMessages(
  section: NatalInterpretationSectionKey,
  chart: SanitizedChart,
  mode: ViewMode,
  lite: boolean,
  language: PromptLanguage,
): ChatMessage[] {
  // Natal report prompts carry no timing at all: no dashas, no predictive, and
  // no as-of date (the only day-precision value the sanitized chart has).
  const { predictive: _p, dashas: _d, as_of: _a, ...natal } = chart;
  const chartJson = chartJsonForSection(section, natal);
  const task = (lite ? REPORT_NATAL_TASKS_LITE : REPORT_NATAL_TASKS)[section];
  const hint = reportLengthHint(section, mode, lite);
  const base = lite ? systemPromptLite(REPORT_TIMELINE_NAMES) : systemPrompt(REPORT_TIMELINE_NAMES);
  return [
    { role: "system", content: withLanguage(base + STABLE_NATAL_HONESTY, language) },
    { role: "user", content: lite ? liteUser(section, chartJson, task, hint) : fullUser(section, chartJson, task, hint) },
  ];
}

function buildReportTimelineMessages(
  section: ReportTimelineSectionKey,
  chart: SanitizedChart,
  mode: ViewMode,
  lite: boolean,
  language: PromptLanguage,
): ChatMessage[] {
  const facts = buildReportFactsBlock(reportSlice(section, chart));
  const task = (lite ? REPORT_TIMELINE_TASKS_LITE : REPORT_TIMELINE_TASKS)[section];
  const hint = reportLengthHint(section, mode, lite);
  const base = lite ? systemPromptLite(REPORT_TIMELINE_NAMES) : systemPrompt(REPORT_TIMELINE_NAMES);
  return [
    { role: "system", content: withLanguage(base + REPORT_FACTS_EXCEPTION, language) },
    { role: "user", content: lite ? liteUser(section, facts, task, hint) : fullUser(section, facts, task, hint) },
  ];
}
```

Refactor the two existing user-message builders (`fullUserContent` :744-764, `liteUserContent` :773-799) into `fullUser(section, reference, task, hint)` / `liteUser(...)` that take the already-chosen task and hint; the legacy callers pass `SECTION_TASKS[section]` / `SECTION_TASKS_LITE[section]` and `modeHint(mode, lite)` and append the predictive block to `reference` exactly as before, so the legacy text is unchanged. For a timeline report section `reference` is the facts block alone (no chart JSON, no "yogas field is EXHAUSTIVE" lead-in; `fullUser` takes an optional `lead` string, the legacy chart lead-in for natal and `"Engine facts for this section (sanitized; month precision):"` for timeline).

- [ ] **Step 5: run** `cd packages/llm && bunx vitest run src/__tests__/report-prompt-snapshots.test.ts src/__tests__/prompt-snapshots.test.ts src/__tests__/structured-interpretation-language.test.ts` -> the 54 snapshots are written on first run; every other assertion green; legacy `prompt-snapshots` unchanged (it must NOT report "1 snapshot updated/written"; it reports "5 passed").

- [ ] **Step 6: review the snapshots** by reading `src/__tests__/__snapshots__/report-prompt-snapshots.test.ts.snap` for `core/full/en`, `guidance1/full/en`, `guidance1/lite/en`, `current_period/full/en`, `year_ahead/lite/pt`, `life_outlook_2/full/es`: each has the SECTION marker, the stated targets, the facts block (timeline) or chart JSON without `as_of`/`dashas` (natal), and the language instruction for es/pt. Fix wording, re-run with `-u` only after reading.

- [ ] **Step 7: commit**
```bash
git add packages/llm/src/report-targets.ts packages/llm/src/structured-interpretation.ts packages/llm/src/__tests__/report-prompt-snapshots.test.ts packages/llm/src/__tests__/__snapshots__/report-prompt-snapshots.test.ts.snap
git commit -m "feat(llm): report-v2 prompts for nine sections, full and lite, with stated word targets"
```

---

### Task 2.9: `streamReportTimeline`, report reasoning cap, natal `promptSet`, lite order, date guard wiring

**Files**
- Modify `packages/llm/src/reasoning.ts` (after :27)
- Modify `packages/llm/src/structured-interpretation.ts`: params (:101-145), `SectionResults`/`emptyResults` (:937-971), `applySection` (:974-1003), `requestSection` (:1101-1134), `runOneSection` (:1136-1160), `streamSections` (:1182-1244), `streamNatalInterpretation` (:1247-1271), new `streamReportTimeline`
- Create `packages/llm/src/__tests__/report-timeline.test.ts`

**Interfaces**
- Produces:
  - `REPORT_SECTION_REASONING_MAX_TOKENS = 6_000` (reasoning.ts)
  - `StructuredInterpretationParams.promptSet?: ReportPromptSet`
  - `interface ReportTimelineParams extends Omit<StructuredInterpretationParams, "onSectionProgress" | "promptSet"> { onSectionProgress?: (section: ReportTimelineSectionKey, progress: SectionProgressSnapshot) => void }`
  - `type ReportTimelineEvent = { type: "section_start"; section: ReportTimelineSectionKey } | { type: "section_complete"; section: ReportTimelineSectionKey } | { type: "complete"; timeline: ReportTimelineContent; asOfMonth: string; dateGuardRemovals: number } | { type: "error"; section: ReportTimelineSectionKey; message: string; status?: number }`
  - `streamReportTimeline(params: ReportTimelineParams): AsyncGenerator<ReportTimelineEvent>`

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/report-timeline.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "../config";
import {
  REPORT_PROMPT_SET,
  REPORT_SECTION_REASONING_MAX_TOKENS,
  SECTION_REASONING_MAX_TOKENS,
  streamNatalInterpretation,
  streamReportTimeline,
  type ReportTimelineEvent,
} from "../index";
import { REPORT_AS_OF, REPORT_RAW_CHART } from "./report-fixture";

const OPENROUTER: ProviderConfig = {
  engine: "openai-http", model: "deepseek/deepseek-v4.1-flash", privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
};
const LOCAL: ProviderConfig = {
  engine: "openai-http", model: "gemma3:4b", privacyMode: "local_only", baseUrl: "http://localhost:11434/v1",
};

const p = (text: string) => ({ layman: text, technical: text });
// As-of month is 2026-06 (REPORT_AS_OF), so Q1 = 2026-06..08.
const REPLIES: Record<string, unknown> = {
  current_period: { maha: p("Steady building."), antar: p("A learning sub-chapter."), activates: [], next_change: p("A change comes.") },
  year_ahead: {
    headline: p("A year of consolidation."),
    quarters: [
      { key: "Q1", layman: "Settle in.", technical: "Fine. Invented window 2031-01 for Saturn." },
      { key: "Q2", ...p("Q2.") }, { key: "Q3", ...p("Q3.") }, { key: "Q4", ...p("Q4.") },
    ],
    focus: p("Rest."),
  },
  life_outlook_1: { domains: ["career", "finances", "relationships", "family"].map((domain) => ({ domain, outlook: p(`${domain}.`) })) },
  life_outlook_2: { domains: ["health", "education", "spiritual"].map((domain) => ({ domain, outlook: p(`${domain}.`) })) },
  core: { summary: p("Natal."), strengths: [], challenges: [], life_themes: [] },
  yoga: { integrated_yoga_narrative: p("Yoga.") },
  guidance1: { family_guidance: p("Home.") },
  guidance2: {},
  remedial: { remedial_measures: p("Walk.") },
};

const sectionOf = (body: string) => /SECTION:([a-z0-9_]+)/.exec(body)?.[1] ?? "";

function stubFetch(log: { section: string; body: Record<string, unknown> }[], replies = REPLIES) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const section = sectionOf(String(init.body));
    log.push({ section, body });
    const content = JSON.stringify(replies[section]);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<ReportTimelineEvent>): Promise<ReportTimelineEvent[]> {
  const out: ReportTimelineEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("streamReportTimeline", () => {
  it("runs the four timeline sections and completes with the as-of month", async () => {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log) }));
    expect(log.map((r) => r.section).sort()).toEqual(["current_period", "life_outlook_1", "life_outlook_2", "year_ahead"]);
    const complete = events.find((e) => e.type === "complete");
    expect(complete?.type).toBe("complete");
    if (complete?.type !== "complete") return;
    expect(complete.asOfMonth).toBe("2026-06");
    expect(complete.timeline.life_outlook.life_outlook_1?.domains.map((d) => d.domain)).toEqual([
      "career", "finances", "relationships", "family",
    ]);
    expect(complete.timeline.life_outlook.life_outlook_2?.domains.map((d) => d.domain)).toEqual([
      "health", "education", "spiritual",
    ]);
  });

  it("removes the invented month and counts it", async () => {
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch([]) }));
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    expect(complete.dateGuardRemovals).toBe(1);
    expect(complete.timeline.year_ahead?.quarters[0].technical).toBe("Fine.");
  });

  it("fails only year_ahead when the model invents a quarter key", async () => {
    const replies = { ...REPLIES, year_ahead: { headline: p("h"), quarters: [{ key: "Q9", ...p("x") }] } };
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch([], replies) }));
    expect(events.filter((e) => e.type === "error").map((e) => e.type === "error" && e.section)).toEqual(["year_ahead"]);
    const complete = events.find((e) => e.type === "complete");
    expect(complete?.type === "complete" && complete.timeline.year_ahead).toBeNull();
  });

  it("marks a failed outlook call as null, keeping the other", async () => {
    const replies = { ...REPLIES, life_outlook_2: { domains: [{ domain: "career", outlook: p("x") }] } };
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch([], replies) }));
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    expect(complete.timeline.life_outlook.life_outlook_2).toBeNull();
    expect(complete.timeline.life_outlook.life_outlook_1?.domains).toHaveLength(4);
  });

  it("caps reasoning at 6,000 tokens on every report section", async () => {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log) }));
    for await (const _ of streamNatalInterpretation({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log), promptSet: REPORT_PROMPT_SET })) {
      // drain
    }
    expect(REPORT_SECTION_REASONING_MAX_TOKENS).toBe(6000);
    expect(log).toHaveLength(9);
    for (const row of log) expect(row.body.reasoning).toEqual({ max_tokens: 6000 });
    expect(log.every((row) => !("max_tokens" in row.body))).toBe(true);
  });

  it("leaves legacy natal calls at the 12,000 cap", async () => {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    for await (const _ of streamNatalInterpretation({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log) })) {
      // drain
    }
    expect(SECTION_REASONING_MAX_TOKENS).toBe(12000);
    for (const row of log) expect(row.body.reasoning).toEqual({ max_tokens: 12000 });
  });

  it("on a local endpoint runs one request at a time, life_outlook last", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const section = sectionOf(String(init.body));
      order.push(section);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLIES[section]) } }] }));
    }) as unknown as typeof fetch;
    await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: LOCAL, fetchImpl }));
    expect(order).toEqual(["current_period", "year_ahead", "life_outlook_1", "life_outlook_2"]);
    expect(maxInFlight).toBe(1);
  });

  it("reports progress per report section when streaming", async () => {
    const seen = new Set<string>();
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const content = JSON.stringify(REPLIES[sectionOf(String(init.body))]);
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(encoder.encode(sse), { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    await collect(streamReportTimeline({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl,
      onSectionProgress: (section) => seen.add(section),
    }));
    expect([...seen].sort()).toEqual(["current_period", "life_outlook_1", "life_outlook_2", "year_ahead"]);
  });
});
```

- [ ] **Step 2: run, expect failure** `cd packages/llm && bunx vitest run src/__tests__/report-timeline.test.ts` -> `streamReportTimeline` is not exported.

- [ ] **Step 3: reasoning constant** (reasoning.ts after :27):

```ts
/**
 * Reasoning budget for each of the nine report-v2 sections (OpenRouter only,
 * via `reasoning.max_tokens`). Keeps the high end of the cost estimate at
 * input + visible budget + 9 x 6,000. Never a `max_tokens` on visible output.
 */
export const REPORT_SECTION_REASONING_MAX_TOKENS = 6_000;
```

- [ ] **Step 4: generator changes** in `structured-interpretation.ts`:

```ts
type AnySectionKey = InterpretationSectionKey | ReportTimelineSectionKey;

interface SectionRunParams<Section extends AnySectionKey>
  extends Omit<StructuredInterpretationParams, "onSectionProgress"> {
  readonly onSectionProgress?: (section: Section, progress: SectionProgressSnapshot) => void;
}
```

Add `readonly promptSet?: ReportPromptSet;` to `StructuredInterpretationParams` (doc: "`REPORT_PROMPT_SET` selects the report-v2 natal prompts (longer targets, family_guidance) and the 6,000-token reasoning cap; absent = the legacy prompts, byte-identical."). Add `ReportTimelineParams` and `ReportTimelineEvent` as in Interfaces.

`SectionResults` gains `current_period: CurrentPeriodSection | null; year_ahead: YearAheadSection | null; life_outlook_1: LifeOutlookSection | null; life_outlook_2: LifeOutlookSection | null; dateGuardRemovals: number; asOfMonth: string;` (`emptyResults` sets `null, null, null, null, 0, ""`).

`applySection(results, section: AnySectionKey, raw, chart: SanitizedChart)` - new cases:

```ts
    case "current_period":
      results.current_period = guarded(results, parseCurrentPeriod(json), currentPeriodSlice(chart));
      return;
    case "year_ahead":
      results.year_ahead = guarded(results, parseYearAhead(json, computeQuarters(reportAsOfMonth(chart)).map((q) => q.key)), yearAheadSlice(chart));
      return;
    case "life_outlook_1":
    case "life_outlook_2":
      results[section] = { domains: guarded(results, parseLifeOutlook(json, LIFE_OUTLOOK_GROUPS[section]), lifeOutlookSlice(chart, section)) };
      return;
```

with

```ts
/** Run the date guard against the months the engine put in this section's input. */
function guarded<T>(results: SectionResults, parsed: T, slice: object): T {
  const { section, removals } = validateTimelineDates(parsed, monthsIn(slice));
  results.dateGuardRemovals += removals;
  return section;
}
```

`requestSection`: `reasoningMaxTokens: reasoningBudget(section, params.promptSet)` with

```ts
function reasoningBudget(section: AnySectionKey, promptSet: ReportPromptSet | undefined): number {
  return promptSet === REPORT_PROMPT_SET || isReportTimelineSection(section)
    ? REPORT_SECTION_REASONING_MAX_TOKENS
    : SECTION_REASONING_MAX_TOKENS;
}
```

`runOneSection` passes `params.promptSet` as the sixth argument of `buildSectionMessages`. `requestSection`/`runOneSection` take `SectionRunParams<Section>` and `section: Section`.

`streamSections<Section extends AnySectionKey>(params: SectionRunParams<Section>, sections: readonly Section[])`: after sanitizing, set `results.asOfMonth = reportAsOfMonth(chart)` (create `results` before the launch). Replace the eager `pending` map (:1202-1204) with a bounded launcher:

```ts
  // A local endpoint (Ollama) serves one request at a time; for report
  // timeline sections we run them in order so the two life-outlook calls are
  // last (owner ruling 7). Cloud runs stay fully parallel.
  const sequential = usesLitePrompt(params.config) && sections.some((s) => isReportTimelineSection(s));
  const queue = [...sections];
  const pending = new Map<Section, Promise<SectionOutcome<Section>>>();
  const launch = (): void => {
    while (queue.length > 0 && (!sequential || pending.size === 0)) {
      const next = queue.shift() as Section;
      pending.set(next, runOneSection(next, chart, params));
    }
  };
  launch();
```

and in the loop, right after `pending.delete(outcome.section);` call `launch();`. `applySection(results, outcome.section, outcome.raw, chart)`.

`streamNatalInterpretation`: extract the destructure at :1252-1265 into `export function stableNatalChart(chart: SiderealChart): SiderealChart` (internal, also used by Task 2.10) - no behaviour change; `params.promptSet` flows through unchanged.

New generator:

```ts
function mergeReportTimeline(results: SectionResults): ReportTimelineContent {
  return {
    current_period: results.current_period,
    year_ahead: results.year_ahead,
    life_outlook: { life_outlook_1: results.life_outlook_1, life_outlook_2: results.life_outlook_2 },
  };
}

/**
 * Stream the four report-v2 timeline sections: current period, year ahead,
 * and the two life-area outlooks. Every section runs the date guard after
 * parse. Fails closed like the v1 timeline: callers send this only when the
 * predictive data is ready.
 */
export async function* streamReportTimeline(params: ReportTimelineParams): AsyncGenerator<ReportTimelineEvent> {
  const results = yield* streamSections({ ...params, promptSet: REPORT_PROMPT_SET }, REPORT_TIMELINE_SECTIONS);
  yield {
    type: "complete",
    timeline: mergeReportTimeline(results),
    asOfMonth: results.asOfMonth,
    dateGuardRemovals: results.dateGuardRemovals,
  };
}
```

Mark the v1 generator: add to `streamCurrentTimeline`'s doc `@deprecated Generation moves to streamReportTimeline (PR 3 switches the hook, then removes this). CurrentTimelineContent stays as the reader type for stored v1 timelines.`

Export from `index.ts` (structured block :169-191): `streamReportTimeline`, `REPORT_TIMELINE_SECTIONS`, types `ReportTimelineEvent`, `ReportTimelineParams`, `ReportTimelineSectionKey`; reasoning block (:380-387): `REPORT_SECTION_REASONING_MAX_TOKENS`; plus `REPORT_PROMPT_SET`, `ReportPromptSet` from `./report-targets`.

- [ ] **Step 5: run, expect pass**: `report-timeline.test.ts` (8 tests) and the whole package: `cd packages/llm && bunx vitest run` -> all green, including `reasoning-cap.test.ts` and `structured-interpretation-split.test.ts` (v1 timeline untouched).

- [ ] **Step 6: commit**
```bash
git add packages/llm/src/reasoning.ts packages/llm/src/structured-interpretation.ts packages/llm/src/index.ts packages/llm/src/__tests__/report-timeline.test.ts
git commit -m "feat(llm): streamReportTimeline with date guard, 6k reasoning cap and lite ordering"
```

---

### Task 2.10: `buildReportMessages` (the nine arrays, before anything is sent)

**Files**
- Modify `packages/llm/src/structured-interpretation.ts` (new export after `streamReportTimeline`)
- Create `packages/llm/src/__tests__/report-messages.test.ts`

**Interfaces**
- Consumes: `buildSectionMessages`, `stableNatalChart`, `sanitizeChartForLlm`, `chartAnalysisInstant`.
- Produces: `interface ReportMessagesInput { chart: SiderealChart; asOf?: AnalysisInstant }`; `interface ReportMessagesOptions { mode: ViewMode; language: PromptLanguage; lite: boolean }`; `type ReportMessages = Readonly<Record<ReportSectionKey, readonly ChatMessage[]>>`; `buildReportMessages(input: ReportMessagesInput, opts: ReportMessagesOptions): ReportMessages`.

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/report-messages.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "../config";
import {
  buildReportMessages,
  REPORT_PROMPT_SET,
  REPORT_SECTIONS,
  streamNatalInterpretation,
  streamReportTimeline,
} from "../index";
import { REPORT_AS_OF, REPORT_RAW_CHART } from "./report-fixture";

const CONFIG: ProviderConfig = {
  engine: "openai-http", model: "deepseek/deepseek-v4.1-flash", privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
};

describe("buildReportMessages", () => {
  it("returns one message array per report section", () => {
    const messages = buildReportMessages({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF }, { mode: "layman", language: "en", lite: false });
    expect(Object.keys(messages).sort()).toEqual([...REPORT_SECTIONS].sort());
  });

  it("builds exactly the messages the generators send, so the estimate prices what is sent", async () => {
    const sent = new Map<string, unknown>();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: unknown };
      sent.set(/SECTION:([a-z0-9_]+)/.exec(String(init.body))?.[1] ?? "", body.messages);
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    }) as unknown as typeof fetch;
    const common = { chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: CONFIG, fetchImpl, language: "es" as const };
    try { for await (const _ of streamNatalInterpretation({ ...common, promptSet: REPORT_PROMPT_SET })) { /* drain */ } } catch { /* empty stub replies */ }
    try { for await (const _ of streamReportTimeline(common)) { /* drain */ } } catch { /* empty stub replies */ }

    const built = buildReportMessages({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF }, { mode: "layman", language: "es", lite: false });
    for (const section of REPORT_SECTIONS) expect(sent.get(section)).toEqual(built[section]);
  });

  it("never puts dashas or predictive data in a natal message", () => {
    const messages = buildReportMessages({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF }, { mode: "layman", language: "en", lite: true });
    for (const section of ["core", "yoga", "guidance1", "guidance2", "remedial"] as const) {
      const user = messages[section][1].content;
      expect(user).not.toContain('"maha_dasha_sequence"');
      expect(user).not.toContain("ENGINE");
    }
  });
});
```

- [ ] **Step 2: run** -> `buildReportMessages` is not exported.

- [ ] **Step 3: implement**

```ts
export interface ReportMessagesInput {
  readonly chart: SiderealChart;
  readonly asOf?: AnalysisInstant;
}

export interface ReportMessagesOptions {
  readonly mode: ViewMode;
  readonly language: PromptLanguage;
  readonly lite: boolean;
}

export type ReportMessages = Readonly<Record<ReportSectionKey, readonly ChatMessage[]>>;

/**
 * The nine report-v2 message arrays, built exactly as the generators build
 * them, so the app can count input tokens (estimateReadingCost) before any
 * request is sent.
 */
export function buildReportMessages(input: ReportMessagesInput, opts: ReportMessagesOptions): ReportMessages {
  const asOf = input.asOf ?? chartAnalysisInstant(input.chart);
  const natal = sanitizeChartForLlm(stableNatalChart(input.chart), asOf);
  const timeline = sanitizeChartForLlm(input.chart, asOf);
  const n = (section: NatalInterpretationSectionKey) =>
    buildSectionMessages(section, natal, opts.mode, opts.lite, opts.language, REPORT_PROMPT_SET);
  const t = (section: ReportTimelineSectionKey) =>
    buildSectionMessages(section, timeline, opts.mode, opts.lite, opts.language, REPORT_PROMPT_SET);
  return {
    core: n("core"), yoga: n("yoga"), guidance1: n("guidance1"), guidance2: n("guidance2"), remedial: n("remedial"),
    current_period: t("current_period"), year_ahead: t("year_ahead"),
    life_outlook_1: t("life_outlook_1"), life_outlook_2: t("life_outlook_2"),
  };
}
```

(The generators default `mode` to `"layman"`; the test passes `mode: "layman"`, matching.) Export `buildReportMessages` and the three types from `index.ts`.

- [ ] **Step 4: run, expect pass** (3 tests).

- [ ] **Step 5: commit**
```bash
git add packages/llm/src/structured-interpretation.ts packages/llm/src/index.ts packages/llm/src/__tests__/report-messages.test.ts
git commit -m "feat(llm): buildReportMessages for pre-send cost estimation"
```

---

### Task 2.11: `pricing` on `OpenRouterModel`

**Files**
- Create `packages/llm/src/cost-estimate.ts` (pricing half; estimate in Task 2.12)
- Modify `packages/llm/src/client.ts:327-336` (types) and `:381-391` (row mapping)
- Modify `packages/llm/src/client.test.ts` (inside `describe("fetchOpenRouterModels")`, :104-166)

**Interfaces**
- Produces: `interface ModelPricing { promptUsdPerToken: number; completionUsdPerToken: number }`; `parseModelPricing(raw: unknown): ModelPricing | undefined`; `findModelPricing(models: readonly OpenRouterModel[], modelId: string): ModelPricing | null`; `OpenRouterModel.pricing?: ModelPricing`.

- [ ] **Step 1: failing test** (append in the `fetchOpenRouterModels` describe; `stubFetch` and `openRouterConfig` are the file's existing helpers):

```ts
  it("parses per-token USD pricing from the catalog row", async () => {
    const fetchImpl = stubFetch({ data: [
      { id: "deepseek/deepseek-v4.1-flash", name: "Flash", pricing: { prompt: "0.0000003", completion: "0.0000012" } },
      { id: "meta/free", name: "Free", pricing: { prompt: "0", completion: "0" } },
      { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" } },
      { id: "odd/model", name: "Odd", pricing: { prompt: "abc", completion: "0.000001" } },
      { id: "no/pricing", name: "None" },
    ] });
    const models = await fetchOpenRouterModels({ config: openRouterConfig, fetchImpl });
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["deepseek/deepseek-v4.1-flash"].pricing).toEqual({ promptUsdPerToken: 0.0000003, completionUsdPerToken: 0.0000012 });
    expect(byId["meta/free"].pricing).toEqual({ promptUsdPerToken: 0, completionUsdPerToken: 0 });
    expect(byId["openrouter/auto"].pricing).toBeUndefined();
    expect(byId["odd/model"].pricing).toBeUndefined();
    expect(byId["no/pricing"]).not.toHaveProperty("pricing");
  });
```

(Check `stubFetch(payload)` at :8 returns a 200 JSON response of `payload`; it is already used that way at :165.)

- [ ] **Step 2: run** `cd packages/llm && bunx vitest run src/client.test.ts` -> FAIL (`pricing` undefined on the flash row).

- [ ] **Step 3: implement.** `cost-estimate.ts`:

```ts
// What a report would cost on the person's own OpenRouter account. Pure. A
// missing, unparseable or negative price yields NO number, never a guess.

import type { ChatMessage, OpenRouterModel } from "./client";

export interface ModelPricing {
  readonly promptUsdPerToken: number;
  readonly completionUsdPerToken: number;
}

function usdPerToken(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** OpenRouter `/models` `pricing` ({ prompt, completion } as decimal USD-per-token strings). */
export function parseModelPricing(raw: unknown): ModelPricing | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const prompt = usdPerToken(row.prompt);
  const completion = usdPerToken(row.completion);
  return prompt === undefined || completion === undefined
    ? undefined
    : { promptUsdPerToken: prompt, completionUsdPerToken: completion };
}

/** The configured model's price, or null when the catalog has no usable price for it. */
export function findModelPricing(models: readonly OpenRouterModel[], modelId: string): ModelPricing | null {
  return models.find((model) => model.id === modelId)?.pricing ?? null;
}
```

client.ts: `import { parseModelPricing, type ModelPricing } from "./cost-estimate";` (cost-estimate imports only types from client, so no runtime cycle). Add to `OpenRouterModel`:

```ts
  /** Per-token USD price from the catalog; absent when missing or unparseable. */
  readonly pricing?: ModelPricing;
```

Response row type: `ReadonlyArray<{ readonly id?: unknown; readonly name?: unknown; readonly pricing?: unknown }>`. In the loop replace `models.push({ id: row.id, name });` with:

```ts
    const pricing = parseModelPricing(row.pricing);
    models.push({ id: row.id, name, ...(pricing ? { pricing } : {}) });
```

- [ ] **Step 4: run, expect pass** -> whole `client.test.ts` green (the existing exact `toEqual` on `{ id, name }` rows still holds: rows without pricing get no key).

- [ ] **Step 5: commit**
```bash
git add packages/llm/src/cost-estimate.ts packages/llm/src/client.ts packages/llm/src/client.test.ts
git commit -m "feat(llm): read per-token pricing from the OpenRouter catalog"
```

---

### Task 2.12: `estimateReadingCost` and `READING_OUTPUT_BUDGET`

**Files**
- Modify `packages/llm/src/cost-estimate.ts`
- Create `packages/llm/src/__tests__/cost-estimate.test.ts`

**Interfaces**
- Consumes: `estimateTokens` (budget.ts:19), `REPORT_WORD_TARGETS`, `REPORT_SECTIONS`, `REPORT_SECTION_REASONING_MAX_TOKENS`.
- Produces: `interface ReadingOutputBudget { visibleTokensLow: number; visibleTokensHigh: number; reasoningTokensLow: number; reasoningTokensHigh: number }`; `READING_OUTPUT_BUDGET`; `interface CostEstimate { lowUsd: number; highUsd: number }`; `estimateReadingCost(messages: readonly (readonly ChatMessage[])[], pricing: ModelPricing | null, budget: ReadingOutputBudget): CostEstimate | null`.

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/cost-estimate.test.ts`

```ts
import { describe, expect, it } from "vitest";

import {
  estimateReadingCost,
  findModelPricing,
  parseModelPricing,
  READING_OUTPUT_BUDGET,
  type ModelPricing,
} from "../cost-estimate";

const FLASH: ModelPricing = { promptUsdPerToken: 0.0000003, completionUsdPerToken: 0.0000012 };
// 4,000 chars = 1,000 estimated input tokens (chars / 4).
const MESSAGES = [[{ role: "user" as const, content: "x".repeat(4000) }]];

describe("READING_OUTPUT_BUDGET", () => {
  it("pins the documented budget: targets -30 % / +30 %, x1.35 tokens/word, 2 voices, 9 x 6,000 reasoning", () => {
    expect(READING_OUTPUT_BUDGET).toEqual({
      visibleTokensLow: 8184,
      visibleTokensHigh: 21200,
      reasoningTokensLow: 0,
      reasoningTokensHigh: 54000,
    });
  });
});

describe("estimateReadingCost", () => {
  it("prices input from the built messages and output from the budget", () => {
    const estimate = estimateReadingCost(MESSAGES, FLASH, READING_OUTPUT_BUDGET);
    expect(estimate?.lowUsd).toBeCloseTo(1000 * 0.0000003 + 8184 * 0.0000012, 12);
    expect(estimate?.highUsd).toBeCloseTo(1000 * 0.0000003 + (21200 + 54000) * 0.0000012, 12);
  });

  it("no price, no number", () => {
    expect(estimateReadingCost(MESSAGES, null, READING_OUTPUT_BUDGET)).toBeNull();
  });

  it("a free model is a distinguishable zero, not a missing number", () => {
    expect(estimateReadingCost(MESSAGES, { promptUsdPerToken: 0, completionUsdPerToken: 0 }, READING_OUTPUT_BUDGET)).toEqual({ lowUsd: 0, highUsd: 0 });
  });

  it("a model missing from the catalog gives no estimate", () => {
    const pricing = findModelPricing([{ id: "other/model", name: "Other", pricing: FLASH }], "deepseek/deepseek-v4.1-flash");
    expect(pricing).toBeNull();
    expect(estimateReadingCost(MESSAGES, pricing, READING_OUTPUT_BUDGET)).toBeNull();
  });

  it.each([
    ["negative", { prompt: "-1", completion: "-1" }],
    ["non-numeric", { prompt: "abc", completion: "0.000001" }],
    ["empty", { prompt: "", completion: "" }],
    ["numbers, not strings", { prompt: 0.0000003, completion: 0.0000012 }],
  ])("%s catalog prices give no estimate", (_label, raw) => {
    const pricing = parseModelPricing(raw) ?? null;
    expect(pricing).toBeNull();
    expect(estimateReadingCost(MESSAGES, pricing, READING_OUTPUT_BUDGET)).toBeNull();
  });
});
```

- [ ] **Step 2: run** `cd packages/llm && bunx vitest run src/__tests__/cost-estimate.test.ts` -> FAIL (`estimateReadingCost` not exported).

- [ ] **Step 3: implement** (append to `cost-estimate.ts`; add imports `import { estimateTokens } from "./budget"; import { REPORT_SECTION_REASONING_MAX_TOKENS } from "./reasoning"; import { REPORT_SECTIONS, REPORT_WORD_TARGETS } from "./report-targets";`):

```ts
export interface ReadingOutputBudget {
  readonly visibleTokensLow: number;
  readonly visibleTokensHigh: number;
  readonly reasoningTokensLow: number;
  readonly reasoningTokensHigh: number;
}

export interface CostEstimate {
  readonly lowUsd: number;
  readonly highUsd: number;
}

const TOKENS_PER_WORD = 1.35;
const VOICES = 2;
/** Same band the real spec accepts for word counts. */
const TARGET_TOLERANCE = 0.3;

function totalWords(edge: "low" | "high"): number {
  return REPORT_SECTIONS.reduce((sum, section) => sum + REPORT_WORD_TARGETS[section][edge], 0);
}

function visibleTokens(words: number): number {
  return Math.round(words * TOKENS_PER_WORD * VOICES);
}

/** Full report on a cloud model: visible prose plus reasoning, low to high. */
export const READING_OUTPUT_BUDGET: ReadingOutputBudget = {
  visibleTokensLow: visibleTokens(totalWords("low") * (1 - TARGET_TOLERANCE)),
  visibleTokensHigh: visibleTokens(totalWords("high") * (1 + TARGET_TOLERANCE)),
  reasoningTokensLow: 0,
  reasoningTokensHigh: REPORT_SECTIONS.length * REPORT_SECTION_REASONING_MAX_TOKENS,
};

/**
 * Input is counted from the exact message arrays that will be sent
 * (buildReportMessages, chars/4); output comes from the budget. No pricing,
 * no number.
 */
export function estimateReadingCost(
  messages: readonly (readonly ChatMessage[])[],
  pricing: ModelPricing | null,
  budget: ReadingOutputBudget,
): CostEstimate | null {
  if (pricing === null) return null;
  const inputTokens = messages.reduce(
    (sum, conversation) => sum + conversation.reduce((acc, message) => acc + estimateTokens(message.content), 0),
    0,
  );
  const usd = (outputTokens: number): number =>
    inputTokens * pricing.promptUsdPerToken + outputTokens * pricing.completionUsdPerToken;
  return {
    lowUsd: usd(budget.visibleTokensLow + budget.reasoningTokensLow),
    highUsd: usd(budget.visibleTokensHigh + budget.reasoningTokensHigh),
  };
}
```

- [ ] **Step 4: run, expect pass** (8 tests).

- [ ] **Step 5: commit**
```bash
git add packages/llm/src/cost-estimate.ts packages/llm/src/__tests__/cost-estimate.test.ts
git commit -m "feat(llm): estimateReadingCost from built messages, catalog price and the output budget"
```

---

### Task 2.13: Public surface, kept v1 names, knip

**Files**
- Modify `packages/llm/src/index.ts` (structured block :169-191, client block :105-118, reasoning block :380-387, sanitize types :17-35, predictive-facts :37-41)
- Create `packages/llm/src/__tests__/report-exports.test.ts`

**Interfaces**
- Produces the package surface PR 3 imports. Kept for stored v1 content: `CurrentTimelineContent`, `CurrentTimelineSectionKey`, `CurrentTimelineEvent`, `CURRENT_TIMELINE_SECTIONS`, `streamCurrentTimeline` (deprecated for generation).

- [ ] **Step 1: failing test** `packages/llm/src/__tests__/report-exports.test.ts`

```ts
import { describe, expect, it } from "vitest";

import * as llm from "../index";
import type {
  CostEstimate, CurrentPeriodSection, CurrentTimelineContent, LifeOutlookDomain, LifeOutlookSection, ModelPricing,
  Quarter, QuarterKey, QuarterProse, ReadingOutputBudget, ReportMessages, ReportSectionKey, ReportTimelineContent,
  ReportTimelineEvent, ReportTimelineSectionKey, SanitizedHouseLord, YearAheadSection,
} from "../index";

describe("@almamesh/llm report surface", () => {
  it.each([
    "buildReportMessages", "computeQuarters", "quarterTitle", "quarterEvents", "validateTimelineDates", "monthsIn",
    "estimateReadingCost", "parseModelPricing", "findModelPricing", "streamReportTimeline", "reportAsOfMonth",
    "currentPeriodSlice", "yearAheadSlice", "lifeOutlookSlice", "ReportParseError",
    // kept for readers of stored v1 timelines until PR 3 removes v1 generation
    "streamCurrentTimeline", "CURRENT_TIMELINE_SECTIONS",
  ])("exports %s", (name) => {
    expect((llm as Record<string, unknown>)[name]).toBeDefined();
  });

  it("pins the literal constants", () => {
    expect(llm.REPORT_PROMPT_SET).toBe("report-v2");
    expect(llm.REPORT_SECTION_REASONING_MAX_TOKENS).toBe(6000);
    expect(llm.REPORT_TIMELINE_SECTIONS).toEqual(["current_period", "year_ahead", "life_outlook_1", "life_outlook_2"]);
    expect(llm.LIFE_OUTLOOK_GROUPS).toEqual({
      life_outlook_1: ["career", "finances", "relationships", "family"],
      life_outlook_2: ["health", "education", "spiritual"],
    });
    expect(llm.CURRENT_TIMELINE_SECTIONS).toEqual(["upcoming_periods", "current_sky"]);
  });

  it("keeps the v1 reader type assignable from stored content", () => {
    const stored: CurrentTimelineContent = { upcoming_periods: [], current_sky: [] };
    expect(stored.current_sky).toEqual([]);
  });
});

// Compile-time only: every contract type is importable.
export type _ReportTypes = [
  CostEstimate, CurrentPeriodSection, LifeOutlookDomain, LifeOutlookSection, ModelPricing, Quarter, QuarterKey,
  QuarterProse, ReadingOutputBudget, ReportMessages, ReportSectionKey, ReportTimelineContent, ReportTimelineEvent,
  ReportTimelineSectionKey, SanitizedHouseLord, YearAheadSection,
];
```

- [ ] **Step 2: run** `cd packages/llm && bunx vitest run src/__tests__/report-exports.test.ts` -> FAIL on the names not yet exported (`computeQuarters`, `quarterTitle`, `validateTimelineDates`, ...).

- [ ] **Step 3: implement** - add to `index.ts`:

```ts
export { computeQuarters, quarterTitle } from "./quarters";
export type { Quarter, QuarterKey } from "./quarters";
export { monthsIn, validateTimelineDates } from "./date-guard";
export {
  currentPeriodSlice, LIFE_DOMAIN_ORDER, LIFE_OUTLOOK_GROUPS, lifeOutlookSlice, quarterEvents, REPORT_TIMELINE_SECTIONS,
  ReportParseError, reportAsOfMonth, yearAheadSlice,
} from "./report-sections";
export type {
  CurrentPeriodSection, LifeOutlookDomain, LifeOutlookSection, QuarterEvent, QuarterProse, ReportTimelineContent,
  ReportTimelineSectionKey, YearAheadSection,
} from "./report-sections";
export { REPORT_PROMPT_SET, REPORT_SECTIONS, REPORT_SECTION_ORDER, REPORT_WORD_TARGETS } from "./report-targets";
export type { ReportPromptSet, ReportSectionKey } from "./report-targets";
export { estimateReadingCost, findModelPricing, parseModelPricing, READING_OUTPUT_BUDGET } from "./cost-estimate";
export type { CostEstimate, ModelPricing, ReadingOutputBudget } from "./cost-estimate";
export { buildReportFactsBlock, REPORT_FACTS_START, REPORT_FACTS_END } from "./predictive-facts";
```

plus `SanitizedHouseLord` in the sanitize type export list, and confirm Task 2.9/2.10 exports are present. Internal-only helpers (`parseYearAhead`, `parseLifeOutlook`, `parseCurrentPeriod`, `reportSlice`, `isReportTimelineSection`, `REPORT_FIELD_TARGETS`, `stableNatalChart`, `persona-parse.ts`) stay unexported from the index; they are imported by tests by path.

- [ ] **Step 4: run** the export test, then knip: `bun run knip`. Expected: no new `files` errors; any new `exports` warnings for internal helpers that only tests use are removed by un-exporting them (keep `export` only where another source module imports it).

- [ ] **Step 5: typecheck the consumers**: `bunx tsc -b packages/shared-types packages/constants packages/store packages/llm --force && bun run --filter '*' typecheck` -> clean (the web hook still compiles against the unchanged v1 API).

- [ ] **Step 6: commit**
```bash
git add packages/llm/src/index.ts packages/llm/src/__tests__/report-exports.test.ts
git commit -m "feat(llm): export the report-v2 surface; keep v1 timeline names for stored readings"
```

---

### Task 2.14: Real spec - full report, 3 runs, P90, cost in range, words +/-30 %

**Files**
- Create `apps/web/e2e/report.real.spec.ts`
- Create `apps/web/playwright.report.real.config.ts`
- Modify `apps/web/package.json` (scripts, next to `test:e2e:timeline:real` at :20)
- Modify `apps/web/src/test/realModelSpecs.contract.test.ts` (`finds the real specs it guards` list)
- Modify `dagger/src/index.ts` (`NIGHTLY_REPORTED_E2E`, ~:105) and `tests/dagger-nightly-real-skips.test.ts:142` (repo root paths)
- Extend `apps/web/e2e/sectionUsage.ts` with `reportSectionWords` (+ unit test in `src/test/sectionUsage.test.ts`)

**Interfaces**
- Consumes (Node-side, from `@almamesh/llm`): `buildReportMessages`, `estimateReadingCost`, `READING_OUTPUT_BUDGET`, `fetchOpenRouterModels`, `findModelPricing`, `REPORT_PROMPT_SET`, `REPORT_SECTIONS`, `REPORT_WORD_TARGETS`, `streamNatalInterpretation`, `streamReportTimeline`; `completionUsage`; `E2E_REAL_MODEL`.
- Produces: `reportSectionWords(section: string, natal: NatalInterpretation, timeline: ReportTimelineContent): { layman: number; technical: number }` (sectionUsage.ts).

- [ ] **Step 1: failing unit test** for the word counter (append to `apps/web/src/test/sectionUsage.test.ts`):

```ts
import type { NatalInterpretation, ReportTimelineContent } from '@almamesh/llm';
import { reportSectionWords } from '../../e2e/sectionUsage';

describe('reportSectionWords', () => {
  const p = (l: string, t: string) => ({ layman: l, technical: t });
  const natal = {
    summary: p('a b', 'c'), strengths: [{ title: 'x', ...p('d', 'e f') }], challenges: [], life_themes: [],
    health_guidance: p('h', 'h'), family_guidance: p('one two three', 'four'),
  } as unknown as NatalInterpretation;
  const timeline: ReportTimelineContent = {
    current_period: { maha: p('m', 'm'), antar: p('a', 'a'), activates: [], next_change: p('n', 'n') },
    year_ahead: { headline: p('h', 'h'), quarters: [{ key: 'Q1', ...p('q one', 'q') }] },
    life_outlook: {
      life_outlook_1: { domains: [{ domain: 'career', outlook: p('c c', 'c') }] },
      life_outlook_2: { domains: [{ domain: 'health', outlook: p('h', 'h h') }] },
    },
  };

  it('counts core, guidance1 (with family) and the outlook groups per voice', () => {
    expect(reportSectionWords('core', natal, timeline)).toEqual({ layman: 3, technical: 3 });
    expect(reportSectionWords('guidance1', natal, timeline)).toEqual({ layman: 4, technical: 2 });
    expect(reportSectionWords('year_ahead', natal, timeline)).toEqual({ layman: 3, technical: 2 });
    expect(reportSectionWords('life_outlook_1', natal, timeline)).toEqual({ layman: 2, technical: 1 });
    expect(reportSectionWords('life_outlook_2', natal, timeline)).toEqual({ layman: 1, technical: 2 });
  });
});
```

Run `cd apps/web && bunx vitest run src/test/sectionUsage.test.ts` -> FAIL (`reportSectionWords` not exported).

- [ ] **Step 2: implement** in `sectionUsage.ts`:

```ts
import type { NatalInterpretation, ReportTimelineContent } from '@almamesh/llm';

function voicesOf(...values: unknown[]): Voices {
  const voices = { layman: 0, technical: 0 };
  for (const value of values) addVoices(value, voices);
  return voices;
}

/** Words per voice for one report section, read from what reached the screen. */
export function reportSectionWords(section: string, natal: NatalInterpretation, timeline: ReportTimelineContent): Voices {
  switch (section) {
    case 'core': return voicesOf(natal.summary, natal.strengths, natal.challenges, natal.life_themes);
    case 'yoga': return voicesOf(natal.integrated_yoga_narrative);
    case 'guidance1': return voicesOf(natal.health_guidance, natal.education_guidance, natal.career_guidance, natal.relationship_guidance, natal.family_guidance);
    case 'guidance2': return voicesOf(natal.finances_guidance, natal.spiritual_guidance, natal.life_evolution_guidance);
    case 'remedial': return voicesOf(natal.remedial_measures);
    case 'current_period': return voicesOf(timeline.current_period);
    case 'year_ahead': return voicesOf(timeline.year_ahead);
    case 'life_outlook_1':
    case 'life_outlook_2':
      return voicesOf(timeline.life_outlook[section]?.domains.map((row) => row.outlook));
    default: return { layman: 0, technical: 0 };
  }
}
```

Run -> pass.

- [ ] **Step 3: the spec** `apps/web/e2e/report.real.spec.ts`

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  buildReportMessages,
  estimateReadingCost,
  fetchOpenRouterModels,
  findModelPricing,
  READING_OUTPUT_BUDGET,
  REPORT_PROMPT_SET,
  REPORT_SECTIONS,
  REPORT_WORD_TARGETS,
  streamNatalInterpretation,
  streamReportTimeline,
  type AnalysisInstant,
  type NatalInterpretation,
  type ProviderConfig,
  type ReportTimelineContent,
} from '@almamesh/llm';
import { E2E_REAL_MODEL } from './realModel';
import { reportSectionWords, sectionUsageRow, type SectionUsageRow } from './sectionUsage';

/**
 * Full report REAL check (no browser): the nine report-v2 sections against
 * live OpenRouter, three runs. Records per run: wall time (natal and timeline
 * run concurrently, as the app does), usage.cost per section, words per voice
 * per section. Asserts: every section lands; usage.cost is inside
 * estimateReadingCost's range; words are within REPORT_WORD_TARGETS +/-30 %;
 * every request carries reasoning.max_tokens 6000 and no max_tokens. P90 is
 * asserted only when REPORT_P90_BUDGET_MS is set (the default-model run).
 *
 * Nightly:  OPENROUTER_API_KEY=... bun run test:e2e:report:real
 * Default model (PR evidence):
 *   REPORT_REAL_MODEL=deepseek/deepseek-v4.1-flash REPORT_P90_BUDGET_MS=150000 OPENROUTER_API_KEY=... bun run test:e2e:report:real
 */

const MODEL = process.env.REPORT_REAL_MODEL ?? E2E_REAL_MODEL;
const RUNS = 3;
const P90_BUDGET_MS = process.env.REPORT_P90_BUDGET_MS ? Number(process.env.REPORT_P90_BUDGET_MS) : null;
const KEY = '1990-01-15T12:00:00+00:00';
const FIXTURES = new URL('../../../../backend/tests/fixtures/', import.meta.url);

function goldenChart(): SiderealChart {
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as Record<string, object>;
  return { ...read('chart_golden_de421.json')[KEY], ...read('predictive_golden_de421.json')[KEY] } as SiderealChart;
}

const AS_OF: AnalysisInstant = { basis: 'chart', instant: new Date('2026-06-09T12:00:00Z') };

function nearestRankP90(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

test('[real] full report-v2 reading against live OpenRouter (3 runs)', async () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  test.skip(!apiKey, 'OPENROUTER_API_KEY not set');
  test.setTimeout(2_400_000);

  const config: ProviderConfig = {
    engine: 'openai-http', model: MODEL, privacyMode: 'cloud_premium',
    baseUrl: 'https://openrouter.ai/api/v1', apiKey,
  };
  const chart = goldenChart();
  const pricing = findModelPricing(await fetchOpenRouterModels({ config }), MODEL);
  const messages = buildReportMessages({ chart, asOf: AS_OF }, { mode: 'layman', language: 'en', lite: false });
  const estimate = estimateReadingCost(REPORT_SECTIONS.map((s) => messages[s]), pricing, READING_OUTPUT_BUDGET);
  expect(estimate, `OpenRouter lists no usable price for ${MODEL}`).not.toBeNull();

  const runs: { totalMs: number; costUsd: number; rows: SectionUsageRow[]; words: Record<string, { layman: number; technical: number }>; errors: string[] }[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const rows: SectionUsageRow[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const requestBody = String(init?.body ?? '');
      bodies.push(JSON.parse(requestBody) as Record<string, unknown>);
      const res = await fetch(input, init);
      const row = sectionUsageRow(requestBody, res.status, await res.clone().text());
      if (row) rows.push(row);
      return res;
    };
    const errors: string[] = [];
    let natal: NatalInterpretation | null = null;
    let timeline: ReportTimelineContent | null = null;
    const t0 = Date.now();
    await Promise.all([
      (async () => {
        for await (const e of streamNatalInterpretation({ chart, asOf: AS_OF, config, fetchImpl, promptSet: REPORT_PROMPT_SET })) {
          if (e.type === 'error') errors.push(`${e.section}: ${e.message}`);
          if (e.type === 'complete') natal = e.interpretation;
        }
      })(),
      (async () => {
        for await (const e of streamReportTimeline({ chart, asOf: AS_OF, config, fetchImpl })) {
          if (e.type === 'error') errors.push(`${e.section}: ${e.message}`);
          if (e.type === 'complete') timeline = e.timeline;
        }
      })(),
    ]);
    const totalMs = Date.now() - t0;
    expect(natal).not.toBeNull();
    expect(timeline).not.toBeNull();
    const words = Object.fromEntries(REPORT_SECTIONS.map((s) => [s, reportSectionWords(s, natal as unknown as NatalInterpretation, timeline as unknown as ReportTimelineContent)]));
    for (const body of bodies) {
      expect(body.reasoning).toEqual({ max_tokens: 6000 });
      expect(body).not.toHaveProperty('max_tokens');
    }
    runs.push({ totalMs, costUsd: rows.reduce((s, r) => s + r.costUsd, 0), rows, words, errors });
  }

  const p90Ms = nearestRankP90(runs.map((r) => r.totalMs));
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    `test-results/report-real-${MODEL.replace(/\W/g, '_')}.json`,
    JSON.stringify({ model: MODEL, estimate, p90Ms, runs }, null, 2),
  );

  for (const run of runs) {
    expect(run.errors, 'every section lands').toEqual([]);
    expect.soft(run.costUsd, 'usage.cost >= estimate low').toBeGreaterThanOrEqual(estimate?.lowUsd ?? Infinity);
    expect.soft(run.costUsd, 'usage.cost <= estimate high').toBeLessThanOrEqual(estimate?.highUsd ?? -Infinity);
    for (const section of REPORT_SECTIONS) {
      const target = REPORT_WORD_TARGETS[section];
      for (const voice of ['layman', 'technical'] as const) {
        const n = run.words[section][voice];
        expect.soft(n, `${section} ${voice} words >= ${Math.floor(target.low * 0.7)}`).toBeGreaterThanOrEqual(Math.floor(target.low * 0.7));
        expect.soft(n, `${section} ${voice} words <= ${Math.ceil(target.high * 1.3)}`).toBeLessThanOrEqual(Math.ceil(target.high * 1.3));
      }
    }
  }
  if (P90_BUDGET_MS !== null) expect(p90Ms, `P90 over ${RUNS} runs`).toBeLessThan(P90_BUDGET_MS);
});
```

- [ ] **Step 4: config** `apps/web/playwright.report.real.config.ts`

```ts
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
```

`apps/web/package.json` scripts: `"test:e2e:report:real": "playwright test --config=playwright.report.real.config.ts",` and `"test:e2e:report:regression": "playwright test --config=playwright.report-regression.config.ts",`.

Contract test: add `'report.real.spec.ts',` to the `arrayContaining` list in `finds the real specs it guards`. Nightly: add `  "report:real",` as the last line of `NIGHTLY_REPORTED_E2E` in `dagger/src/index.ts`, and `"report:real"` to the suite array at `tests/dagger-nightly-real-skips.test.ts:142`.

- [ ] **Step 5: prove the guards first (no key)**
```bash
cd apps/web && bunx vitest run src/test/realModelSpecs.contract.test.ts src/test/sectionUsage.test.ts
cd ../../.. && bun test tests/dagger-nightly-real-skips.test.ts
cd frontend/apps/web && bun run test:e2e:report:real
```
Expected: contract green (the spec names no slug and never sends `PRODUCT_DEFAULT_MODEL`); nightly test green; the spec SKIPS with "OPENROUTER_API_KEY not set" (this also proves Playwright loads `@almamesh/llm` in Node; if it cannot, the failure is a module-resolution error here, and the fix is a `paths`-free relative import `../../../packages/llm/src/index` in the spec).

- [ ] **Step 6: measure (key required)**
```bash
cd apps/web
OPENROUTER_API_KEY=$OPENROUTER_API_KEY bun run test:e2e:report:real
OPENROUTER_API_KEY=$OPENROUTER_API_KEY REPORT_REAL_MODEL=deepseek/deepseek-v4.1-flash REPORT_P90_BUDGET_MS=150000 bun run test:e2e:report:real
node -e 'for (const f of ["deepseek_deepseek_v4_pro","deepseek_deepseek_v4_1_flash"]) { const j=require("./test-results/report-real-"+f+".json"); console.log(j.model, "P90", (j.p90Ms/1000).toFixed(1)+"s", "estimate", j.estimate.lowUsd.toFixed(4)+"-"+j.estimate.highUsd.toFixed(4), "runs", j.runs.map(r=>r.costUsd.toFixed(4)+"/"+(r.totalMs/1000).toFixed(0)+"s").join(" ")); }'
```
Expected: both runs pass; flash P90 < 150 s. If flash P90 >= 150 s and `year_ahead` is the slowest section in `rows`, split it into two calls (Q1-Q2, Q3-Q4) as the spec allows, in a follow-up task before merge, and re-measure. Paste the numbers plus a per-section words table (median of 3) into the PR body next to the Task 2.1 baseline.

- [ ] **Step 7: commit**
```bash
git add apps/web/e2e/report.real.spec.ts apps/web/playwright.report.real.config.ts apps/web/package.json apps/web/e2e/sectionUsage.ts apps/web/src/test/sectionUsage.test.ts apps/web/src/test/realModelSpecs.contract.test.ts ../dagger/src/index.ts ../tests/dagger-nightly-real-skips.test.ts
git commit -m "test(e2e): nightly real check for the nine-section report: P90, cost range, word targets"
```

---

### Task 2.15: Mutation red runs

**Files**
- Create `frontend/apps/web/scripts/mutations/pr2-report-sections.sh` (no mutation harness exists in the repo; this is the new location for all four PRs)

Each mutation breaks the property, not the form. The verdict is the test runner's exit code.

| # | Mutation | File | Test that must go red |
| --- | --- | --- | --- |
| 1 | `validateTimelineDates` returns its input | `date-guard.ts` | `date-guard.test.ts` "removes a month the engine did not supply" |
| 2 | Let a `YYYY-MM-DD` through | `date-guard.ts` | "removes day-precision dates" |
| 3 | Pass the full predictive block to `life_outlook_*` | `report-sections.ts` | `report-slices.test.ts` "passes life_outlook_1 only its four domain forecasts..." |
| 4 | Hard-code a price when pricing is absent | `cost-estimate.ts` | `cost-estimate.test.ts` "no price, no number" |
| 5 | Accept any quarter key | `report-sections.ts` | `report-parsers.test.ts` "rejects a quarter key it did not send" |
| 6 | Send the 12k cap on report sections | `structured-interpretation.ts` | `report-timeline.test.ts` "caps reasoning at 6,000 tokens on every report section" |

- [ ] **Step 1: write the script**

```bash
#!/usr/bin/env bash
# PR 2 mutation red runs. Each mutation must apply (asserted), and its named
# test must FAIL (verdict = vitest exit code, never grepped output). The tree
# must be clean before and after.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
LLM="$ROOT/frontend/packages/llm"
cd "$ROOT"

if ! git diff --quiet -- frontend/packages/llm/src; then
  echo "refusing to run: frontend/packages/llm/src has uncommitted changes" >&2
  exit 2
fi

FAILED=0
MARKERS=()

mutate() {
  local id="$1" file="$2" perl_expr="$3" marker="$4" test_file="$5" test_name="$6"
  MARKERS+=("$marker")
  perl -0pi -e "$perl_expr" "$ROOT/$file"
  if ! grep -qF "$marker" "$ROOT/$file"; then
    echo "MUTATION $id DID NOT APPLY to $file" >&2
    git checkout -- "$file"
    exit 1
  fi
  (cd "$LLM" && bunx vitest run "$test_file" -t "$test_name" >/tmp/pr2-mutation-$id.log 2>&1)
  local code=$?
  git checkout -- "$file"
  if [ "$code" -eq 0 ]; then
    echo "| $id | $file | $test_name | GREEN (guard did NOT catch it) |"
    FAILED=1
  else
    echo "| $id | $file | $test_name | RED (exit $code) |"
  fi
}

echo "| # | file | test | result |"
echo "| --- | --- | --- | --- |"

mutate 1 frontend/packages/llm/src/date-guard.ts \
  's/(\): \{ section: T; removals: number \} \{\n)/$1  return { section, removals: 0 }; \/\/ MUTATION-PR2-1\n/' \
  'MUTATION-PR2-1' src/__tests__/date-guard.test.ts 'removes a month the engine did not supply'

mutate 2 frontend/packages/llm/src/date-guard.ts \
  's/if \(DAY_DATE\.test\(sentence\)\) return true;/if (false) return true; \/\/ MUTATION-PR2-2/' \
  'MUTATION-PR2-2' src/__tests__/date-guard.test.ts 'removes day-precision dates'

mutate 3 frontend/packages/llm/src/report-sections.ts \
  's/return forecast \? \[\{ \.\.\.forecast, house_lords: houses\[domain\] \?\? \[\] \}\] : \[\];/return [{ ...(forecast ?? {}), ...chart.predictive, house_lords: houses[domain] ?? [] } as never]; \/\/ MUTATION-PR2-3/' \
  'MUTATION-PR2-3' src/__tests__/report-slices.test.ts 'passes life_outlook_1 only its four domain forecasts'

mutate 4 frontend/packages/llm/src/cost-estimate.ts \
  's/if \(pricing === null\) return null;/if (pricing === null) pricing = { promptUsdPerToken: 0.0000003, completionUsdPerToken: 0.0000012 }; \/\/ MUTATION-PR2-4/' \
  'MUTATION-PR2-4' src/__tests__/cost-estimate.test.ts 'no price, no number'

mutate 5 frontend/packages/llm/src/report-sections.ts \
  's/if \(!isSentQuarter\(key, sent\) \|\| seen\.has\(key\)\) \{/if (false \&\& seen.has(key as QuarterKey)) { \/\/ MUTATION-PR2-5/' \
  'MUTATION-PR2-5' src/__tests__/report-parsers.test.ts 'rejects a quarter key it did not send'

mutate 6 frontend/packages/llm/src/structured-interpretation.ts \
  's/\? REPORT_SECTION_REASONING_MAX_TOKENS\n/? SECTION_REASONING_MAX_TOKENS \/\/ MUTATION-PR2-6\n/' \
  'MUTATION-PR2-6' src/__tests__/report-timeline.test.ts 'caps reasoning at 6,000 tokens on every report section'

if ! git diff --quiet; then
  echo "tree not clean after restoring mutations" >&2
  git diff --stat >&2
  exit 1
fi
for marker in "${MARKERS[@]}"; do
  if grep -rqF "$marker" "$ROOT/frontend/packages/llm/src"; then
    echo "leftover mutation marker $marker in the tree" >&2
    exit 1
  fi
done

exit "$FAILED"
```

Note on mutation 5: `key` is not narrowed to `QuarterKey` once the guard is gone, but vitest does not typecheck, so the mutated file still runs; the cast in the replacement keeps the line valid TS anyway.

- [ ] **Step 2: run it** `bash frontend/apps/web/scripts/mutations/pr2-report-sections.sh; echo "exit $?"`
Expected: six rows, all `RED (exit 1)`, final `exit 0`, `git status --short` empty. If any row is GREEN the guard measures shape: fix the test, not the script.

- [ ] **Step 3: commit**
```bash
chmod +x frontend/apps/web/scripts/mutations/pr2-report-sections.sh
git add frontend/apps/web/scripts/mutations/pr2-report-sections.sh
git commit -m "test(mutations): PR 2 red runs for the date guard, input slices, pricing and reasoning cap"
```

---

### Task 2.16: Live end-to-end

PR 2 changes no screen. The live check proves the dashboard reading journey is unchanged in a real no-hooks production build, on desktop Chromium and the iPhone 15 WebKit profile, and that the app still sends only v1 sections (the hook is not switched until PR 3). The real-model check is Task 2.14's spec.

**Files**
- Create `apps/web/e2e/report-regression.spec.ts`
- Create `apps/web/playwright.report-regression.config.ts`

- [ ] **Step 1: config** `apps/web/playwright.report-regression.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PORT = Number(process.env.REPORT_REGRESSION_PORT ?? 4191);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * PR 2 live regression: a NO-HOOKS production build, the real onboarding
 * journey, then the dashboard reading against a stubbed provider. WebKit
 * needs macOS and an on-disk profile (e2e/webkitProfile.ts); its service
 * worker is blocked so page.route sees the provider calls.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /report-regression\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 120_000 },
  reporter: 'list',
  use: { baseURL: BASE_URL, headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone-15-webkit', use: { ...devices['iPhone 15'], serviceWorkers: 'block' } },
  ],
  webServer: {
    command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 600_000,
    cwd: __dirname,
  },
});
```

- [ ] **Step 2: spec** `apps/web/e2e/report-regression.spec.ts`

```ts
import { mkdirSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './webkitProfile';
import { collectConsoleErrors, expectChartRenders, generateChart } from './live/liveJourney';
import { LLM_SETTINGS_KEY } from './interpretation.helpers';

/**
 * PR 2 ships library code only. This drives the real journey (no hooks) and
 * proves the dashboard reading and timeline still render from the v1
 * sections, and that no report-v2 section is requested yet.
 */

const LEGACY = ['core', 'yoga', 'guidance1', 'guidance2', 'remedial', 'upcoming_periods', 'current_sky'] as const;
const p = (text: string) => ({ layman: text, technical: text });
const STUB: Record<(typeof LEGACY)[number], unknown> = {
  core: { summary: p('STUB SUMMARY about this chart.'), strengths: [{ title: 'Grit', ...p('You persevere.') }], challenges: [], life_themes: [] },
  yoga: { integrated_yoga_narrative: p('Your life arc bends toward leadership.') },
  guidance1: { career_guidance: p('Lead teams.'), health_guidance: p('Rest more.') },
  guidance2: { finances_guidance: p('Save steadily.') },
  remedial: { remedial_measures: p('Walk and journal.') },
  upcoming_periods: { upcoming_periods: [{ title: 'Next chapter', ...p('Plan deliberately.') }] },
  current_sky: { current_sky: [{ title: 'Current sky', ...p('Pause before acting.') }] },
};

test('dashboard reading still renders from the v1 sections (no hooks build)', async ({ page }, testInfo) => {
  const shots = `test-results/pr2-evidence/${testInfo.project.name}`;
  mkdirSync(shots, { recursive: true });
  const errors = collectConsoleErrors(page);
  const requested: string[] = [];

  await page.addInitScript(([key, cfg]) => window.localStorage.setItem(key as string, cfg as string), [
    LLM_SETTINGS_KEY,
    JSON.stringify({ apiBase: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', model: 'stub/model', privacyMode: 'cloud_premium', engine: 'openai-http' }),
  ] as const);
  await page.route('**/chat/completions', async (route) => {
    const section = /SECTION:([a-z0-9_]+)/.exec(route.request().postData() ?? '')?.[1] ?? '';
    requested.push(section);
    const payload = STUB[section as (typeof LEGACY)[number]];
    if (!payload) return route.fulfill({ status: 400, body: `unexpected section ${section}` });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }) });
  });

  await page.goto('/onboarding');
  await generateChart(page);
  await expectChartRenders(page);
  await page.screenshot({ path: `${shots}/1-dashboard-chart.png`, fullPage: true });

  await page.getByTestId('generate-reading').click();
  await expect(page.getByText('STUB SUMMARY about this chart.').and(page.locator('p'))).toBeVisible();
  await page.screenshot({ path: `${shots}/2-dashboard-reading.png`, fullPage: true });

  const timeline = page.getByTestId('generate-timeline').or(page.getByTestId('regenerate-timeline'));
  await expect(timeline).toBeEnabled({ timeout: 300_000 });
  await timeline.click();
  await expect(page.getByTestId('current-timeline-section')).toBeVisible();
  await page.screenshot({ path: `${shots}/3-dashboard-timeline.png`, fullPage: true });

  expect(new Set(requested)).toEqual(new Set(LEGACY));
  expect(errors).toEqual([]);
});
```

(`generateChart` / `expectChartRenders` / `collectConsoleErrors` are the live-smoke helpers at `e2e/live/liveJourney.ts:61-101`; read them before running: if `generateChart` expects to start on `/` rather than `/onboarding`, change the `goto` to match.)

- [ ] **Step 3: run both profiles**
```bash
cd apps/web && bun run test:e2e:report:regression
ls test-results/pr2-evidence/chromium test-results/pr2-evidence/iphone-15-webkit
```
Expected: 2 passed (WebKit needs macOS); three screenshots per profile; `errors` empty. Also run the existing stubbed suite unchanged: `bun run test:e2e:interp` -> green.

- [ ] **Step 4: real-model check** is Task 2.14 Step 6 (`E2E_REAL_MODEL`, skip-with-reason without a key).

- [ ] **Step 5: commit**
```bash
git add apps/web/e2e/report-regression.spec.ts apps/web/playwright.report-regression.config.ts
git commit -m "test(e2e): PR 2 live regression of the dashboard reading in Chromium and iPhone 15 WebKit"
```

---

### Task 2.17: Full gate and northstar

- [ ] **Step 1: gate** from the repo root: `make gate` -> backend and frontend gates green (frontend: declarations build, typecheck, lint, knip, all package tests, web unit tests, build, prerender + boot-fault checks). Save the tail of the output for the PR body.
- [ ] **Step 2: `frontend-quality` skill** on the changed files (`packages/llm/src/{quarters,date-guard,report-sections,report-targets,cost-estimate,persona-parse}.ts`, the modified llm files, the e2e files). Fix every finding it raises in this PR (no `any`, no default exports, `interface` over `type` for object shapes).
- [ ] **Step 3: push + PR**
```bash
git push -u origin feat/report-sections-llm
gh pr create --draft --title "feat(llm): report sections (current period, year ahead, life-area outlook), date guard, cost estimate" --body-file /tmp/pr2-body.md
```
PR body sections: TL;DR; **Claim touched** ("Readings use month precision only, and every date comes from the engine"); Deviations (the six above); Baseline table (Task 2.1); Report numbers (Task 2.14: P90 per model, estimate range vs actual `usage.cost` per run, words per section per voice vs targets); Red-run table (Task 2.15 script output, verbatim); live evidence (six screenshots from `test-results/pr2-evidence/`, console arrays empty); `make gate` tail; nightly wiring note (`report:real`). End with the attribution lines from the session system reminder.
- [ ] **Step 4: CI** `gh pr checks --watch` -> the required `Dagger` verdict green. On red, use the `github-actions-agent`, fix, push, re-watch.
- [ ] **Step 5: northstar** dispatch the `northstar` agent with: the PR URL, the claim "Readings use month precision only, and every date comes from the engine", the red-run table, and the instruction to try to get an invented or day-precision date onto a `ReportTimelineContent` through `streamReportTimeline` with a stub provider. Merge only at grade A; fix and re-grade otherwise.
- [ ] **Step 6: merge and clean up in the same breath**: `gh pr ready && gh pr merge --squash --delete-branch`, then `git worktree remove ../.worktrees/report-sections-llm && git branch -D feat/report-sections-llm`, then confirm CI green on `main`.

---

## PR 3: store v7, hook, dashboard report

**Branch:** `claude/reading-pr3-store-report` (worktree `.worktrees/reading-pr3`, from fresh `origin/main` after PR 2 merges)

**Claim touched:** "Your reading is saved on this device and survives reloads, export and import."

**Depends on:** PR 2 merged (`@almamesh/llm` report sections, `computeQuarters`, `REPORT_PROMPT_SET`, natal `family_guidance`).

**Review Focus item 5 ("a failed v2 refresh keeps the v1 timeline") is pinned in Task 3.4** (hook test, both failure modes) and Task 3.12 (the on-screen half). Commit rule, decided: a v2 timeline is committed only when both `current_period` and `year_ahead` parsed. Otherwise the run ends as a timeline error and the saved timeline (v1 or an older v2) stays exactly as it was. A v2 run with those two written but a `life_outlook_*` call failed IS committed, with the failed section recorded, because chapters 2 and 3 are the point of the refresh and chapter 4's engine half never depends on the model.

**Deviations:**

1. The store version constant is the existing `INTERPRETATION_PERSIST_VERSION` (now `7`), not `INTERPRETATION_STORE_VERSION`. Renaming it would touch every persist test for no gain.
2. `ReadingReportProps` adds `chartId: string`, `reading: ReadingReportSource` (the hook's durability-gated `interpretation`, `currentTimeline` and `chapters`), and optional `onGetFullYearAhead` / `onRetryFailed` callbacks. The hook's single-flight guard (`useSingleFlight`) is per hook instance, so a second `useStreamingInterpretation` inside `ReadingReport` could start a second paid run beside the page's. The page owns the hook and hands the component what it renders. PR 4 mounts it the same way.
3. The audience type is the real `ReportAudience` (`'you' | 'astrologer'`, `lib/reportSelectors.ts`).
4. The hook also gains `refreshTimeline(): void` and `timelineQueued: boolean`. The Dashboard's private `timelineRegenerationQueued` state and resume effect (`Dashboard.tsx:233-235`, `:541-566`) move into the hook, so "Refresh timeline", "Get the full year ahead" and `startReading` share one queue.
5. PR 2 exports used beyond CONTRACT.md (PR 2's final signatures):
   - `streamReportTimeline(params: ReportTimelineParams): AsyncGenerator<ReportTimelineEvent>`. `ReportTimelineParams` extends `Omit<StructuredInterpretationParams, 'onSectionProgress' | 'promptSet'>` and has no `asOfMonth` parameter.
   - The `complete` event is `{ type: 'complete'; timeline: ReportTimelineContent; asOfMonth: string; dateGuardRemovals: number }`. PR 3 stores the event's `asOfMonth`.
   - `ReportTimelineContent = { current_period: CurrentPeriodSection | null; year_ahead: YearAheadSection | null; life_outlook: { life_outlook_1: LifeOutlookSection | null; life_outlook_2: LifeOutlookSection | null } }`.
   - Also used: `LIFE_DOMAIN_ORDER` (card order), `quarterTitle(quarter, language)`, `quarterEvents(chart: SanitizedChart, quarter)`, `usesLitePrompt`, and the `promptSet` parameter on `streamNatalInterpretation`.
   - Each request body carries `SECTION:<key>`. `VedicInterpretation.family_guidance?: Persona | null` is in `@almamesh/shared-types`.
6. Quarter titles and quarter event lists come from PR 2 (`quarterTitle`, `quarterEvents`), so the screen and the prompt show one list. The titles use PR 2's hyphen form ("Oct-Dec 2026"). `QuarterEvent.what` is the engine's English phrase. Localizing it is left to PR 5.
7. `CollapsibleSection`, `CoreGroup`, `TitledItems` and `resolveTitledItems` are private functions in `DashboardInterpretation.tsx` today. They move unchanged to a new `readingBlocks.tsx`, so `ReadingReport` can reuse them.

### File map

| Path (under `frontend/`) | Action | Responsibility |
| --- | --- | --- |
| `packages/store/src/interpretation.ts` | modify | v7: `TimelineContentV1 \| TimelineContentV2`, `asOfMonth`, `dateGuardRemovals`, `promptSet`, `isCommittableTimeline`, refusal of an incomplete v2, `tagTimelineShape` migration step |
| `packages/store/src/interpretation.migration.test.ts` | create | v6 to v7 migration: byte-for-byte v1 tag, idempotent merge, v2 passthrough |
| `packages/store/src/interpretation.test.ts` | modify | v7 fixture shape, version pins 6 to 7, v2 commit and refusal tests |
| `apps/web/src/lib/readingReportFacts.ts` | create | Pure engine slices: dasha bar, quarter lists (wrapping PR 2's `quarterEvents`), life-area cards, overview facts, month labels |
| `apps/web/src/lib/__tests__/readingReportFacts.test.ts` | create | Tests for the above |
| `apps/web/src/hooks/readingChapters.ts` | create | Pure `deriveChapters` (five chapter statuses from two lanes) |
| `apps/web/src/hooks/__tests__/readingChapters.test.ts` | create | Tests for the above |
| `apps/web/src/hooks/useStreamingInterpretation.ts` | modify | v2 timeline run (`asOfMonth`, `dateGuardRemovals`, `promptSet`, commit rule); `startReading`, `refreshTimeline`, `retryFailed`, `timelineQueued`, `chapters` |
| `apps/web/src/hooks/__tests__/useStreamingInterpretation.test.ts` | modify | Report-timeline mock, v2 tests, "failed v2 keeps v1", "queued, not sent" |
| `apps/web/src/locales/{en,es,pt}/dashboard.json` | modify | `report.*` strings, four new `sections.*` names |
| `apps/web/src/i18n/__tests__/reportLocales.test.ts` | create | en/es/pt parity for `report.*` plus pinned literals |
| `apps/web/src/components/features/dashboard/readingBlocks.tsx` | create | Shared reading blocks, moved out of `DashboardInterpretation.tsx` |
| `apps/web/src/components/features/dashboard/DashboardInterpretation.tsx` | modify | Import the moved blocks (no behaviour change) |
| `apps/web/src/components/features/dashboard/ReadingReport.tsx` | create | Five-chapter report, contents list, caption, legacy v1 path |
| `apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx` | create | Component tests (engine-drawn facts, voices, legacy, family optional) |
| `apps/web/src/components/features/dashboard/__tests__/readingReportFixtures.ts` | create | Synthetic chart/predictive/report fixtures (no real birth data) |
| `apps/web/src/components/features/dashboard/index.ts` | modify | Export `ReadingReport` |
| `apps/web/src/pages/Dashboard.tsx` | modify | Mount `ReadingReport`; "Get reading" calls `startReading`; queue moves to the hook |
| `apps/web/src/pages/__tests__/Dashboard.regenerate.test.tsx` | modify | Report-timeline mock and new test ids |
| `packages/llm/src/structured-interpretation.ts`, `packages/llm/src/index.ts` and the llm tests listed in Task 3.14 | modify / delete | Delete v1 timeline generation (`streamCurrentTimeline`, `streamStructuredInterpretation`, the `upcoming_periods` and `current_sky` tasks). `CurrentTimelineContent` stays as the v1 reader type |
| `apps/web/e2e/chat.grounding.spec.ts`, `apps/web/src/pages/__tests__/Dashboard.aiDegradation.test.tsx` | modify | Stop mocking the deleted v1 stream |
| `apps/web/e2e/interpretation.spec.ts` | modify | Stub the four new timeline sections |
| `apps/web/e2e/timeline.real.spec.ts` | modify | New section keys and test ids |
| `apps/web/e2e/portableInvariants.helpers.ts` | modify | v2 timeline stubs plus `family_guidance` |
| `apps/web/e2e/portable-invariants.spec.ts` | modify | New "v2 report survives export, wipe and import" test |
| `apps/web/e2e/reading-report.spec.ts` | create | Live stubbed journey, Chromium + iPhone 15 WebKit, screenshots, clean console |
| `apps/web/e2e/reading-report.real.spec.ts` | create | Real-model check (`E2E_REAL_MODEL`, skips without `OPENROUTER_API_KEY`) |
| `apps/web/playwright.reading-report.config.ts` | create | Build+preview config, `chromium` and `iphone-webkit` (`devices['iPhone 15']`) projects |
| `apps/web/package.json` | modify | `test:e2e:reading-report` and `test:e2e:reading-report:real` scripts |
| `apps/web/scripts/webkit-macos-lane.sh` | modify | Run the reading-report suite on `iphone-webkit` |
| `dagger/src/index.ts` | modify | Chromium lane runs the suite; the WebKit-lane contract file list includes the config |
| `apps/web/scripts/mutations/pr3-store-report.sh` | create | Mutation red runs |

All commands below run from `frontend/` unless a `cd` says otherwise. Store tests: `cd packages/store && bunx vitest run <file>`. Web tests: `cd apps/web && bunx vitest run <file>`.

---

### Task 3.1: Store v7 timeline shape and the commit rule

**Files:**
- Modify: `packages/store/src/interpretation.ts:83-107` (timeline types), `:225-232` (`setCurrentTimeline` signature), `:975-1007` (`setCurrentTimeline` body)
- Test: `packages/store/src/interpretation.test.ts:706-728` (fixture), new tests after `:790`

**Interfaces:**
- Consumes: `CurrentPeriodSection`, `YearAheadSection`, `LifeOutlookSection`, `ReadingProvenance` from `@almamesh/llm`.
- Produces:
  ```ts
  export interface TimelineContentV1 { readonly shape: 'v1'; readonly upcoming_periods: readonly TitledPersona[] | null; readonly current_sky: readonly TitledPersona[] | null }
  export interface TimelineContentV2 { readonly shape: 'v2'; readonly current_period: CurrentPeriodSection | null; readonly year_ahead: YearAheadSection | null; readonly life_outlook: { readonly life_outlook_1: LifeOutlookSection | null; readonly life_outlook_2: LifeOutlookSection | null } }
  export type TimelineContent = TimelineContentV1 | TimelineContentV2;
  export type CurrentTimelineContent = TimelineContent;
  export interface TimelineProvenance extends ReadingProvenance { readonly promptSet?: 'report-v2' }
  export interface TimelineCommitMeta { readonly asOfMonth?: string; readonly dateGuardRemovals?: number }
  export function isCommittableTimeline(content: TimelineContent): boolean;
  // CurrentTimelineEntry gains: content?: TimelineContent; asOfMonth?: string; dateGuardRemovals?: number; provenance?: TimelineProvenance
  // setCurrentTimeline gains a 7th parameter: meta?: TimelineCommitMeta
  ```

- [ ] **Step 1: Write the failing tests.** In `interpretation.test.ts`, change the `TIMELINE` fixture at `:712` to carry its shape, and add the v2 tests inside the same `describe` after the test that ends near `:812`:

```ts
  const TIMELINE = {
    shape: 'v1',
    upcoming_periods: [
      {
        title: 'A dated chapter',
        layman: 'A steady opening arrives next month.',
        technical: 'The next antardasha begins next month.',
      },
    ],
    current_sky: [
      {
        title: 'Active now',
        layman: 'Focus on patient progress.',
        technical: 'The current transit emphasizes the tenth house.',
      },
    ],
  } as const;

  const persona = (text: string) => ({ layman: text, technical: `${text} (technical)` });
  const V2_TIMELINE = {
    shape: 'v2',
    current_period: {
      maha: persona('Saturn shapes these years.'),
      antar: persona('Mercury sharpens the detail.'),
      activates: [{ title: 'Work', ...persona('Work asks for patience.') }],
      next_change: persona('A softer stretch follows.'),
    },
    year_ahead: {
      headline: persona('A year of steady building.'),
      quarters: (['Q1', 'Q2', 'Q3', 'Q4'] as const).map((key) => ({
        key,
        layman: `${key} plain.`,
        technical: `${key} technical.`,
      })),
      focus: persona('Finish what you start.'),
    },
    life_outlook: {
      life_outlook_1: { domains: [{ domain: 'career', outlook: persona('Career steadies.') }] },
      life_outlook_2: null,
    },
  } as const;

  it('stores a v2 timeline with its as-of month, date-guard count and prompt set', async () => {
    const store = newStore();
    const run = store.getState().startCurrentTimeline('c1', 'profile-1');
    await store.getState().setCurrentTimeline(
      'c1',
      V2_TIMELINE,
      '2026-10-10T00:00:00Z',
      { ...PROVENANCE, promptSet: 'report-v2' },
      { predictiveRequestKey: 'today-key' },
      run,
      { asOfMonth: '2026-10', dateGuardRemovals: 2 },
    );

    const timeline = store.getState().getEntry('c1')?.timeline;
    expect(timeline?.status).toBe('complete');
    expect(timeline?.content).toEqual(V2_TIMELINE);
    expect(timeline?.asOfMonth).toBe('2026-10');
    expect(timeline?.dateGuardRemovals).toBe(2);
    expect(timeline?.provenance?.promptSet).toBe('report-v2');
  });

  it('refuses a v2 timeline without year_ahead and keeps the saved v1 timeline', async () => {
    const store = newStore();
    await store.getState().setCurrentTimeline(
      'c1',
      TIMELINE,
      '2026-07-02T00:00:00Z',
      PROVENANCE,
      { predictiveRequestKey: 'old-key' },
    );
    const run = store.getState().startCurrentTimeline('c1');
    await store.getState().setCurrentTimeline(
      'c1',
      { ...V2_TIMELINE, year_ahead: null },
      '2026-10-10T00:00:00Z',
      PROVENANCE,
      { predictiveRequestKey: 'today-key' },
      run,
      { asOfMonth: '2026-10' },
    );

    const timeline = store.getState().getEntry('c1')?.timeline;
    expect(JSON.stringify(timeline?.content)).toBe(JSON.stringify(TIMELINE));
    expect(timeline?.updatedAt).toBe('2026-07-02T00:00:00Z');
    expect(timeline?.asOfMonth).toBeUndefined();
  });

  it('isCommittableTimeline needs both current_period and year_ahead on a v2 timeline', () => {
    expect(isCommittableTimeline(TIMELINE)).toBe(true);
    expect(isCommittableTimeline(V2_TIMELINE)).toBe(true);
    expect(isCommittableTimeline({ ...V2_TIMELINE, current_period: null })).toBe(false);
    expect(isCommittableTimeline({ ...V2_TIMELINE, year_ahead: null })).toBe(false);
    expect(
      isCommittableTimeline({ ...V2_TIMELINE, life_outlook: { life_outlook_1: null, life_outlook_2: null } }),
    ).toBe(true);
  });
```

Add `isCommittableTimeline` to the import list at `:9-20`.

- [ ] **Step 2: Run, expect failure.**
  `cd packages/store && bunx vitest run src/interpretation.test.ts -t "v2 timeline|isCommittableTimeline|refuses a v2"`
  Expected: FAIL. `isCommittableTimeline` is not exported (`TypeError: isCommittableTimeline is not a function`), and `tsc` rejects the 7th argument.

- [ ] **Step 3: Implement.** In `interpretation.ts`, replace the `CurrentTimelineContent` interface (`:83-87`) and extend `CurrentTimelineEntry` (`:89-107`):

```ts
import type {
  CurrentPeriodSection,
  LifeOutlookSection,
  NatalInterpretation,
  RawEvidenceAnnotationPayload,
  ReadingProvenance,
  YearAheadSection,
} from '@almamesh/llm';

/** What v6 stored. v7 tags it `shape: 'v1'` on hydrate and never rewrites it. */
export interface TimelineContentV1 {
  readonly shape: 'v1';
  readonly upcoming_periods: readonly TitledPersona[] | null;
  readonly current_sky: readonly TitledPersona[] | null;
}

/** The report timeline: chapters 2 and 3, and the "This year" half of chapter 4. */
export interface TimelineContentV2 {
  readonly shape: 'v2';
  readonly current_period: CurrentPeriodSection | null;
  readonly year_ahead: YearAheadSection | null;
  /** One entry per outlook call (PR 2's shape); null = that call failed or never ran. */
  readonly life_outlook: {
    readonly life_outlook_1: LifeOutlookSection | null;
    readonly life_outlook_2: LifeOutlookSection | null;
  };
}

export type TimelineContent = TimelineContentV1 | TimelineContentV2;

/** The v6 name, kept so existing imports compile; it is the v7 union. */
export type CurrentTimelineContent = TimelineContent;

/** Reading provenance plus the prompt set, so a v2 report from older prompts is visible. */
export interface TimelineProvenance extends ReadingProvenance {
  readonly promptSet?: 'report-v2';
}

/** Facts about one committed timeline run that are not prose. */
export interface TimelineCommitMeta {
  /** The month the year ahead counts from (`YYYY-MM`). */
  readonly asOfMonth?: string;
  /** Sentences the date guard removed across the run's sections. */
  readonly dateGuardRemovals?: number;
}

/**
 * Whether a finished timeline may replace the saved one. A v2 timeline needs
 * both core chapters; without them the refresh failed and the saved timeline
 * (v1 or an older v2) must stay exactly as it was.
 */
export function isCommittableTimeline(content: TimelineContent): boolean {
  if (content.shape === 'v1') return true;
  return content.current_period !== null && content.year_ahead !== null;
}
```

In `CurrentTimelineEntry` change `content?: CurrentTimelineContent` to `content?: TimelineContent`, change `provenance?: ReadingProvenance` to `provenance?: TimelineProvenance`, and add:

```ts
  /** The month the year ahead counts from. Absent on v1 timelines. */
  readonly asOfMonth?: string;
  /** How many invented or day-precision dates the date guard removed. */
  readonly dateGuardRemovals?: number;
```

In the `InterpretationStore` interface (`:225-232`):

```ts
  setCurrentTimeline: (
    chartId: string,
    content: TimelineContent,
    updatedAt: string,
    provenance?: TimelineProvenance,
    inputProvenance?: InterpretationInputProvenance,
    runToken?: InterpretationRunToken,
    meta?: TimelineCommitMeta,
  ) => Promise<void>;
```

In the action (`:975-1007`), add the `meta` parameter, refuse an incomplete v2 first, and spread the meta fields:

```ts
    setCurrentTimeline: async (
      chartId,
      content,
      updatedAt,
      provenance,
      inputProvenance,
      runToken,
      meta,
    ) => {
      if (!isCommittableTimeline(content)) return;
      set((state) => {
        if (!acceptsTimelineRun(chartId, runToken)) return state;
        const current = entryOf(state.byChart, chartId);
        const previous = current.timeline;
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            timeline: {
              status: 'complete',
              content,
              sections: previous?.sections ?? {},
              ...(previous?.failedSections !== undefined
                ? { failedSections: previous.failedSections }
                : {}),
              ...(previous?.failedSectionCodes !== undefined
                ? { failedSectionCodes: previous.failedSectionCodes }
                : {}),
              updatedAt,
              provenance,
              inputProvenance,
              ...(meta?.asOfMonth !== undefined ? { asOfMonth: meta.asOfMonth } : {}),
              ...(meta?.dateGuardRemovals !== undefined
                ? { dateGuardRemovals: meta.dateGuardRemovals }
                : {}),
            },
          }),
        };
      });
      await persistInterpretationSnapshot(get());
    },
```

The refusal does not touch the entry. The hook (Task 3.4) records the error.

- [ ] **Step 4: Run, expect pass.** Run the same command, then the whole store suite plus types: `cd packages/store && bunx vitest run && bun run typecheck`. Expected: PASS. If `interpretation.setAsideHold.test.ts` or another existing test builds a timeline literal without `shape`, add `shape: 'v1'` to that literal only.

- [ ] **Step 5: Commit.**
```bash
git add frontend/packages/store/src/interpretation.ts frontend/packages/store/src/interpretation.test.ts
git commit -m "feat(store): v7 timeline shape union with as-of month, date-guard count and commit rule"
```

### Task 3.2: Migration v6 to v7 tags the saved timeline as `shape: 'v1'`

**Files:**
- Modify: `packages/store/src/interpretation.ts:296-318` (version doc + constant), `:333-352` (`migrateInterpretationPersistedState` pipeline)
- Create: `packages/store/src/interpretation.migration.test.ts`
- Modify: `packages/store/src/interpretation.test.ts:986-990` and `:1155-1157` (version pins)

**Interfaces:**
- Consumes: `migrateInterpretationPersistedState`, `mergeInterpretationPersistedState`, `interpretationStoreCreator`.
- Produces: `INTERPRETATION_PERSIST_VERSION = 7`. A private `tagTimelineShape(entry)` step in the migrate pipeline. `merge` runs it on every hydrate, so it must be idempotent.

- [ ] **Step 1: Write the failing tests.** Create `packages/store/src/interpretation.migration.test.ts`:

```ts
/**
 * v6 -> v7: the saved timeline is tagged `shape: 'v1'` and nothing else changes.
 * No text is dropped, rewritten or regenerated. `merge` runs the same pipeline
 * on every hydrate, so the step must be idempotent.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import {
  INTERPRETATION_PERSIST_VERSION,
  interpretationStoreCreator,
  mergeInterpretationPersistedState,
  migrateInterpretationPersistedState,
  type InterpretationStore,
} from './interpretation';

const V6_TIMELINE_CONTENT = {
  upcoming_periods: [
    { title: 'Jupiter antardasha', layman: 'A season of growth.', technical: 'Jupiter antar in Saturn maha.' },
  ],
  current_sky: [
    { title: 'Saturn in the 10th', layman: 'Work asks for patience.', technical: 'Saturn transits the 10th from the Moon.' },
  ],
};

function v6Blob() {
  return {
    byChart: {
      c1: {
        status: 'complete',
        sections: { core: true },
        profileId: 'profile-1',
        updatedAt: '2026-07-01T00:00:00Z',
        interpretation: {
          summary: { layman: 'A grounded soul.', technical: 'Saturn lagna lord.' },
          strengths: [],
          challenges: [],
          life_themes: [],
        },
        timeline: {
          status: 'complete',
          content: V6_TIMELINE_CONTENT,
          sections: { upcoming_periods: true, current_sky: true },
          updatedAt: '2026-07-02T00:00:00Z',
          provenance: { engine: 'openai-http', model: 'm', baseUrl: 'https://openrouter.ai/api/v1' },
          inputProvenance: { predictiveRequestKey: 'day-key' },
        },
      },
    },
  };
}

describe('interpretation persist v7', () => {
  it('pins the persist version at 7', () => {
    expect(INTERPRETATION_PERSIST_VERSION).toBe(7);
  });

  it('v6 timeline survives as shape v1, byte for byte', () => {
    const before = v6Blob();
    const migrated = migrateInterpretationPersistedState(structuredClone(before), 6);
    const content = migrated.byChart.c1?.timeline?.content;

    expect(content?.shape).toBe('v1');
    const { shape: _shape, ...rest } = content as unknown as Record<string, unknown>;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(before.byChart.c1.timeline.content));
    // Everything outside `content` is untouched too.
    const { content: _c, ...timelineRest } = migrated.byChart.c1?.timeline ?? {};
    const { content: _o, ...originalRest } = before.byChart.c1.timeline;
    expect(timelineRest).toEqual(originalRest);
    expect(migrated.byChart.c1?.interpretation).toEqual(before.byChart.c1.interpretation);
  });

  it('is idempotent: merge on every hydrate leaves a tagged timeline alone', () => {
    const once = migrateInterpretationPersistedState(v6Blob(), 6);
    const twice = migrateInterpretationPersistedState(structuredClone(once), 7);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    const live = createStore<InterpretationStore>(interpretationStoreCreator).getState();
    const merged = mergeInterpretationPersistedState(structuredClone(once), live);
    expect(JSON.stringify(merged.byChart)).toBe(JSON.stringify(once.byChart));
  });

  it('passes a v2 timeline through untouched', () => {
    const blob = v6Blob();
    const v2 = {
      shape: 'v2',
      current_period: null,
      year_ahead: { headline: { layman: 'h', technical: 'h' }, quarters: [] },
      life_outlook: { life_outlook_1: null, life_outlook_2: null },
    };
    (blob.byChart.c1.timeline as { content: unknown }).content = v2;
    const migrated = migrateInterpretationPersistedState(blob, 7);
    expect(migrated.byChart.c1?.timeline?.content).toEqual(v2);
  });

  it('leaves an entry with no timeline byte-identical', () => {
    const blob = v6Blob();
    delete (blob.byChart.c1 as { timeline?: unknown }).timeline;
    const migrated = migrateInterpretationPersistedState(structuredClone(blob), 6);
    expect(JSON.stringify(migrated)).toBe(JSON.stringify(blob));
  });

  it('tags a timeline split out of a pre-v6 combined reading as v1', () => {
    const migrated = migrateInterpretationPersistedState(
      {
        byChart: {
          c1: {
            status: 'complete',
            sections: { upcoming_periods: true },
            interpretation: {
              summary: { layman: 's', technical: 's' },
              strengths: [],
              challenges: [],
              life_themes: [],
              upcoming_periods: V6_TIMELINE_CONTENT.upcoming_periods,
              current_sky: V6_TIMELINE_CONTENT.current_sky,
            },
          },
        },
      },
      5,
    );
    expect(migrated.byChart.c1?.timeline?.content).toEqual({ ...V6_TIMELINE_CONTENT, shape: 'v1' });
  });

  it('a malformed timeline content is left for the defensive reader, not rewritten', () => {
    const blob = v6Blob();
    (blob.byChart.c1.timeline as { content: unknown }).content = 'garbled';
    const migrated = migrateInterpretationPersistedState(blob, 6);
    expect(migrated.byChart.c1?.timeline?.content).toBe('garbled');
  });
});
```

Update the two existing pins: `interpretation.test.ts:988` `expect(INTERPRETATION_PERSIST_VERSION).toBe(6)` becomes `toBe(7)`, and `:1156` the same. Rename the `describe` at `:986` to `'persist migrations up to v7'`. Say in the PR body that these two pins move on purpose.

- [ ] **Step 2: Run, expect failure.**
  `cd packages/store && bunx vitest run src/interpretation.migration.test.ts`
  Expected: FAIL. `expected 6 to be 7`, and `expected undefined to be 'v1'` in "v6 timeline survives as shape v1, byte for byte".

- [ ] **Step 3: Implement.** In `interpretation.ts`, append to the version doc comment above `:316`:

```ts
 * v7: the timeline content becomes a tagged union. Every saved timeline is
 * tagged `shape: 'v1'` (what v6 stored) by appending the tag. No field is
 * rewritten, dropped or regenerated. New report timelines are `shape: 'v2'`.
```

then `export const INTERPRETATION_PERSIST_VERSION = 7;`. Add the step after `splitLegacyTimeline`:

```ts
/** v7: tag a v6 timeline's content `shape: 'v1'`. Never rewrites or drops a field. */
function tagTimelineShape(entry: ChartInterpretationEntry): ChartInterpretationEntry {
  if (!isPlainRecord(entry) || !isPlainRecord(entry.timeline)) return entry;
  const content: unknown = entry.timeline.content;
  if (!isPlainRecord(content)) return entry;
  if (content.shape === 'v1' || content.shape === 'v2') return entry;
  const tagged = { ...content, shape: 'v1' } as unknown as TimelineContentV1;
  return { ...entry, timeline: { ...entry.timeline, content: tagged } };
}
```

and change the pipeline line in `migrateInterpretationPersistedState` (`:346`) to:

```ts
    const healed = healInterruptedEntry(
      tagTimelineShape(splitLegacyTimeline(normalizeEntrySummary(entry))),
    );
```

- [ ] **Step 4: Run, expect pass.** `cd packages/store && bunx vitest run && bun run typecheck`. Expected: all store tests PASS.

- [ ] **Step 5: Commit.**
```bash
git add frontend/packages/store/src/interpretation.ts frontend/packages/store/src/interpretation.migration.test.ts frontend/packages/store/src/interpretation.test.ts
git commit -m "feat(store): migrate v6 timelines to v7 as shape v1 without rewriting content"
```

### Task 3.3: Engine facts for the report (pure)

**Files:**
- Create: `apps/web/src/lib/readingReportFacts.ts`
- Test: `apps/web/src/lib/__tests__/readingReportFacts.test.ts`

**Interfaces:**
- Consumes: `computeQuarters`, `quarterEvents`, `LIFE_DOMAIN_ORDER`, `type Quarter`, `type QuarterEvent`, `type SanitizedChart` from `@almamesh/llm` (PR 2); `SiderealChart`, `VimshottariDasha`, `DashaPeriod`, `YogaGrade` from `@almamesh/browser/types`; `DomainsCtx`, `DomainWindowData`, `LifeDomain`, `StrengthBand` from `@almamesh/shared-types`.
- Produces:
  ```ts
  export function monthOf(isoDate: string): string | null;
  export function formatMonth(month: string, language: string): string;
  export interface PeriodFact { readonly lord: string; readonly startMonth: string; readonly endMonth: string }
  export interface DashaBarFacts { readonly maha: PeriodFact; readonly antar: PeriodFact | null; readonly antarMonthsLeft: number | null; readonly nextChange: { readonly lord: string; readonly month: string } | null; readonly remainingAntars: readonly PeriodFact[] }
  export function dashaBarFacts(dashas: VimshottariDasha | undefined, asOfMonth: string): DashaBarFacts | null;
  export interface QuarterFacts { readonly quarter: Quarter; readonly events: readonly QuarterEvent[] }
  export function quarterFacts(asOfMonth: string, sanitized: SanitizedChart | null): readonly QuarterFacts[];
  export interface DomainCardFacts { readonly domain: LifeDomain; readonly band: StrengthBand; readonly keyGraha: string; readonly meetsMinimum: boolean; readonly savBindus: number; readonly windows: readonly DomainWindowData[] }
  export function domainCardFacts(domains: DomainsCtx | undefined): readonly DomainCardFacts[];
  export interface OverviewFacts { readonly lagnaSign: string | null; readonly moonSign: string | null; readonly moonNakshatra: string | null; readonly topYogas: readonly { readonly name: string; readonly grade: YogaGrade }[] }
  export function overviewFacts(chart: SiderealChart | undefined): OverviewFacts | null;
  ```
  There is no as-of-month helper here. The as-of month comes from PR 2's `complete` event, and the hook stores it (Task 3.4). Quarter titles and quarter events come from PR 2 (`quarterTitle`, `quarterEvents`), so there is one copy of each. `quarterFacts` only pairs PR 2's quarters with PR 2's per-quarter events, using the same sanitized chart the prompt is built from.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/lib/__tests__/readingReportFacts.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { VimshottariDasha } from '@almamesh/browser/types';
import type { DomainsCtx } from '@almamesh/shared-types';

vi.mock('@almamesh/llm', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/llm')>('@almamesh/llm');
  return { ...actual, quarterEvents: vi.fn(actual.quarterEvents) };
});

import { LIFE_DOMAIN_ORDER, quarterEvents, type SanitizedChart } from '@almamesh/llm';
import {
  dashaBarFacts,
  domainCardFacts,
  formatMonth,
  monthOf,
  quarterFacts,
} from '../readingReportFacts';

const DASHAS = {
  current_maha: { lord: 'saturn', start_date: '2020-01-01', end_date: '2039-01-01', duration_years: 19 },
  current_antar: { lord: 'mercury', start_date: '2025-04-01', end_date: '2027-12-01', duration_years: 2.7 },
  current_pratyantar: null,
  maha_dasha_sequence: [
    {
      lord: 'saturn',
      start_date: '2020-01-01',
      end_date: '2039-01-01',
      duration_years: 19,
      antar_sequence: [
        { lord: 'mercury', start_date: '2025-04-01', end_date: '2027-12-01', duration_years: 2.7 },
        { lord: 'ketu', start_date: '2027-12-01', end_date: '2029-01-01', duration_years: 1.1 },
      ],
    },
    { lord: 'mercury', start_date: '2039-01-01', end_date: '2056-01-01', duration_years: 17 },
  ],
} as unknown as VimshottariDasha;

describe('readingReportFacts', () => {
  it('reads month precision only', () => {
    expect(monthOf('2027-03-14')).toBe('2027-03');
    expect(monthOf('garbage')).toBeNull();
    expect(formatMonth('2026-10', 'en')).toBe('Oct 2026');
  });

  it('draws the dasha bar from the engine: windows, months left, next change', () => {
    const bar = dashaBarFacts(DASHAS, '2026-10');
    expect(bar?.maha).toEqual({ lord: 'saturn', startMonth: '2020-01', endMonth: '2039-01' });
    expect(bar?.antar).toEqual({ lord: 'mercury', startMonth: '2025-04', endMonth: '2027-12' });
    expect(bar?.antarMonthsLeft).toBe(14);
    expect(bar?.nextChange).toEqual({ lord: 'ketu', month: '2027-12' });
    expect(bar?.remainingAntars.map((p) => p.lord)).toEqual(['ketu']);
  });

  it('falls back to the next mahadasha when no antar is left in this one', () => {
    expect(dashaBarFacts(DASHAS, '2028-06')?.nextChange).toEqual({ lord: 'mercury', month: '2039-01' });
  });

  it('has no dasha bar without a current mahadasha', () => {
    expect(dashaBarFacts(undefined, '2026-10')).toBeNull();
    expect(dashaBarFacts({ ...DASHAS, current_maha: null }, '2026-10')).toBeNull();
  });

  it('pairs PR 2 quarters with PR 2 quarterEvents on the same sanitized chart the prompt uses', () => {
    const sanitized = { as_of: { date: '2026-11-10', basis: 'chart' } } as unknown as SanitizedChart;
    vi.mocked(quarterEvents).mockImplementation((_chart, quarter) =>
      quarter.key === 'Q2' ? [{ month: '2027-03', source: 'transit', what: 'x', severity: 'challenging' }] : [],
    );
    const quarters = quarterFacts('2026-11', sanitized);
    expect(quarters.map((q) => q.quarter.months[0])).toEqual(['2026-11', '2027-02', '2027-05', '2027-08']);
    expect(quarters[1]?.events).toHaveLength(1);
    expect(vi.mocked(quarterEvents).mock.calls.every(([chart]) => chart === sanitized)).toBe(true);
    expect(quarterFacts('2026-11', null).every((q) => q.events.length === 0)).toBe(true);
  });

  it('orders life-area cards by LIFE_DOMAIN_ORDER and reads band, key graha and windows from domains_context', () => {
    const forecast = (band: 'strong' | 'moderate' | 'weak') => ({
      strength_summary: { key_graha: 'jupiter', key_graha_meets_minimum: true, sav_bindus: 31, band },
      upcoming_windows: [{ date: '2027-02-01', source: 'dasha', kind: 'sign_ingress', trigger: 'jupiter', severity: 'supportive', descriptor: 'x' }],
    });
    const domains = {
      instant: '2026-10-10T00:00:00Z',
      forecasts: Object.fromEntries(LIFE_DOMAIN_ORDER.map((d) => [d, { domain: d, ...forecast(d === 'career' ? 'weak' : 'strong') }])),
    } as unknown as DomainsCtx;
    const cards = domainCardFacts(domains);
    expect(cards.map((c) => c.domain)).toEqual([...LIFE_DOMAIN_ORDER]);
    expect(cards.map((c) => c.domain)).toEqual([
      'career', 'finances', 'relationships', 'family', 'health', 'education', 'spiritual',
    ]);
    expect(cards[0]).toMatchObject({ band: 'weak', keyGraha: 'jupiter', meetsMinimum: true, savBindus: 31 });
    expect(cards[0]?.windows).toHaveLength(1);
    expect(domainCardFacts(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/lib/__tests__/readingReportFacts.test.ts`
  Expected: FAIL with `Failed to resolve import "../readingReportFacts"`.

- [ ] **Step 3: Implement.** Create `apps/web/src/lib/readingReportFacts.ts`:

```ts
/**
 * Engine facts for the reading report: pure slices and reshapes of what the
 * engine already computed. No astrology happens here, and nothing comes from
 * model text. Quarter titles and quarter events are PR 2's own functions, so
 * the screen and the prompt show one list.
 */
import {
  computeQuarters,
  LIFE_DOMAIN_ORDER,
  quarterEvents,
  type Quarter,
  type QuarterEvent,
  type SanitizedChart,
} from '@almamesh/llm';
import type { DashaPeriod, SiderealChart, VimshottariDasha, YogaGrade } from '@almamesh/browser/types';
import type { DomainsCtx, DomainWindowData, LifeDomain, StrengthBand } from '@almamesh/shared-types';

const MONTH = /^\d{4}-\d{2}$/;

/** `YYYY-MM` of an engine date, or null when it is not a date. */
export function monthOf(isoDate: string): string | null {
  const month = isoDate.slice(0, 7);
  return MONTH.test(month) ? month : null;
}

function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/** "Oct 2026" in the reader's language (dasha bar and window dates). */
export function formatMonth(month: string, language: string): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
  return date.toLocaleDateString(language, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export interface PeriodFact {
  readonly lord: string;
  readonly startMonth: string;
  readonly endMonth: string;
}

export interface DashaBarFacts {
  readonly maha: PeriodFact;
  readonly antar: PeriodFact | null;
  readonly antarMonthsLeft: number | null;
  readonly nextChange: { readonly lord: string; readonly month: string } | null;
  readonly remainingAntars: readonly PeriodFact[];
}

function periodFact(period: DashaPeriod): PeriodFact | null {
  const startMonth = monthOf(period.start_date);
  const endMonth = monthOf(period.end_date);
  return startMonth && endMonth ? { lord: period.lord, startMonth, endMonth } : null;
}

function isFact(fact: PeriodFact | null): fact is PeriodFact {
  return fact !== null;
}

function mahaIndex(dashas: VimshottariDasha, maha: PeriodFact): number {
  return dashas.maha_dasha_sequence.findIndex(
    (row) => row.lord === maha.lord && monthOf(row.start_date) === maha.startMonth,
  );
}

/** The current maha/antar windows, months left, and the next change. */
export function dashaBarFacts(
  dashas: VimshottariDasha | undefined,
  asOfMonth: string,
): DashaBarFacts | null {
  const maha = dashas?.current_maha ? periodFact(dashas.current_maha) : null;
  if (!dashas || !maha) return null;
  const antar = dashas.current_antar ? periodFact(dashas.current_antar) : null;
  const index = mahaIndex(dashas, maha);
  const row = index >= 0 ? dashas.maha_dasha_sequence[index] : undefined;
  const remainingAntars = (row?.antar_sequence ?? [])
    .map(periodFact)
    .filter(isFact)
    .filter((period) => monthIndex(period.startMonth) > monthIndex(asOfMonth));
  const nextMahaRow = index >= 0 ? dashas.maha_dasha_sequence[index + 1] : undefined;
  const next = remainingAntars[0] ?? (nextMahaRow ? periodFact(nextMahaRow) : null);
  return {
    maha,
    antar,
    antarMonthsLeft: antar ? Math.max(0, monthIndex(antar.endMonth) - monthIndex(asOfMonth)) : null,
    nextChange: next ? { lord: next.lord, month: next.startMonth } : null,
    remainingAntars,
  };
}

export interface QuarterFacts {
  readonly quarter: Quarter;
  readonly events: readonly QuarterEvent[];
}

/** PR 2's four quarters, each with PR 2's engine events from the prompt's sanitized chart. */
export function quarterFacts(asOfMonth: string, sanitized: SanitizedChart | null): readonly QuarterFacts[] {
  return computeQuarters(asOfMonth).map((quarter) => ({
    quarter,
    events: sanitized ? quarterEvents(sanitized, quarter) : [],
  }));
}

export interface DomainCardFacts {
  readonly domain: LifeDomain;
  readonly band: StrengthBand;
  readonly keyGraha: string;
  readonly meetsMinimum: boolean;
  readonly savBindus: number;
  readonly windows: readonly DomainWindowData[];
}

/** Strength chip and windows per life area, straight from `domains_context`, in PR 2's card order. */
export function domainCardFacts(domains: DomainsCtx | undefined): readonly DomainCardFacts[] {
  if (!domains) return [];
  return LIFE_DOMAIN_ORDER.flatMap((domain) => {
    const forecast = domains.forecasts[domain];
    if (!forecast) return [];
    const strength = forecast.strength_summary;
    return [
      {
        domain,
        band: strength.band,
        keyGraha: strength.key_graha,
        meetsMinimum: strength.key_graha_meets_minimum,
        savBindus: strength.sav_bindus,
        windows: forecast.upcoming_windows,
      },
    ];
  });
}

export interface OverviewFacts {
  readonly lagnaSign: string | null;
  readonly moonSign: string | null;
  readonly moonNakshatra: string | null;
  readonly topYogas: readonly { readonly name: string; readonly grade: YogaGrade }[];
}

/** Lagna, Moon and the three strongest yogas, for chapter 1. */
export function overviewFacts(chart: SiderealChart | undefined): OverviewFacts | null {
  if (!chart) return null;
  const moon = chart.planets.moon ?? chart.planets.Moon;
  const topYogas = [...chart.yogas]
    .sort((a, b) => (b.strength_pct ?? -1) - (a.strength_pct ?? -1))
    .slice(0, 3)
    .map((yoga) => ({ name: yoga.display_name || yoga.name, grade: yoga.grade }));
  return {
    lagnaSign: chart.lagna.sign ?? null,
    moonSign: moon?.sign ?? null,
    moonNakshatra: moon?.nakshatra ?? null,
    topYogas,
  };
}
```

- [ ] **Step 4: Run, expect pass.** `cd apps/web && bunx vitest run src/lib/__tests__/readingReportFacts.test.ts && bun run typecheck`. Expected: PASS. If Node's ICU spells the month differently in `formatMonth`, keep the test literal (`'Oct 2026'`): that literal is the promise.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/lib/readingReportFacts.ts frontend/apps/web/src/lib/__tests__/readingReportFacts.test.ts
git commit -m "feat(web): pure engine facts for the reading report (dasha bar, PR 2 quarter events, life areas)"
```

### Task 3.4: Hook runs the v2 report timeline and the report-v2 natal prompts (as-of month, date guard, prompt set, commit rule)

**Files:**
- Modify: `apps/web/src/hooks/useStreamingInterpretation.ts:22-36` (imports), `:74-77` (`CURRENT_TIMELINE_SECTIONS`), `:132-145` (result types), `:368-372` (`TimelineProgress`), `:530-537` (`streamNatalInterpretation` call), `:613-700` (`runTimeline`)
- Test: `apps/web/src/hooks/__tests__/useStreamingInterpretation.test.ts` (mock at `:21-29`, existing timeline tests `:835-1023`, new tests)

**Interfaces:**
- Consumes: `streamReportTimeline(params: ReportTimelineParams)` (no `asOfMonth` param; the `complete` event carries `{ timeline, asOfMonth, dateGuardRemovals }`), `REPORT_PROMPT_SET`, `type ReportTimelineContent`, `type ReportTimelineEvent`, `type ReportTimelineSectionKey`, and the `promptSet` param on `streamNatalInterpretation` (PR 2); `isCommittableTimeline`, `type TimelineContent`, `type TimelineContentV2` (Task 3.1).
- Produces: `CURRENT_TIMELINE_SECTIONS: readonly ReportTimelineSectionKey[] = ['current_period','year_ahead','life_outlook_1','life_outlook_2']`; `currentTimeline: TimelineContent | undefined`; `failedTimelineSections: readonly ReportTimelineSectionKey[]`; `TimelineProgress` keyed by `ReportTimelineSectionKey`. `streamCurrentTimeline` keeps its name and options and now runs the report timeline. Natal runs pass `promptSet: REPORT_PROMPT_SET`. Without it, PR 2's longer natal targets, `family_guidance` and the 6,000-token reasoning cap never switch on.

- [ ] **Step 1: Write the failing tests.** In the test file, add `streamReportTimeline: vi.fn()` to the `@almamesh/llm` mock (`:21-29`). Add `streamReportTimeline`, `type ReportTimelineContent` and `type ReportTimelineEvent` to the `@almamesh/llm` import, and `migrateInterpretationPersistedState` to the `@almamesh/store` import. Add these helpers below `timelineEventStream`:

```ts
const mockedReportStream = vi.mocked(streamReportTimeline);

function reportEventStream(events: ReportTimelineEvent[]): () => AsyncGenerator<ReportTimelineEvent> {
  return async function* () {
    for (const event of events) yield event;
  };
}

function failingReportStream(error: Error): () => AsyncGenerator<ReportTimelineEvent> {
  return async function* () {
    for (const event of [] as ReportTimelineEvent[]) yield event;
    throw error;
  };
}

const READY_PREDICTIVE = {
  status: 'ready',
  profileKey: 'profile-123',
  requestKey: CURRENT_PREDICTIVE_KEY,
  rawContexts: {
    transit_context: { instant: '2026-07-12T00:00:00Z' },
    varga_context_full: { charts: {} },
    strength_context: {},
    domains_context: { forecasts: {} },
  },
} as never;

const persona = (text: string) => ({ layman: text, technical: `${text} (technical)` });
const V2_TIMELINE: ReportTimelineContent = {
  current_period: {
    maha: persona('Saturn shapes these years.'),
    antar: persona('Mercury sharpens the detail.'),
    activates: [{ title: 'Work', ...persona('Work asks for patience.') }],
    next_change: persona('A softer stretch follows.'),
  },
  year_ahead: {
    headline: persona('A year of steady building.'),
    quarters: (['Q1', 'Q2', 'Q3', 'Q4'] as const).map((key) => ({
      key,
      layman: `${key} plain.`,
      technical: `${key} technical.`,
    })),
    focus: persona('Finish what you start.'),
  },
  life_outlook: {
    life_outlook_1: { domains: [{ domain: 'career', outlook: persona('Career steadies.') }] },
    life_outlook_2: { domains: [{ domain: 'health', outlook: persona('Rest matters.') }] },
  },
};

/** A v6 natal reading plus a v6 timeline, hydrated through the real v7 migration. */
function seedV6ReadingWithV1Timeline(): void {
  const migrated = migrateInterpretationPersistedState(
    {
      byChart: {
        'chart-123': {
          status: 'complete',
          sections: {},
          updatedAt: '2026-07-01T00:00:00Z',
          interpretation: SAMPLE_INTERPRETATION,
          timeline: {
            status: 'complete',
            sections: {},
            updatedAt: '2026-07-01T00:00:00Z',
            content: {
              upcoming_periods: [{ title: 'Next chapter', layman: 'Plan deliberately.', technical: 'Dasha timing.' }],
              current_sky: [{ title: 'Now', layman: 'Pause.', technical: 'Transit.' }],
            },
          },
        },
      },
    },
    6,
  );
  useInterpretationStore.setState({ byChart: migrated.byChart });
}
```

Replace the body of the existing test `'streams the current timeline independently without replacing the natal reading'` (`:835-883`) so it drives the report stream:

```ts
  it('streams the report timeline without replacing the natal reading, recording month, guard count and prompt set', async () => {
    usePredictiveStore.setState(READY_PREDICTIVE);
    await useInterpretationStore.getState().setInterpretation(
      'chart-123',
      SAMPLE_INTERPRETATION,
      '2026-07-11T00:00:00Z',
      undefined,
      { predictiveRequestKey: null },
    );
    mockedReportStream.mockImplementation(
      reportEventStream([
        { type: 'section_complete', section: 'current_period' },
        { type: 'section_complete', section: 'year_ahead' },
        { type: 'section_complete', section: 'life_outlook_1' },
        { type: 'section_complete', section: 'life_outlook_2' },
        { type: 'complete', timeline: V2_TIMELINE, asOfMonth: '2026-07', dateGuardRemovals: 3 },
      ]),
    );

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamCurrentTimeline('chart-123', { intent: 'user-request', view_mode: 'layman' });
    });

    expect(mockedStream).not.toHaveBeenCalled();
    expect(mockedReportStream.mock.calls[0]?.[0]).not.toHaveProperty('asOfMonth');
    expect(result.current.interpretation).toEqual(SAMPLE_INTERPRETATION);
    expect(result.current.currentTimeline).toEqual({ shape: 'v2', ...V2_TIMELINE });
    expect(result.current.timelineSections).toHaveLength(4);
    expect(result.current.timelineSections.every((section) => section.complete)).toBe(true);
    const timeline = useInterpretationStore.getState().getEntry('chart-123')?.timeline;
    expect(timeline?.asOfMonth).toBe('2026-07');
    expect(timeline?.dateGuardRemovals).toBe(3);
    expect(timeline?.provenance?.promptSet).toBe('report-v2');
  });
```

Add the regression test that holds Review Focus item 5:

```ts
  it.each([
    [
      'one core section failed (partial run)',
      reportEventStream([
        { type: 'error', section: 'current_period', message: 'upstream 502', status: 502 },
        { type: 'section_complete', section: 'year_ahead' },
        { type: 'complete', timeline: { ...V2_TIMELINE, current_period: null }, asOfMonth: '2026-07', dateGuardRemovals: 0 },
      ]),
    ],
    [
      'every section failed',
      failingReportStream(new LlmRequestError('Interpretation failed: all 4 sections failed.', { status: 502 })),
    ],
  ])('a failed v2 refresh keeps the v1 timeline: %s', async (_label, stream) => {
    seedV6ReadingWithV1Timeline();
    const v1Before = JSON.stringify(useInterpretationStore.getState().getEntry('chart-123')?.timeline?.content);
    expect(JSON.parse(v1Before).shape).toBe('v1');
    usePredictiveStore.setState(READY_PREDICTIVE);
    mockedReportStream.mockImplementation(stream);

    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamCurrentTimeline('chart-123', { intent: 'user-request', view_mode: 'layman' });
    });

    const entry = useInterpretationStore.getState().getEntry('chart-123');
    expect(JSON.stringify(entry?.timeline?.content)).toBe(v1Before);
    expect(entry?.timeline?.updatedAt).toBe('2026-07-01T00:00:00Z');
    expect(entry?.timeline?.asOfMonth).toBeUndefined();
    expect(entry?.interpretation).toEqual(SAMPLE_INTERPRETATION);
    expect(result.current.currentTimeline?.shape).toBe('v1');
    expect(result.current.timelineStatus).toBe('error');
  });
```

Add the natal prompt-set test (PR 2's report-v2 natal prompts are opt-in):

```ts
  it('natal runs ask for the report-v2 prompts (longer targets, family guidance, 6k reasoning cap)', async () => {
    mockedStream.mockImplementation(eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]));
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });
    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedStream.mock.calls[0]?.[0].promptSet).toBe(REPORT_PROMPT_SET);
  });
```

Import `REPORT_PROMPT_SET` from `@almamesh/llm` in the test file (the mock spreads `actual`, so it is the real constant).

Update the other existing timeline tests in this file (`'records a canonical error code for a failed timeline section'` at `:885`, `'exposes live timeline prose…'` at `:952`, `'aborts the timeline stream on unmount…'` at `:983`) with this mapping only: `mockedTimelineStream` becomes `mockedReportStream`, `timelineEventStream` becomes `reportEventStream`, section `'upcoming_periods'` becomes `'year_ahead'`, `'current_sky'` becomes `'current_period'`, and a `complete` event gains `asOfMonth: '2026-07', dateGuardRemovals: 0` with `timeline: V2_TIMELINE`. In `'starts idle…'` (`:220`) change `expect(result.current.timelineSections).toHaveLength(2)` to `toHaveLength(4)`. That is a deliberate contract change (four timeline sections replace two). Say so in the PR body.

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/hooks/__tests__/useStreamingInterpretation.test.ts -t "report timeline|failed v2 refresh"`
  Then `-t "report-v2 prompts"`.
  Expected: FAIL. `mockedReportStream` was never called (the hook still calls `streamCurrentTimeline`), so `currentTimeline` is undefined. The prompt-set test fails with `expected undefined to be 'report-v2'`. The partial case fails with `expected '{"shape":"v2"…' to be '{"upcoming_periods"…'` once the stream is wired but the commit rule is missing.

- [ ] **Step 3: Implement.** In `useStreamingInterpretation.ts`:

Imports (`:22-36`): drop `streamCurrentTimeline` and `type CurrentTimelineSectionKey`, and add:

```ts
  REPORT_PROMPT_SET,
  streamReportTimeline,
  type ReportTimelineSectionKey,
```

From `@almamesh/store`, replace `type CurrentTimelineContent` with `isCommittableTimeline, type TimelineContent, type TimelineContentV2`.

In `runNatal`, the `streamNatalInterpretation({ … })` call (`:530-537`) gains one line:

```ts
        for await (const event of streamNatalInterpretation({
          chart,
          asOf: storedChartAnalysisInstant(stored),
          config,
          mode: options.view_mode === 'expert' ? 'expert' : 'layman',
          language,
          signal: controller.signal,
          // Report-v2 natal prompts: longer targets, family_guidance, 6k reasoning cap.
          promptSet: REPORT_PROMPT_SET,
        })) {
```

Replace `:74-77`:

```ts
/** The four report-timeline sections, in the order the generator runs them. */
export const CURRENT_TIMELINE_SECTIONS: readonly ReportTimelineSectionKey[] = [
  'current_period',
  'year_ahead',
  'life_outlook_1',
  'life_outlook_2',
];

/** Shown when a v2 run could not write its two core chapters. The saved timeline is kept. */
const TIMELINE_INCOMPLETE =
  'The year ahead could not be written this time. Your earlier timeline is kept. Try again.';
```

In `UseStreamingInterpretationResult` change `currentTimeline: CurrentTimelineContent | undefined` to `currentTimeline: TimelineContent | undefined`, change `failedTimelineSections` to `readonly ReportTimelineSectionKey[]`, and `failedTimelineSectionCodes` to `Readonly<Partial<Record<ReportTimelineSectionKey, string>>>`. Change `TimelineProgress` (`:368`) to `Readonly<Partial<Record<ReportTimelineSectionKey, SectionProgressSnapshot>>>`.

In `runTimeline`, replace the stream loop body. There is no `asOfMonth` parameter: PR 2 computes it from the sanitized chart and returns it on the `complete` event, which is the month the hook stores.

```ts
      // ...config / controller / runToken / progress lines unchanged...
      try {
        for await (const event of streamReportTimeline({
          chart: input.chart,
          asOf: storedChartAnalysisInstant(stored),
          config,
          mode: options.view_mode === 'expert' ? 'expert' : 'layman',
          language,
          signal: controller.signal,
          onSectionProgress: (section, snapshot) => progress.push(section, snapshot),
        })) {
          if (controller.signal.aborted) return;
          if (event.type === 'section_complete') {
            markCurrentTimelineSectionComplete(id, event.section, runToken);
          } else if (event.type === 'error') {
            markCurrentTimelineSectionFailed(
              id,
              event.section,
              runToken,
              sectionErrorCode(event.message, event.status),
            );
          } else if (event.type === 'complete') {
            const content: TimelineContentV2 = {
              shape: 'v2',
              current_period: event.timeline.current_period,
              year_ahead: event.timeline.year_ahead,
              life_outlook: event.timeline.life_outlook,
            };
            // Commit rule: a v2 run replaces the saved timeline only when both
            // core chapters parsed. Otherwise the saved v1 (or older v2) stays.
            if (!isCommittableTimeline(content)) {
              setCurrentTimelineError(id, TIMELINE_INCOMPLETE, 'unknown', runToken);
              return;
            }
            setTimelineDurabilityPendingRun(runToken);
            await setCurrentTimeline(
              id,
              content,
              new Date().toISOString(),
              { ...configProvenance(config), predictiveAware: true, promptSet: REPORT_PROMPT_SET },
              input.provenance,
              runToken,
              { asOfMonth: event.asOfMonth, dateGuardRemovals: event.dateGuardRemovals },
            );
            setTimelineDurabilityPendingRun((pending) => (pending === runToken ? null : pending));
          }
        }
```

The `catch`/`finally` blocks stay as they are. In the return object change the `failedTimelineSections` cast to `section.key as ReportTimelineSectionKey`. Then `grep -rn "CurrentTimelineSectionKey\|CURRENT_TIMELINE_SECTIONS" frontend/apps/web/src` and switch each web-app use to `ReportTimelineSectionKey` (the Dashboard one is in Task 3.13).

- [ ] **Step 4: Run, expect pass.** `cd apps/web && bunx vitest run src/hooks/__tests__/useStreamingInterpretation.test.ts && bun run typecheck`. Expected: PASS. (`Dashboard.tsx` type errors are fixed in Task 3.13. If `typecheck` stops there, run only the vitest file here and the typecheck in 3.13.)

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/hooks/useStreamingInterpretation.ts frontend/apps/web/src/hooks/__tests__/useStreamingInterpretation.test.ts
git commit -m "feat(web): hook runs the v2 report timeline and report-v2 natal prompts; a failed run never overwrites a saved timeline"
```

### Task 3.5: Chapter statuses (pure)

**Files:**
- Create: `apps/web/src/hooks/readingChapters.ts`
- Test: `apps/web/src/hooks/__tests__/readingChapters.test.ts`

**Interfaces:**
- Consumes: `TimelineContent` (`@almamesh/store`), `NatalInterpretation` (`@almamesh/llm`).
- Produces:
  ```ts
  export type ChapterId = 'overview' | 'current_period' | 'year_ahead' | 'life_areas' | 'remedies';
  export type ChapterStatus = 'idle' | 'writing' | 'written' | 'failed' | 'waiting_timing';
  export interface ReportChapter { readonly id: ChapterId; readonly status: ChapterStatus }
  export interface LaneState { readonly running: boolean; readonly queued: boolean; readonly errored: boolean; readonly completed: Readonly<Record<string, boolean>>; readonly failed: Readonly<Record<string, boolean>>; readonly written: Readonly<Record<string, boolean>> }
  export const CHAPTER_IDS: readonly ChapterId[];
  export function natalWritten(interpretation: NatalInterpretation | undefined): Readonly<Record<string, boolean>>;
  export function timelineWritten(content: TimelineContent | undefined): Readonly<Record<string, boolean>>;
  export function deriveChapters(natal: LaneState, timeline: LaneState): readonly ReportChapter[];
  ```

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/hooks/__tests__/readingChapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TimelineContent } from '@almamesh/store';

import { deriveChapters, timelineWritten, type LaneState } from '../readingChapters';

const IDLE: LaneState = { running: false, queued: false, errored: false, completed: {}, failed: {}, written: {} };
const NATAL_WRITTEN: LaneState = {
  ...IDLE,
  written: { core: true, yoga: true, guidance1: true, guidance2: true, remedial: true },
};
const statusOf = (chapters: ReturnType<typeof deriveChapters>, id: string) =>
  chapters.find((chapter) => chapter.id === id)?.status;

describe('deriveChapters', () => {
  it('lists the five chapters in report order', () => {
    expect(deriveChapters(IDLE, IDLE).map((c) => c.id)).toEqual([
      'overview', 'current_period', 'year_ahead', 'life_areas', 'remedies',
    ]);
    expect(deriveChapters(IDLE, IDLE).every((c) => c.status === 'idle')).toBe(true);
  });

  it('shows timing chapters waiting while the timeline is queued for predictive facts', () => {
    const chapters = deriveChapters(NATAL_WRITTEN, { ...IDLE, queued: true });
    expect(statusOf(chapters, 'overview')).toBe('written');
    expect(statusOf(chapters, 'current_period')).toBe('waiting_timing');
    expect(statusOf(chapters, 'year_ahead')).toBe('waiting_timing');
    expect(statusOf(chapters, 'life_areas')).toBe('waiting_timing');
    expect(statusOf(chapters, 'remedies')).toBe('written');
  });

  it('marks a chapter writing until each of its sections completes', () => {
    const running: LaneState = { ...IDLE, running: true, completed: { core: true } };
    const chapters = deriveChapters(running, IDLE);
    expect(statusOf(chapters, 'overview')).toBe('writing');
    expect(statusOf(chapters, 'remedies')).toBe('writing');
  });

  it('a failed section fails its chapter, and a failed run with nothing written fails every chapter it owns', () => {
    const failedYear = deriveChapters(NATAL_WRITTEN, { ...IDLE, failed: { year_ahead: true } });
    expect(statusOf(failedYear, 'year_ahead')).toBe('failed');
    expect(statusOf(failedYear, 'current_period')).toBe('idle');
    const errored = deriveChapters(NATAL_WRITTEN, { ...IDLE, errored: true });
    expect(statusOf(errored, 'current_period')).toBe('failed');
    expect(statusOf(errored, 'life_areas')).toBe('failed');
  });

  it('a v1 timeline writes no v2 chapter; a v2 timeline writes what parsed', () => {
    const v1: TimelineContent = { shape: 'v1', upcoming_periods: [], current_sky: [] };
    expect(timelineWritten(v1)).toEqual({});
    const v2 = {
      shape: 'v2',
      current_period: null,
      year_ahead: { headline: { layman: 'h', technical: 'h' }, quarters: [] },
      life_outlook: {
        life_outlook_1: null,
        life_outlook_2: { domains: [{ domain: 'health', outlook: { layman: 'x', technical: 'x' } }] },
      },
    } as unknown as TimelineContent;
    expect(timelineWritten(v2)).toEqual({
      current_period: false,
      year_ahead: true,
      life_outlook_1: false,
      life_outlook_2: true,
    });
  });
});
```

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/hooks/__tests__/readingChapters.test.ts`
  Expected: FAIL with `Failed to resolve import "../readingChapters"`.

- [ ] **Step 3: Implement.** Create `apps/web/src/hooks/readingChapters.ts`:

```ts
/**
 * The five report chapters and their status, derived from the natal and
 * timeline lanes. Pure: the hook feeds it store state and flight state.
 */
import type { NatalInterpretation } from '@almamesh/llm';
import type { TimelineContent } from '@almamesh/store';

export type ChapterId = 'overview' | 'current_period' | 'year_ahead' | 'life_areas' | 'remedies';
export type ChapterStatus = 'idle' | 'writing' | 'written' | 'failed' | 'waiting_timing';

export interface ReportChapter {
  readonly id: ChapterId;
  readonly status: ChapterStatus;
}

/** One generation lane (natal or timeline) as the chapters see it. */
export interface LaneState {
  readonly running: boolean;
  /** Timeline only: asked for, waiting for exact-day predictive facts. */
  readonly queued: boolean;
  /** The last run ended in a run-level error. */
  readonly errored: boolean;
  readonly completed: Readonly<Record<string, boolean>>;
  readonly failed: Readonly<Record<string, boolean>>;
  /** Section has content in the saved artifact. */
  readonly written: Readonly<Record<string, boolean>>;
}

export const CHAPTER_IDS: readonly ChapterId[] = [
  'overview',
  'current_period',
  'year_ahead',
  'life_areas',
  'remedies',
];

interface ChapterSources {
  readonly natal: readonly string[];
  readonly timeline: readonly string[];
}

const SOURCES: Readonly<Record<ChapterId, ChapterSources>> = {
  overview: { natal: ['core', 'yoga'], timeline: [] },
  current_period: { natal: [], timeline: ['current_period'] },
  year_ahead: { natal: [], timeline: ['year_ahead'] },
  life_areas: { natal: ['guidance1', 'guidance2'], timeline: ['life_outlook_1', 'life_outlook_2'] },
  remedies: { natal: ['remedial', 'guidance2'], timeline: [] },
};

const RANK: Readonly<Record<ChapterStatus, number>> = {
  idle: 0,
  written: 1,
  writing: 2,
  waiting_timing: 3,
  failed: 4,
};

export function natalWritten(
  interpretation: NatalInterpretation | undefined,
): Readonly<Record<string, boolean>> {
  if (!interpretation) return {};
  return { core: true, yoga: true, guidance1: true, guidance2: true, remedial: true };
}

export function timelineWritten(
  content: TimelineContent | undefined,
): Readonly<Record<string, boolean>> {
  if (content?.shape !== 'v2') return {};
  return {
    current_period: content.current_period !== null,
    year_ahead: content.year_ahead !== null,
    life_outlook_1: content.life_outlook.life_outlook_1 !== null,
    life_outlook_2: content.life_outlook.life_outlook_2 !== null,
  };
}

function sectionStatus(lane: LaneState, key: string): ChapterStatus {
  if (lane.failed[key] || (lane.errored && !lane.written[key])) return 'failed';
  if (lane.queued) return 'waiting_timing';
  if (lane.running && !lane.completed[key]) return 'writing';
  if (lane.written[key] || lane.completed[key]) return 'written';
  return 'idle';
}

function combine(statuses: readonly ChapterStatus[]): ChapterStatus {
  return statuses.reduce<ChapterStatus>(
    (worst, status) => (RANK[status] > RANK[worst] ? status : worst),
    'idle',
  );
}

export function deriveChapters(natal: LaneState, timeline: LaneState): readonly ReportChapter[] {
  return CHAPTER_IDS.map((id) => ({
    id,
    status: combine([
      ...SOURCES[id].natal.map((key) => sectionStatus(natal, key)),
      ...SOURCES[id].timeline.map((key) => sectionStatus(timeline, key)),
    ]),
  }));
}
```

`errored` only fails a never-started lane when it is the lane's own status. The hook passes `errored: false` for an idle timeline that was never requested, so a natal-only reading shows chapters 2 and 3 as `idle`, not `failed`.

- [ ] **Step 4: Run, expect pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/hooks/readingChapters.ts frontend/apps/web/src/hooks/__tests__/readingChapters.test.ts
git commit -m "feat(web): derive the five report chapter statuses from the natal and timeline lanes"
```

### Task 3.6: Hook `startReading`, `refreshTimeline`, `retryFailed`, `timelineQueued`, `chapters`

**Files:**
- Modify: `apps/web/src/hooks/useStreamingInterpretation.ts:91-148` (result interface), `:378-385` (predictive subscriptions), after `:710` (new callbacks and queue effect), `:712-773` (derived state and return)
- Test: `apps/web/src/hooks/__tests__/useStreamingInterpretation.test.ts`

**Interfaces:**
- Consumes: `deriveChapters`, `natalWritten`, `timelineWritten`, `type ReportChapter` (Task 3.5); `currentTimelineInputState`, `resolveInterpretationConfig` (same file); `describeLlmStatus`, `usesLitePrompt` (`@almamesh/llm`); `useContentModeStore` (`../stores/contentMode`).
- Produces (added to `UseStreamingInterpretationResult`):
  ```ts
  startReading: () => void;     // one user action: natal now, timeline now or queued
  refreshTimeline: () => void;  // "Refresh timeline" / "Get the full year ahead"
  retryFailed: () => void;      // re-runs the lane(s) with failed sections
  timelineQueued: boolean;      // a timeline run is waiting for exact-day facts
  chapters: readonly ReportChapter[];
  ```
  Re-exported from `hooks/useStreamingInterpretation.ts` (PR 4 imports them from here): `export type { ChapterId, ChapterStatus, ReportChapter } from './readingChapters';`. The existing `errorKind` and `timelineErrorKind` fields stay unchanged.

- [ ] **Step 1: Write the failing tests.** Add inside the main `describe` of the hook test file:

```ts
  it('mounting the hook spends nothing', async () => {
    usePredictiveStore.setState(READY_PREDICTIVE);
    renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mockedStream).not.toHaveBeenCalled();
    expect(mockedReportStream).not.toHaveBeenCalled();
  });

  it('queued, not sent: startReading on a pending predictive chart writes natal now and holds the timeline', async () => {
    hydrateLlmSettings(openRouterPreset('sk-or-test', 'deepseek/deepseek-v4-pro'));
    mockedStream.mockImplementation(eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]));
    usePredictiveStore.setState({ status: 'loading', profileKey: 'profile-123', requestKey: CURRENT_PREDICTIVE_KEY } as never);
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));

    await act(async () => {
      result.current.startReading();
    });
    await waitFor(() => expect(result.current.status).toBe('complete'));

    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedReportStream).not.toHaveBeenCalled();
    expect(result.current.timelineQueued).toBe(true);
    expect(result.current.timelineStatus).toBe('idle');
    const status = (id: string) => result.current.chapters.find((c) => c.id === id)?.status;
    expect(status('overview')).toBe('written');
    expect(status('year_ahead')).toBe('waiting_timing');
  });

  it('a queued timeline starts exactly once when the facts become ready', async () => {
    hydrateLlmSettings(openRouterPreset('sk-or-test', 'deepseek/deepseek-v4-pro'));
    mockedStream.mockImplementation(eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]));
    mockedReportStream.mockImplementation(
      reportEventStream([{ type: 'complete', timeline: V2_TIMELINE, asOfMonth: '2026-07', dateGuardRemovals: 0 }]),
    );
    usePredictiveStore.setState({ status: 'loading', profileKey: 'profile-123', requestKey: CURRENT_PREDICTIVE_KEY } as never);
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      result.current.startReading();
    });
    expect(mockedReportStream).not.toHaveBeenCalled();

    await act(async () => {
      usePredictiveStore.setState(READY_PREDICTIVE);
    });
    await waitFor(() => expect(result.current.timelineStatus).toBe('complete'));
    expect(mockedReportStream).toHaveBeenCalledTimes(1);
    expect(useInterpretationStore.getState().getEntry('chart-123')?.timeline?.asOfMonth).toBe('2026-07');
    expect(result.current.timelineQueued).toBe(false);
    expect(result.current.chapters.every((c) => c.status === 'written')).toBe(true);
  });

  it('on a local endpoint the natal sections run first and the timeline (life outlook last) after', async () => {
    // hydrateLlmSettings(null) in beforeEach: the default endpoint is local, so lite prompts apply.
    expect(usesLitePrompt(resolveInterpretationConfig())).toBe(true);
    let releaseNatal!: () => void;
    const natalHeld = new Promise<void>((resolve) => {
      releaseNatal = resolve;
    });
    mockedStream.mockImplementation(async function* () {
      await natalHeld;
      yield { type: 'complete', interpretation: SAMPLE_INTERPRETATION } as NatalInterpretationEvent;
    });
    mockedReportStream.mockImplementation(
      reportEventStream([{ type: 'complete', timeline: V2_TIMELINE, asOfMonth: '2026-07', dateGuardRemovals: 0 }]),
    );
    usePredictiveStore.setState(READY_PREDICTIVE);
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      result.current.startReading();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedReportStream, 'a one-at-a-time local model gets natal first').not.toHaveBeenCalled();
    await act(async () => {
      releaseNatal();
    });
    await waitFor(() => expect(mockedReportStream).toHaveBeenCalledTimes(1));
  });

  it('startReading with ready facts on a cloud endpoint runs both lanes at once', async () => {
    hydrateLlmSettings(openRouterPreset('sk-or-test', 'deepseek/deepseek-v4-pro'));
    mockedStream.mockImplementation(eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]));
    mockedReportStream.mockImplementation(
      reportEventStream([{ type: 'complete', timeline: V2_TIMELINE, asOfMonth: '2026-07', dateGuardRemovals: 0 }]),
    );
    usePredictiveStore.setState(READY_PREDICTIVE);
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      result.current.startReading();
    });
    await waitFor(() => expect(result.current.timelineStatus).toBe('complete'));
    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect(mockedReportStream).toHaveBeenCalledTimes(1);
    expect(mockedStream.mock.calls[0]?.[0].chart).not.toHaveProperty('transit_context');
  });

  it('a queued timeline is dropped, not sent, when AI is switched off before the facts arrive', async () => {
    mockedStream.mockImplementation(eventStream([{ type: 'complete', interpretation: SAMPLE_INTERPRETATION }]));
    usePredictiveStore.setState({ status: 'loading', profileKey: 'profile-123', requestKey: CURRENT_PREDICTIVE_KEY } as never);
    hydrateLlmSettings({ ...openRouterPreset('sk-or-test', 'deepseek/deepseek-v4-pro') });
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      result.current.startReading();
    });
    await act(async () => {
      hydrateLlmSettings({ tier: 'off' } as never);
      usePredictiveStore.setState(READY_PREDICTIVE);
    });
    expect(mockedReportStream).not.toHaveBeenCalled();
    expect(result.current.timelineQueued).toBe(false);
  });

  it('retryFailed re-runs only the lane with a failed section', async () => {
    mockedStream.mockImplementation(
      eventStream([
        { type: 'error', section: 'yoga', message: 'boom' },
        { type: 'complete', interpretation: SAMPLE_INTERPRETATION },
      ]),
    );
    usePredictiveStore.setState(READY_PREDICTIVE);
    const { result } = renderHook(() => useStreamingInterpretation('chart-123'));
    await act(async () => {
      await result.current.streamInterpretation('chart-123', { intent: 'user-request' });
    });
    expect(result.current.chapters.find((c) => c.id === 'overview')?.status).toBe('failed');

    await act(async () => {
      result.current.retryFailed();
    });
    await waitFor(() => expect(mockedStream).toHaveBeenCalledTimes(2));
    expect(mockedReportStream).not.toHaveBeenCalled();
  });
```

The "AI switched off" test uses whatever `hydrateLlmSettings` payload makes `describeLlmStatus().configured === false` today. Check `packages/llm/src/settings.ts` for the exact off value and use it in place of `{ tier: 'off' }` if it differs.

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/hooks/__tests__/useStreamingInterpretation.test.ts -t "startReading|queued|retryFailed|spends nothing|local endpoint"`
  Expected: FAIL with `TypeError: result.current.startReading is not a function` (and the same for `retryFailed`). "mounting the hook spends nothing" passes already. It is a guard for later edits.

- [ ] **Step 3: Implement.** In `useStreamingInterpretation.ts`:

Imports: add `describeLlmStatus` and `usesLitePrompt` to the `@almamesh/llm` import (in the test file, import `usesLitePrompt`, `REPORT_PROMPT_SET` and `type NatalInterpretationEvent` from it too); add
```ts
import { useContentModeStore } from '../stores/contentMode';
import {
  deriveChapters,
  natalWritten,
  timelineWritten,
  type LaneState,
  type ReportChapter,
} from './readingChapters';

export type { ChapterId, ChapterStatus, ReportChapter } from './readingChapters';
```

Add to `UseStreamingInterpretationResult` (with doc comments):

```ts
  /** One user action: natal now, timeline now or once exact-day facts are ready. */
  startReading: () => void;
  /** Refresh chapters 2, 3 and the "This year" half of 4 (queued while facts load). */
  refreshTimeline: () => void;
  /** Re-run the lane(s) that have a failed section. */
  retryFailed: () => void;
  /** A timeline run is waiting for exact-day predictive facts. */
  timelineQueued: boolean;
  /** The five report chapters with their status. */
  chapters: readonly ReportChapter[];
```

Replace the two bare subscriptions (`:381-382`) so the queue effect can depend on them:

```ts
  const predictiveRequestKeyLive = usePredictiveStore((s) => s.requestKey);
  const predictiveStatusLive = usePredictiveStore((s) => s.status);
```

After `streamTimeline` is defined (`:702-710`), add:

```ts
  // The chart whose timeline was explicitly requested while its exact-day
  // facts were still computing. Only startReading/refreshTimeline/retryFailed
  // (each called from a click) can set it, so mounts, reloads and day changes
  // never start a paid run.
  const [timelineQueuedFor, setTimelineQueuedFor] = useState<string | null>(null);

  const requestTimeline = useCallback(
    (id: string, options: StreamInterpretationOptions): void => {
      if (currentTimelineInputState(id) === 'pending') {
        setTimelineQueuedFor(id);
        return;
      }
      setTimelineQueuedFor(null);
      streamTimeline(id, options).catch((err: unknown) =>
        safeError('interpretation.stream_failed', err),
      );
    },
    [streamTimeline],
  );

  const userRequest = useCallback(
    (): StreamInterpretationOptions => ({
      intent: 'user-request',
      view_mode: useContentModeStore.getState().contentMode === 'technical' ? 'expert' : 'layman',
    }),
    [],
  );

  const startReading = useCallback((): void => {
    if (!chartId) return;
    const options = userRequest();
    const natal = streamInterpretation(chartId, options).catch((err: unknown) =>
      safeError('interpretation.stream_failed', err),
    );
    // A local endpoint serves one request at a time and runs lite prompts:
    // natal first, then the timeline, whose life_outlook calls run last
    // (REPORT_SECTION_ORDER). A cloud endpoint runs both lanes at once.
    if (usesLitePrompt(resolveInterpretationConfig())) {
      void natal.then(() => requestTimeline(chartId, options));
      return;
    }
    requestTimeline(chartId, options);
  }, [chartId, requestTimeline, streamInterpretation, userRequest]);

  const refreshTimeline = useCallback((): void => {
    if (chartId) requestTimeline(chartId, userRequest());
  }, [chartId, requestTimeline, userRequest]);

  const retryFailed = useCallback((): void => {
    if (!chartId) return;
    const options = userRequest();
    const natalFailed =
      entry?.status === 'error' || Object.values(entry?.failedSections ?? {}).some(Boolean);
    const timelineFailed =
      entry?.timeline?.status === 'error' ||
      Object.values(entry?.timeline?.failedSections ?? {}).some(Boolean);
    if (natalFailed) {
      streamInterpretation(chartId, options).catch((err: unknown) =>
        safeError('interpretation.stream_failed', err),
      );
    }
    if (timelineFailed) requestTimeline(chartId, options);
  }, [chartId, entry, requestTimeline, streamInterpretation, userRequest]);

  // Resume the one queued, user-requested timeline once its facts settle.
  // AI switched off in the meantime drops the request instead of sending it.
  useEffect(() => {
    if (timelineQueuedFor === null || timelineFlight.activeKey !== null) return;
    if (currentTimelineInputState(timelineQueuedFor) === 'pending') return;
    const id = timelineQueuedFor;
    setTimelineQueuedFor(null);
    if (!describeLlmStatus().configured) return;
    streamTimeline(id, userRequest()).catch((err: unknown) =>
      safeError('interpretation.stream_failed', err),
    );
  }, [
    predictiveRequestKeyLive,
    predictiveStatusLive,
    streamTimeline,
    timelineFlight.activeKey,
    timelineQueuedFor,
    userRequest,
  ]);
```

After `timelineSections` is computed (`:739`), derive the chapters:

```ts
  const timelineQueued = chartId != null && timelineQueuedFor === chartId;
  const natalLane: LaneState = {
    running: status === 'generating',
    queued: false,
    errored: storedStatus === 'error',
    completed: completed,
    failed: failed,
    written: natalWritten(entry?.interpretation),
  };
  const timelineLane: LaneState = {
    running: timelineStatus === 'generating',
    queued: timelineQueued,
    errored: storedTimelineStatus === 'error',
    completed: timelineCompleted,
    failed: timelineFailed,
    written: timelineWritten(entry?.timeline?.content),
  };
  const chapters = deriveChapters(natalLane, timelineLane);
```

and add `startReading, refreshTimeline, retryFailed, timelineQueued, chapters,` to the returned object. `safeError('interpretation.stream_failed', …)` is an existing allowlisted code (`:350`).

- [ ] **Step 4: Run, expect pass.** `cd apps/web && bunx vitest run src/hooks/__tests__/useStreamingInterpretation.test.ts`. Expected: PASS, including the existing `'does not spend timeline calls before exact-day predictive facts are ready'` (`:1010`).

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/hooks/useStreamingInterpretation.ts frontend/apps/web/src/hooks/__tests__/useStreamingInterpretation.test.ts
git commit -m "feat(web): one user action starts the full reading; the timeline waits for exact-day facts"
```

### Task 3.7: en/es/pt strings for the report

**Files:**
- Modify: `apps/web/src/locales/en/dashboard.json`, `apps/web/src/locales/es/dashboard.json`, `apps/web/src/locales/pt/dashboard.json` (add `report` object; add four keys to `sections`)
- Create: `apps/web/src/i18n/__tests__/reportLocales.test.ts`

**Interfaces:**
- Produces: `dashboard:report.*` and `dashboard:sections.{current_period,year_ahead,life_outlook_1,life_outlook_2}`.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/i18n/__tests__/reportLocales.test.ts`:

```ts
/**
 * Report copy parity: the `dashboard.report` tree and the four new section
 * names exist in en/es/pt with the same keys, every leaf non-empty. The caption
 * literals are pinned: they are what the spec promises on screen.
 */
import { describe, expect, it } from 'vitest';

import en from '../../locales/en/dashboard.json';
import es from '../../locales/es/dashboard.json';
import pt from '../../locales/pt/dashboard.json';

type Catalog = Record<string, unknown>;

function leaves(node: unknown, prefix = ''): Record<string, string> {
  if (typeof node === 'string') return { [prefix]: node };
  if (node === null || typeof node !== 'object') return { [prefix]: '' };
  return Object.assign(
    {},
    ...Object.entries(node as Catalog).map(([key, value]) =>
      leaves(value, prefix ? `${prefix}.${key}` : key),
    ),
  );
}

const NEW_SECTIONS = ['current_period', 'year_ahead', 'life_outlook_1', 'life_outlook_2'];

describe('dashboard.report locales', () => {
  it.each([
    ['es', es],
    ['pt', pt],
  ])('%s has the same report keys as en, all non-empty', (_lang, catalog) => {
    const enLeaves = leaves((en as Catalog).report);
    const otherLeaves = leaves((catalog as Catalog).report);
    expect(Object.keys(otherLeaves).sort()).toEqual(Object.keys(enLeaves).sort());
    expect(Object.entries(otherLeaves).filter(([, v]) => v.trim() === '')).toEqual([]);
    for (const key of NEW_SECTIONS) {
      expect(((catalog as Catalog).sections as Catalog)[key]).toBeTruthy();
    }
  });

  it('pins the caption and chapter names the spec promises (en)', () => {
    const report = (en as Catalog).report as Catalog;
    expect(report.caption_written_by).toBe('Written by {{model}} on {{date}}.');
    expect(report.caption_year_ahead_from).toBe('Year ahead from {{month}}.');
    expect(report.get_full_year_ahead).toBe('Get the full year ahead');
    expect(report.chapters).toEqual({
      overview: 'Overview',
      current_period: 'Your current period',
      year_ahead: 'The year ahead',
      life_areas: 'Life areas',
      remedies: 'Remedies and guidance',
    });
  });

  it('keeps interpolation placeholders identical across languages', () => {
    const enLeaves = leaves((en as Catalog).report);
    for (const catalog of [es, pt]) {
      const other = leaves((catalog as Catalog).report);
      for (const [key, value] of Object.entries(enLeaves)) {
        const vars = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();
        expect(vars(other[key] ?? ''), key).toEqual(vars(value));
      }
    }
  });
});
```

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/i18n/__tests__/reportLocales.test.ts`
  Expected: FAIL. `report` is undefined in en, so `expected undefined to be 'Written by {{model}} on {{date}}.'`.

- [ ] **Step 3: Implement.** Add to `en/dashboard.json`, inside `"sections"`:

```json
    "current_period": "Your current period",
    "year_ahead": "The year ahead",
    "life_outlook_1": "This year: career, money, relationships, family",
    "life_outlook_2": "This year: health, learning, spiritual path"
```

and a new top-level `"report"` object:

```json
  "report": {
    "title": "Your reading",
    "contents": "In this reading",
    "chapters": {
      "overview": "Overview",
      "current_period": "Your current period",
      "year_ahead": "The year ahead",
      "life_areas": "Life areas",
      "remedies": "Remedies and guidance"
    },
    "status": {
      "idle": "Not written yet",
      "writing": "Writing…",
      "written": "Written",
      "failed": "Could not be written",
      "waiting_timing": "Waiting for timing data"
    },
    "caption_written_by": "Written by {{model}} on {{date}}.",
    "caption_written_at": "Written on {{date}}.",
    "caption_year_ahead_from": "Year ahead from {{month}}.",
    "overview_facts": "Lagna {{lagna}} · Moon in {{moon}}, {{nakshatra}} nakshatra",
    "top_yogas": "Strongest yogas",
    "maha": "Mahadasha",
    "antar": "Antardasha",
    "period_window": "{{lord}}: {{start}} to {{end}}",
    "months_left_one": "{{count}} month left in this antardasha",
    "months_left_other": "{{count}} months left in this antardasha",
    "next_change": "Next change: {{lord}} from {{month}}",
    "activates": "What this period activates",
    "what_comes_next": "What comes next",
    "remaining_antars": "The rest of this mahadasha",
    "quarter_events_empty": "No engine events fall in these months.",
    "antar_change": "{{lord}} antardasha begins",
    "slow_hit": "{{graha}} exact on {{target}}",
    "this_year_focus": "This year's focus",
    "your_nature": "Your nature in this area",
    "this_year": "This year",
    "lean_into": "Lean into",
    "watch_for": "Watch for",
    "windows": "Timing windows",
    "windows_empty": "No timing windows in the next twelve months.",
    "strength_link": "How this strength is computed",
    "key_graha": "Key planet {{graha}} · {{bindus}} SAV bindus",
    "long_arc": "Your long arc",
    "remedies": "Remedies",
    "legacy_note": "This timeline was written before the full year ahead existed.",
    "get_full_year_ahead": "Get the full year ahead",
    "retry_failed": "Try the missing chapters again"
  }
```

`es/dashboard.json`, `"sections"` additions:

```json
    "current_period": "Tu periodo actual",
    "year_ahead": "El año que viene",
    "life_outlook_1": "Este año: carrera, dinero, relaciones, familia",
    "life_outlook_2": "Este año: salud, aprendizaje, camino espiritual"
```

`"report"`:

```json
  "report": {
    "title": "Tu lectura",
    "contents": "En esta lectura",
    "chapters": {
      "overview": "Panorama",
      "current_period": "Tu periodo actual",
      "year_ahead": "El año que viene",
      "life_areas": "Áreas de la vida",
      "remedies": "Remedios y orientación"
    },
    "status": {
      "idle": "Aún sin escribir",
      "writing": "Escribiendo…",
      "written": "Escrito",
      "failed": "No se pudo escribir",
      "waiting_timing": "Esperando los datos de tiempo"
    },
    "caption_written_by": "Escrita por {{model}} el {{date}}.",
    "caption_written_at": "Escrita el {{date}}.",
    "caption_year_ahead_from": "El año que viene desde {{month}}.",
    "overview_facts": "Lagna {{lagna}} · Luna en {{moon}}, nakshatra {{nakshatra}}",
    "top_yogas": "Yogas más fuertes",
    "maha": "Mahadasha",
    "antar": "Antardasha",
    "period_window": "{{lord}}: de {{start}} a {{end}}",
    "months_left_one": "Queda {{count}} mes en esta antardasha",
    "months_left_other": "Quedan {{count}} meses en esta antardasha",
    "next_change": "Próximo cambio: {{lord}} desde {{month}}",
    "activates": "Lo que activa este periodo",
    "what_comes_next": "Lo que viene después",
    "remaining_antars": "El resto de esta mahadasha",
    "quarter_events_empty": "No hay eventos del motor en estos meses.",
    "antar_change": "Comienza la antardasha de {{lord}}",
    "slow_hit": "{{graha}} exacto sobre {{target}}",
    "this_year_focus": "El enfoque de este año",
    "your_nature": "Tu naturaleza en esta área",
    "this_year": "Este año",
    "lean_into": "Apóyate en",
    "watch_for": "Cuidado con",
    "windows": "Ventanas de tiempo",
    "windows_empty": "No hay ventanas de tiempo en los próximos doce meses.",
    "strength_link": "Cómo se calcula esta fuerza",
    "key_graha": "Planeta clave {{graha}} · {{bindus}} bindus SAV",
    "long_arc": "Tu arco largo",
    "remedies": "Remedios",
    "legacy_note": "Esta cronología se escribió antes de que existiera el año completo.",
    "get_full_year_ahead": "Obtener el año completo",
    "retry_failed": "Reintentar los capítulos que faltan"
  }
```

`pt/dashboard.json`, `"sections"` additions:

```json
    "current_period": "Seu período atual",
    "year_ahead": "O ano que vem",
    "life_outlook_1": "Este ano: carreira, dinheiro, relacionamentos, família",
    "life_outlook_2": "Este ano: saúde, aprendizado, caminho espiritual"
```

`"report"`:

```json
  "report": {
    "title": "Sua leitura",
    "contents": "Nesta leitura",
    "chapters": {
      "overview": "Visão geral",
      "current_period": "Seu período atual",
      "year_ahead": "O ano que vem",
      "life_areas": "Áreas da vida",
      "remedies": "Remédios e orientação"
    },
    "status": {
      "idle": "Ainda não escrito",
      "writing": "Escrevendo…",
      "written": "Escrito",
      "failed": "Não foi possível escrever",
      "waiting_timing": "Aguardando os dados de tempo"
    },
    "caption_written_by": "Escrita por {{model}} em {{date}}.",
    "caption_written_at": "Escrita em {{date}}.",
    "caption_year_ahead_from": "O ano que vem a partir de {{month}}.",
    "overview_facts": "Lagna {{lagna}} · Lua em {{moon}}, nakshatra {{nakshatra}}",
    "top_yogas": "Yogas mais fortes",
    "maha": "Mahadasha",
    "antar": "Antardasha",
    "period_window": "{{lord}}: de {{start}} a {{end}}",
    "months_left_one": "Falta {{count}} mês nesta antardasha",
    "months_left_other": "Faltam {{count}} meses nesta antardasha",
    "next_change": "Próxima mudança: {{lord}} a partir de {{month}}",
    "activates": "O que este período ativa",
    "what_comes_next": "O que vem depois",
    "remaining_antars": "O resto desta mahadasha",
    "quarter_events_empty": "Nenhum evento do motor cai nestes meses.",
    "antar_change": "Começa a antardasha de {{lord}}",
    "slow_hit": "{{graha}} exato sobre {{target}}",
    "this_year_focus": "O foco deste ano",
    "your_nature": "Sua natureza nesta área",
    "this_year": "Este ano",
    "lean_into": "Apoie-se em",
    "watch_for": "Atenção a",
    "windows": "Janelas de tempo",
    "windows_empty": "Nenhuma janela de tempo nos próximos doze meses.",
    "strength_link": "Como esta força é calculada",
    "key_graha": "Planeta-chave {{graha}} · {{bindus}} bindus SAV",
    "long_arc": "Seu arco longo",
    "remedies": "Remédios",
    "legacy_note": "Esta linha do tempo foi escrita antes de existir o ano completo.",
    "get_full_year_ahead": "Obter o ano completo",
    "retry_failed": "Tentar de novo os capítulos que faltam"
  }
```

- [ ] **Step 4: Run, expect pass.** `cd apps/web && bunx vitest run src/i18n/__tests__/reportLocales.test.ts && node scripts/verify-i18n.mjs`. Expected: PASS, and the i18n verifier reports no missing keys.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/locales/en/dashboard.json frontend/apps/web/src/locales/es/dashboard.json frontend/apps/web/src/locales/pt/dashboard.json frontend/apps/web/src/i18n/__tests__/reportLocales.test.ts
git commit -m "feat(i18n): reading report copy in en, es and pt"
```

### Task 3.8: Move the shared reading blocks out of `DashboardInterpretation`

**Files:**
- Create: `apps/web/src/components/features/dashboard/readingBlocks.tsx`
- Modify: `apps/web/src/components/features/dashboard/DashboardInterpretation.tsx:20-123` (delete the four private functions and the `ResolvedItem` type; import them)
- Test: existing `apps/web/src/components/features/dashboard/__tests__/DashboardInterpretation.test.tsx` (unchanged, must stay green)

**Interfaces:**
- Produces: `export interface ResolvedItem`, `export function resolveTitledItems(items, audience)`, `export function TitledItems({ items, fill })`, `export function CoreGroup({ title, items, testid })`, `export function CollapsibleSection({ title, testid, children, defaultOpen })`. `defaultOpen` is new, optional, default `false`, passed to `Disclosure`.

- [ ] **Step 1: Write the failing test.** Append to `DashboardInterpretation.test.tsx`:

```ts
import { CollapsibleSection } from '../readingBlocks';

describe('readingBlocks.CollapsibleSection', () => {
  it('is closed by default and can open by default', () => {
    const { rerender } = render(
      <CollapsibleSection title="Chapter" testid="c">
        <p>Inside</p>
      </CollapsibleSection>,
    );
    expect(screen.queryByText('Inside')).toBeNull();
    rerender(
      <CollapsibleSection title="Chapter" testid="c" defaultOpen>
        <p>Inside</p>
      </CollapsibleSection>,
    );
    expect(screen.queryByText('Inside')).toBeNull(); // state is per mount
  });

  it('renders open when mounted with defaultOpen', () => {
    render(
      <CollapsibleSection title="Chapter" testid="c" defaultOpen>
        <p>Inside</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('Inside')).toBeTruthy();
  });
});
```

(Check `Disclosure` first: if it renders closed content in the DOM with `hidden`, assert `toBeVisible()` / `not.toBeVisible()` with `@testing-library/jest-dom` the way the existing tests in this file do.)

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/components/features/dashboard/__tests__/DashboardInterpretation.test.tsx`
  Expected: FAIL with `Failed to resolve import "../readingBlocks"`.

- [ ] **Step 3: Implement.** Create `readingBlocks.tsx` by moving `ResolvedItem`, `resolveTitledItems`, `TitledItems`, `CoreGroup` and `CollapsibleSection` verbatim from `DashboardInterpretation.tsx:30-123`, adding `export` to each. Give `CollapsibleSection` the new prop:

```tsx
export function CollapsibleSection({
  title,
  testid,
  children,
  defaultOpen = false,
}: {
  title: ReactNode;
  testid: string;
  children: ReactNode;
  defaultOpen?: boolean;
}): ReactElement {
  const { t } = useTranslation('dashboard');
  return (
    <div data-testid={testid}>
      <Disclosure
        summary={<span className="font-display text-base text-text-primary">{title}</span>}
        toggleLabel={t('interpretation.expand')}
        toggleLabelOpen={t('interpretation.collapse')}
        defaultOpen={defaultOpen}
        className="rounded-xl border border-ui-border bg-background-secondary/50 shadow-[inset_0_1px_0_0_rgba(244,241,232,0.04)] transition-colors hover:border-accent-gold/40 hover:bg-background-secondary/70"
        triggerClassName="px-5 py-[0.9rem]"
        contentClassName="mx-5 border-t border-ui-border/70 pb-5 pt-4"
      >
        {children}
      </Disclosure>
    </div>
  );
}
```

`title` widens from `string` to `ReactNode`, so a chapter title can carry its status chip. In `DashboardInterpretation.tsx` delete the moved code and add:

```ts
import { CollapsibleSection, CoreGroup, TitledItems, resolveTitledItems } from './readingBlocks';
```

Remove the now-unused imports (`TitledPersona` stays for `DashboardCurrentTimelineProps`; `Disclosure` moves).

- [ ] **Step 4: Run, expect pass.** Same command plus `bun run lint`. Expected: PASS, no unused-import errors.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/components/features/dashboard/readingBlocks.tsx frontend/apps/web/src/components/features/dashboard/DashboardInterpretation.tsx frontend/apps/web/src/components/features/dashboard/__tests__/DashboardInterpretation.test.tsx
git commit -m "refactor(web): share the reading blocks between the dashboard reading and the report"
```

### Task 3.9: `ReadingReport` shell: contents list, caption, chapter 1

**Files:**
- Create: `apps/web/src/components/features/dashboard/ReadingReport.tsx`
- Create: `apps/web/src/components/features/dashboard/__tests__/readingReportFixtures.ts`
- Create: `apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx`
- Modify: `apps/web/src/components/features/dashboard/index.ts` (export)

**Interfaces:**
- Consumes: hook types `ReportChapter`, `UseStreamingInterpretationResult`; stores `useInterpretationStore`, `useChartLibraryStore`, `usePredictiveStore`; `currentTimelineInputState`; facts from Task 3.3; blocks from Task 3.8.
- Produces:
  ```ts
  export type ReadingReportSource = Pick<UseStreamingInterpretationResult, 'interpretation' | 'currentTimeline' | 'chapters'>;
  export interface ReadingReportProps {
    readonly audience: ReportAudience;
    readonly variant: 'dashboard' | 'onboarding';
    readonly chartId: string;
    readonly reading: ReadingReportSource;
    readonly onGetFullYearAhead?: () => void;
    readonly onRetryFailed?: () => void;
  }
  export function ReadingReport(props: ReadingReportProps): ReactElement | null;
  // Root element: <article data-testid="reading-report" data-variant={variant}>.
  // The dashboard "Get reading" button keeps data-testid="generate-reading" (Task 3.13).
  ```

- [ ] **Step 1: Write the fixtures.** Create `__tests__/readingReportFixtures.ts` (synthetic, no real birth data):

```ts
import type { ReportChapter } from '../../../../hooks/readingChapters';
import type { ReadingReportSource } from '../ReadingReport';
import { useChartLibraryStore, useInterpretationStore, usePredictiveStore, type TimelineContent } from '@almamesh/store';
import type { LifeDomain, VedicInterpretation } from '@almamesh/shared-types';
import { LIFE_DOMAIN_ORDER, LIFE_OUTLOOK_GROUPS } from '@almamesh/llm';

export const CHART_ID = 'chart-r';
const P = (text: string) => ({ layman: `${text} (you)`, technical: `${text} (astrologer)` });

export const NATAL: VedicInterpretation = {
  summary: P('Summary'),
  strengths: [{ title: 'Grit', ...P('Grit') }],
  challenges: [{ title: 'Haste', ...P('Haste') }],
  life_themes: [{ title: 'Service', ...P('Service') }],
  integrated_yoga_narrative: P('Yoga narrative'),
  career_guidance: P('Career nature'),
  finances_guidance: P('Finances nature'),
  relationship_guidance: P('Relationship nature'),
  health_guidance: P('Health nature'),
  education_guidance: P('Education nature'),
  spiritual_guidance: P('Spiritual nature'),
  life_evolution_guidance: P('Long arc'),
  remedial_measures: P('Remedies'),
  family_guidance: P('Family nature'),
};

function outlookFor(domain: LifeDomain) {
  return { domain, outlook: P(`${domain} this year`), lean_into: `${domain} lean`, watch_for: `${domain} watch` };
}

export const V2: TimelineContent = {
  shape: 'v2',
  current_period: {
    maha: P('Maha prose'),
    antar: P('Antar prose'),
    activates: [{ title: 'Work', ...P('Activates work') }],
    next_change: P('Next change prose'),
  },
  year_ahead: {
    headline: P('Headline prose'),
    quarters: (['Q1', 'Q2', 'Q3', 'Q4'] as const).map((key) => ({
      key,
      layman: `${key} prose (you)`,
      technical: `${key} prose (astrologer)`,
    })),
    focus: P('Focus prose'),
  },
  life_outlook: {
    life_outlook_1: { domains: LIFE_OUTLOOK_GROUPS.life_outlook_1.map((domain) => outlookFor(domain)) },
    life_outlook_2: { domains: LIFE_OUTLOOK_GROUPS.life_outlook_2.map((domain) => outlookFor(domain)) },
  },
};

export const V1: TimelineContent = {
  shape: 'v1',
  upcoming_periods: [{ title: 'Legacy road', ...P('Legacy road') }],
  current_sky: [{ title: 'Legacy sky', ...P('Legacy sky') }],
};

export const ALL_WRITTEN: readonly ReportChapter[] = (
  ['overview', 'current_period', 'year_ahead', 'life_areas', 'remedies'] as const
).map((id) => ({ id, status: 'written' }));

const DASHAS = {
  current_maha: { lord: 'saturn', start_date: '2020-01-01', end_date: '2039-01-01', duration_years: 19 },
  current_antar: { lord: 'mercury', start_date: '2025-04-01', end_date: '2027-12-01', duration_years: 2.7 },
  current_pratyantar: null,
  maha_dasha_sequence: [
    {
      lord: 'saturn', start_date: '2020-01-01', end_date: '2039-01-01', duration_years: 19,
      antar_sequence: [
        { lord: 'mercury', start_date: '2025-04-01', end_date: '2027-12-01', duration_years: 2.7 },
        { lord: 'ketu', start_date: '2027-12-01', end_date: '2029-01-01', duration_years: 1.1 },
      ],
    },
  ],
};

/** Seed the three stores the report reads; `band` overrides the career band. */
export function seedStores(options: { timeline?: TimelineContent; band?: 'strong' | 'moderate' | 'weak' } = {}): void {
  useChartLibraryStore.setState({
    charts: {
      [CHART_ID]: {
        chart_id: CHART_ID,
        profile_id: 'profile-r',
        astronomical_calculations: { calculation_timestamp: '2026-10-10T12:00:00.000Z' },
        sidereal_chart: {
          lagna: { sign: 'Gemini' },
          planets: { moon: { sign: 'Taurus', nakshatra: 'Rohini' } },
          yogas: [
            { name: 'gajakesari', display_name: 'Gaja Kesari', grade: 'strong', strength_pct: 80 },
            { name: 'budhaditya', display_name: 'Budha Aditya', grade: 'moderate', strength_pct: 55 },
          ],
          dashas: DASHAS,
        },
      },
    },
  } as never);
  usePredictiveStore.setState({
    status: 'ready',
    domainsCtx: {
      instant: '2026-10-10T00:00:00Z',
      forecasts: Object.fromEntries(
        LIFE_DOMAIN_ORDER.map((domain) => [
          domain,
          {
            domain,
            strength_summary: {
              key_graha: 'jupiter',
              key_graha_meets_minimum: true,
              sav_bindus: 31,
              band: domain === 'career' ? (options.band ?? 'weak') : 'strong',
            },
            upcoming_windows: [
              { date: '2027-02-01', source: 'dasha', kind: 'sign_ingress', trigger: 'jupiter', severity: 'supportive', descriptor: 'jupiter.ingress.taurus' },
            ],
          },
        ]),
      ),
    },
    // Quarter events come from PR 2's quarterEvents (mocked in the test), not from transitCtx.
  } as never);
  useInterpretationStore.setState({
    byChart: {
      [CHART_ID]: {
        status: 'complete',
        sections: {},
        interpretation: NATAL,
        updatedAt: '2026-10-10T09:00:00Z',
        provenance: { engine: 'openai-http', model: 'deepseek/deepseek-v4.1-flash', baseUrl: 'https://openrouter.ai/api/v1' },
        ...(options.timeline
          ? {
              timeline: {
                status: 'complete',
                sections: {},
                content: options.timeline,
                updatedAt: '2026-10-10T09:01:00Z',
                ...(options.timeline.shape === 'v2' ? { asOfMonth: '2026-10' } : {}),
              },
            }
          : {}),
      },
    },
  } as never);
}

export function source(timeline: TimelineContent | undefined, chapters = ALL_WRITTEN): ReadingReportSource {
  return { interpretation: NATAL, currentTimeline: timeline, chapters };
}
```

The component's engine facts are gated on `currentTimelineInputState(chartId) === 'ready'`, which needs the real predictive identity. Quarter events come from PR 2's `quarterEvents` on the chart sanitized the same way the prompt is (`sanitizeChartForLlm(withRawPredictive(chart, chartId), storedChartAnalysisInstant(stored))`). In the component test, mock the hook seam and the two `@almamesh/llm` functions, so the test checks the wiring rather than PR 2's slicing (PR 2 tests that):

```ts
const SANITIZED = { as_of: { date: '2026-10-10', basis: 'chart' } };
vi.mock('../../../../hooks/useStreamingInterpretation', () => ({
  currentTimelineInputState: () => 'ready',
  withRawPredictive: (chart: unknown) => chart,
}));
vi.mock('@almamesh/llm', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/llm')>('@almamesh/llm');
  return {
    ...actual,
    sanitizeChartForLlm: vi.fn(() => SANITIZED),
    quarterEvents: vi.fn((_chart: unknown, quarter: { key: string }) =>
      quarter.key === 'Q2'
        ? [{ month: '2027-03', source: 'transit', what: 'sign_ingress saturn pisces -> aries', severity: 'challenging' }]
        : [],
    ),
  };
});
```

- [ ] **Step 2: Write the failing tests.** Create `__tests__/ReadingReport.test.tsx` with the shell tests (chapters 2-5 tests are added in Tasks 3.10-3.12):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import '../../../../i18n/config';
import { ReadingReport, type ReadingReportProps } from '../ReadingReport';
import { CHART_ID, V1, V2, seedStores, source } from './readingReportFixtures';

const SANITIZED = { as_of: { date: '2026-10-10', basis: 'chart' } };
vi.mock('../../../../hooks/useStreamingInterpretation', () => ({
  currentTimelineInputState: () => 'ready',
  withRawPredictive: (chart: unknown) => chart,
}));
vi.mock('@almamesh/llm', async () => {
  const actual = await vi.importActual<typeof import('@almamesh/llm')>('@almamesh/llm');
  return {
    ...actual,
    sanitizeChartForLlm: vi.fn(() => SANITIZED),
    quarterEvents: vi.fn((_chart: unknown, quarter: { key: string }) =>
      quarter.key === 'Q2'
        ? [{ month: '2027-03', source: 'transit', what: 'sign_ingress saturn pisces -> aries', severity: 'challenging' }]
        : [],
    ),
  };
});

function renderReport(props: Partial<ReadingReportProps> = {}) {
  return render(
    <MemoryRouter>
      <ReadingReport
        chartId={CHART_ID}
        audience="you"
        variant="dashboard"
        reading={source(V2)}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('ReadingReport shell', () => {
  beforeEach(() => seedStores({ timeline: V2 }));

  it('lists the five chapters with their status', () => {
    renderReport({
      reading: source(V2, [
        { id: 'overview', status: 'written' },
        { id: 'current_period', status: 'writing' },
        { id: 'year_ahead', status: 'waiting_timing' },
        { id: 'life_areas', status: 'failed' },
        { id: 'remedies', status: 'idle' },
      ]),
    });
    const contents = screen.getByTestId('report-contents');
    expect(within(contents).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByTestId('report-contents-overview').textContent).toContain('Written');
    expect(screen.getByTestId('report-contents-current_period').textContent).toContain('Writing…');
    expect(screen.getByTestId('report-contents-year_ahead').textContent).toContain('Waiting for timing data');
    expect(screen.getByTestId('report-contents-life_areas').textContent).toContain('Could not be written');
  });

  it('opens chapter 1 by default and keeps chapters 2-5 closed', () => {
    renderReport();
    expect(screen.getByText('Summary (you)')).toBeTruthy();
    expect(screen.queryByText('Maha prose (you)')).toBeNull();
    expect(screen.queryByText('Remedies (you)')).toBeNull();
  });

  it('captions the model, the date and the as-of month', () => {
    renderReport();
    expect(screen.getByTestId('reading-provenance').textContent).toBe(
      'Written by deepseek/deepseek-v4.1-flash on Oct 10, 2026. Year ahead from Oct 2026.',
    );
  });

  it('draws Lagna, Moon and the strongest yogas from the chart, not the model', () => {
    renderReport();
    const facts = screen.getByTestId('report-overview-facts');
    expect(facts.textContent).toContain('Gemini');
    expect(facts.textContent).toContain('Taurus');
    expect(facts.textContent).toContain('Rohini');
    expect(screen.getByTestId('report-yoga-gajakesari').textContent).toContain('Gaja Kesari');
  });

  it('switches every chapter voice with the audience, with no new call', () => {
    const { rerender } = renderReport();
    expect(screen.getByText('Summary (you)')).toBeTruthy();
    rerender(
      <MemoryRouter>
        <ReadingReport chartId={CHART_ID} audience="astrologer" variant="dashboard" reading={source(V2)} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Summary (astrologer)')).toBeTruthy();
  });

  it('shows a retry for failed chapters only when a chapter failed', () => {
    const onRetryFailed = vi.fn();
    renderReport({ onRetryFailed });
    expect(screen.queryByTestId('report-retry-failed')).toBeNull();
    renderReport({
      onRetryFailed,
      reading: source(V2, [{ id: 'overview', status: 'failed' }]),
    });
    fireEvent.click(screen.getByTestId('report-retry-failed'));
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
  });
});
```

The caption date format is `toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })`, the same as Dashboard `:615-620`, so `Oct 10, 2026`. The spec example "10 Oct 2026" is the en-GB order. The app formats in the UI language, so the en literal is `Oct 10, 2026`.

- [ ] **Step 3: Run, expect failure.**
  `cd apps/web && bunx vitest run src/components/features/dashboard/__tests__/ReadingReport.test.tsx`
  Expected: FAIL with `Failed to resolve import "../ReadingReport"`.

- [ ] **Step 4: Implement.** Create `ReadingReport.tsx`. This task writes the shell and chapter 1. Chapters 2-5 are the functions `CurrentPeriodChapter`, `YearAheadChapter`, `LifeAreasChapter` and `RemediesChapter`, added in Tasks 3.10-3.12. Until then they are stubs that return `null`, so the file compiles:

```tsx
/**
 * ReadingReport: the five-chapter reading. The engine draws every date,
 * band and window; the model's prose sits around them. It computes no
 * astrology and makes no model call. The page that owns
 * `useStreamingInterpretation` hands it the reading and the chapter statuses,
 * so a paid run can only ever start from that page's single-flight guard.
 */
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SiderealChart } from '@almamesh/browser/types';
import { quarterTitle, sanitizeChartForLlm, type LifeOutlookDomain, type SanitizedChart } from '@almamesh/llm';
import type { LifeDomain, VedicInterpretation } from '@almamesh/shared-types';
import {
  useChartLibraryStore,
  useInterpretationStore,
  usePredictiveStore,
  type TimelineContentV1,
  type TimelineContentV2,
} from '@almamesh/store';

import {
  currentTimelineInputState,
  withRawPredictive,
  type UseStreamingInterpretationResult,
} from '../../../hooks/useStreamingInterpretation';
import type { ChapterId, ChapterStatus } from '../../../hooks/readingChapters';
import { storedChartAnalysisInstant } from '../../../lib/analysisInstant';
import { personaText, type ReportAudience } from '../../../lib/reportSelectors';
import {
  dashaBarFacts,
  domainCardFacts,
  formatMonth,
  overviewFacts,
  quarterFacts,
  type DashaBarFacts,
  type DomainCardFacts,
  type QuarterFacts,
} from '../../../lib/readingReportFacts';
import { domainWindowLabel } from '../../../lib/predictiveEventCopy';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { BandBadge, SeverityBadge } from '../predictive/PredictiveBadges';
import { DashboardCurrentTimeline } from './DashboardInterpretation';
import { CollapsibleSection, CoreGroup, TitledItems, resolveTitledItems } from './readingBlocks';

export type ReadingReportSource = Pick<
  UseStreamingInterpretationResult,
  'interpretation' | 'currentTimeline' | 'chapters'
>;

export interface ReadingReportProps {
  readonly audience: ReportAudience;
  readonly variant: 'dashboard' | 'onboarding';
  readonly chartId: string;
  readonly reading: ReadingReportSource;
  /** "Get the full year ahead" on a legacy v1 timeline (a user action). */
  readonly onGetFullYearAhead?: () => void;
  /** "Try the missing chapters again" (a user action). */
  readonly onRetryFailed?: () => void;
}

const DATE_OPTIONS = { year: 'numeric', month: 'short', day: 'numeric' } as const;

function graha(t: (key: string, options?: Record<string, unknown>) => string, lord: string): string {
  return t(`predictive:graha.${lord.toLowerCase()}`, { defaultValue: lord });
}

function StatusChip({ status }: { status: ChapterStatus }): ReactElement {
  const { t } = useTranslation('dashboard');
  return (
    <span className="ml-2 text-[11px] uppercase tracking-[0.14em] text-text-tertiary">
      {t(`report.status.${status}`)}
    </span>
  );
}

function Contents({ chapters }: { chapters: ReadingReportSource['chapters'] }): ReactElement {
  const { t } = useTranslation('dashboard');
  return (
    <nav aria-label={t('report.contents')} data-testid="report-contents">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-text-muted">
        {t('report.contents')}
      </h3>
      <ol className="mt-2 space-y-1 text-sm">
        {chapters.map((chapter) => (
          <li
            key={chapter.id}
            data-testid={`report-contents-${chapter.id}`}
            data-status={chapter.status}
            className="flex flex-wrap items-baseline gap-x-2 text-text-secondary"
          >
            <span className="text-text-primary">{t(`report.chapters.${chapter.id}`)}</span>
            <StatusChip status={chapter.status} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Chapter({
  id,
  status,
  defaultOpen = false,
  children,
}: {
  id: ChapterId;
  status: ChapterStatus;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation('dashboard');
  return (
    <CollapsibleSection
      testid={`report-chapter-${id}`}
      defaultOpen={defaultOpen}
      title={
        <>
          {t(`report.chapters.${id}`)}
          <span data-testid={`report-chapter-status-${id}`} data-status={status}>
            <StatusChip status={status} />
          </span>
        </>
      }
    >
      {children}
    </CollapsibleSection>
  );
}

function OverviewChapter({
  interpretation,
  chart,
  audience,
}: {
  interpretation: VedicInterpretation | undefined;
  chart: SiderealChart | undefined;
  audience: ReportAudience;
}): ReactElement {
  const { t } = useTranslation(['dashboard', 'predictive']);
  const facts = overviewFacts(chart);
  const summary = personaText(interpretation?.summary, audience);
  const yoga = personaText(interpretation?.integrated_yoga_narrative, audience);
  return (
    <div className="space-y-6">
      {facts ? (
        <div className="space-y-2 text-sm text-text-secondary">
          <p data-testid="report-overview-facts">
            {t('dashboard:report.overview_facts', {
              lagna: facts.lagnaSign ?? '—',
              moon: facts.moonSign ?? '—',
              nakshatra: facts.moonNakshatra ?? '—',
            })}
          </p>
          {facts.topYogas.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-text-tertiary">
                {t('dashboard:report.top_yogas')}
              </span>
              {facts.topYogas.map((entry) => (
                <span
                  key={entry.name}
                  data-testid={`report-yoga-${entry.name.toLowerCase().replace(/\W/g, '')}`}
                  className="inline-flex items-center gap-1"
                >
                  {entry.name} <BandBadge band={entry.grade} />
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {summary ? <MarkdownContent content={summary} /> : null}
      {interpretation ? (
        <>
          <CoreGroup title={t('dashboard:interpretation.strengths')} items={resolveTitledItems(interpretation.strengths, audience)} testid="dashboard-strengths" />
          <CoreGroup title={t('dashboard:interpretation.challenges')} items={resolveTitledItems(interpretation.challenges, audience)} testid="dashboard-challenges" />
          <CoreGroup title={t('dashboard:interpretation.life_themes')} items={resolveTitledItems(interpretation.life_themes, audience)} testid="dashboard-life-themes" />
        </>
      ) : null}
      {yoga ? (
        <section className="space-y-2" data-testid="dashboard-yogas">
          <h3 className="font-display text-lg text-text-primary">{t('dashboard:interpretation.yogas')}</h3>
          <MarkdownContent content={yoga} compact className="max-w-none" />
        </section>
      ) : null}
    </div>
  );
}

// Chapters 2-5: Tasks 3.10-3.12 replace these stubs.
function CurrentPeriodChapter(_props: { content: TimelineContentV2; dasha: DashaBarFacts | null; audience: ReportAudience }): ReactElement | null {
  return null;
}
function YearAheadChapter(_props: { content: TimelineContentV2; quarters: readonly QuarterFacts[]; audience: ReportAudience }): ReactElement | null {
  return null;
}
function LifeAreasChapter(_props: { interpretation: VedicInterpretation | undefined; content: TimelineContentV2 | null; cards: readonly DomainCardFacts[]; audience: ReportAudience }): ReactElement | null {
  return null;
}
function RemediesChapter(_props: { interpretation: VedicInterpretation | undefined; content: TimelineContentV2 | null; audience: ReportAudience }): ReactElement | null {
  return null;
}

function useCaption(chartId: string): string | null {
  const { t, i18n } = useTranslation('dashboard');
  const entry = useInterpretationStore((s) => s.byChart[chartId]);
  if (!entry?.updatedAt) return null;
  const date = new Date(entry.updatedAt).toLocaleDateString(i18n.language, DATE_OPTIONS);
  const model = entry.provenance?.model;
  const written = model
    ? t('report.caption_written_by', { model, date })
    : t('report.caption_written_at', { date });
  const month = entry.timeline?.content?.shape === 'v2' ? entry.timeline.asOfMonth : undefined;
  return month
    ? `${written} ${t('report.caption_year_ahead_from', { month: formatMonth(month, i18n.language) })}`
    : written;
}

/**
 * PR 2's quarters with PR 2's `quarterEvents`, built from the chart sanitized
 * exactly as the prompt was (exact-key predictive facts, month precision).
 * So the events on screen are the events the model was given.
 */
function useQuarterFacts(chartId: string, asOfMonth: string | undefined, enabled: boolean): readonly QuarterFacts[] {
  const stored = useChartLibraryStore((s) => s.charts[chartId]);
  const requestKey = usePredictiveStore((s) => s.requestKey);
  return useMemo(() => {
    if (!enabled || !asOfMonth) return [];
    const chart = stored?.sidereal_chart;
    let sanitized: SanitizedChart | null = null;
    if (stored && chart) {
      sanitized = sanitizeChartForLlm(withRawPredictive(chart, chartId), storedChartAnalysisInstant(stored));
    }
    return quarterFacts(asOfMonth, sanitized);
    // requestKey: recompute when the exact-day facts change.
  }, [asOfMonth, chartId, enabled, requestKey, stored]);
}

/** The five-chapter reading on the dashboard (and, in PR 4, onboarding step 3). */
export function ReadingReport({
  audience,
  variant,
  chartId,
  reading,
  onGetFullYearAhead,
  onRetryFailed,
}: ReadingReportProps): ReactElement | null {
  const { t } = useTranslation('dashboard');
  const chart = useChartLibraryStore((s) => s.charts[chartId]?.sidereal_chart);
  const asOfMonth = useInterpretationStore((s) => s.byChart[chartId]?.timeline?.asOfMonth);
  const predictiveStatus = usePredictiveStore((s) => s.status);
  usePredictiveStore((s) => s.requestKey);
  const domainsCtx = usePredictiveStore((s) => s.domainsCtx);
  const caption = useCaption(chartId);
  const { interpretation, currentTimeline, chapters } = reading;
  // Engine facts only when the predictive store holds THIS chart's exact-day facts.
  const factsReady = predictiveStatus === 'ready' && currentTimelineInputState(chartId) === 'ready';
  const v2 = currentTimeline?.shape === 'v2' ? currentTimeline : null;
  const quarters = useQuarterFacts(chartId, asOfMonth, v2 !== null && factsReady);

  if (!interpretation && !currentTimeline) return null;

  const v1: TimelineContentV1 | null = currentTimeline?.shape === 'v1' ? currentTimeline : null;
  const dasha = asOfMonth ? dashaBarFacts(chart?.dashas, asOfMonth) : null;
  const cards = factsReady ? domainCardFacts(domainsCtx) : [];
  const status = (id: ChapterId): ChapterStatus =>
    chapters.find((chapter) => chapter.id === id)?.status ?? 'idle';
  const anyFailed = chapters.some((chapter) => chapter.status === 'failed');

  return (
    <article className="max-w-2xl space-y-6" data-testid="reading-report" data-variant={variant}>
      <Contents chapters={chapters} />
      {caption ? (
        <p className="text-[11px] uppercase tracking-[0.18em] text-text-tertiary" data-testid="reading-provenance">
          {caption}
        </p>
      ) : null}
      {anyFailed && onRetryFailed ? (
        <button
          type="button"
          onClick={onRetryFailed}
          data-testid="report-retry-failed"
          className="min-h-11 text-sm underline hover:no-underline"
        >
          {t('report.retry_failed')}
        </button>
      ) : null}
      <div className="space-y-2.5">
        <Chapter id="overview" status={status('overview')} defaultOpen>
          <OverviewChapter interpretation={interpretation} chart={chart} audience={audience} />
        </Chapter>
        {v1 ? (
          <div className="space-y-3" data-testid="report-legacy-timeline">
            <p className="text-sm text-text-secondary">{t('report.legacy_note')}</p>
            <DashboardCurrentTimeline
              currentSky={v1.current_sky ?? []}
              upcomingPeriods={v1.upcoming_periods ?? []}
              audience={audience}
            />
            {onGetFullYearAhead ? (
              <button
                type="button"
                onClick={onGetFullYearAhead}
                data-testid="get-full-year-ahead"
                className="inline-flex min-h-11 items-center rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-secondary hover:border-accent-gold/40 hover:text-text-primary"
              >
                {t('report.get_full_year_ahead')}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <Chapter id="current_period" status={status('current_period')}>
              {v2 ? <CurrentPeriodChapter content={v2} dasha={dasha} audience={audience} /> : null}
            </Chapter>
            <Chapter id="year_ahead" status={status('year_ahead')}>
              {v2 ? <YearAheadChapter content={v2} quarters={quarters} audience={audience} /> : null}
            </Chapter>
          </>
        )}
        <Chapter id="life_areas" status={status('life_areas')}>
          <LifeAreasChapter interpretation={interpretation} content={v2} cards={cards} audience={audience} />
        </Chapter>
        <Chapter id="remedies" status={status('remedies')}>
          <RemediesChapter interpretation={interpretation} content={v2} audience={audience} />
        </Chapter>
      </div>
    </article>
  );
}
```

`graha`, `Link`, `LifeDomain`, `LifeOutlookDomain`, `TitledItems`, `SeverityBadge`, `domainWindowLabel` and `quarterTitle` are first used in Tasks 3.10-3.12. If lint flags them as unused now, add each import in the task that first uses it. In `index.ts` add `export { ReadingReport } from './ReadingReport';` and a line in its doc comment.

- [ ] **Step 5: Run, expect pass.** `cd apps/web && bunx vitest run src/components/features/dashboard/__tests__/ReadingReport.test.tsx && bun run typecheck && bun run lint`. Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add frontend/apps/web/src/components/features/dashboard/ReadingReport.tsx frontend/apps/web/src/components/features/dashboard/index.ts frontend/apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx frontend/apps/web/src/components/features/dashboard/__tests__/readingReportFixtures.ts
git commit -m "feat(web): ReadingReport shell with contents, caption and the overview chapter"
```

### Task 3.10: Chapters 2 and 3: dasha bar and quarters, drawn by the engine

**Files:**
- Modify: `apps/web/src/components/features/dashboard/ReadingReport.tsx` (replace the `CurrentPeriodChapter` and `YearAheadChapter` stubs)
- Test: `apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx`

**Interfaces:**
- Consumes: `DashaBarFacts`, `QuarterFacts` (wrapping PR 2's `QuarterEvent { month; source; what; severity }`), PR 2's `quarterTitle(quarter, language)`, `formatMonth`, and `sanitizeChartForLlm` / `quarterEvents` (mocked in the test).
- Produces: test ids `report-dasha-bar`, `report-next-change`, `report-quarter-<Q>`, `report-quarter-events-<Q>`.

- [ ] **Step 1: Write the failing tests.** Append to `ReadingReport.test.tsx`:

```tsx
describe('ReadingReport chapters 2 and 3', () => {
  beforeEach(() => seedStores({ timeline: V2 }));

  function open(id: string) {
    fireEvent.click(within(screen.getByTestId(`report-chapter-${id}`)).getByRole('button'));
  }

  it('draws the dasha bar from the engine: lords, month windows, months left, next change', () => {
    renderReport();
    open('current_period');
    const bar = screen.getByTestId('report-dasha-bar');
    expect(bar.textContent).toContain('Saturn: Jan 2020 to Jan 2039');
    expect(bar.textContent).toContain('Mercury: Apr 2025 to Dec 2027');
    expect(bar.textContent).toContain('14 months left in this antardasha');
    expect(screen.getByTestId('report-next-change').textContent).toBe('Next change: Ketu from Dec 2027');
    expect(screen.getByText('Maha prose (you)')).toBeTruthy();
    expect(screen.getByText('Activates work (you)')).toBeTruthy();
  });

  it('titles four quarters with PR 2 quarterTitle and lists PR 2 quarterEvents from the prompt chart', () => {
    renderReport();
    open('year_ahead');
    expect(within(screen.getByTestId('report-quarter-Q1')).getByRole('heading').textContent).toBe('Oct-Dec 2026');
    expect(within(screen.getByTestId('report-quarter-Q2')).getByRole('heading').textContent).toBe('Jan-Mar 2027');
    const q2Events = screen.getByTestId('report-quarter-events-Q2');
    expect(q2Events.textContent).toContain('Mar 2027');
    expect(q2Events.textContent).toContain('sign_ingress saturn pisces -> aries');
    expect(within(q2Events).getByTestId('severity-challenging')).toBeTruthy();
    // One list: every quarter was asked of the same sanitized chart the prompt uses.
    expect(vi.mocked(quarterEvents).mock.calls.every(([chart]) => chart === SANITIZED)).toBe(true);
    expect(screen.getByTestId('report-quarter-events-Q1').textContent).toContain('No engine events fall in these months.');
    expect(screen.getByText('Q2 prose (you)')).toBeTruthy();
    expect(screen.getByText('Headline prose (you)')).toBeTruthy();
  });
});
```

Add `import { quarterEvents } from '@almamesh/llm';` to the test file (it resolves to the mock).

`SeverityBadge` has no test id today. Add `data-testid={`severity-${severity}`}` to its `<Badge>` in `PredictiveBadges.tsx:20` as part of this task, the same way `BandBadge` does at `:32`.

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/components/features/dashboard/__tests__/ReadingReport.test.tsx -t "chapters 2 and 3"`
  Expected: FAIL with `Unable to find an element by: [data-testid="report-dasha-bar"]`.

- [ ] **Step 3: Implement.** Replace the two stubs in `ReadingReport.tsx`:

```tsx
function PersonaBlock({ title, persona, audience, testid }: {
  title: string;
  persona: { layman?: string | null; technical?: string | null } | null | undefined;
  audience: ReportAudience;
  testid: string;
}): ReactElement | null {
  const text = personaText(persona, audience);
  if (!text) return null;
  return (
    <section className="space-y-1" data-testid={testid}>
      <h4 className="font-display text-[0.95rem] font-medium text-accent-gold-bright">{title}</h4>
      <MarkdownContent content={text} compact className="max-w-none" />
    </section>
  );
}

function CurrentPeriodChapter({ content, dasha, audience }: {
  content: TimelineContentV2;
  dasha: DashaBarFacts | null;
  audience: ReportAudience;
}): ReactElement | null {
  const { t, i18n } = useTranslation(['dashboard', 'predictive']);
  const period = content.current_period;
  if (!period) return null;
  const month = (value: string) => formatMonth(value, i18n.language);
  return (
    <div className="space-y-5">
      {dasha ? (
        <div className="space-y-1 rounded-lg border border-ui-border/70 px-4 py-3 text-sm" data-testid="report-dasha-bar">
          <p>
            <span className="text-text-tertiary">{t('dashboard:report.maha')} · </span>
            {t('dashboard:report.period_window', { lord: graha(t, dasha.maha.lord), start: month(dasha.maha.startMonth), end: month(dasha.maha.endMonth) })}
          </p>
          {dasha.antar ? (
            <p>
              <span className="text-text-tertiary">{t('dashboard:report.antar')} · </span>
              {t('dashboard:report.period_window', { lord: graha(t, dasha.antar.lord), start: month(dasha.antar.startMonth), end: month(dasha.antar.endMonth) })}
            </p>
          ) : null}
          {dasha.antarMonthsLeft !== null ? (
            <p className="text-text-secondary">{t('dashboard:report.months_left', { count: dasha.antarMonthsLeft })}</p>
          ) : null}
          {dasha.nextChange ? (
            <p className="text-text-secondary" data-testid="report-next-change">
              {t('dashboard:report.next_change', { lord: graha(t, dasha.nextChange.lord), month: month(dasha.nextChange.month) })}
            </p>
          ) : null}
        </div>
      ) : null}
      <PersonaBlock title={t('dashboard:report.maha')} persona={period.maha} audience={audience} testid="report-maha" />
      <PersonaBlock title={t('dashboard:report.antar')} persona={period.antar} audience={audience} testid="report-antar" />
      {period.activates.length > 0 ? (
        <section className="space-y-2" data-testid="report-activates">
          <h4 className="font-display text-[0.95rem] text-text-primary">{t('dashboard:report.activates')}</h4>
          <TitledItems items={resolveTitledItems(period.activates, audience)} fill />
        </section>
      ) : null}
      <PersonaBlock title={t('dashboard:report.what_comes_next')} persona={period.next_change} audience={audience} testid="report-what-comes-next" />
      {dasha && dasha.remainingAntars.length > 0 ? (
        <section className="text-sm text-text-secondary" data-testid="report-remaining-antars">
          <h4 className="text-xs uppercase tracking-wider text-text-tertiary">{t('dashboard:report.remaining_antars')}</h4>
          <ul className="mt-1 space-y-0.5">
            {dasha.remainingAntars.map((antar) => (
              <li key={`${antar.lord}-${antar.startMonth}`}>
                {t('dashboard:report.period_window', { lord: graha(t, antar.lord), start: month(antar.startMonth), end: month(antar.endMonth) })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const KNOWN_SEVERITY = new Set(['supportive', 'neutral', 'challenging']);

function QuarterEvents({ facts }: { facts: QuarterFacts }): ReactElement {
  const { t, i18n } = useTranslation('dashboard');
  const key = facts.quarter.key;
  return (
    <ul className="space-y-1 text-sm" data-testid={`report-quarter-events-${key}`}>
      {facts.events.length === 0 ? (
        <li className="text-text-secondary">{t('report.quarter_events_empty')}</li>
      ) : (
        facts.events.map((event, index) => (
          <li key={`${event.source}-${event.month}-${index}`} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="mr-2 font-mono text-xs text-text-tertiary">{formatMonth(event.month, i18n.language)}</span>
              {/* PR 2's engine phrase, the same text the prompt carried (English for now). */}
              {event.what}
            </span>
            {event.severity && KNOWN_SEVERITY.has(event.severity) ? (
              <SeverityBadge severity={event.severity as TransitSeverity} />
            ) : null}
          </li>
        ))
      )}
    </ul>
  );
}

function YearAheadChapter({ content, quarters, audience }: {
  content: TimelineContentV2;
  quarters: readonly QuarterFacts[];
  audience: ReportAudience;
}): ReactElement | null {
  const language = useLanguageStore((s) => s.language);
  const year = content.year_ahead;
  if (!year) return null;
  return (
    <div className="space-y-6">
      {personaText(year.headline, audience) ? (
        <MarkdownContent content={personaText(year.headline, audience)} compact className="max-w-none" />
      ) : null}
      {quarters.map((facts) => {
        const prose = year.quarters.find((quarter) => quarter.key === facts.quarter.key);
        return (
          <section key={facts.quarter.key} className="space-y-2" data-testid={`report-quarter-${facts.quarter.key}`}>
            <h4 className="font-display text-base text-text-primary">{quarterTitle(facts.quarter, language)}</h4>
            <QuarterEvents facts={facts} />
            {prose ? (
              <MarkdownContent content={personaText(prose, audience)} compact className="max-w-none" />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
```

`QuarterProse` has `layman`/`technical`, so `personaText` reads it directly. The quarters and their events come from PR 2's `computeQuarters` and `quarterEvents`, run on the same sanitized chart as the prompt (`useQuarterFacts`, Task 3.9). They never come from the model's keys, so a missing or extra model quarter cannot move a date. Add `useLanguageStore` to the `@almamesh/store` import, and `type TransitSeverity` to the `@almamesh/shared-types` import. The language store's value is the `PromptLanguage` that `quarterTitle` takes, the same one the prompt used.

- [ ] **Step 4: Run, expect pass.** Same command, then the whole file. Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/components/features/dashboard/ReadingReport.tsx frontend/apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx frontend/apps/web/src/components/features/predictive/PredictiveBadges.tsx
git commit -m "feat(web): current period and year ahead chapters with engine-drawn dasha bar and quarter events"
```

### Task 3.11: Chapter 4: seven life-area cards, strength chip from `domains_context`

**Files:**
- Modify: `apps/web/src/components/features/dashboard/ReadingReport.tsx` (replace the `LifeAreasChapter` stub)
- Test: `apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx`

**Interfaces:**
- Consumes: `DomainCardFacts`, `domainWindowLabel`, `BandBadge`, `SeverityBadge`; route `/life/:domain` (`App.tsx:148`), which renders the signed strength receipt (`pages/LifeDomain.tsx:125-135`).
- Produces: test ids `report-life-<domain>`, `report-strength-chip-<domain>`, `report-life-natal-<domain>`, `report-life-year-<domain>`, `report-windows-<domain>`.

- [ ] **Step 1: Write the failing tests.**

```tsx
describe('ReadingReport chapter 4: life areas', () => {
  function openLifeAreas() {
    fireEvent.click(within(screen.getByTestId('report-chapter-life_areas')).getByRole('button'));
  }

  it('renders seven cards in spec order', () => {
    seedStores({ timeline: V2 });
    renderReport();
    openLifeAreas();
    const ids = screen.getAllByTestId(/^report-life-(?!natal|year)[a-z]+$/).map((el) => el.dataset.testid);
    expect(ids).toEqual([
      'report-life-career', 'report-life-finances', 'report-life-relationships', 'report-life-family',
      'report-life-health', 'report-life-education', 'report-life-spiritual',
    ]);
  });

  it('strength chip comes from the engine and links to the strength receipt', () => {
    seedStores({ timeline: V2, band: 'weak' });
    renderReport();
    openLifeAreas();
    const chip = screen.getByTestId('report-strength-chip-career');
    expect(within(chip).getByTestId('band-weak')).toBeTruthy();
    expect(chip.getAttribute('href')).toBe('/life/career');
    seedStores({ timeline: V2, band: 'strong' });
    expect(within(screen.getByTestId('report-strength-chip-career')).getByTestId('band-strong')).toBeTruthy();
  });

  it('shows the natal nature, then This year, then engine windows', () => {
    seedStores({ timeline: V2 });
    renderReport();
    openLifeAreas();
    const career = screen.getByTestId('report-life-career');
    expect(within(career).getByTestId('report-life-natal-career').textContent).toContain('Career nature (you)');
    expect(within(career).getByTestId('report-life-year-career').textContent).toContain('career this year (you)');
    expect(within(career).getByTestId('report-life-year-career').textContent).toContain('career lean');
    expect(within(career).getByTestId('report-windows-career').textContent).toContain('Feb 2027');
  });

  it('family: natal guidance is optional; an old reading without it shows engine data and This year only', () => {
    seedStores({ timeline: V2 });
    const { family_guidance: _f, ...oldNatal } = source(V2).interpretation ?? {};
    renderReport({ reading: { ...source(V2), interpretation: oldNatal as never } });
    openLifeAreas();
    const family = screen.getByTestId('report-life-family');
    expect(within(family).queryByTestId('report-life-natal-family')).toBeNull();
    expect(within(family).getByTestId('report-life-year-family')).toBeTruthy();
    expect(within(family).getByTestId('report-strength-chip-family')).toBeTruthy();
  });

  it('keeps the engine half of every card when the This year calls have not run', () => {
    seedStores({});
    renderReport({ reading: source(undefined) });
    openLifeAreas();
    expect(screen.getByTestId('report-strength-chip-health')).toBeTruthy();
    expect(screen.queryByTestId('report-life-year-health')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/components/features/dashboard/__tests__/ReadingReport.test.tsx -t "life areas"`
  Expected: FAIL with `Unable to find an element by: [data-testid="report-strength-chip-career"]`.

- [ ] **Step 3: Implement.** Replace the stub:

```tsx
const NATAL_GUIDANCE: Readonly<Record<LifeDomain, keyof VedicInterpretation>> = {
  career: 'career_guidance',
  finances: 'finances_guidance',
  relationships: 'relationship_guidance',
  family: 'family_guidance',
  health: 'health_guidance',
  education: 'education_guidance',
  spiritual: 'spiritual_guidance',
};

function LifeAreaCard({ card, interpretation, outlook, audience }: {
  card: DomainCardFacts;
  interpretation: VedicInterpretation | undefined;
  outlook: LifeOutlookDomain | undefined;
  audience: ReportAudience;
}): ReactElement {
  const { t, i18n } = useTranslation(['dashboard', 'predictive']);
  const natalField = interpretation?.[NATAL_GUIDANCE[card.domain]];
  const natal = personaText(natalField as Parameters<typeof personaText>[0], audience);
  const yearText = outlook ? personaText(outlook.outlook, audience) : '';
  return (
    <section className="space-y-3 rounded-xl border border-ui-border/70 px-4 py-4" data-testid={`report-life-${card.domain}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-display text-base text-text-primary">{t(`predictive:domains.names.${card.domain}`)}</h4>
        <Link
          to={`/life/${card.domain}`}
          data-testid={`report-strength-chip-${card.domain}`}
          title={t('dashboard:report.strength_link')}
          className="inline-flex min-h-11 items-center gap-2 text-xs text-text-tertiary hover:text-text-primary"
        >
          <BandBadge band={card.band} />
          <span>{t('dashboard:report.key_graha', { graha: graha(t, card.keyGraha), bindus: card.savBindus })}</span>
        </Link>
      </header>
      {natal ? (
        <div data-testid={`report-life-natal-${card.domain}`}>
          <h5 className="text-xs uppercase tracking-wider text-text-tertiary">{t('dashboard:report.your_nature')}</h5>
          <MarkdownContent content={natal} compact className="max-w-none" />
        </div>
      ) : null}
      {outlook && yearText ? (
        <div data-testid={`report-life-year-${card.domain}`}>
          <h5 className="text-xs uppercase tracking-wider text-text-tertiary">{t('dashboard:report.this_year')}</h5>
          <MarkdownContent content={yearText} compact className="max-w-none" />
          {outlook.lean_into ? <p className="text-sm"><span className="text-text-tertiary">{t('dashboard:report.lean_into')}: </span>{outlook.lean_into}</p> : null}
          {outlook.watch_for ? <p className="text-sm"><span className="text-text-tertiary">{t('dashboard:report.watch_for')}: </span>{outlook.watch_for}</p> : null}
        </div>
      ) : null}
      <div data-testid={`report-windows-${card.domain}`}>
        <h5 className="text-xs uppercase tracking-wider text-text-tertiary">{t('dashboard:report.windows')}</h5>
        {card.windows.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('dashboard:report.windows_empty')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {card.windows.map((window) => (
              <li key={`${window.date}-${window.descriptor}`} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="mr-2 font-mono text-xs text-text-tertiary">{formatMonth(window.date.slice(0, 7), i18n.language)}</span>
                  {domainWindowLabel(t, window)}
                </span>
                <SeverityBadge severity={window.severity} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The "This year" entry for one domain, from either outlook call. */
function outlookFor(content: TimelineContentV2 | null, domain: LifeDomain): LifeOutlookDomain | undefined {
  if (!content) return undefined;
  return [
    ...(content.life_outlook.life_outlook_1?.domains ?? []),
    ...(content.life_outlook.life_outlook_2?.domains ?? []),
  ].find((entry) => entry.domain === domain);
}

function LifeAreasChapter({ interpretation, content, cards, audience }: {
  interpretation: VedicInterpretation | undefined;
  content: TimelineContentV2 | null;
  cards: readonly DomainCardFacts[];
  audience: ReportAudience;
}): ReactElement {
  return (
    <div className="space-y-4">
      {cards.map((card) => (
        <LifeAreaCard
          key={card.domain}
          card={card}
          interpretation={interpretation}
          outlook={outlookFor(content, card.domain)}
          audience={audience}
        />
      ))}
    </div>
  );
}
```

Cards render in PR 2's `LIFE_DOMAIN_ORDER` (from `domainCardFacts`). `NATAL_GUIDANCE` uses `keyof VedicInterpretation`, so `family_guidance` must exist on the type from PR 2 (Deviation 5). The band, key graha, bindus and windows come only from `card`, which comes only from `domains_context`. The model's outlook object has no band field to read.

- [ ] **Step 4: Run, expect pass.** Whole `ReadingReport.test.tsx`. Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/components/features/dashboard/ReadingReport.tsx frontend/apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx
git commit -m "feat(web): life-area cards with engine strength chip, natal nature, this year and timing windows"
```

### Task 3.12: Chapter 5 (remedies, long arc, this year's focus) and the legacy v1 path

**Files:**
- Modify: `apps/web/src/components/features/dashboard/ReadingReport.tsx` (replace the `RemediesChapter` stub)
- Test: `apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx`

**Interfaces:**
- Produces: test ids `report-remedies`, `report-long-arc`, `report-year-focus`, `report-legacy-timeline`, `get-full-year-ahead`.

- [ ] **Step 1: Write the failing tests.**

```tsx
describe('ReadingReport chapter 5 and the legacy path', () => {
  function open(id: string) {
    fireEvent.click(within(screen.getByTestId(`report-chapter-${id}`)).getByRole('button'));
  }

  it('chapter 5 holds remedies, the long arc (moved from life areas) and this year\'s focus', () => {
    seedStores({ timeline: V2 });
    renderReport();
    open('remedies');
    expect(screen.getByTestId('report-remedies').textContent).toContain('Remedies (you)');
    expect(screen.getByTestId('report-long-arc').textContent).toContain('Long arc (you)');
    expect(screen.getByTestId('report-year-focus').textContent).toContain('Focus prose (you)');
    open('life_areas');
    expect(within(screen.getByTestId('report-chapter-life_areas')).queryByText('Long arc (you)')).toBeNull();
  });

  it('a legacy v1 timeline renders as before, plus Get the full year ahead', () => {
    seedStores({ timeline: V1 });
    const onGetFullYearAhead = vi.fn();
    renderReport({ reading: source(V1), onGetFullYearAhead });
    const legacy = screen.getByTestId('report-legacy-timeline');
    expect(within(legacy).getByText('Legacy sky')).toBeTruthy();
    expect(screen.queryByTestId('report-chapter-current_period')).toBeNull();
    expect(screen.queryByTestId('report-chapter-year_ahead')).toBeNull();
    fireEvent.click(screen.getByTestId('get-full-year-ahead'));
    expect(onGetFullYearAhead).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('reading-provenance').textContent).not.toContain('Year ahead from');
  });

  it('a failed v2 refresh keeps the v1 timeline on screen', () => {
    seedStores({ timeline: V1 });
    renderReport({
      reading: source(V1, [
        { id: 'overview', status: 'written' },
        { id: 'current_period', status: 'failed' },
        { id: 'year_ahead', status: 'failed' },
        { id: 'life_areas', status: 'failed' },
        { id: 'remedies', status: 'written' },
      ]),
      onGetFullYearAhead: vi.fn(),
      onRetryFailed: vi.fn(),
    });
    expect(within(screen.getByTestId('report-legacy-timeline')).getByText('Legacy road')).toBeTruthy();
    expect(screen.getByTestId('get-full-year-ahead')).toBeTruthy();
    expect(screen.getByTestId('report-retry-failed')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/components/features/dashboard/__tests__/ReadingReport.test.tsx -t "chapter 5"`
  Expected: FAIL with `Unable to find an element by: [data-testid="report-remedies"]`. The legacy tests already pass from Task 3.9, and they stay as guards.

- [ ] **Step 3: Implement.** Replace the stub:

```tsx
function RemediesChapter({ interpretation, content, audience }: {
  interpretation: VedicInterpretation | undefined;
  content: TimelineContentV2 | null;
  audience: ReportAudience;
}): ReactElement {
  const { t } = useTranslation('dashboard');
  return (
    <div className="space-y-5">
      <PersonaBlock title={t('report.remedies')} persona={interpretation?.remedial_measures} audience={audience} testid="report-remedies" />
      <PersonaBlock title={t('report.long_arc')} persona={interpretation?.life_evolution_guidance} audience={audience} testid="report-long-arc" />
      <PersonaBlock title={t('report.this_year_focus')} persona={content?.year_ahead?.focus} audience={audience} testid="report-year-focus" />
    </div>
  );
}
```

- [ ] **Step 4: Run, expect pass.** Whole file, then `bun run typecheck && bun run lint`. Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/components/features/dashboard/ReadingReport.tsx frontend/apps/web/src/components/features/dashboard/__tests__/ReadingReport.test.tsx
git commit -m "feat(web): remedies chapter with the long arc and this year's focus; legacy timeline keeps rendering"
```

### Task 3.13: Mount `ReadingReport` on the dashboard

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx` at `:27` (type import), `:50-57` (component imports), `:189-208` (hook destructure), `:233-235` (queue state, delete), `:487-502` (`handleRegenerateTimeline`), `:541-566` (resume effect, delete), `:609-640` (`readingDate` … `timelineCaption`, delete), `:739-759` (generate button), `:766-787` (timeline button), `:969` (progress key cast), `:1031-1151` (reading section and timeline block)
- Modify: `apps/web/src/pages/__tests__/Dashboard.regenerate.test.tsx` (report mock and new ids)

**Interfaces:**
- Consumes: hook `startReading`, `refreshTimeline`, `retryFailed`, `timelineQueued`, `chapters`; `ReadingReport`.
- Produces: the dashboard "Get reading" (`generate-reading`) starts the full report. "Refresh timeline" (`generate-timeline`/`regenerate-timeline`) refreshes chapters 2, 3 and the "This year" half of 4. `reading-section` stays the container test id.

- [ ] **Step 1: Write the failing tests.** In `Dashboard.regenerate.test.tsx`: add `streamReportTimeline: vi.fn()` to its `@almamesh/llm` mock and use it everywhere the file mocks `streamCurrentTimeline` (same mapping as Task 3.4: `'upcoming_periods'` to `'year_ahead'`, `'current_sky'` to `'current_period'`, `complete` gains `asOfMonth: '2026-07', dateGuardRemovals: 0` and a v2 `timeline` with the nested `life_outlook`). Rename the live test id lookups `timeline-live-upcoming_periods` to `timeline-live-year_ahead`. Where a test asserted `current-timeline-section` after a v2 run, assert `report-chapter-year_ahead` instead. Add:

```tsx
  it('Get reading starts the full report: natal now, the timeline queued until facts are ready', async () => {
    renderDashboardWithoutReading(); // existing helper that renders with AI configured and no reading
    fireEvent.click(await screen.findByTestId('generate-reading'));
    await waitFor(() => expect(mockedNatalStream).toHaveBeenCalledTimes(1));
    expect(mockedReportStream).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLButtonElement>('generate-timeline').disabled).toBe(true);
  });

  it('mounts the five-chapter report inside the reading section', async () => {
    renderDashboardWithReading();
    const section = await screen.findByTestId('reading-section');
    expect(within(section).getByTestId('reading-report')).toBeTruthy();
    expect(within(section).getByTestId('report-contents').querySelectorAll('li')).toHaveLength(5);
  });
```

Use the file's real render helpers and mock names (read `:1-288` first). If the helpers are named differently, keep the assertions and swap the helper names. Update `'captions the reading with the model that generated it and the date'` (`:359`) to expect `Written by <model> on <date>.`. That is a deliberate copy change; name it in the PR body.

- [ ] **Step 2: Run, expect failure.**
  `cd apps/web && bunx vitest run src/pages/__tests__/Dashboard.regenerate.test.tsx`
  Expected: FAIL with `Unable to find an element by: [data-testid="reading-report"]`, and the generate test sees `mockedReportStream` missing from the page (the page still calls the natal-only handler).

- [ ] **Step 3: Implement.** In `Dashboard.tsx`:

1. `:27`: replace `type CurrentTimelineSectionKey,` with `type ReportTimelineSectionKey,`.
2. `:50-57`: drop `DashboardCurrentTimeline, DashboardInterpretation,` from the barrel import, and add `import { ReadingReport } from "../components/features/dashboard/ReadingReport";`.
3. Hook destructure (`:189-208`): add `startReading, refreshTimeline, retryFailed, timelineQueued, chapters,`.
4. Delete `:233-235` (`timelineRegenerationQueued` state) and the resume effect `:541-566`.
5. Replace `handleRegenerateTimeline` (`:487-502`):

```tsx
  // "Refresh timeline" and "Get the full year ahead": chapters 2, 3 and the
  // "This year" half of 4. The hook queues it while exact-day facts compute.
  const handleRegenerateTimeline = useCallback(() => {
    if (!chartId) return;
    refreshTimeline();
  }, [chartId, refreshTimeline]);
```

6. Delete `readingDate` through `timelineCaption` (`:609-640`). The caption now lives in `ReadingReport`.
7. Generate button (`:741`): `onClick={interpretation ? handleRegenerateReading : startReading}`. Regenerate stays natal-only, as today.
8. Timeline button (`:766-787`): replace both `timelineRegenerationQueued` uses with `timelineQueued`.
9. `:969`: `timelineProgress[section.key as ReportTimelineSectionKey]`.
10. Reading section (`:1031`): change the condition to `{((summaryReady && interpretation) || currentTimeline) && (`. Replace `<MarkdownContent content={summaryText} />`, `<DashboardInterpretation … />` and the `readingCaption` paragraph (`:1105-1121`) with:

```tsx
            {chartId ? (
              <ReadingReport
                chartId={chartId}
                audience={audience}
                variant="dashboard"
                reading={{ interpretation, currentTimeline, chapters }}
                onGetFullYearAhead={canRegenerateReading ? handleRegenerateTimeline : undefined}
                onRetryFailed={canRegenerateReading ? retryFailed : undefined}
              />
            ) : null}
```

11. Move the `timeline-partial-failure` paragraph (`:1126-1143`) into the reading section, just above `<ReadingReport>`, unchanged. Delete the rest of the old `{currentTimeline && (…)}` block (`:1124-1151`).
12. Remove imports that are now unused (`MarkdownContent` only if no other use remains; check with `bun run lint`).

- [ ] **Step 4: Run, expect pass.** `cd apps/web && bunx vitest run src/pages/__tests__ && bun run typecheck && bun run lint`. Expected: PASS for every Dashboard test file (`Dashboard.aiDegradation`, `.chatZone`, `.export`, `.noChart`, `.regenerate`, `.summary-voice`). `Dashboard.summary-voice.test.tsx` asserts the summary voice. The summary now renders inside chapter 1 (open by default), so it should pass unchanged. If it reads `dashboard-interpretation`, point it at `reading-report`.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/src/pages/Dashboard.tsx frontend/apps/web/src/pages/__tests__/Dashboard.regenerate.test.tsx
git commit -m "feat(web): dashboard renders the five-chapter report; Get reading starts the full report"
```

### Task 3.14: Delete v1 timeline generation from `@almamesh/llm`

Nothing in the app calls the v1 timeline generator any more (the hook switched in Task 3.4, the Dashboard in Task 3.13). Generating `upcoming_periods`/`current_sky` is now dead code that could be called by mistake. v1 content stays readable: `CurrentTimelineContent` (llm) stays as the v1 reader type, the `VedicInterpretation` legacy fields stay in shared-types, and the PDF, `/report`, chat serialization and the v6 migration all still read saved v1 prose.

**Files:**
- Modify: `packages/llm/src/structured-interpretation.ts` at `:54-71` (drop `"upcoming_periods" | "current_sky"` from `InterpretationSectionKey`; delete `CurrentTimelineSectionKey`), `:95-99` (`CurrentTimelineEvent`, delete), `:154-165` (`CURRENT_TIMELINE_SECTIONS` and `ALL_SECTIONS`, delete), `:450-503` (`UPCOMING_PERIODS_TASK`, `CURRENT_SKY_TASK` and their `SECTION_TASKS` entries, delete), `:591-613` (`UPCOMING_PERIODS_TASK_LITE` and the lite entries, delete), `:716` (the `timelineSection` branch in the builder; keep only what report sections need), `:996-1001` (the two parse cases, delete), `:1006-1060` (`mergeResults`, `mergeTimelineResults`, delete), `:1273-1292` (`streamCurrentTimeline`, `streamStructuredInterpretation`, delete)
- Modify: `packages/llm/src/index.ts:173-182` (drop the deleted exports; keep `CurrentTimelineContent`)
- Delete: `packages/llm/src/__tests__/current-sky.test.ts` (it tests only the deleted `CURRENT_SKY_TASK`)
- Modify: the llm tests that exercise v1 generation: `structured-interpretation.test.ts`, `structured-interpretation-split.test.ts`, `structured-section-streaming.test.ts`, `structured-section-retry.test.ts`, `structured-interpretation-language.test.ts`, `reasoning-cap.test.ts`, `structured-budget.test.ts`, `prompt-interpretation.test.ts`, `predictive-prompt.test.ts`, `json-stream.test.ts`, `json-prose.test.ts`, `client-inband-error.test.ts`
- Modify: `apps/web/src/pages/__tests__/Dashboard.aiDegradation.test.tsx`, `apps/web/e2e/chat.grounding.spec.ts` (stop mocking/stubbing the deleted stream)

**Interfaces:**
- Removes: `streamCurrentTimeline`, `streamStructuredInterpretation`, `CurrentTimelineEvent`, `CurrentTimelineParams`, `CurrentTimelineSectionKey`, `CURRENT_TIMELINE_SECTIONS` (llm), `ALL_SECTIONS`, `InterpretationEvent`, and `upcoming_periods` / `current_sky` as section keys.
- Keeps: `CurrentTimelineContent` (v1 reader type), `streamNatalInterpretation`, `streamReportTimeline`, `NATAL_SECTIONS`, and every `VedicInterpretation` field.

- [ ] **Step 1: Write the failing test.** Create `packages/llm/src/__tests__/v1-timeline-removed.test.ts`:

```ts
/**
 * v1 timeline generation is gone: the app writes report-v2 timelines only.
 * Saved v1 timelines stay readable (store v7 tags them shape 'v1'), which is
 * why `CurrentTimelineContent` is still exported as a type.
 */
import { describe, expect, it } from 'vitest';

import * as llm from '../index';
import { buildSectionMessages } from '../structured-interpretation';

describe('v1 timeline generation is removed', () => {
  it('no longer exports the v1 generators or their section list', () => {
    for (const name of ['streamCurrentTimeline', 'streamStructuredInterpretation', 'CURRENT_TIMELINE_SECTIONS', 'ALL_SECTIONS']) {
      expect(name in llm, name).toBe(false);
    }
    expect('streamReportTimeline' in llm).toBe(true);
    expect('streamNatalInterpretation' in llm).toBe(true);
  });

  it('refuses to build a prompt for a v1 timeline section', () => {
    expect(() => buildSectionMessages('upcoming_periods' as never, {} as never, 'layman')).toThrow();
    expect(() => buildSectionMessages('current_sky' as never, {} as never, 'layman')).toThrow();
  });
});
```

If `buildSectionMessages` today returns a message with an undefined task for an unknown key instead of throwing, add an explicit guard as part of Step 3 (`if (!(section in SECTION_TASKS) && !isReportTimelineSection(section)) throw new Error(\`unknown section: ${section}\`)`). Dropping a key must never silently build a prompt with no task in it.

- [ ] **Step 2: Run, expect failure.**
  `cd packages/llm && bunx vitest run src/__tests__/v1-timeline-removed.test.ts`
  Expected: FAIL with `streamCurrentTimeline: expected true to be false`.

- [ ] **Step 3: Implement.** Make the deletions listed under **Files**. Then make the tests compile and pass with this mapping, and only this mapping:

| Test that used… | Becomes |
| --- | --- |
| `streamStructuredInterpretation` over all seven sections | `streamNatalInterpretation` over the five natal sections. Expected section lists, counts and merged fields drop `upcoming_periods`/`current_sky` |
| `streamCurrentTimeline` (split, streaming progress, retry, reasoning cap, in-band error) | `streamReportTimeline` with the four report keys, if PR 2 does not already cover that behaviour for report sections. If PR 2's tests already cover it (`reasoning-cap.test.ts` for the 6k report cap, the PR 2 retry/streaming tests), delete the v1 case |
| a `upcoming_periods`/`current_sky` prompt snapshot or task-text assertion | delete the case: the prompt no longer exists |
| `upcoming_periods`/`current_sky` used only as a sample key name (`json-stream`, `json-prose`) | rename the sample key to `year_ahead` and keep the assertion |

`git rm frontend/packages/llm/src/__tests__/current-sky.test.ts`. In `Dashboard.aiDegradation.test.tsx` remove `streamCurrentTimeline` from the `@almamesh/llm` mock (add `streamReportTimeline: vi.fn()` if the page path needs it). In `e2e/chat.grounding.spec.ts` drop the v1 section stubs.

Each deleted test case covers a removed feature. None of them asserted a defect. List every deleted case by name in the PR body under "Tests removed with v1 generation".

- [ ] **Step 4: Run, expect pass.**
  `cd packages/llm && bunx vitest run && bun run typecheck`, then `cd ../../apps/web && bunx vitest run && bun run typecheck && bun run lint`, then `grep -rn "streamCurrentTimeline\|streamStructuredInterpretation\|UPCOMING_PERIODS_TASK\|CURRENT_SKY_TASK" frontend/packages frontend/apps --include='*.ts' --include='*.tsx' | grep -v node_modules` from the repo root.
  Expected: all green, and the grep prints nothing (comments that name the old function must be reworded too).

- [ ] **Step 5: Commit.**
```bash
git rm frontend/packages/llm/src/__tests__/current-sky.test.ts
git add frontend/packages/llm/src/structured-interpretation.ts frontend/packages/llm/src/index.ts frontend/packages/llm/src/__tests__/v1-timeline-removed.test.ts frontend/packages/llm/src/__tests__/structured-interpretation.test.ts frontend/packages/llm/src/__tests__/structured-interpretation-split.test.ts frontend/packages/llm/src/__tests__/structured-section-streaming.test.ts frontend/packages/llm/src/__tests__/structured-section-retry.test.ts frontend/packages/llm/src/__tests__/structured-interpretation-language.test.ts frontend/packages/llm/src/__tests__/reasoning-cap.test.ts frontend/packages/llm/src/__tests__/structured-budget.test.ts frontend/packages/llm/src/__tests__/prompt-interpretation.test.ts frontend/packages/llm/src/__tests__/predictive-prompt.test.ts frontend/packages/llm/src/__tests__/json-stream.test.ts frontend/packages/llm/src/__tests__/json-prose.test.ts frontend/packages/llm/src/__tests__/client-inband-error.test.ts frontend/apps/web/src/pages/__tests__/Dashboard.aiDegradation.test.tsx frontend/apps/web/e2e/chat.grounding.spec.ts
git commit -m "refactor(llm): delete v1 timeline generation; saved v1 timelines stay readable"
```
(Stage only the files the mapping actually touched. Drop any path above that needed no change.)

### Task 3.15: Existing e2e stubs and the export/wipe/import round trip of a v2 report

**Files:**
- Modify: `apps/web/e2e/interpretation.spec.ts:42-92` (stub keys)
- Modify: `apps/web/e2e/timeline.real.spec.ts:62-67`, `:86`, `:110-113`, `:130` (section keys and ids)
- Modify: `apps/web/e2e/portableInvariants.helpers.ts:131-153` (`READING_SECTIONS`)
- Modify: `apps/web/e2e/portable-invariants.spec.ts` (new test after `:464`)

**Interfaces:**
- Consumes: `fakeThirdParties`, `onboard`, `spaNavigate`, `exportBackup`, `importBackup`, `expectCleanBrowser`, `gotoSettled` (existing helpers); the `freshBrowser` helper local to `portable-invariants.spec.ts`.
- Produces: a stub vocabulary for the v2 sections that the new live spec (Task 3.17) also imports: `export const REPORT_SECTION_JSON` from `portableInvariants.helpers.ts`.

- [ ] **Step 1: Write the failing test.** In `portableInvariants.helpers.ts`, export the v2 stubs and add them to `READING_SECTIONS` (replace the `upcoming_periods`/`current_sky` entries at `:151-152`):

```ts
export const YEAR_AHEAD_SENTINEL = 'INVARIANT YEAR AHEAD headline survives export and import.';
const voice = (text: string) => ({ layman: text, technical: `${text} (astrologer)` });

export const REPORT_SECTION_JSON: Record<string, unknown> = {
  current_period: {
    maha: voice('Maha years ask for patience.'),
    antar: voice('This antar sharpens the detail.'),
    activates: [{ title: 'Work', ...voice('Work comes forward.') }],
    next_change: voice('A softer stretch follows.'),
  },
  year_ahead: {
    headline: voice(YEAR_AHEAD_SENTINEL),
    quarters: ['Q1', 'Q2', 'Q3', 'Q4'].map((key) => ({ key, layman: `${key} plain.`, technical: `${key} technical.` })),
    focus: voice('Finish what you start.'),
  },
  life_outlook_1: {
    domains: ['career', 'finances', 'relationships', 'family'].map((domain) => ({
      domain,
      outlook: voice(`${domain} steadies this year.`),
      lean_into: 'Long projects.',
      watch_for: 'Overwork.',
    })),
  },
  life_outlook_2: {
    domains: ['health', 'education', 'spiritual'].map((domain) => ({
      domain,
      outlook: voice(`${domain} steadies this year.`),
    })),
  },
};
```

and in `READING_SECTIONS` add `family_guidance: { layman: 'Family.', technical: '4th lord.' }` to `guidance1`, then `...REPORT_SECTION_JSON`. No prose contains a date, so the date guard removes nothing.

Add to `portable-invariants.spec.ts` after the first `describe` (`:464`):

```ts
test.describe('reading report v2: export, wipe, import', () => {
  test('a v2 report survives export, wipe and import identically', async ({ browser }, testInfo) => {
    const a = await freshBrowser(browser, testInfo);
    await gotoSettled(a.page, '/onboarding');
    await onboard(a.page, SELF);
    await connectAi(a.page);
    await spaNavigate(a.page, '/dashboard');
    await a.page.getByTestId('generate-reading').click();
    await expect(a.page.getByTestId('report-contents-year_ahead')).toHaveAttribute('data-status', 'written', {
      timeout: 180_000,
    });
    await expect(a.page.getByTestId('report-contents-overview')).toHaveAttribute('data-status', 'written');
    const report = a.page.getByTestId('reading-report');
    await report.getByTestId('report-chapter-year_ahead').getByRole('button').first().click();
    const before = {
      text: await report.innerText(),
      caption: await a.page.getByTestId('reading-provenance').innerText(),
    };
    expect(before.text).toContain(YEAR_AHEAD_SENTINEL);
    expect(before.caption).toMatch(/Year ahead from/);

    const exportPath = testInfo.outputPath('report-v2.almamesh');
    const bytes = await exportBackup(a.page, exportPath);
    expect(bytes.includes(Buffer.from(YEAR_AHEAD_SENTINEL)), 'export is encrypted').toBe(false);
    expectCleanBrowser(a.problems, 'browser A');
    await a.close();

    const b = await freshBrowser(browser, testInfo);
    await importBackup(b.page, exportPath);
    await spaNavigate(b.page, '/dashboard');
    const restored = b.page.getByTestId('reading-report');
    await expect(b.page.getByTestId('report-contents-year_ahead')).toHaveAttribute('data-status', 'written', {
      timeout: 60_000,
    });
    await restored.getByTestId('report-chapter-year_ahead').getByRole('button').first().click();
    expect(await restored.innerText()).toBe(before.text);
    expect(await b.page.getByTestId('reading-provenance').innerText()).toBe(before.caption);
    expect(b.llmCalls, 'restoring must not regenerate anything through the LLM').toEqual([]);
    expectCleanBrowser(b.problems, 'browser B');
    await b.close();
  });
});
```

Import `YEAR_AHEAD_SENTINEL` from the helpers. A fresh browser B is the "wipe": a new OPFS origin with nothing in it.

In `interpretation.spec.ts`, replace the two timeline stubs in `SECTION_JSON` with `...REPORT_SECTION_JSON` (imported from `./portableInvariants.helpers`), extend `SectionKey` with the four new keys, and add `family_guidance` to `guidance1`. In `timeline.real.spec.ts` map `upcoming_periods` to `year_ahead` in the response classifier (`:65`) and the saved-file names. Change the settled locator (`:110`) to `page.getByTestId('report-contents-year_ahead').and(page.locator('[data-status="written"]')).or(page.getByTestId('timeline-partial-failure')).or(page.getByTestId('timeline-retry'))`.

- [ ] **Step 2: Run, expect failure (before Tasks 3.1-3.14 are on the branch it cannot pass; run it now to see the right red).**
  `cd apps/web && bun run test:e2e:portable-invariants --project=chromium -g "v2 report survives"`
  Expected on a tree without the report: FAIL with `locator('[data-testid="report-contents-year_ahead"]') … element(s) not found`. With Tasks 3.1-3.14 applied, run Step 4.

- [ ] **Step 3: Implement.** No product code. The test drives Tasks 3.1-3.14.

- [ ] **Step 4: Run, expect pass.**
  `cd apps/web && bun run test:e2e:portable-invariants --project=chromium -g "v2 report survives" && bun run test:e2e:interp`
  Expected: both PASS. Then on macOS: `PORTABLE_INVARIANTS_E2E_BASE_URL= bun run test:e2e:portable-invariants --project=iphone-webkit -g "v2 report survives"`, expected PASS.

- [ ] **Step 5: Commit.**
```bash
git add frontend/apps/web/e2e/portableInvariants.helpers.ts frontend/apps/web/e2e/portable-invariants.spec.ts frontend/apps/web/e2e/interpretation.spec.ts frontend/apps/web/e2e/timeline.real.spec.ts
git commit -m "test(e2e): a v2 report survives export, wipe and import; stubs speak the report sections"
```

### Task 3.16: Mutation red runs

**Files:**
- Create: `apps/web/scripts/mutations/pr3-store-report.sh` (no mutation harness exists in the repo today; this creates the `scripts/mutations/` location the plan uses for every PR)

Each row of the spec's PR 3 red-run table, plus the second guard on the fail-closed timeline:

| # | Mutation | Test that must go red |
| --- | --- | --- |
| 1 | Migration drops `current_sky` | `interpretation.migration.test.ts` "v6 timeline survives as shape v1, byte for byte" |
| 2 | Render a band from model text instead of `domains_context` | `ReadingReport.test.tsx` "strength chip comes from the engine and links to the strength receipt" |
| 3a | `startReading` starts the timeline while predictive is pending | `useStreamingInterpretation.test.ts` "queued, not sent" |
| 3b | `runTimeline` drops the predictive guard | existing `useStreamingInterpretation.test.ts` "does not spend timeline calls before exact-day predictive facts are ready" |
| 4 | Commit any v2 timeline (no commit rule) | `useStreamingInterpretation.test.ts` "a failed v2 refresh keeps the v1 timeline" |

- [ ] **Step 1: Write the script.**

```bash
#!/usr/bin/env bash
# PR 3 mutation red runs. Each mutation breaks one property this PR claims,
# asserts the mutation applied, runs the named test, and requires it to FAIL
# (judged by exit code, never by grepping output). The tree is restored after
# each run and checked clean at the end.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
FE="$ROOT/frontend"
STORE_SRC="frontend/packages/store/src/interpretation.ts"
REPORT_SRC="frontend/apps/web/src/components/features/dashboard/ReadingReport.tsx"
HOOK_SRC="frontend/apps/web/src/hooks/useStreamingInterpretation.ts"
MARKERS=("_droppedSky" "band=\"strong\" data-mutant" "if (false && currentTimelineInputState" "predictive === null && false" "isCommittableTimeline(content) || true")
results=()
failures=0

restore() { git -C "$ROOT" checkout -- "$1"; }

# run_mutation <label> <file> <perl-expression> <marker> <workdir> <vitest file> <test name pattern>
run_mutation() {
  local label="$1" file="$2" expr="$3" marker="$4" workdir="$5" test_file="$6" pattern="$7"
  perl -0pi -e "$expr" "$ROOT/$file"
  if ! grep -qF -- "$marker" "$ROOT/$file"; then
    echo "MUTATION DID NOT APPLY: $label" >&2
    restore "$file"
    exit 1
  fi
  (cd "$workdir" && bunx vitest run "$test_file" -t "$pattern" >/dev/null 2>&1)
  local code=$?
  restore "$file"
  if [ "$code" -ne 0 ]; then
    results+=("RED   (exit $code)  $label")
  else
    results+=("GREEN (exit 0)  $label  <-- guard did not fail")
    failures=$((failures + 1))
  fi
}

run_mutation "1 migration drops current_sky" "$STORE_SRC" \
  "s/const tagged = \\{ \\.\\.\\.content, shape: 'v1' \\}/const { current_sky: _droppedSky, ...kept } = content; const tagged = { ...kept, shape: 'v1' }/" \
  "_droppedSky" "$FE/packages/store" "src/interpretation.migration.test.ts" "v6 timeline survives as shape v1"

run_mutation "2 band from model text, not domains_context" "$REPORT_SRC" \
  "s/<BandBadge band=\\{card\\.band\\} \\/>/<BandBadge band=\"strong\" data-mutant \\/>/" \
  "band=\"strong\" data-mutant" "$FE/apps/web" "src/components/features/dashboard/__tests__/ReadingReport.test.tsx" "strength chip comes from the engine"

run_mutation "3a timeline sent while predictive is pending" "$HOOK_SRC" \
  "s/if \\(currentTimelineInputState\\(id\\) === 'pending'\\) \\{\\n        setTimelineQueuedFor/if (false && currentTimelineInputState(id) === 'pending') {\\n        setTimelineQueuedFor/" \
  "if (false && currentTimelineInputState" "$FE/apps/web" "src/hooks/__tests__/useStreamingInterpretation.test.ts" "queued, not sent"

run_mutation "3b runTimeline fails open without predictive facts" "$HOOK_SRC" \
  "s/if \\(predictive === null\\) \\{/if (predictive === null && false) {/" \
  "predictive === null && false" "$FE/apps/web" "src/hooks/__tests__/useStreamingInterpretation.test.ts" "does not spend timeline calls before exact-day predictive facts are ready"

run_mutation "4 failed v2 run overwrites the v1 timeline" "$HOOK_SRC" \
  "s/if \\(!isCommittableTimeline\\(content\\)\\) \\{/if (!(isCommittableTimeline(content) || true)) {/" \
  "isCommittableTimeline(content) || true" "$FE/apps/web" "src/hooks/__tests__/useStreamingInterpretation.test.ts" "a failed v2 refresh keeps the v1 timeline"

printf '%s\n' "${results[@]}"

if ! git -C "$ROOT" diff --quiet; then
  echo "TREE NOT CLEAN after mutations" >&2
  git -C "$ROOT" diff --stat >&2
  exit 1
fi
for marker in "${MARKERS[@]}"; do
  if grep -rqF -- "$marker" "$ROOT/frontend/packages/store/src" "$ROOT/frontend/apps/web/src"; then
    echo "LEFTOVER MUTATION MARKER: $marker" >&2
    exit 1
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "$failures guard(s) stayed green under mutation" >&2
  exit 1
fi
echo "All PR 3 guards went red under mutation; tree clean."
```

Mutation 4 also turns the store's own refusal into the only guard left. The store refusal in `setCurrentTimeline` (Task 3.1) still blocks the overwrite, so the hook test may stay green under mutation 4 alone. If it does, extend mutation 4 to also apply `s/if \(!isCommittableTimeline\(content\)\) return;/if (false) return;/` to `$STORE_SRC` (with marker `if (false) return;`, added to `MARKERS`), and restore both files. That is the honest red: both layers removed, the v1 timeline is overwritten.

- [ ] **Step 2: Run on the finished branch.**
  `chmod +x frontend/apps/web/scripts/mutations/pr3-store-report.sh && frontend/apps/web/scripts/mutations/pr3-store-report.sh`
  Expected: five `RED (exit 1)` lines, then `All PR 3 guards went red under mutation; tree clean.`, exit 0. Paste the output into the PR body.

- [ ] **Step 3: Commit.**
```bash
git add frontend/apps/web/scripts/mutations/pr3-store-report.sh
git commit -m "test: PR 3 mutation red runs (migration, engine band, fail-closed timeline, commit rule)"
```

### Task 3.17: Live end-to-end

**Files:**
- Create: `apps/web/playwright.reading-report.config.ts`
- Create: `apps/web/e2e/reading-report.spec.ts`
- Create: `apps/web/e2e/reading-report.real.spec.ts`
- Modify: `apps/web/package.json` (scripts), `apps/web/scripts/webkit-macos-lane.sh` (iphone-webkit run), `dagger/src/index.ts:528-533` (`browserSuites` adds the Chromium run) and `:440-444` (the WebKit-lane contract file list adds the config)

Evidence required (both Desktop Chromium and iPhone 15 WebKit):

| Screen | Screenshot file | Console |
| --- | --- | --- |
| Dashboard before tap (zero provider calls) | `01-before.png` | clean |
| Chapters writing | `02-writing.png` | clean |
| Chapter 1 open | `03-overview.png` | clean |
| Chapter 2 open (dasha bar) | `04-current-period.png` | clean |
| Chapter 3 open (quarters + events) | `05-year-ahead.png` | clean |
| Chapter 4 open (strength chips, windows) | `06-life-areas.png` | clean |
| Chapter 5 open | `07-remedies.png` | clean |
| For Astrologer voice | `08-astrologer.png` | clean |
| After reload, same report | `09-reloaded.png` | clean |

- [ ] **Step 1: Write the config.** `apps/web/playwright.reading-report.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PORT = Number(process.env.READING_REPORT_E2E_PORT ?? 4193);
const EXTERNAL_BASE_URL = process.env.READING_REPORT_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const REAL = process.env.READING_REPORT_REAL === '1';

/**
 * The dashboard reading report, driven like a user against a production
 * build with the exit-gate hooks (chart seeding). The stubbed spec is the
 * gate; READING_REPORT_REAL=1 runs the real-model check instead.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: REAL ? /reading-report\.real\.spec\.ts/ : /reading-report\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: REAL ? 2_400_000 : 300_000,
  expect: { timeout: 30_000 },
  use: { baseURL: BASE_URL, headless: true, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 15'] } },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 240_000,
        cwd: __dirname,
      },
});
```

`package.json` scripts:

```json
    "test:e2e:reading-report": "playwright test --config=playwright.reading-report.config.ts",
    "test:e2e:reading-report:real": "READING_REPORT_REAL=1 playwright test --config=playwright.reading-report.config.ts --project=chromium",
```

- [ ] **Step 2: Write the stubbed spec.** `apps/web/e2e/reading-report.spec.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

import { test } from './webkitProfile';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';
import { expectCleanBrowser, REPORT_SECTION_JSON, watchBrowser, YEAR_AHEAD_SENTINEL } from './portableInvariants.helpers';

/**
 * The five-chapter reading on the dashboard: real engine, stubbed
 * OpenAI-compatible provider (page.route). Proves zero provider calls before
 * the tap, all five chapters with engine-drawn facts, both voices, and the
 * same report after a reload, with a clean console, on desktop Chromium and
 * the iPhone 15 WebKit profile.
 */

const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  model: 'deepseek/deepseek-v4.1-flash',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};

const P = (text: string) => ({ layman: text, technical: `${text} (astrologer)` });
const NATAL_JSON: Record<string, unknown> = {
  core: {
    summary: 'REPORT SUMMARY for this chart.',
    strengths: [{ title: 'Grit', ...P('You persevere.') }],
    challenges: [{ title: 'Haste', ...P('Slow down.') }],
    life_themes: [{ title: 'Service', ...P('You help others.') }],
  },
  yoga: { integrated_yoga_narrative: P('Your life arc bends toward leadership.') },
  guidance1: {
    health_guidance: P('Rest more.'),
    education_guidance: P('Keep learning.'),
    career_guidance: P('Lead teams.'),
    relationship_guidance: P('Communicate.'),
    family_guidance: P('Family is your anchor.'),
  },
  guidance2: {
    finances_guidance: P('Save steadily.'),
    spiritual_guidance: P('Reflect daily.'),
    life_evolution_guidance: P('You grow through challenge.'),
  },
  remedial: { remedial_measures: P('Meditate and journal.') },
};
const SECTIONS: Record<string, unknown> = { ...NATAL_JSON, ...REPORT_SECTION_JSON };

async function stubProvider(page: Page): Promise<{ calls: () => string[] }> {
  const calls: string[] = [];
  await page.route('**/openrouter.ai/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    const url = request.url();
    if (url.includes('/models')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
    if (url.includes('/credits')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":{"total_credits":10,"total_usage":1}}' });
    }
    const body = request.postData() ?? '';
    const section = Object.keys(SECTIONS).find((key) => body.includes(`SECTION:${key}`));
    if (!section) {
      calls.push('unexpected');
      return route.fulfill({ status: 400, body: 'no SECTION marker' });
    }
    calls.push(section);
    const content = JSON.stringify(SECTIONS[section]);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }] }),
    });
  });
  return { calls: () => calls };
}

async function openChapter(page: Page, id: string): Promise<void> {
  await page.getByTestId(`report-chapter-${id}`).getByRole('button').first().click();
}

test('the dashboard reading report: five chapters, engine facts, both voices, survives reload', async ({ page, context }, testInfo) => {
  const dir = `test-results/reading-report/${testInfo.project.name}`;
  mkdirSync(dir, { recursive: true });
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  const provider = await stubProvider(page);
  const problems = watchBrowser(context, new URL(testInfo.project.use.baseURL ?? 'http://127.0.0.1:4193').origin);

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const generate = page.getByTestId('generate-reading');
  await expect(generate).toBeVisible();
  expect(provider.calls(), 'mounting the dashboard spends nothing').toEqual([]);
  await page.screenshot({ path: `${dir}/01-before.png`, fullPage: true });

  await generate.click();
  await expect(page.getByTestId('report-contents')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${dir}/02-writing.png`, fullPage: true });
  for (const id of ['overview', 'current_period', 'year_ahead', 'life_areas', 'remedies']) {
    await expect(page.getByTestId(`report-contents-${id}`)).toHaveAttribute('data-status', 'written', { timeout: 180_000 });
  }
  expect([...provider.calls()].sort()).toEqual(
    ['core', 'guidance1', 'guidance2', 'life_outlook_1', 'life_outlook_2', 'remedial', 'current_period', 'year_ahead', 'yoga'].sort(),
  );

  await expect(page.getByText('REPORT SUMMARY for this chart.').and(page.locator('p'))).toBeVisible();
  await expect(page.getByTestId('report-overview-facts')).toContainText(/Lagna/);
  await expect(page.getByTestId('reading-provenance')).toContainText(/Written by deepseek\/deepseek-v4\.1-flash on .+\. Year ahead from .+\./);
  await page.screenshot({ path: `${dir}/03-overview.png`, fullPage: true });

  await openChapter(page, 'current_period');
  await expect(page.getByTestId('report-dasha-bar')).toBeVisible();
  await expect(page.getByTestId('report-dasha-bar')).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  await page.getByTestId('report-chapter-current_period').screenshot({ path: `${dir}/04-current-period.png` });

  await openChapter(page, 'year_ahead');
  await expect(page.getByText(YEAR_AHEAD_SENTINEL)).toBeVisible();
  for (const key of ['Q1', 'Q2', 'Q3', 'Q4']) {
    await expect(page.getByTestId(`report-quarter-${key}`).getByRole('heading')).toHaveText(/^[A-Za-z]{3}( \d{4})?-[A-Za-z]{3} \d{4}$/);
  }
  await page.getByTestId('report-chapter-year_ahead').screenshot({ path: `${dir}/05-year-ahead.png` });

  await openChapter(page, 'life_areas');
  for (const domain of ['career', 'finances', 'relationships', 'family', 'health', 'education', 'spiritual']) {
    const chip = page.getByTestId(`report-strength-chip-${domain}`);
    await expect(chip).toHaveAttribute('href', `/life/${domain}`);
    await expect(chip.locator('[data-testid^="band-"]')).toHaveCount(1);
  }
  await expect(page.getByTestId('report-life-natal-family')).toContainText('Family is your anchor.');
  await page.getByTestId('report-chapter-life_areas').screenshot({ path: `${dir}/06-life-areas.png` });

  await openChapter(page, 'remedies');
  await expect(page.getByTestId('report-long-arc')).toContainText('You grow through challenge.');
  await expect(page.getByTestId('report-year-focus')).toContainText('Finish what you start.');
  await page.getByTestId('report-chapter-remedies').screenshot({ path: `${dir}/07-remedies.png` });

  const callsBeforeToggle = provider.calls().length;
  await page.getByTestId('content-mode-toggle').click();
  await expect(page.getByText('REPORT SUMMARY for this chart.')).toBeVisible();
  await expect(page.getByText('You grow through challenge. (astrologer)')).toBeVisible();
  expect(provider.calls().length, 'the voice toggle makes no model call').toBe(callsBeforeToggle);
  await page.screenshot({ path: `${dir}/08-astrologer.png`, fullPage: true });

  const reportBefore = await page.getByTestId('reading-report').innerText();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('report-contents-year_ahead')).toHaveAttribute('data-status', 'written', { timeout: 60_000 });
  for (const id of ['current_period', 'year_ahead', 'life_areas', 'remedies']) await openChapter(page, id);
  expect(await page.getByTestId('reading-report').innerText()).toBe(reportBefore);
  expect(provider.calls().length, 'reload spends nothing').toBe(callsBeforeToggle);
  await page.screenshot({ path: `${dir}/09-reloaded.png`, fullPage: true });

  expect(provider.calls()).not.toContain('unexpected');
  expectCleanBrowser(problems, testInfo.project.name);
});
```

Before writing this, check the voice toggle's real test id in `components/ui/ContentModeToggle.tsx` and use it in place of `content-mode-toggle`. The summary in the `core` stub is a plain string, which the parser maps to both voices. That is why the summary line reads the same in both voices.

- [ ] **Step 3: Write the real-model check.** `apps/web/e2e/reading-report.real.spec.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';
import { E2E_REAL_MODEL } from './realModel';

/**
 * Real-model check: the full report against live OpenRouter on
 * E2E_REAL_MODEL, then a reload shows the same report. Skips without a key.
 * Run: OPENROUTER_API_KEY=... bun run test:e2e:reading-report:real
 */
test('[real] the full report writes, saves and survives a reload', async ({ page }) => {
  const KEY = process.env.OPENROUTER_API_KEY;
  test.skip(!KEY, 'OPENROUTER_API_KEY not set');
  test.setTimeout(2_400_000);
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify({ apiBase: 'https://openrouter.ai/api/v1', apiKey: KEY, model: E2E_REAL_MODEL, privacyMode: 'cloud_premium', engine: 'openai-http' })] as const,
  );
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e)}`));

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  await page.getByTestId('generate-reading').click();
  for (const id of ['overview', 'current_period', 'year_ahead', 'life_areas', 'remedies']) {
    await expect(page.getByTestId(`report-contents-${id}`)).toHaveAttribute('data-status', /written|failed/, { timeout: 1_200_000 });
  }
  const totalMs = Date.now() - t0;
  const statuses = await page.locator('[data-testid^="report-contents-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-status')));
  const text = await page.getByTestId('reading-report').innerText();
  expect(text, 'no day-precision date reaches the screen').not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('report-contents-overview')).toHaveAttribute('data-status', /written|failed/, { timeout: 60_000 });
  expect(await page.getByTestId('reading-report').innerText()).toBe(text);

  mkdirSync('test-results/reading-report-real', { recursive: true });
  writeFileSync('test-results/reading-report-real/summary.json', JSON.stringify({ model: E2E_REAL_MODEL, totalMs, statuses }, null, 2));
  writeFileSync('test-results/reading-report-real/console.txt', errors.join('\n'));
  await page.screenshot({ path: 'test-results/reading-report-real/report.png', fullPage: true });
  expect(statuses.every((s) => s === 'written'), `chapter statuses: ${statuses.join(', ')}`).toBe(true);
  expect(errors).toEqual([]);
});
```

- [ ] **Step 4: Wire the lanes.** `scripts/webkit-macos-lane.sh`, before `exit "${status}"`:

```bash
READING_REPORT_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:reading-report --project=iphone-webkit --retries=0 || status=1
```

`dagger/src/index.ts` `browserSuites()` (`:530`) adds:

```ts
      "READING_REPORT_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:reading-report --project=chromium",
```

and the WebKit-lane contract list (`:441-444`) adds `"frontend/apps/web/playwright.reading-report.config.ts",`.

- [ ] **Step 5: Run it like a user.**
```bash
cd frontend/apps/web
bun run test:e2e:reading-report --project=chromium
bun run test:e2e:reading-report --project=iphone-webkit      # macOS (WebKit needs macOS OPFS)
OPENROUTER_API_KEY=... bun run test:e2e:reading-report:real
```
Then drive it by hand once: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --port 4193`, open `/dashboard` with a real key in Settings → AI, tap "Generate natal reading", watch the five statuses move, open each chapter, toggle the voice, reload. Expected: all three runs PASS; screenshots in `test-results/reading-report/{chromium,iphone-webkit}/01..09-*.png`; `test-results/reading-report-real/summary.json` all `written`; console files empty.

- [ ] **Step 6: Commit.**
```bash
git add frontend/apps/web/playwright.reading-report.config.ts frontend/apps/web/e2e/reading-report.spec.ts frontend/apps/web/e2e/reading-report.real.spec.ts frontend/apps/web/package.json frontend/apps/web/scripts/webkit-macos-lane.sh dagger/src/index.ts
git commit -m "test(e2e): live reading report journey on Chromium and iPhone 15 WebKit, plus a real-model check"
```

### Task 3.18: Full gate and northstar

- [ ] **Step 1: Quality skill.** Run the `frontend-quality` skill on the branch. Fix every finding in the files this PR touched (no `any`, named exports only, hook dependency hygiene, a11y: the chapter toggles are buttons, chips are links with a title, touch targets at least 44 px).
- [ ] **Step 2: Gate.** From the repo root: `make gate`. Expected: green, including the store and web Vitest suites, `tsc`, lint, `verify-i18n`, and the memory-budget lane. Save the tail of the output for the PR.
- [ ] **Step 3: Mutation evidence.** `frontend/apps/web/scripts/mutations/pr3-store-report.sh`. Expected: five RED lines, clean tree.
- [ ] **Step 4: Push and open the PR.**
```bash
git push -u origin claude/reading-pr3-store-report
gh pr create --title "feat: store v7, report hook, dashboard ReadingReport (PR 3 of 4)" --body-file /tmp/pr3-body.md
```
The PR body must contain:
  - **Claim:** "Your reading is saved on this device and survives reloads, export and import."
  - **Contract changes, said loudly:** persist version pins 6 to 7 (two tests); `timelineSections` length 2 to 4; the caption copy changes to "Written by … on …. Year ahead from …."; Dashboard tests now mock `streamReportTimeline`.
  - **Commit rule:** a v2 timeline is committed only when `current_period` and `year_ahead` both parsed; otherwise the saved timeline is kept (Task 3.4 test, both failure modes).
  - The mutation script output (five RED lines).
  - Screenshots `01`-`09` for both profiles, and the clean-console statement for each.
  - Gate evidence: the `make gate` tail and the CI run link once green.
  - Real-model `summary.json` (model, total ms, statuses).
- [ ] **Step 5: CI green.** `gh pr checks --watch`. Expected: every required check passes, including the Dagger `browserSuites` lane that now runs the reading-report spec on Chromium.
- [ ] **Step 6: Northstar.** Dispatch the `northstar` agent on the PR against the claim "Your reading is saved on this device and survives reloads, export and import", plus the engine-drawn-facts property (bands, dates and windows come from the engine). Require grade A. Fix and re-grade until it is A.
- [ ] **Step 7: Merge and clean up in one go.** `gh pr merge --squash --delete-branch`, then `git worktree remove .worktrees/reading-pr3`, `git branch -D claude/reading-pr3-store-report`. Check `main` CI is green and the deploy's `build.json` `git_sha` matches the merge SHA (with `content-type: application/json`). Then open the live dashboard with a real key and confirm the report renders and survives a reload.

---

## PR 4: onboarding reading route

**Requested tests live in:** (a) reload / direct open derives the step from stored data, never `location.state`, and sends nothing on load: Task 4.10 (unit, tests 3 and 4) and Task 4.14 (e2e reload step in the main journey). (b) cost line: model missing from the list, `"0"/"0"` pricing, negative or non-numeric pricing: Task 4.7.

**Branch:** `feat/onboarding-reading-route` (off `main` after PR 1 and PR 3 merge)

**Claim touched:** "Paid AI calls happen only after you ask." and "AlmaMesh is free forever." (also guards "Your key goes only to the provider you choose": a local endpoint never contacts openrouter.ai)

**Depends on:** PR 1 (`AiSetupPanel`), PR 2 (`estimateReadingCost`, `READING_OUTPUT_BUDGET`, `ModelPricing`, `OpenRouterModel.pricing`, `buildReportMessages`), PR 3 (`startReading`, `chapters`, `retryFailed`, `ReadingReport` variant `'onboarding'`).

**Deviations:**
- Uses PR 2's final builder `buildReportMessages({ chart, asOf? }, { mode, language, lite })` → `Readonly<Record<ReportSectionKey, readonly ChatMessage[]>>`. The only call site is `hooks/useReadingEstimateMessages.ts`, which passes the hook's own `asOf` (`storedChartAnalysisInstant`), its mode mapping (content mode `'technical'` → `'expert'`) and `usesLitePrompt(config)`. The e2e stub's `life_outlook_1` / `life_outlook_2` payloads are per-section model answers (`{ domains: [...] }`), so they already fit the nested `ReportTimelineContent.life_outlook`; nothing PR 4 writes uses a flat array.
- PR 3's final interfaces are used: `ReadingReportProps = { chartId; reading: { interpretation, currentTimeline, chapters }; audience: ReportAudience; variant; onGetFullYearAhead?; onRetryFailed? }`. `OnboardingReadingPage` owns the single `useStreamingInterpretation` instance (`useSingleFlight` is per instance) and passes its data in. The page leaves `onGetFullYearAhead` and `onRetryFailed` unset because it renders its own Retry. `ReportChapter`, `ChapterId` and `ChapterStatus` are re-exported from `hooks/useStreamingInterpretation.ts`, and `errorKind` / `timelineErrorKind` drive the 402 path.
- `audience` is `ReportAudience` (`lib/reportSelectors.ts`). PR 3 confirms the root `data-testid="reading-report"` and the dashboard button `generate-reading`.
- `AiSetupPanel` is assumed to keep `LlmModelSettings`' test ids: `llm-openrouter-key`, `llm-save`, `llm-connection-result`, `llm-advanced-summary`, `llm-api-base`, `llm-model`, `llm-save-advanced`. The local-endpoint e2e also assumes the advanced form opens without first selecting the OpenRouter tier. If selecting a tier writes the OpenRouter base, the panel's keyless catalog read would hit openrouter.ai. That would be a PR 1 bug and this e2e is the test that catches it.
- The disclosure line above "Get my reading" reuses `settings:tiers.cloud_body` (the panel's own birth-date disclosure, test id `tier-cloud-honesty` in PR 1). There is no new `reading.disclosure` key. `ai.privacy_warning`, which the spec names, is the local-only refusal warning, not the disclosure.
- Step-2 copy says "the year ahead quarter by quarter" (ruling 6), not the spec's "month by month". Copy must match what ships.
- Rectify gets a "Skip for now" button that shows only when entered from onboarding. The spec says "Skipping rectify also goes on to step 2/3", but Rectify has no skip today.
- Onboarding for a second person (`/onboarding?person=<id>`) also continues to `/onboarding/reading`. One exit path, and the page's own guards apply.
- 17 existing e2e specs and scripts waited for `/dashboard` right after onboarding. They now go through one shared helper, `continueToDashboard` (Task 4.11). The spec's file table does not list these.

### File map

| Path (under `frontend/apps/web/`) | Action | Responsibility |
| --- | --- | --- |
| `src/lib/onboardingHandoff.ts` | create | `ONBOARDING_READING_PATH`, the navigation-state hint, allow-listed reader |
| `src/lib/onboardingHandoff.test.ts` | create | Hint reader accepts only the onboarding reading route |
| `src/pages/Onboarding.tsx` | modify | Exit to `/onboarding/reading` (or rectify) with the hint; drop the fake "interpretation" step |
| `src/pages/__tests__/Onboarding.durableChart.test.tsx` | modify | New destination (reversed contract), unknown-time hint, no fake step |
| `src/pages/__tests__/Onboarding.confidence.test.tsx` | modify | New destination |
| `src/pages/__tests__/OnboardingRecovery.test.tsx` | modify | New destination |
| `src/pages/Rectify.tsx` | modify | Every exit honours the hint; "Skip for now" when entered from onboarding |
| `src/pages/Rectify.test.tsx` | modify | Hint honoured, foreign hint ignored, skip only from onboarding |
| `src/App.tsx` | modify | Lazy route `/onboarding/reading` |
| `src/App.onboardingReadingRoute.test.tsx` | create | Route is mounted and reachable |
| `src/lib/readingCost.ts` | create | Pure: quote from an estimate, cents/range formatting, balance view |
| `src/lib/readingCost.test.ts` | create | Pure function tests |
| `src/hooks/useReadingCostQuote.ts` | create | OpenRouter-only price and balance lookup |
| `src/hooks/useReadingEstimateMessages.ts` | create | The one seam onto PR 2's `buildReportMessages` |
| `src/components/features/onboarding/ReadingCostLine.tsx` | create | Cost line, balance, low-balance warning |
| `src/components/features/onboarding/ReadingCostLine.test.tsx` | create | Request (b) cases, ruling 8, local/cloud get zero lookups |
| `src/lib/readingChapters.ts` | create | `CHAPTER_IDS`, running/failed/complete predicates |
| `src/lib/readingChapters.test.ts` | create | Predicate tests |
| `src/components/features/onboarding/ReadingUnlockStep.tsx` | create | Step 2: `AiSetupPanel` + two lines + "Skip for now" |
| `src/components/features/onboarding/YourReadingStep.tsx` | create | Step 3: outline, model, cost, disclosure, the one button, failures, report |
| `src/components/features/onboarding/ReadingOutline.tsx` | create | The five chapters with status |
| `src/pages/OnboardingReading.tsx` | create | Entry guards, step choice from stored data, predictive auto-start |
| `src/pages/__tests__/OnboardingReading.test.tsx` | create | Guards, nothing sent before the tap, reload, dashboard link, 402, failures |
| `src/locales/{en,es,pt}/onboarding.json` | modify | `reading.*` strings; delete `generating.steps.interpretation` |
| `src/locales/onboarding.reading.test.ts` | create | Pins cost / free-forever / disclosure copy in en/es/pt |
| `e2e/onboardingExit.ts`, `scripts/onboardingExit.mjs` | create | Shared "after onboarding, reach the dashboard" helper |
| 17 e2e specs/scripts (Task 4.11 table) | modify | Use the helper; memory-budget proves predictive starts on the reading route |
| `e2e/rectification.spec.ts` | modify | Unknown-time journey: onboarding → rectify → skip → reading route |
| `e2e/onboardingReading.stub.ts` | create | Stubbed OpenAI-compatible provider (v2 report sections, probe, 401/402) |
| `e2e/onboarding-reading.spec.ts` + `playwright.onboarding-reading.config.ts` | create | Live journeys, Chromium + iPhone 15 WebKit, six-screen evidence |
| `e2e/onboarding-reading.real.spec.ts` + `playwright.onboarding-reading.real.config.ts` | create | Real `E2E_REAL_MODEL` check, gated on `OPENROUTER_API_KEY` |
| `package.json` | modify | `test:e2e:onboarding-reading`, `test:e2e:onboarding-reading:real` |
| `scripts/mutations/pr4-onboarding-reading.sh` | create | Mutation red runs |

All commands below run from `frontend/apps/web` unless they say otherwise.

---

### Task 4.1: Navigation hint helper

**Files:** create `src/lib/onboardingHandoff.ts`, `src/lib/onboardingHandoff.test.ts`

**Interfaces:**
- Produces: `ONBOARDING_READING_PATH = '/onboarding/reading'`; `interface OnboardingHandoffState { readonly from: 'onboarding'; readonly next: typeof ONBOARDING_READING_PATH }`; `onboardingHandoff(): OnboardingHandoffState`; `readOnboardingNext(state: unknown): typeof ONBOARDING_READING_PATH | null`.

- [ ] **Write the failing test** `src/lib/onboardingHandoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ONBOARDING_READING_PATH, onboardingHandoff, readOnboardingNext } from './onboardingHandoff';

describe('onboarding hand-off hint', () => {
  it('builds the hint onboarding passes on', () => {
    expect(onboardingHandoff()).toEqual({ from: 'onboarding', next: '/onboarding/reading' });
    expect(ONBOARDING_READING_PATH).toBe('/onboarding/reading');
  });

  it('reads the hint back', () => {
    expect(readOnboardingNext({ from: 'onboarding', next: '/onboarding/reading' })).toBe('/onboarding/reading');
  });

  it.each([
    ['no state (Settings, dashboard, pasted URL)', undefined],
    ['null', null],
    ['a string', '/onboarding/reading'],
    ['another origin of the hint', { from: 'settings', next: '/onboarding/reading' }],
    ['a different target (never an open redirect)', { from: 'onboarding', next: 'https://evil.example/' }],
    ['a different in-app target', { from: 'onboarding', next: '/settings/data' }],
  ])('ignores %s', (_why, state) => {
    expect(readOnboardingNext(state)).toBeNull();
  });
});
```

- [ ] **Run it:** `bunx vitest run src/lib/onboardingHandoff.test.ts`. Expected: FAIL, `Failed to resolve import "./onboardingHandoff"`.
- [ ] **Implement** `src/lib/onboardingHandoff.ts`:

```ts
/**
 * The onboarding → reading hand-off. A navigation HINT carried in React Router
 * state, not data: SQLite is the only system of record, and the reading page
 * derives its step from stored data alone. Only Rectify reads this hint, to
 * decide where its exits go. The reader is an allow-list, so a crafted state
 * object can never turn an exit into an open redirect.
 */
export const ONBOARDING_READING_PATH = '/onboarding/reading' as const;

export interface OnboardingHandoffState {
  readonly from: 'onboarding';
  readonly next: typeof ONBOARDING_READING_PATH;
}

export function onboardingHandoff(): OnboardingHandoffState {
  return { from: 'onboarding', next: ONBOARDING_READING_PATH };
}

export function readOnboardingNext(state: unknown): typeof ONBOARDING_READING_PATH | null {
  if (typeof state !== 'object' || state === null) return null;
  const { from, next } = state as { readonly from?: unknown; readonly next?: unknown };
  return from === 'onboarding' && next === ONBOARDING_READING_PATH ? ONBOARDING_READING_PATH : null;
}
```

- [ ] **Run to pass:** same command. Expected: 8 passed.
- [ ] **Commit:** `git add src/lib/onboardingHandoff.ts src/lib/onboardingHandoff.test.ts && git commit -m "feat(onboarding): allow-listed navigation hint for the reading step"`

---

### Task 4.2: Onboarding continues to the reading step

This reverses a stated contract. Six existing assertions pin `navigate('/dashboard')` as the end of onboarding. The PR body must say so plainly: "Onboarding no longer ends at the dashboard; it ends at `/onboarding/reading`." The tests are inverted, not deleted.

**Files:** modify `src/pages/Onboarding.tsx` (imports near :31; `:463-466`), `src/pages/__tests__/Onboarding.durableChart.test.tsx` (:198, :315, plus a new test), `src/pages/__tests__/Onboarding.confidence.test.tsx` (:166, :208, :230), `src/pages/__tests__/OnboardingRecovery.test.tsx` (:110, :132)

**Interfaces:** Consumes `onboardingHandoff`, `ONBOARDING_READING_PATH` (Task 4.1). Produces `navigate('/onboarding/reading' | '/rectify/<id>', { state: OnboardingHandoffState })`.

- [ ] **Write the failing tests.** In all three test files, replace each `expect(navigateSpy).toHaveBeenCalledWith('/dashboard')` (the six lines listed above; keep each line's `waitFor` options) with:

```ts
expect(navigateSpy).toHaveBeenCalledWith('/onboarding/reading', {
  state: { from: 'onboarding', next: '/onboarding/reading' },
})
```

Then add this to the `describe` in `Onboarding.durableChart.test.tsx`:

```ts
  it('sends an unknown birth time to rectify, carrying the hint that the reading comes next', async () => {
    seedReadyToGenerate();
    useOnboardingStore.setState((state) => ({
      data: { ...state.data, timeConfidence: 'unknown', needsRectification: true },
    }));
    renderPage();

    fireEvent.click(screen.getByTestId('skip-life-events-button'));
    await waitFor(() => expect(generateChart).toHaveBeenCalledOnce());
    compute.resolve(fakeSiderealChart);
    await waitFor(() => expect(persisted.calls).toBeGreaterThan(0));
    persisted.release();

    const profileId = useProfilesStore.getState().activeProfileId;
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(`/rectify/${profileId}`, {
        state: { from: 'onboarding', next: '/onboarding/reading' },
      }),
    );
  });
```

- [ ] **Run:** `bunx vitest run src/pages/__tests__/Onboarding.durableChart.test.tsx src/pages/__tests__/Onboarding.confidence.test.tsx src/pages/__tests__/OnboardingRecovery.test.tsx`. Expected: 7 FAIL, each `expected "spy" to be called with arguments: [ '/onboarding/reading', … ]` (received `'/dashboard'` or `'/rectify/<id>'` with no state).
- [ ] **Implement.** In `src/pages/Onboarding.tsx` add after the `waitForStoreSaved` import (:32):

```ts
import { ONBOARDING_READING_PATH, onboardingHandoff } from "../lib/onboardingHandoff";
```

Replace `:465-466`:

```ts
        const destination = data.timeConfidence === 'unknown' ? `/rectify/${profileId}` : '/dashboard';
        navigate(destination);
```

with:

```ts
        // The chart is saved: the reading is the next step. An unknown birth
        // time goes through rectify first; the hint tells Rectify's exits to
        // continue here instead of the dashboard. The reading page decides its
        // own step from stored data, so the hint is never needed there.
        const destination =
          data.timeConfidence === 'unknown' ? `/rectify/${profileId}` : ONBOARDING_READING_PATH;
        navigate(destination, { state: onboardingHandoff() });
```

- [ ] **Run to pass:** same command. Expected: all pass.
- [ ] **Commit:** `git add src/pages/Onboarding.tsx src/pages/__tests__/Onboarding.durableChart.test.tsx src/pages/__tests__/Onboarding.confidence.test.tsx src/pages/__tests__/OnboardingRecovery.test.tsx && git commit -m "feat(onboarding)!: continue to /onboarding/reading after the chart is saved"`

---

### Task 4.3: Remove the fake "interpretation" generating step

**Files:** modify `src/pages/Onboarding.tsx` (`:96-104`), `src/locales/{en,es,pt}/onboarding.json` (`generating.steps.interpretation`, en `:101`), `src/pages/__tests__/Onboarding.durableChart.test.tsx` (new test)

- [ ] **Write the failing test** (add to the `describe` in `Onboarding.durableChart.test.tsx`):

```ts
  it('lists only the work the engine does while generating: no "insights" step', async () => {
    seedReadyToGenerate();
    renderPage();

    fireEvent.click(screen.getByTestId('skip-life-events-button'));
    await waitFor(() => expect(generateChart).toHaveBeenCalledOnce());

    // No interpretation runs during onboarding; the screen must not say one does.
    expect(screen.queryByText(/personalized insights/i)).toBeNull();
    expect(screen.getByText(/^Step \d of 4$/)).toBeTruthy();
  });
```

and add to `src/locales/onboarding.parity.test.ts` inside its `describe`:

```ts
  it('the generating steps name no interpretation (none runs during onboarding)', () => {
    for (const locale of [en, es, pt]) {
      const steps = leaf(locale as Record<string, unknown>, 'generating.steps') as Record<string, string>;
      expect(Object.keys(steps).sort()).toEqual(['dashas', 'houses', 'positions', 'yogas']);
    }
  });
```

- [ ] **Run:** `bunx vitest run src/pages/__tests__/Onboarding.durableChart.test.tsx -t "no \"insights\" step" && bunx vitest run src/locales/onboarding.parity.test.ts`. Expected: FAIL on `Generating personalized insights` being found, and the steps keys including `interpretation`.
- [ ] **Implement.** In `src/pages/Onboarding.tsx` replace `:96-104` with:

```ts
// Generation steps for progress display. Labels are resolved via i18n at render
// time from each step's stable id; only the timing lives here. Only work the
// on-device engine really does is listed: no interpretation runs here (the
// reading is the next, explicit step at /onboarding/reading).
const GENERATION_STEPS = [
  { id: 'positions', duration: 2000 },
  { id: 'houses', duration: 1500 },
  { id: 'yogas', duration: 2000 },
  { id: 'dashas', duration: 1500 },
] as const;
```

In each of `src/locales/en/onboarding.json`, `es/onboarding.json` and `pt/onboarding.json`, delete the `"interpretation": …` line in `generating.steps`, and the trailing comma on the `dashas` line above it.

- [ ] **Run to pass:** same command. Expected: pass.
- [ ] **Commit:** `git add src/pages/Onboarding.tsx src/locales/en/onboarding.json src/locales/es/onboarding.json src/locales/pt/onboarding.json src/locales/onboarding.parity.test.ts src/pages/__tests__/Onboarding.durableChart.test.tsx && git commit -m "fix(onboarding): remove the generating step that claimed an interpretation runs"`

---

### Task 4.4: Rectify honours the hint, and can be skipped from onboarding

**Files:** modify `src/pages/Rectify.tsx` (`:14` import, `:51` after `useNavigate`, `:282`, header after the `<h1>` at `:290`, `:397`), `src/pages/Rectify.test.tsx`

**Interfaces:** Consumes `readOnboardingNext` (Task 4.1), `onboarding:reading.skip` (Task 4.8; in this task the test matches by test id, not text).

- [ ] **Write the failing tests.** Add to `src/pages/Rectify.test.tsx`, inside `describe('RectifyPage', …)` after the existing `'keep recorded requests no regeneration and navigates back'` test:

```tsx
  describe('entered from onboarding (navigation hint)', () => {
    const FROM_ONBOARDING = { from: 'onboarding', next: '/onboarding/reading' };

    function renderRectifyWith(state: unknown) {
      return render(
        <MemoryRouter initialEntries={[{ pathname: '/rectify/profile-abc', state }]}>
          <Routes>
            <Route path="/rectify/:profileId" element={<RectifyPage />} />
          </Routes>
        </MemoryRouter>,
      );
    }

    it('keep recorded continues to the reading step', async () => {
      const { rerender } = renderRectifyWith(FROM_ONBOARDING);
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      await navigateToResults(rerender);

      fireEvent.click(screen.getByTestId('keep-recorded-btn'));
      expect(mockNavigate).toHaveBeenCalledWith('/onboarding/reading');
    });

    it('confirming a time continues to the reading step once the chart is saved', async () => {
      const { rerender } = renderRectifyWith(FROM_ONBOARDING);
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      await navigateToResults(rerender);

      fireEvent.click(screen.getByTestId('confirm-candidate-btn'));
      await screen.findByTestId('regen-modal');
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('regen-confirm-btn'));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/onboarding/reading'));
      expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard');
    });

    it('offers "Skip for now", which continues to the reading step', async () => {
      renderRectifyWith(FROM_ONBOARDING);
      fireEvent.click(await screen.findByTestId('rectify-skip-btn'));
      expect(mockNavigate).toHaveBeenCalledWith('/onboarding/reading');
    });

    it('has no skip button when entered from Settings or the dashboard (no hint)', async () => {
      renderRectify();
      await screen.findByTestId('intro-step');
      expect(screen.queryByTestId('rectify-skip-btn')).toBeNull();
    });

    it('ignores a hint that names anything but the reading route', async () => {
      const { rerender } = renderRectifyWith({ from: 'onboarding', next: 'https://evil.example/' });
      fireEvent.click(await screen.findByTestId('intro-start-btn'));
      fireEvent.click(await screen.findByTestId('events-continue-btn'));
      await navigateToResults(rerender);

      fireEvent.click(screen.getByTestId('keep-recorded-btn'));
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
      expect(screen.queryByTestId('rectify-skip-btn')).toBeNull();
    });
  });
```

(`navigateToResults` re-renders a `MemoryRouter` in the same position, so the router keeps its first location, state included.)

- [ ] **Run:** `bunx vitest run src/pages/Rectify.test.tsx -t "entered from onboarding"`. Expected: 3 FAIL (`'/dashboard'` received, and `Unable to find an element by: [data-testid="rectify-skip-btn"]`), 2 pass.
- [ ] **Implement** in `src/pages/Rectify.tsx`:

`:14` becomes:

```ts
import { useParams, useNavigate, useLocation } from 'react-router-dom';
```

add after the `waitForChartSaved` import (`:36`):

```ts
import { readOnboardingNext } from '../lib/onboardingHandoff';
```

`:52` becomes `const { t } = useTranslation(['rectify', 'onboarding']);` and after it add:

```ts
  // Entered from onboarding: every exit continues to the reading step. Entered
  // from Settings, the dashboard or a pasted URL: no hint, the dashboard as before.
  const location = useLocation();
  const onboardingNext = readOnboardingNext(location.state);
  const exitTo = onboardingNext ?? '/dashboard';
```

`:282` `navigate('/dashboard');` becomes `navigate(exitTo);`, and `:397` `onKeepRecorded={() => navigate('/dashboard')}` becomes `onKeepRecorded={() => navigate(exitTo)}`.

After the `<h1 …>{t('wizard.title')}</h1>` line (`:290`) add:

```tsx
      {onboardingNext !== null && (
        <button
          type="button"
          data-testid="rectify-skip-btn"
          onClick={() => navigate(exitTo)}
          className="mb-4 w-fit text-sm text-text-secondary underline underline-offset-4"
        >
          {t('onboarding:reading.skip')}
        </button>
      )}
```

Update the file's header comment line 11 "…navigates to /dashboard." to "…navigates to /dashboard, or to the reading step when entered from onboarding."

- [ ] **Run to pass:** `bunx vitest run src/pages/Rectify.test.tsx`. Expected: all pass, the existing `'/dashboard'` tests included. That shows entry from Settings and the dashboard is unchanged.
- [ ] **Commit:** `git add src/pages/Rectify.tsx src/pages/Rectify.test.tsx && git commit -m "feat(rectify): exits continue to the reading step when entered from onboarding"`

---

### Task 4.5: Mount the `/onboarding/reading` route

**Files:** modify `src/App.tsx` (`:41`, `:145`); create `src/App.onboardingReadingRoute.test.tsx`; create a stub `src/pages/OnboardingReading.tsx` (completed in Task 4.10)

- [ ] **Write the failing test** `src/App.onboardingReadingRoute.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useChartLibraryStore } from '@almamesh/store';

import './i18n/config';

vi.mock('./providers/chartEngineContext', () => ({
  useChartEngine: () => ({ startBootstrap: () => {} }),
  useOptionalChartEngine: () => null,
}));
vi.mock('./pages/OnboardingReading', () => ({
  default: () => <div data-testid="onboarding-reading-page">reading</div>,
}));
vi.mock('./components/features/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout-chrome">{children}</div>
  ),
}));
vi.mock('./components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('./hooks/useChatScopeSync', () => ({ useChatScopeSync: () => {} }));
vi.mock('./hooks/useLanguageSync', () => ({ useLanguageSync: () => {} }));
vi.mock('./hooks/useRegenerationSubscription', () => ({ useRegenerationSubscription: () => {} }));
vi.mock('./hooks/useChartReanchor', () => ({ useChartReanchor: () => {} }));

import App from './App';

describe('/onboarding/reading route', () => {
  beforeEach(() => {
    useChartLibraryStore.setState({
      charts: { saved: { chart_id: 'saved', person_name: 'Saved', is_primary: true } as never },
    });
  });

  it('is mounted inside the app shell', async () => {
    render(
      <MemoryRouter initialEntries={['/onboarding/reading']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('onboarding-reading-page')).toBeTruthy();
    expect(screen.getByTestId('app-layout-chrome')).toBeTruthy();
  });
});
```

- [ ] **Run:** `bunx vitest run src/App.onboardingReadingRoute.test.tsx`. Expected: FAIL. The route falls through to `NotFoundPage` ("Page not found"), so the reading page's test id is never found.
- [ ] **Implement.** Create the placeholder `src/pages/OnboardingReading.tsx`:

```tsx
import type { ReactElement } from 'react';

export function OnboardingReadingPage(): ReactElement {
  return <main data-testid="onboarding-reading" />;
}

export default OnboardingReadingPage;
```

In `src/App.tsx` after `:41` (`const OnboardingPage = …`) add:

```ts
const OnboardingReadingPage = lazyWithRetry(() => import('./pages/OnboardingReading'), 'OnboardingReading')
```

and after `:145` (`<Route path="/onboarding" …/>`) add:

```tsx
        <Route path="/onboarding/reading" element={storagePage(<OnboardingReadingPage />)} />
```

- [ ] **Run to pass:** same command, plus `bunx vitest run src/App.rootRoute.test.tsx src/App.welcomeRoute.test.tsx`. Expected: all pass.
- [ ] **Commit:** `git add src/App.tsx src/App.onboardingReadingRoute.test.tsx src/pages/OnboardingReading.tsx && git commit -m "feat(app): mount the /onboarding/reading route"`

---

### Task 4.6: Pure cost helpers

**Files:** create `src/lib/readingCost.ts`, `src/lib/readingCost.test.ts`

**Interfaces:**
- Consumes (PR 2): `type CostEstimate = { lowUsd: number; highUsd: number }` from `@almamesh/llm`.
- Produces: `type ReadingCostQuote = { kind: 'hidden' } | { kind: 'free' } | { kind: 'estimate'; lowUsd: number; highUsd: number }`; `interface BalanceView { remainingUsd: number; low: boolean }`; `quoteReadingCost(estimate: CostEstimate | null): ReadingCostQuote`; `balanceView(remainingUsd: number | null, quote: ReadingCostQuote): BalanceView | null`; `formatCostRange(lowUsd: number, highUsd: number): string`; `formatUsd(usd: number, locale: string): string`.

- [ ] **Write the failing test** `src/lib/readingCost.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { balanceView, formatCostRange, formatUsd, quoteReadingCost } from './readingCost';

describe('quoteReadingCost', () => {
  it('hides the line when there is no estimate (no price, unknown model, not OpenRouter)', () => {
    expect(quoteReadingCost(null)).toEqual({ kind: 'hidden' });
  });

  it('says free when the model costs nothing (PR 2 returns 0 / 0)', () => {
    expect(quoteReadingCost({ lowUsd: 0, highUsd: 0 })).toEqual({ kind: 'free' });
  });

  it('passes a real estimate through', () => {
    expect(quoteReadingCost({ lowUsd: 0.05, highUsd: 0.09 })).toEqual({
      kind: 'estimate',
      lowUsd: 0.05,
      highUsd: 0.09,
    });
  });

  it.each([
    [{ lowUsd: -0.01, highUsd: 0.09 }],
    [{ lowUsd: 0.05, highUsd: Number.NaN }],
    [{ lowUsd: 0.05, highUsd: Number.POSITIVE_INFINITY }],
    [{ lowUsd: 0.09, highUsd: 0.05 }],
  ])('never shows a made-up number: %o is hidden', (estimate) => {
    expect(quoteReadingCost(estimate)).toEqual({ kind: 'hidden' });
  });
});

describe('formatCostRange', () => {
  it.each([
    [0.051, 0.089, '5–9¢'],
    [0.06, 0.06, '6¢'],
    [0.001, 0.004, '1¢'],
    [1.2, 2.5, '$1.20–$2.50'],
  ])('%f..%f -> %s', (low, high, want) => {
    expect(formatCostRange(low, high)).toBe(want);
  });
});

describe('balanceView', () => {
  const estimate = { kind: 'estimate', lowUsd: 0.05, highUsd: 0.09 } as const;

  it('is null when the balance is unknown', () => {
    expect(balanceView(null, estimate)).toBeNull();
  });

  it('always shows a known balance; no warning at or above the high end (ruling 8)', () => {
    expect(balanceView(5, estimate)).toEqual({ remainingUsd: 5, low: false });
    expect(balanceView(0.09, estimate)).toEqual({ remainingUsd: 0.09, low: false });
  });

  it('warns only below the high end of the estimate', () => {
    expect(balanceView(0.08, estimate)).toEqual({ remainingUsd: 0.08, low: true });
  });

  it('never warns on a free model or a hidden estimate', () => {
    expect(balanceView(0, { kind: 'free' })).toEqual({ remainingUsd: 0, low: false });
    expect(balanceView(0, { kind: 'hidden' })).toEqual({ remainingUsd: 0, low: false });
  });
});

describe('formatUsd', () => {
  it('formats a balance in US dollars for the UI language', () => {
    expect(formatUsd(4, 'en')).toBe('$4.00');
  });
});
```

- [ ] **Run:** `bunx vitest run src/lib/readingCost.test.ts`. Expected: FAIL, cannot resolve `./readingCost`.
- [ ] **Implement** `src/lib/readingCost.ts`:

```ts
import type { CostEstimate } from '@almamesh/llm';

/** What the cost line shows. `hidden` covers every case with no honest number. */
export type ReadingCostQuote =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'free' }
  | { readonly kind: 'estimate'; readonly lowUsd: number; readonly highUsd: number };

/** The OpenRouter balance as step 3 shows it (ruling 8). */
export interface BalanceView {
  readonly remainingUsd: number;
  /** True only when the balance is below the HIGH end of the estimate. */
  readonly low: boolean;
}

const HIDDEN: ReadingCostQuote = { kind: 'hidden' };

function isUsd(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Turn PR 2's estimate into what the page may say. Never a made-up number. */
export function quoteReadingCost(estimate: CostEstimate | null): ReadingCostQuote {
  if (estimate === null) return HIDDEN;
  const { lowUsd, highUsd } = estimate;
  if (!isUsd(lowUsd) || !isUsd(highUsd) || lowUsd > highUsd) return HIDDEN;
  if (highUsd === 0) return { kind: 'free' };
  return { kind: 'estimate', lowUsd, highUsd };
}

export function balanceView(remainingUsd: number | null, quote: ReadingCostQuote): BalanceView | null {
  if (remainingUsd === null) return null;
  const low = quote.kind === 'estimate' && remainingUsd < quote.highUsd;
  return { remainingUsd, low };
}

/** "5–9¢", "6¢", or "$1.20–$2.50" past a dollar. Low rounds, high rounds up. */
export function formatCostRange(lowUsd: number, highUsd: number): string {
  const lowCents = Math.max(1, Math.round(lowUsd * 100));
  const highCents = Math.max(lowCents, Math.ceil(highUsd * 100 - 1e-9));
  if (highCents >= 100) return `$${lowUsd.toFixed(2)}–$${highUsd.toFixed(2)}`;
  return lowCents === highCents ? `${lowCents}¢` : `${lowCents}–${highCents}¢`;
}

export function formatUsd(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(usd);
}
```

- [ ] **Run to pass:** same command. Expected: all pass.
- [ ] **Commit:** `git add src/lib/readingCost.ts src/lib/readingCost.test.ts && git commit -m "feat(reading): pure cost-quote and balance helpers"`

---

### Task 4.7: OpenRouter-only price and balance lookup, and the cost line

**Files:** create `src/hooks/useReadingCostQuote.ts`, `src/components/features/onboarding/ReadingCostLine.tsx`, `src/components/features/onboarding/ReadingCostLine.test.tsx`

**Interfaces:**
- Consumes (PR 2, `@almamesh/llm`): `estimateReadingCost(messages, pricing, budget): CostEstimate | null`, `READING_OUTPUT_BUDGET`, `type ModelPricing`, `OpenRouterModel.pricing?: ModelPricing`. Existing: `fetchOpenRouterModels`, `fetchOpenRouterCredits`, `resolveProviderConfig`, `OPENROUTER_API_BASE`, `type LlmProviderKind`, `type ChatMessage`, `type ProviderConfig`.
- Produces: `interface ReadingCostInput { kind: LlmProviderKind; modelId: string; messages: readonly (readonly ChatMessage[])[] | null; creditsConfig: ProviderConfig }`; `interface ReadingCostState { quote: ReadingCostQuote; balance: BalanceView | null }`; `useReadingCostQuote(input: ReadingCostInput): ReadingCostState`; `ReadingCostLine(props: ReadingCostInput): ReactElement | null`.

- [ ] **Write the failing test** `src/components/features/onboarding/ReadingCostLine.test.tsx`:

```tsx
import '../../../i18n/config';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { OPENROUTER_API_BASE, resolveProviderConfig, type ChatMessage } from '@almamesh/llm';

import { ReadingCostLine } from './ReadingCostLine';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const MESSAGES: readonly (readonly ChatMessage[])[] = [
  [{ role: 'system', content: 's'.repeat(2_000) }, { role: 'user', content: 'u'.repeat(6_000) }],
];
const CREDITS_CONFIG = resolveProviderConfig({
  VITE_LLM_API_BASE: OPENROUTER_API_BASE,
  VITE_LLM_API_KEY: 'sk-or-test',
  VITE_LLM_MODEL: MODEL,
  VITE_LLM_PRIVACY_MODE: 'cloud_premium',
});

interface CatalogRow {
  readonly id: string;
  readonly name: string;
  readonly pricing?: { readonly prompt: string; readonly completion: string };
}

let requested: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function serve(catalog: readonly CatalogRow[], balance: { total_credits: number; total_usage: number } | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/models')) return json({ data: catalog });
      if (url.endsWith('/credits') && balance) return json({ data: balance });
      return new Response('{"error":{"message":"nope"}}', { status: 500 });
    }),
  );
}

function renderLine(kind: 'openrouter' | 'local' | 'cloud' | 'none' = 'openrouter') {
  return render(<ReadingCostLine kind={kind} modelId={MODEL} messages={MESSAGES} creditsConfig={CREDITS_CONFIG} />);
}

beforeEach(() => {
  requested = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReadingCostLine', () => {
  it('shows the estimate and a known balance, with no warning when the balance covers it', async () => {
    serve([{ id: MODEL, name: 'Flash', pricing: { prompt: '0.0000003', completion: '0.0000012' } }], {
      total_credits: 5,
      total_usage: 1,
    });
    renderLine();
    expect(await screen.findByTestId('reading-cost-line')).toHaveTextContent(
      /^About \d+(–\d+)?¢ on your OpenRouter account\. AlmaMesh charges nothing\.$/,
    );
    expect(await screen.findByTestId('reading-balance')).toHaveTextContent('Your OpenRouter balance: $4.00');
    expect(screen.queryByTestId('reading-balance-low')).toBeNull();
  });

  it('warns only when the balance is below the high end of the estimate', async () => {
    serve([{ id: MODEL, name: 'Flash', pricing: { prompt: '0.0000003', completion: '0.0000012' } }], {
      total_credits: 0.01,
      total_usage: 0.009,
    });
    renderLine();
    expect(await screen.findByTestId('reading-balance-low')).toBeTruthy();
  });

  it('shows no cost line when the configured model is missing from the OpenRouter list (balance still shown)', async () => {
    serve([{ id: 'other/model', name: 'Other', pricing: { prompt: '0.000001', completion: '0.000002' } }], {
      total_credits: 5,
      total_usage: 1,
    });
    renderLine();
    await screen.findByTestId('reading-balance');
    expect(screen.queryByTestId('reading-cost-line')).toBeNull();
  });

  it('says "Free on this model" when pricing is "0" / "0"', async () => {
    serve([{ id: MODEL, name: 'Free', pricing: { prompt: '0', completion: '0' } }], null);
    renderLine();
    expect(await screen.findByTestId('reading-cost-line')).toHaveTextContent(
      'Free on this model. AlmaMesh charges nothing.',
    );
  });

  it.each([
    ['negative', { prompt: '-0.000001', completion: '0.000002' }],
    ['non-numeric', { prompt: 'abc', completion: 'free' }],
  ])('shows no cost line for %s pricing', async (_why, pricing) => {
    serve([{ id: MODEL, name: 'Odd', pricing }], null);
    renderLine();
    await waitFor(() => expect(requested.some((url) => url.endsWith('/models'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('reading-cost-line')).toBeNull();
  });

  it.each(['local', 'cloud', 'none'] as const)(
    'a %s endpoint gets no price lookup, no balance lookup and no cost line',
    async (kind) => {
      serve([{ id: MODEL, name: 'Flash', pricing: { prompt: '0.0000003', completion: '0.0000012' } }], {
        total_credits: 5,
        total_usage: 1,
      });
      const { container } = renderLine(kind);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(requested).toEqual([]);
      expect(container.textContent).toBe('');
    },
  );
});
```

- [ ] **Run:** `bunx vitest run src/components/features/onboarding/ReadingCostLine.test.tsx`. Expected: FAIL, cannot resolve `./ReadingCostLine`.
- [ ] **Implement** `src/hooks/useReadingCostQuote.ts`:

```ts
import { useEffect, useState } from 'react';
import {
  estimateReadingCost,
  fetchOpenRouterCredits,
  fetchOpenRouterModels,
  OPENROUTER_API_BASE,
  READING_OUTPUT_BUDGET,
  resolveProviderConfig,
  type ChatMessage,
  type LlmProviderKind,
  type ModelPricing,
  type ProviderConfig,
} from '@almamesh/llm';
import { safeWarn } from '@almamesh/shared-types';

import { balanceView, quoteReadingCost, type BalanceView, type ReadingCostQuote } from '../lib/readingCost';

export interface ReadingCostInput {
  readonly kind: LlmProviderKind;
  readonly modelId: string;
  /** The nine message arrays the reading WOULD send (null until buildable). */
  readonly messages: readonly (readonly ChatMessage[])[] | null;
  /** The saved interpretation config; its key reads the OpenRouter balance. */
  readonly creditsConfig: ProviderConfig;
}

export interface ReadingCostState {
  readonly quote: ReadingCostQuote;
  readonly balance: BalanceView | null;
}

/** The public catalog read is KEYLESS (as Settings does): no key travels for a price. */
async function loadPricing(modelId: string, signal: AbortSignal): Promise<ModelPricing | null> {
  try {
    const config = resolveProviderConfig({ VITE_LLM_API_BASE: OPENROUTER_API_BASE });
    const catalog = await fetchOpenRouterModels({ config, signal });
    return catalog.find((model) => model.id === modelId)?.pricing ?? null;
  } catch (error) {
    if (!signal.aborted) safeWarn('provider.models_failed', error);
    return null;
  }
}

async function loadBalance(config: ProviderConfig, signal: AbortSignal): Promise<number | null> {
  try {
    return (await fetchOpenRouterCredits({ config, signal })).remaining;
  } catch (error) {
    if (!signal.aborted) safeWarn('provider.credits_failed', error);
    return null;
  }
}

export function useReadingCostQuote({ kind, modelId, messages, creditsConfig }: ReadingCostInput): ReadingCostState {
  const [pricing, setPricing] = useState<ModelPricing | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    // OpenRouter only. A local or other cloud endpoint gets no lookup and no
    // line: never a made-up number, never a request to openrouter.ai.
    if (kind !== 'openrouter') return;
    const controller = new AbortController();
    void loadPricing(modelId, controller.signal).then((found) => {
      if (!controller.signal.aborted) setPricing(found);
    });
    void loadBalance(creditsConfig, controller.signal).then((found) => {
      if (!controller.signal.aborted) setRemaining(found);
    });
    return () => controller.abort();
  }, [kind, modelId, creditsConfig.baseUrl, creditsConfig.apiKey]);

  const estimate =
    kind === 'openrouter' && messages !== null
      ? estimateReadingCost(messages, pricing, READING_OUTPUT_BUDGET)
      : null;
  const quote = quoteReadingCost(estimate);
  return { quote, balance: kind === 'openrouter' ? balanceView(remaining, quote) : null };
}
```

(`creditsConfig` is read inside the effect but keyed on its two identity fields, so a new object with the same values per render does not refetch. Add `// eslint-disable-next-line react-hooks/exhaustive-deps` only if the repo's lint flags it, with that reason.)

`src/components/features/onboarding/ReadingCostLine.tsx`:

```tsx
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { useReadingCostQuote, type ReadingCostInput } from '../../../hooks/useReadingCostQuote';
import { formatCostRange, formatUsd } from '../../../lib/readingCost';

/** Cost line (OpenRouter only), the balance whenever known, and a warning only below the high estimate. */
export function ReadingCostLine(props: ReadingCostInput): ReactElement | null {
  const { t, i18n } = useTranslation('onboarding');
  const { quote, balance } = useReadingCostQuote(props);
  if (quote.kind === 'hidden' && balance === null) return null;
  return (
    <div data-testid="reading-cost" className="space-y-1 text-sm text-text-secondary">
      {quote.kind === 'free' && <p data-testid="reading-cost-line">{t('reading.cost_free')}</p>}
      {quote.kind === 'estimate' && (
        <p data-testid="reading-cost-line">
          {t('reading.cost_estimate', { amount: formatCostRange(quote.lowUsd, quote.highUsd) })}
        </p>
      )}
      {balance !== null && (
        <p data-testid="reading-balance" data-low={balance.low}>
          {t('reading.balance', { amount: formatUsd(balance.remainingUsd, i18n.language) })}
        </p>
      )}
      {balance?.low === true && (
        <p role="status" data-testid="reading-balance-low" className="text-status-warning">
          {t('reading.balance_low')}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Run to pass:** run the same command after Task 4.8 adds the strings. Until then the text assertions fail with raw keys (`reading.cost_free`), which is the expected failure for this step. Expected after 4.8: 9 passed.
- [ ] **Commit:** `git add src/hooks/useReadingCostQuote.ts src/components/features/onboarding/ReadingCostLine.tsx src/components/features/onboarding/ReadingCostLine.test.tsx && git commit -m "feat(reading): OpenRouter-only cost line with balance (never a made-up number)"`

---

### Task 4.8: en / es / pt strings, with the claim copy pinned

**Files:** modify `src/locales/{en,es,pt}/onboarding.json` (new top-level `reading` object, last key after `error`); create `src/locales/onboarding.reading.test.ts`

- [ ] **Write the failing test** `src/locales/onboarding.reading.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import en from './en/onboarding.json';
import es from './es/onboarding.json';
import pt from './pt/onboarding.json';

interface ReadingCopy {
  readonly reading: Record<string, unknown> & {
    readonly cost_estimate: string;
    readonly cost_free: string;
    readonly unlock_line_report: string;
    readonly unlock_line_key: string;
  };
}

const LOCALES: Record<string, { copy: ReadingCopy; chargesNothing: string; free: string }> = {
  en: { copy: en as ReadingCopy, chargesNothing: 'AlmaMesh charges nothing.', free: 'Free on this model.' },
  es: { copy: es as ReadingCopy, chargesNothing: 'AlmaMesh no cobra nada.', free: 'Gratis con este modelo.' },
  pt: { copy: pt as ReadingCopy, chargesNothing: 'O AlmaMesh não cobra nada.', free: 'Grátis neste modelo.' },
};

describe('reading-step copy keeps "free forever" true', () => {
  it('pins the approved English lines exactly', () => {
    const r = (en as ReadingCopy).reading;
    expect(r.cost_estimate).toBe('About {{amount}} on your OpenRouter account. AlmaMesh charges nothing.');
    expect(r.cost_free).toBe('Free on this model. AlmaMesh charges nothing.');
    expect(r.unlock_line_key).toBe(
      'Your key stays on this device. It is sent only to the AI provider you choose, never to us.',
    );
    expect(r.unlock_line_report).toBe(
      "Your reading is a full report: who you are, the period you're in now, the year ahead quarter by quarter, and all seven life areas.",
    );
  });

  it.each(Object.entries(LOCALES))('%s: the provider charges, AlmaMesh does not', (_l, { copy, chargesNothing, free }) => {
    expect(copy.reading.cost_estimate).toContain('{{amount}}');
    expect(copy.reading.cost_estimate).toContain('OpenRouter');
    expect(copy.reading.cost_estimate.endsWith(chargesNothing)).toBe(true);
    expect(copy.reading.cost_free).toBe(`${free} ${chargesNothing}`);
  });

  it.each(Object.entries(LOCALES))('%s: no price, plan or subscription wording anywhere in the step', (_l, { copy }) => {
    const all = JSON.stringify(copy.reading).toLowerCase();
    for (const banned of ['subscription', 'suscripción', 'assinatura', 'premium', 'upgrade', 'plan pro']) {
      expect(all).not.toContain(banned);
    }
  });
});
```

- [ ] **Run:** `bunx vitest run src/locales/onboarding.reading.test.ts`. Expected: FAIL, `Cannot read properties of undefined (reading 'cost_estimate')`.
- [ ] **Implement.** Append to `src/locales/en/onboarding.json` (as the last top-level key; add the comma after the preceding `}`):

```json
  "reading": {
    "unlock_title": "Unlock your reading",
    "unlock_line_report": "Your reading is a full report: who you are, the period you're in now, the year ahead quarter by quarter, and all seven life areas.",
    "unlock_line_key": "Your key stays on this device. It is sent only to the AI provider you choose, never to us.",
    "skip": "Skip for now",
    "title": "Your reading",
    "outline_heading": "What your report contains",
    "chapters": {
      "overview": "Overview: who you are",
      "current_period": "Your current period",
      "year_ahead": "The year ahead",
      "life_areas": "Life areas: all seven",
      "remedies": "Remedies and guidance"
    },
    "chapter_status": {
      "idle": "Not started",
      "writing": "Writing",
      "written": "Written",
      "failed": "Not written",
      "waiting_timing": "Waiting for your timing data"
    },
    "model": "Written by {{model}}",
    "cost_estimate": "About {{amount}} on your OpenRouter account. AlmaMesh charges nothing.",
    "cost_free": "Free on this model. AlmaMesh charges nothing.",
    "balance": "Your OpenRouter balance: {{amount}}",
    "balance_low": "That may be more than your balance. Add credits on OpenRouter, or pick a cheaper model in Settings.",
    "get": "Get my reading",
    "go_dashboard": "Go to dashboard",
    "retry": "Retry",
    "retry_failed": "Retry failed sections",
    "timing_loading": "Working out your timing data on this device.",
    "timing_failed": "Your timing data could not be worked out on this device, so the timing chapters will not be written. The rest of your reading is unaffected.",
    "ready": "Your reading is ready. It is saved on your dashboard."
  }
```

`src/locales/es/onboarding.json`:

```json
  "reading": {
    "unlock_title": "Desbloquea tu lectura",
    "unlock_line_report": "Tu lectura es un informe completo: quién eres, el periodo en el que estás ahora, el año que viene trimestre a trimestre y las siete áreas de la vida.",
    "unlock_line_key": "Tu clave se queda en este dispositivo. Solo se envía al proveedor de IA que elijas, nunca a nosotros.",
    "skip": "Omitir por ahora",
    "title": "Tu lectura",
    "outline_heading": "Qué contiene tu informe",
    "chapters": {
      "overview": "Resumen: quién eres",
      "current_period": "Tu periodo actual",
      "year_ahead": "El año que viene",
      "life_areas": "Áreas de la vida: las siete",
      "remedies": "Remedios y orientación"
    },
    "chapter_status": {
      "idle": "Sin empezar",
      "writing": "Escribiendo",
      "written": "Escrito",
      "failed": "No escrito",
      "waiting_timing": "Esperando tus datos de tiempos"
    },
    "model": "Escrito por {{model}}",
    "cost_estimate": "Unos {{amount}} en tu cuenta de OpenRouter. AlmaMesh no cobra nada.",
    "cost_free": "Gratis con este modelo. AlmaMesh no cobra nada.",
    "balance": "Tu saldo en OpenRouter: {{amount}}",
    "balance_low": "Puede superar tu saldo. Añade crédito en OpenRouter o elige un modelo más barato en Ajustes.",
    "get": "Obtener mi lectura",
    "go_dashboard": "Ir al panel",
    "retry": "Reintentar",
    "retry_failed": "Reintentar las secciones fallidas",
    "timing_loading": "Calculando tus datos de tiempos en este dispositivo.",
    "timing_failed": "No se pudieron calcular tus datos de tiempos en este dispositivo, así que los capítulos de tiempos no se escribirán. El resto de tu lectura no se ve afectado.",
    "ready": "Tu lectura está lista. Está guardada en tu panel."
  }
```

`src/locales/pt/onboarding.json`:

```json
  "reading": {
    "unlock_title": "Desbloqueie sua leitura",
    "unlock_line_report": "Sua leitura é um relatório completo: quem você é, o período em que você está agora, o ano que vem trimestre a trimestre e as sete áreas da vida.",
    "unlock_line_key": "Sua chave fica neste dispositivo. Ela é enviada apenas ao provedor de IA que você escolher, nunca para nós.",
    "skip": "Pular por agora",
    "title": "Sua leitura",
    "outline_heading": "O que seu relatório contém",
    "chapters": {
      "overview": "Visão geral: quem você é",
      "current_period": "Seu período atual",
      "year_ahead": "O ano que vem",
      "life_areas": "Áreas da vida: todas as sete",
      "remedies": "Remédios e orientação"
    },
    "chapter_status": {
      "idle": "Não iniciado",
      "writing": "Escrevendo",
      "written": "Escrito",
      "failed": "Não escrito",
      "waiting_timing": "Aguardando seus dados de tempo"
    },
    "model": "Escrito por {{model}}",
    "cost_estimate": "Cerca de {{amount}} na sua conta do OpenRouter. O AlmaMesh não cobra nada.",
    "cost_free": "Grátis neste modelo. O AlmaMesh não cobra nada.",
    "balance": "Seu saldo no OpenRouter: {{amount}}",
    "balance_low": "Isso pode passar do seu saldo. Adicione créditos no OpenRouter ou escolha um modelo mais barato em Configurações.",
    "get": "Obter minha leitura",
    "go_dashboard": "Ir para o painel",
    "retry": "Tentar de novo",
    "retry_failed": "Tentar de novo as seções que falharam",
    "timing_loading": "Calculando seus dados de tempo neste dispositivo.",
    "timing_failed": "Não foi possível calcular seus dados de tempo neste dispositivo, então os capítulos de tempo não serão escritos. O resto da sua leitura não é afetado.",
    "ready": "Sua leitura está pronta. Ela está salva no seu painel."
  }
```

- [ ] **Run to pass:** `bunx vitest run src/locales/onboarding.reading.test.ts src/locales/onboarding.parity.test.ts src/components/features/onboarding/ReadingCostLine.test.tsx && node scripts/verify-i18n.mjs`. Expected: all pass. Parity holds and placeholders match.
- [ ] **Commit:** `git add src/locales/en/onboarding.json src/locales/es/onboarding.json src/locales/pt/onboarding.json src/locales/onboarding.reading.test.ts && git commit -m "feat(i18n): reading-step copy in en/es/pt, free-forever wording pinned"`

---

### Task 4.9: Chapter predicates, outline, and the unlock step

**Files:** create `src/lib/readingChapters.ts`, `src/lib/readingChapters.test.ts`, `src/components/features/onboarding/ReadingOutline.tsx`, `src/components/features/onboarding/ReadingUnlockStep.tsx`

**Interfaces:**
- Consumes (PR 3): `type ChapterId`, `type ChapterStatus`, `interface ReportChapter` from `hooks/useStreamingInterpretation.ts`. (PR 1): `AiSetupPanel`, `AiSetupPanelProps`. Existing: `type LlmStatus`.
- Produces: `CHAPTER_IDS: readonly ChapterId[]`; `chapterStatus(chapters, id): ChapterStatus`; `isChapterRunning(c): boolean`; `hasFailedChapter(chapters): boolean`; `hasWrittenChapter(chapters): boolean`; `isReportComplete(chapters): boolean`; `ReadingOutline({ chapters })`; `ReadingUnlockStep({ onConnected })`.

- [ ] **Write the failing test** `src/lib/readingChapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { ReportChapter } from '../hooks/useStreamingInterpretation';
import {
  CHAPTER_IDS,
  chapterStatus,
  hasFailedChapter,
  hasWrittenChapter,
  isChapterRunning,
  isReportComplete,
} from './readingChapters';

const all = (status: ReportChapter['status']): ReportChapter[] => CHAPTER_IDS.map((id) => ({ id, status }));

describe('reading chapters', () => {
  it('names the five chapters in reading order', () => {
    expect(CHAPTER_IDS).toEqual(['overview', 'current_period', 'year_ahead', 'life_areas', 'remedies']);
  });

  it('a report is complete only when every chapter is written', () => {
    expect(isReportComplete(all('written'))).toBe(true);
    expect(isReportComplete([])).toBe(false);
    expect(isReportComplete([...all('written').slice(1), { id: 'overview', status: 'failed' }])).toBe(false);
  });

  it('writing and waiting for timing data both count as running', () => {
    expect(isChapterRunning({ id: 'overview', status: 'writing' })).toBe(true);
    expect(isChapterRunning({ id: 'year_ahead', status: 'waiting_timing' })).toBe(true);
    expect(isChapterRunning({ id: 'overview', status: 'written' })).toBe(false);
  });

  it('finds failed and written chapters, and defaults a missing chapter to idle', () => {
    expect(hasFailedChapter([{ id: 'remedies', status: 'failed' }])).toBe(true);
    expect(hasWrittenChapter([{ id: 'remedies', status: 'written' }])).toBe(true);
    expect(chapterStatus([], 'life_areas')).toBe('idle');
  });
});
```

- [ ] **Run:** `bunx vitest run src/lib/readingChapters.test.ts`. Expected: FAIL, cannot resolve `./readingChapters`.
- [ ] **Implement** `src/lib/readingChapters.ts`:

```ts
import type { ChapterId, ChapterStatus, ReportChapter } from '../hooks/useStreamingInterpretation';

export const CHAPTER_IDS: readonly ChapterId[] = [
  'overview',
  'current_period',
  'year_ahead',
  'life_areas',
  'remedies',
];

export function chapterStatus(chapters: readonly ReportChapter[], id: ChapterId): ChapterStatus {
  return chapters.find((chapter) => chapter.id === id)?.status ?? 'idle';
}

export function isChapterRunning(chapter: ReportChapter): boolean {
  return chapter.status === 'writing' || chapter.status === 'waiting_timing';
}

export function hasFailedChapter(chapters: readonly ReportChapter[]): boolean {
  return chapters.some((chapter) => chapter.status === 'failed');
}

export function hasWrittenChapter(chapters: readonly ReportChapter[]): boolean {
  return chapters.some((chapter) => chapter.status === 'written');
}

export function isReportComplete(chapters: readonly ReportChapter[]): boolean {
  return chapters.length > 0 && chapters.every((chapter) => chapter.status === 'written');
}
```

`src/components/features/onboarding/ReadingOutline.tsx`:

```tsx
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import type { ReportChapter } from '../../../hooks/useStreamingInterpretation';
import { CHAPTER_IDS, chapterStatus } from '../../../lib/readingChapters';

export interface ReadingOutlineProps {
  readonly chapters: readonly ReportChapter[];
}

/** The five chapters and where each one is. Shown before and during the run. */
export function ReadingOutline({ chapters }: ReadingOutlineProps): ReactElement {
  const { t } = useTranslation('onboarding');
  return (
    <section aria-labelledby="reading-outline-heading" className="rounded-lg border border-ui-border p-4">
      <h2 id="reading-outline-heading" className="mb-3 text-sm font-medium text-text-primary">
        {t('reading.outline_heading')}
      </h2>
      <ol className="space-y-2">
        {CHAPTER_IDS.map((id) => {
          const status = chapterStatus(chapters, id);
          return (
            <li
              key={id}
              data-testid={`reading-outline-${id}`}
              data-status={status}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="text-text-primary">{t(`reading.chapters.${id}`)}</span>
              <span className="text-xs text-text-muted">{t(`reading.chapter_status.${status}`)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
```

`src/components/features/onboarding/ReadingUnlockStep.tsx`:

```tsx
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LlmStatus } from '@almamesh/llm';

import { AiSetupPanel } from '../ai/AiSetupPanel';

export interface ReadingUnlockStepProps {
  /** Fired by the panel only after a passing key test has been saved to SQLite. */
  readonly onConnected: (status: LlmStatus) => void;
}

/** Step 2: the one shared AI setup panel, two lines of copy, and a way out. */
export function ReadingUnlockStep({ onConnected }: ReadingUnlockStepProps): ReactElement {
  const { t } = useTranslation('onboarding');
  return (
    <section data-testid="reading-unlock" className="flex flex-col gap-5">
      <h1 className="font-display text-2xl text-text-primary">{t('reading.unlock_title')}</h1>
      <AiSetupPanel
        showOffChoice={false}
        onConnected={onConnected}
        intro={
          <div className="space-y-2 text-sm text-text-secondary">
            <p>{t('reading.unlock_line_report')}</p>
            <p>{t('reading.unlock_line_key')}</p>
          </div>
        }
      />
      <Link
        to="/dashboard"
        data-testid="reading-skip"
        className="w-fit text-sm text-text-secondary underline underline-offset-4"
      >
        {t('reading.skip')}
      </Link>
    </section>
  );
}
```

- [ ] **Run to pass:** `bunx vitest run src/lib/readingChapters.test.ts`. Expected: 4 passed. (The two components are covered in Task 4.10.)
- [ ] **Commit:** `git add src/lib/readingChapters.ts src/lib/readingChapters.test.ts src/components/features/onboarding/ReadingOutline.tsx src/components/features/onboarding/ReadingUnlockStep.tsx && git commit -m "feat(reading): chapter predicates, outline, and the unlock step"`

---

### Task 4.10: The reading page (guards, your-reading step, one trigger)

**Files:** create `src/hooks/useReadingEstimateMessages.ts`, `src/components/features/onboarding/YourReadingStep.tsx`, `src/pages/__tests__/OnboardingReading.test.tsx`; replace the placeholder `src/pages/OnboardingReading.tsx`

**Interfaces:**
- Consumes (PR 3): `useStreamingInterpretation(chartId)` → `{ startReading(): void; refreshTimeline(): void; retryFailed(): void; timelineQueued; chapters: readonly ReportChapter[]; interpretation; currentTimeline; errorKind; timelineErrorKind }` (one instance, owned by the page); `ReadingReport({ chartId, reading: { interpretation, currentTimeline, chapters }, audience: ReportAudience, variant: 'onboarding', onGetFullYearAhead?, onRetryFailed? })`. (PR 2): `buildReportMessages`, `usesLitePrompt`. Existing: `storedChartAnalysisInstant`. Existing: `usePredictiveLayer({ auto: true })`, `describeLlmStatus`, `useLlmStatus`, `resolveInterpretationConfig`, `withRawPredictive`, `selectPrimaryStoredChart`, `NarrationUnavailable`, `resolveReportAudience`, `useContentModeStore`, `toPromptLanguage`.
- Produces: `OnboardingReadingPage(): ReactElement` (named + default export); `YourReadingStep(props: YourReadingStepProps)`; `useReadingEstimateMessages(input: ReadingEstimateInput /* { chart, chartId, predictiveStatus, contentMode, config } */): readonly (readonly ChatMessage[])[] | null`. The root carries `data-testid="onboarding-reading"`, `data-step="unlock" | "reading"` and `data-predictive-status`.

- [ ] **Write the failing test** `src/pages/__tests__/OnboardingReading.test.tsx`:

```tsx
import '../../i18n/config';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { hydrateLlmSettings } from '@almamesh/llm';
import { useChartLibraryStore, useProfilesStore } from '@almamesh/store';

import type { ReportChapter, UseStreamingInterpretationResult } from '../../hooks/useStreamingInterpretation';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const IDS = ['overview', 'current_period', 'year_ahead', 'life_areas', 'remedies'] as const;

const hook = vi.hoisted(() => ({
  startReading: vi.fn(),
  retryFailed: vi.fn(),
  chapters: [] as ReportChapter[],
  errorKind: null as string | null,
  timelineErrorKind: null as string | null,
}));
const predictive = vi.hoisted(() => ({ status: 'loading', options: [] as unknown[] }));

vi.mock('../../hooks/useStreamingInterpretation', async (orig) => {
  const actual = await orig<typeof import('../../hooks/useStreamingInterpretation')>();
  return {
    ...actual,
    useStreamingInterpretation: () =>
      ({
        startReading: hook.startReading,
        retryFailed: hook.retryFailed,
        chapters: hook.chapters,
        interpretation: undefined,
        currentTimeline: undefined,
        errorKind: hook.errorKind,
        timelineErrorKind: hook.timelineErrorKind,
      }) as unknown as UseStreamingInterpretationResult,
  };
});
vi.mock('../../hooks/usePredictiveLayer', () => ({
  usePredictiveLayer: (options: unknown) => {
    predictive.options.push(options);
    return { status: predictive.status };
  },
}));
vi.mock('../../components/features/dashboard/ReadingReport', () => ({
  ReadingReport: ({ variant, chartId, reading }: { variant: string; chartId: string; reading: { chapters: unknown[] } }) => (
    <div data-testid="reading-report" data-variant={variant} data-chart-id={chartId} data-chapters={reading.chapters.length} />
  ),
}));
vi.mock('../../components/features/ai/AiSetupPanel', () => ({
  AiSetupPanel: ({
    onConnected,
    intro,
    showOffChoice,
  }: {
    onConnected?: (status: { kind: string; label: string; configured: boolean }) => void;
    intro?: React.ReactNode;
    showOffChoice?: boolean;
  }) => (
    <div data-testid="ai-setup-panel" data-show-off={String(showOffChoice)}>
      {intro}
      <button
        data-testid="stub-connect"
        onClick={() => {
          hydrateLlmSettings(JSON.stringify(OPENROUTER));
          onConnected?.({ kind: 'openrouter', label: 'OpenRouter', configured: true });
        }}
      >
        connect
      </button>
    </div>
  ),
}));
const builder = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@almamesh/llm', async (orig) => {
  const actual = await orig<typeof import('@almamesh/llm')>();
  return {
    ...actual,
    buildReportMessages: (...args: unknown[]) => {
      builder.calls.push(args);
      return { core: [{ role: 'user', content: 'x'.repeat(8_000) }] };
    },
  };
});
// The seeded chart is a stub; pin the analysis instant the hook and the estimate share.
vi.mock('../../lib/analysisInstant', async (orig) => ({
  ...(await orig<typeof import('../../lib/analysisInstant')>()),
  storedChartAnalysisInstant: () => ({ instant: '2026-10-10T00:00:00Z' }),
}));

import OnboardingReadingPage from '../OnboardingReading';

const OPENROUTER = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  model: MODEL,
  interpretationModel: MODEL,
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};

let requested: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function completionRequests(): string[] {
  return requested.filter((url) => url.endsWith('/chat/completions'));
}

function chapters(status: ReportChapter['status']): ReportChapter[] {
  return IDS.map((id) => ({ id, status }));
}

function seedChart(): void {
  useProfilesStore.setState({
    activeProfileId: 'p1',
    profiles: { p1: { id: 'p1', name: 'Asha', createdAt: '2026-01-01T00:00:00Z', avatarTint: '#888888' } as never },
  });
  useChartLibraryStore.setState({
    charts: { c1: { chart_id: 'c1', profile_id: 'p1', is_primary: true, person_name: 'Asha', sidereal_chart: {} } as never },
  });
}

function renderAt(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/onboarding/reading', state }]}>
      <Routes>
        <Route path="/onboarding/reading" element={<OnboardingReadingPage />} />
        <Route path="/onboarding" element={<div data-testid="onboarding-page" />} />
        <Route path="/dashboard" element={<div data-testid="dashboard-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  requested = [];
  hook.startReading.mockReset();
  hook.retryFailed.mockReset();
  hook.chapters = chapters('idle');
  hook.errorKind = null;
  hook.timelineErrorKind = null;
  predictive.status = 'loading';
  predictive.options = [];
  hydrateLlmSettings(JSON.stringify(OPENROUTER));
  seedChart();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/models')) {
        return json({ data: [{ id: MODEL, name: 'Flash', pricing: { prompt: '0.0000003', completion: '0.0000012' } }] });
      }
      if (url.endsWith('/credits')) return json({ data: { total_credits: 5, total_usage: 1 } });
      return new Response('unexpected', { status: 500 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  hydrateLlmSettings(null);
  useChartLibraryStore.setState({ charts: {} });
});

describe('OnboardingReading — entry guards', () => {
  it('sends a visitor with no saved chart to /onboarding', async () => {
    useChartLibraryStore.setState({ charts: {} });
    renderAt();
    expect(await screen.findByTestId('onboarding-page')).toBeTruthy();
  });

  it('sends a person whose complete report is already stored to /dashboard', async () => {
    hook.chapters = chapters('written');
    renderAt();
    expect(await screen.findByTestId('dashboard-page')).toBeTruthy();
  });

  it('shows the unlock step when no AI is configured: shared panel, no "off" choice, the two lines, and Skip', async () => {
    hydrateLlmSettings(null);
    renderAt();
    expect(screen.getByTestId('onboarding-reading').getAttribute('data-step')).toBe('unlock');
    expect(screen.getByTestId('ai-setup-panel').getAttribute('data-show-off')).toBe('false');
    expect(screen.getByText(/Your key stays on this device/)).toBeTruthy();
    expect(screen.getByText(/the year ahead quarter by quarter/)).toBeTruthy();
    expect(screen.getByTestId('reading-skip').getAttribute('href')).toBe('/dashboard');

    fireEvent.click(screen.getByTestId('stub-connect'));
    expect(await screen.findByTestId('reading-get')).toBeTruthy();
    expect(screen.getByTestId('onboarding-reading').getAttribute('data-step')).toBe('reading');
  });

  it('derives the step from stored data, never from location.state, and sends nothing on load', async () => {
    // A reload or a pasted URL has no state; a stale or crafted state must not matter.
    for (const state of [undefined, { step: 'unlock' }, { from: 'onboarding', next: '/onboarding/reading' }]) {
      renderAt(state);
      expect(screen.getByTestId('onboarding-reading').getAttribute('data-step')).toBe('reading');
      cleanup();
    }
    hydrateLlmSettings(null);
    renderAt({ step: 'reading' });
    expect(screen.getByTestId('onboarding-reading').getAttribute('data-step')).toBe('unlock');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completionRequests()).toEqual([]);
    expect(hook.startReading).not.toHaveBeenCalled();
  });

  it('starts the local predictive compute on mount', () => {
    renderAt();
    expect(predictive.options[0]).toEqual({ auto: true });
    expect(screen.getByTestId('onboarding-reading').getAttribute('data-predictive-status')).toBe('loading');
  });
});

describe('OnboardingReading — your reading', () => {
  it('sends nothing until Get my reading', async () => {
    renderAt();
    await screen.findByTestId('reading-cost-line');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hook.startReading).not.toHaveBeenCalled();
    expect(completionRequests()).toEqual([]);
    // The only network calls before the tap: the OpenRouter price and balance reads.
    expect(requested.every((url) => /^https:\/\/openrouter\.ai\/api\/v1\/(models|credits)$/.test(url))).toBe(true);

    fireEvent.click(screen.getByTestId('reading-get'));
    expect(hook.startReading).toHaveBeenCalledTimes(1);
  });

  it('estimates from the same instant, voice and lite flag the hook will send with (nothing sent)', () => {
    builder.calls = [];
    renderAt();
    const [input, opts] = builder.calls[0] as [{ asOf: unknown }, { mode: string; lite: boolean; language: string }];
    expect(input.asOf).toEqual({ instant: '2026-10-10T00:00:00Z' });
    expect(opts).toEqual({ mode: 'layman', language: 'en', lite: false });
    expect(completionRequests()).toEqual([]);
  });

  it('shows the outline, the model, and the disclosure line above the button', async () => {
    renderAt();
    for (const id of IDS) expect(screen.getByTestId(`reading-outline-${id}`)).toBeTruthy();
    expect(screen.getByTestId('reading-model').textContent).toBe(`Written by ${MODEL}`);
    const disclosure = screen.getByTestId('reading-disclosure');
    // The panel's own disclosure (settings:tiers.cloud_body, PR 1's tier-cloud-honesty), repeated above the button.
    expect(disclosure.textContent).toMatch(/without your name or birth date.*can reveal your birth date/);
    const button = screen.getByTestId('reading-get');
    expect(disclosure.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['idle', 'writing', 'waiting_timing', 'failed', 'written'] as const)(
    'dashboard link is always available (chapters %s)',
    (status) => {
      hook.chapters = [{ id: 'overview', status: 'written' }, ...IDS.slice(1).map((id) => ({ id, status }))];
      renderAt();
      expect(screen.getByTestId('reading-go-dashboard').getAttribute('href')).toBe('/dashboard');
    },
  );

  it('streams into the onboarding variant of the report once started', () => {
    hook.chapters = [{ id: 'overview', status: 'writing' }, ...IDS.slice(1).map((id) => ({ id, status: 'idle' as const }))];
    renderAt();
    const report = screen.getByTestId('reading-report');
    expect(report.getAttribute('data-variant')).toBe('onboarding');
    // The page owns the ONE hook instance (useSingleFlight is per instance) and passes its data in.
    expect(report.getAttribute('data-chart-id')).toBe('c1');
    expect(report.getAttribute('data-chapters')).toBe('5');
    expect(screen.queryByTestId('reading-get')).toBeNull();
  });

  it('402: the dashboard credits message, Retry and Go to dashboard; written sections kept', () => {
    hook.errorKind = 'credits';
    hook.chapters = [{ id: 'overview', status: 'written' }, ...IDS.slice(1).map((id) => ({ id, status: 'failed' as const }))];
    renderAt();
    expect(screen.getByTestId('reading-credits')).toBeTruthy();
    expect(screen.getByTestId('reading-report')).toBeTruthy();
    expect(screen.getByTestId('reading-go-dashboard')).toBeTruthy();
    fireEvent.click(screen.getByTestId('reading-retry'));
    expect(hook.retryFailed).toHaveBeenCalledTimes(1);
    expect(hook.startReading).not.toHaveBeenCalled();
  });

  it('any other failure: failed sections marked, Retry failed sections, the rest kept', () => {
    hook.errorKind = 'server';
    hook.chapters = [...IDS.slice(0, 4).map((id) => ({ id, status: 'written' as const })), { id: 'remedies', status: 'failed' }];
    renderAt();
    expect(screen.getByTestId('reading-outline-remedies').getAttribute('data-status')).toBe('failed');
    fireEvent.click(screen.getByTestId('reading-retry-failed'));
    expect(hook.retryFailed).toHaveBeenCalledTimes(1);
  });

  it('predictive failure: says the timing chapters will not run, and offers the dashboard', () => {
    predictive.status = 'error';
    renderAt();
    expect(screen.getByTestId('reading-timing-failed')).toBeTruthy();
    expect(screen.getByTestId('reading-go-dashboard')).toBeTruthy();
  });
});
```

- [ ] **Run:** `bunx vitest run src/pages/__tests__/OnboardingReading.test.tsx`. Expected: FAIL. The placeholder page renders an empty `<main>`, so the `data-step` / `reading-*` lookups fail (`Unable to find an element by: [data-testid="reading-get"]`, `data-step` is `null`).
- [ ] **Implement** `src/hooks/useReadingEstimateMessages.ts`. This is the single seam onto PR 2's builder. It passes the same `asOf`, `mode` and `lite` the hook passes at `useStreamingInterpretation.ts:532-534`:

```ts
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { buildReportMessages, usesLitePrompt, type ChatMessage, type ProviderConfig } from '@almamesh/llm';
import type { ContentMode, PredictiveStatus, StoredChart } from '@almamesh/store';

import { toPromptLanguage } from '../components/features/rectify/rectifyLlmConfig';
import { storedChartAnalysisInstant } from '../lib/analysisInstant';
import { withRawPredictive } from './useStreamingInterpretation';

export interface ReadingEstimateInput {
  readonly chart: StoredChart;
  readonly chartId: string;
  readonly predictiveStatus: PredictiveStatus;
  /** The For You / For Astrologer toggle; the Dashboard maps 'technical' to the hook's 'expert'. */
  readonly contentMode: ContentMode;
  /** resolveInterpretationConfig(): decides lite (local endpoint) exactly as the hook does. */
  readonly config: ProviderConfig;
}

/**
 * The nine message arrays the reading WOULD send, built locally for the cost
 * estimate with the same instant, voice and lite flag the hook will use.
 * Building them sends nothing. Re-built when the predictive layer lands,
 * because the timing sections then carry its sliced facts.
 */
export function useReadingEstimateMessages({
  chart,
  chartId,
  predictiveStatus,
  contentMode,
  config,
}: ReadingEstimateInput): readonly (readonly ChatMessage[])[] | null {
  const { i18n } = useTranslation();
  const lite = usesLitePrompt(config);
  return useMemo(() => {
    const sidereal = chart.sidereal_chart;
    if (!sidereal) return null;
    const messages = buildReportMessages(
      { chart: withRawPredictive(sidereal, chartId), asOf: storedChartAnalysisInstant(chart) },
      {
        mode: contentMode === 'technical' ? 'expert' : 'layman',
        language: toPromptLanguage(i18n.language),
        lite,
      },
    );
    return Object.values(messages);
    // predictiveStatus is a dependency on purpose: withRawPredictive reads the store.
  }, [chart, chartId, predictiveStatus, contentMode, lite, i18n.language]);
}
```

`src/components/features/onboarding/YourReadingStep.tsx` (the `react` import line and the `<DashboardLink />` line are mutation anchors in Task 4.13; keep them byte-exact):

```tsx
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useContentModeStore, type PredictiveStatus, type StoredChart } from '@almamesh/store';

import { useLlmStatus } from '../../../hooks/useLlmStatus';
import { useReadingEstimateMessages } from '../../../hooks/useReadingEstimateMessages';
import {
  resolveInterpretationConfig,
  type UseStreamingInterpretationResult,
} from '../../../hooks/useStreamingInterpretation';
import {
  hasFailedChapter,
  hasWrittenChapter,
  isChapterRunning,
  isReportComplete,
} from '../../../lib/readingChapters';
import { resolveReportAudience } from '../../../lib/reportSelectors';
import { NarrationUnavailable } from '../dashboard/NarrationUnavailable';
import { ReadingReport } from '../dashboard/ReadingReport';
import { ReadingCostLine } from './ReadingCostLine';
import { ReadingOutline } from './ReadingOutline';

export interface YourReadingStepProps {
  readonly chart: StoredChart;
  readonly chartId: string;
  readonly reading: UseStreamingInterpretationResult;
  readonly predictiveStatus: PredictiveStatus;
}

function DashboardLink(): ReactElement {
  const { t } = useTranslation('onboarding');
  return (
    <Link
      to="/dashboard"
      data-testid="reading-go-dashboard"
      className="text-sm text-text-secondary underline underline-offset-4"
    >
      {t('reading.go_dashboard')}
    </Link>
  );
}

function TimingNotice({ status }: { readonly status: PredictiveStatus }): ReactElement | null {
  const { t } = useTranslation('onboarding');
  if (status === 'loading') {
    return <p data-testid="reading-timing-loading" className="text-xs text-text-muted">{t('reading.timing_loading')}</p>;
  }
  if (status === 'error') {
    return (
      <p data-testid="reading-timing-failed" role="status" className="text-sm text-text-secondary">
        {t('reading.timing_failed')}
      </p>
    );
  }
  return null;
}

function ReadingFailure({ reading }: { readonly reading: UseStreamingInterpretationResult }): ReactElement | null {
  const { t } = useTranslation('onboarding');
  if (!hasFailedChapter(reading.chapters)) return null;
  const creditsOut = reading.errorKind === 'credits' || reading.timelineErrorKind === 'credits';
  const retry = (
    <button
      type="button"
      data-testid={creditsOut ? 'reading-retry' : 'reading-retry-failed'}
      onClick={reading.retryFailed}
      className="rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-primary"
    >
      {t(creditsOut ? 'reading.retry' : 'reading.retry_failed')}
    </button>
  );
  if (!creditsOut) return <div data-testid="reading-failed">{retry}</div>;
  return (
    <NarrationUnavailable
      outage="credits"
      context={hasWrittenChapter(reading.chapters) ? 'kept' : 'fresh'}
      actions={retry}
      testId="reading-credits"
    />
  );
}

/** Step 3. The ONLY trigger for a paid call is the "Get my reading" click. */
export function YourReadingStep({ chart, chartId, reading, predictiveStatus }: YourReadingStepProps): ReactElement {
  const { t } = useTranslation(['onboarding', 'settings']);
  const status = useLlmStatus();
  const config = resolveInterpretationConfig();
  const contentMode = useContentModeStore((s) => s.contentMode);
  const audience = resolveReportAudience(contentMode);
  const messages = useReadingEstimateMessages({ chart, chartId, predictiveStatus, contentMode, config });
  const { chapters, startReading } = reading;
  const running = chapters.some(isChapterRunning);
  const started = chapters.some((chapter) => chapter.status !== 'idle');
  const canStart = !running && !isReportComplete(chapters) && !hasFailedChapter(chapters);
  return (
    <section data-testid="your-reading" className="flex flex-col gap-5">
      <h1 className="font-display text-2xl text-text-primary">{t('reading.title')}</h1>
      <ReadingOutline chapters={chapters} />
      <p data-testid="reading-model" className="text-sm text-text-secondary">
        {t('reading.model', { model: config.model })}
      </p>
      <ReadingCostLine kind={status.kind} modelId={config.model} messages={messages} creditsConfig={config} />
      <TimingNotice status={predictiveStatus} />
      <p data-testid="reading-disclosure" className="text-xs text-text-muted">
        {t('settings:tiers.cloud_body')}
      </p>
      {!running && <ReadingFailure reading={reading} />}
      {isReportComplete(chapters) && <p data-testid="reading-ready">{t('reading.ready')}</p>}
      <div className="flex flex-wrap items-center gap-4">
        {canStart && (
          <button
            type="button"
            data-testid="reading-get"
            onClick={startReading}
            className="rounded-lg bg-accent-gold px-6 py-2 text-sm font-medium text-background-primary"
          >
            {t('reading.get')}
          </button>
        )}
        <DashboardLink />
      </div>
      {started && (
        <ReadingReport
          chartId={chartId}
          reading={{
            interpretation: reading.interpretation,
            currentTimeline: reading.currentTimeline,
            chapters: reading.chapters,
          }}
          audience={audience}
          variant="onboarding"
        />
      )}
    </section>
  );
}
```

(Check `useContentModeStore` from `@almamesh/store` supports a selector, as `stores/contentMode.ts` re-exports it. If it does not, use `useContentModeStore().contentMode`, as `Dashboard.tsx:118` does.)

Replace `src/pages/OnboardingReading.tsx`:

```tsx
import { useState, type ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { describeLlmStatus } from '@almamesh/llm';
import { useChartLibraryStore, useProfilesStore } from '@almamesh/store';

import { ReadingUnlockStep } from '../components/features/onboarding/ReadingUnlockStep';
import { YourReadingStep } from '../components/features/onboarding/YourReadingStep';
import { usePredictiveLayer } from '../hooks/usePredictiveLayer';
import { useStreamingInterpretation } from '../hooks/useStreamingInterpretation';
import { selectPrimaryStoredChart } from '../lib/predictive';
import { isReportComplete } from '../lib/readingChapters';

/**
 * `/onboarding/reading`: the step after the chart. Reached from onboarding,
 * from Rectify, or by reload or pasted URL. It decides everything from STORED
 * data (chart library, interpretation store, saved AI settings), never from
 * navigation state, so every way in lands on the same screen.
 */
export function OnboardingReadingPage(): ReactElement {
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const charts = useChartLibraryStore((s) => s.charts);
  const chart = selectPrimaryStoredChart(charts, activeProfileId);
  const chartId = chart?.chart_id ?? null;
  // Fully local (~30 s under Pyodide): started on mount so the timing data is
  // usually ready by the time the person has read the outline.
  const predictive = usePredictiveLayer({ auto: true });
  const reading = useStreamingInterpretation(chartId);
  // Decided ONCE at entry: a report finishing on this page must not bounce the
  // person away, and saving settings without a passing key test must not skip step 2.
  const [entry] = useState(() => ({
    complete: isReportComplete(reading.chapters),
    configured: describeLlmStatus().configured,
  }));
  const [connected, setConnected] = useState(false);

  if (!chart || !chartId) return <Navigate to="/onboarding" replace />;
  if (entry.complete) return <Navigate to="/dashboard" replace />;
  const step = entry.configured || connected ? 'reading' : 'unlock';
  return (
    <main
      data-testid="onboarding-reading"
      data-step={step}
      data-predictive-status={predictive.status}
      className="mx-auto max-w-2xl px-4 py-8"
    >
      {step === 'unlock' ? (
        <ReadingUnlockStep onConnected={() => setConnected(true)} />
      ) : (
        <YourReadingStep chart={chart} chartId={chartId} reading={reading} predictiveStatus={predictive.status} />
      )}
    </main>
  );
}

export default OnboardingReadingPage;
```

- [ ] **Run to pass:** `bunx vitest run src/pages/__tests__/OnboardingReading.test.tsx src/components/features/onboarding src/lib/readingChapters.test.ts src/lib/readingCost.test.ts`. Expected: all pass. Then `bunx tsc --noEmit -p .` should be clean.
- [ ] **Commit:** `git add src/hooks/useReadingEstimateMessages.ts src/components/features/onboarding/YourReadingStep.tsx src/pages/OnboardingReading.tsx src/pages/__tests__/OnboardingReading.test.tsx && git commit -m "feat(reading): /onboarding/reading page, Get my reading is the only trigger"`

---

### Task 4.11: Existing journeys reach the dashboard through the new step

Without this, every e2e lane and verifier that onboarded and then waited for `/dashboard` times out on `/onboarding/reading`. The memory-budget lane also has to prove the predictive compute really starts on the new route.

**Files:** create `e2e/onboardingExit.ts`, `scripts/onboardingExit.mjs`; modify the files in the table below.

- [ ] **Write the failing check.** Build without hooks and run the memory-budget lane, which is the lane this PR must keep green. Use the commands in its header: `./node_modules/.bin/vite build --outDir dist-real && (./node_modules/.bin/vite preview --outDir dist-real --port 4199 &) && MEMORY_BUDGET_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:memory-budget`. Expected: FAIL, `page.waitForURL: Timeout 300000ms exceeded … navigated to "/onboarding/reading"`.
- [ ] **Implement** `e2e/onboardingExit.ts`:

```ts
import type { Page } from '@playwright/test';

/** Onboarding ends on the reading step (or, before that ships, on the dashboard). */
export const READING_OR_DASHBOARD = /\/(onboarding\/reading|dashboard)(?:[?#]|$)/;

/**
 * After the chart is saved, leave the reading step the way a person who does
 * not want a reading right now does: "Skip for now" (no AI) or "Go to
 * dashboard" (AI set up). Accepts landing straight on /dashboard too, so the
 * live smoke stays valid across the deploy that introduces the step.
 */
export async function continueToDashboard(page: Page, timeout = 300_000): Promise<void> {
  await page.waitForURL(READING_OR_DASHBOARD, { timeout });
  if (new URL(page.url()).pathname === '/onboarding/reading') {
    await page.getByTestId('reading-skip').or(page.getByTestId('reading-go-dashboard')).first().click();
  }
  await page.waitForURL('**/dashboard', { timeout: 60_000 });
}
```

`scripts/onboardingExit.mjs` (same contract for the Node verifiers):

```js
/** See e2e/onboardingExit.ts: leave the reading step for the dashboard. */
export const READING_OR_DASHBOARD = /\/(onboarding\/reading|dashboard)(?:[?#]|$)/

export async function continueToDashboard(page, timeout = 300_000) {
  await page.waitForURL(READING_OR_DASHBOARD, { timeout })
  if (new URL(page.url()).pathname === '/onboarding/reading') {
    await page.getByTestId('reading-skip').or(page.getByTestId('reading-go-dashboard')).first().click()
  }
  await page.waitForURL('**/dashboard', { timeout: 60_000 })
}
```

Edit each site. Add `import { continueToDashboard } from './onboardingExit';` to each e2e file (`'../onboardingExit'` from `e2e/live/`). Add `import { continueToDashboard } from './onboardingExit.mjs'` to each script.

| File:line | Replace | With |
| --- | --- | --- |
| `e2e/time-handling.spec.ts:75` | `await page.waitForURL('**/dashboard', { timeout: 300_000 });` | `await continueToDashboard(page, 300_000);` |
| `e2e/returning-visitor-engine.e2e.spec.ts:260` | `await page.waitForURL('**/dashboard', { timeout: 60_000 });` | `await continueToDashboard(page, 60_000);` |
| `e2e/boot-retry.spec.ts:108` | `await page.waitForURL('**/dashboard', { timeout: 120_000 });` | `await continueToDashboard(page, 120_000);` |
| `e2e/dual-voice-life-atlas.e2e.spec.ts:119` | `await page.waitForURL('**/dashboard', { timeout: 180_000 });` | `await continueToDashboard(page, 180_000);` |
| `e2e/chart-durable-reload.spec.ts:153` and `:165` | `await page.waitForURL("**/dashboard", { timeout: 300_000 });` | `await continueToDashboard(page, 300_000);` (`:165` is the rectify path, which now continues to the reading step) |
| `e2e/portableInvariants.helpers.ts:261` | `await page.waitForURL('**/dashboard', { timeout: 240_000 });` | `await continueToDashboard(page, 240_000);` |
| `e2e/birth-time-edit.spec.ts:74` | `await page.waitForURL("**/dashboard", { timeout: 300_000 });` | `await continueToDashboard(page, 300_000);` |
| `e2e/live/liveJourney.ts:94` | `await page.waitForURL('**/dashboard', { timeout: 60_000 });` | `await continueToDashboard(page, 60_000);` |
| `e2e/report-pdf.e2e.spec.ts:745-760` | the `waitForFunction` predicate `window.location.pathname === '/dashboard' \|\|` and the `!== '/dashboard'` check | predicate `['/dashboard', '/onboarding/reading'].includes(window.location.pathname) \|\|`; the check becomes `!['/dashboard', '/onboarding/reading'].includes(new URL(page.url()).pathname)`; then add `await continueToDashboard(page, 60_000);` after the `if` block |
| `scripts/verify-webgl-contexts.mjs:73` | `await page.waitForURL('**/dashboard', { timeout: 300_000 })` | `await continueToDashboard(page, 300_000)` |
| `scripts/verify-onboarding-recovery.mjs:127` | `page.waitForURL('**/dashboard', { timeout: 180_000 }).then(() => 'dashboard'),` | `continueToDashboard(page, 180_000).then(() => 'dashboard'),` |
| `scripts/verify-real-onboarding.mjs:152` | `page.waitForURL('**/dashboard', { timeout: 180_000 }).then(() => 'dashboard'),` | `continueToDashboard(page, 180_000).then(() => 'dashboard'),` |
| `scripts/attribute-memory.mjs:212` | `await page.waitForURL('**/dashboard', { timeout: 300_000 })` | `await continueToDashboard(page, 300_000)` |
| `scripts/verify-storage-blocked.mjs:280` | `await control.page.waitForURL('**/dashboard', { timeout: 60_000 })` | `await continueToDashboard(control.page, 60_000)` |
| `scripts/verify-browser-journey.mjs:101` (end of `onboard()`) | after `await page.getByTestId('skip-life-events-button').click()` | add `await continueToDashboard(page, CHART_BUDGET_MS)` |
| `e2e/memory-budget.e2e.spec.ts:96-97` | `await page.waitForURL('**/dashboard', { timeout: 300_000 });` | the block below |

Memory-budget replacement (inside `onboardToDashboard`), which proves predictive starts on this route:

```ts
  // Onboarding now continues to the reading step, which starts the local
  // predictive compute on mount. Measure the budget WITH that compute running.
  await page.waitForURL('**/onboarding/reading', { timeout: 300_000 });
  await expect(page.getByTestId('onboarding-reading')).toHaveAttribute('data-predictive-status', /loading|ready/, {
    timeout: 60_000,
  });
  await page.getByTestId('reading-skip').click();
  await page.waitForURL('**/dashboard', { timeout: 60_000 });
```

Not changed, and why: `wizard-phase2.spec.ts`, `portable-invariants.spec.ts:225`, `durable-saves.spec.ts`, `first-run-restore.spec.ts`, `verify-pro-ui.mjs` (they reach Rectify or the dashboard without onboarding's hint, so `/dashboard` stays right), `verify-reset-deletes.mjs` (onboarding fails by design there).

- [ ] **Run to pass:** the memory-budget command above; then `bun run test:e2e:time-handling`, `bun run test:e2e:chart-durable-reload`, `bun run test:e2e:birth-time-edit` (Chromium projects). Expected: green, and the memory lane prints its `memory-report` lines inside `BOOT_MEMORY_BUDGET`. Record the RSS / heap numbers next to `main`'s in the PR body.
- [ ] **Commit:** `git add e2e/onboardingExit.ts scripts/onboardingExit.mjs e2e/time-handling.spec.ts e2e/returning-visitor-engine.e2e.spec.ts e2e/boot-retry.spec.ts e2e/dual-voice-life-atlas.e2e.spec.ts e2e/chart-durable-reload.spec.ts e2e/portableInvariants.helpers.ts e2e/birth-time-edit.spec.ts e2e/live/liveJourney.ts e2e/report-pdf.e2e.spec.ts e2e/memory-budget.e2e.spec.ts scripts/verify-webgl-contexts.mjs scripts/verify-onboarding-recovery.mjs scripts/verify-real-onboarding.mjs scripts/attribute-memory.mjs scripts/verify-storage-blocked.mjs scripts/verify-browser-journey.mjs && git commit -m "test(e2e): journeys pass through the reading step; memory lane measures predictive on it"`

---

### Task 4.12: Unknown-time journey in `rectification.spec.ts`

**Files:** modify `e2e/rectification.spec.ts` (append a test and two helpers)

- [ ] **Write the failing test** (append to `e2e/rectification.spec.ts`):

```ts
const BENGALURU_GEO = {
  name: 'Bengaluru', latitude: 12.9716, longitude: 77.5946, country: 'India', country_code: 'IN',
  admin1: 'Karnataka', timezone: 'Asia/Kolkata', population: 8443675, feature_code: 'PPLA',
};

async function typeSections(page: Page, testId: string, digits: string, trailing = ''): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 30 });
  if (trailing) await page.keyboard.type(trailing, { delay: 30 });
}

test('unknown birth time: onboarding → rectify → Skip continues to the reading step, not the dashboard', async ({ page }) => {
  await page.route('https://geocoding-api.open-meteo.com/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      contentType: 'application/json',
      body: JSON.stringify({ results: [BENGALURU_GEO] }),
    }),
  );
  await page.goto('/onboarding');
  await page.getByTestId('name-input').fill('Unknown Time');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', '08081988');
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill('Bengaluru');
  await page.locator('[role="option"]').first().click({ timeout: 120_000 });
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', '0644', 'a');
  await page.getByTestId('confidence-option-unknown').click();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();

  await page.waitForURL('**/rectify/**', { timeout: 300_000 });
  await page.getByTestId('rectify-skip-btn').click();

  await expect(page, 'Rectify entered from onboarding must continue to the reading step').toHaveURL(
    /\/onboarding\/reading$/,
  );
  await expect(page.getByTestId('onboarding-reading')).toHaveAttribute('data-step', 'unlock');
  await page.screenshot({ path: `${RECTIFY_DIR}/unknown-time-reading-step.png`, fullPage: true });
});
```

- [ ] **Run on `main` + Tasks 4.1–4.3 only (before 4.4):** `bun run test:e2e:rectification -- -g "unknown birth time"`. Expected: FAIL, `locator.click: Timeout … getByTestId('rectify-skip-btn')`.
- [ ] **Run to pass (after 4.4–4.10):** same command. Expected: 1 passed, plus the existing live-preview test.
- [ ] **Commit:** `git add e2e/rectification.spec.ts && git commit -m "test(e2e): unknown-time onboarding continues from rectify to the reading step"`

---

### Task 4.13: Mutation red runs

**Files:** create `scripts/mutations/pr4-onboarding-reading.sh` (`frontend/apps/web/scripts/mutations/`; the repo has no mutation harness yet)

- [ ] **Write the script:**

```bash
#!/usr/bin/env bash
# PR 4 mutation red runs: break each property the PR claims, prove the named
# test goes RED (by exit code, never by grepping output), restore, and prove the
# tree is clean. Run from anywhere; needs a committed, clean tree.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WEB="$ROOT/frontend/apps/web"
cd "$WEB" || exit 1

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "refusing to run: working tree is not clean" >&2
  exit 1
fi

RESULTS=()
FAILED=0

run_test() { # $1 = kind (unit|e2e), $2 = target, $3 = name filter, [$4 = config]
  if [ "$1" = unit ]; then
    bunx vitest run "$2" -t "$3" >/tmp/pr4-mutation.log 2>&1
  else
    bunx playwright test --config="$4" --project=chromium -g "$3" >/tmp/pr4-mutation.log 2>&1
  fi
}

# mutate <id> <file> <perl -0pi expression> <marker> <kind> <target> <filter> [config]
mutate() {
  local id="$1" file="$2" expr="$3" marker="$4" kind="$5" target="$6" filter="$7" config="${8:-}"

  if ! run_test "$kind" "$target" "$filter" "$config"; then
    echo "BASELINE NOT GREEN for $id ($filter); a red run would prove nothing" >&2
    cat /tmp/pr4-mutation.log >&2
    exit 1
  fi

  perl -0pi -e "$expr" "$file"
  if ! grep -qF "$marker" "$file"; then
    echo "MUTATION $id DID NOT APPLY to $file" >&2
    git checkout -- "$file"
    exit 1
  fi

  run_test "$kind" "$target" "$filter" "$config"
  local code=$?
  git checkout -- "$file"

  if [ "$code" -ne 0 ]; then
    RESULTS+=("| $id | $kind: $filter | RED (exit $code) |")
  else
    RESULTS+=("| $id | $kind: $filter | STILL GREEN - guard does not guard |")
    FAILED=1
  fi
}

STEP=src/components/features/onboarding/YourReadingStep.tsx
COST=src/hooks/useReadingCostQuote.ts
RECT=src/pages/Rectify.tsx

# M1: auto-start the reading on mount.
M1="s/^import type \{ ReactElement \} from 'react';/import { useEffect, type ReactElement } from 'react';/m; s/(  const running = chapters\.some\(isChapterRunning\);\n)/\$1  useEffect(() => { startReading(); }, [startReading]); \/\/ MUTATION:auto-start\n/"
mutate M1-unit "$STEP" "$M1" "MUTATION:auto-start" unit src/pages/__tests__/OnboardingReading.test.tsx "sends nothing until Get my reading"
mutate M1-e2e "$STEP" "$M1" "MUTATION:auto-start" e2e - "known time, no AI" playwright.onboarding-reading.config.ts

# M2: Rectify ignores state.next.
M2="s/  const exitTo = onboardingNext \?\? '\/dashboard';/  const exitTo = '\/dashboard'; \/\/ MUTATION:ignore-next/"
mutate M2-unit "$RECT" "$M2" "MUTATION:ignore-next" unit src/pages/Rectify.test.tsx "keep recorded continues to the reading step"
mutate M2-e2e "$RECT" "$M2" "MUTATION:ignore-next" e2e - "unknown birth time" playwright.rectification.config.ts

# M3: fetch prices for a local endpoint.
M3="s/    if \(kind !== 'openrouter'\) return;/    if (kind === 'none') return; \/\/ MUTATION:local-price-fetch/"
mutate M3-unit "$COST" "$M3" "MUTATION:local-price-fetch" unit src/components/features/onboarding/ReadingCostLine.test.tsx "a local endpoint gets no price lookup"
mutate M3-e2e "$COST" "$M3" "MUTATION:local-price-fetch" e2e - "local endpoint never contacts OpenRouter" playwright.onboarding-reading.config.ts

# M4: hide "Go to dashboard" while streaming.
M4="s/        <DashboardLink \/>/        {!running && <DashboardLink \/>} {\/* MUTATION:hide-dashboard *\/}/"
mutate M4-unit "$STEP" "$M4" "MUTATION:hide-dashboard" unit src/pages/__tests__/OnboardingReading.test.tsx "dashboard link is always available"
mutate M4-e2e "$STEP" "$M4" "MUTATION:hide-dashboard" e2e - "known time, no AI" playwright.onboarding-reading.config.ts

echo "| Mutation | Test | Result |"
echo "| --- | --- | --- |"
printf '%s\n' "${RESULTS[@]}"

if ! git diff --quiet; then
  echo "TREE NOT RESTORED:" >&2
  git diff --stat >&2
  exit 1
fi
if grep -rn "MUTATION:" "$WEB/src" "$WEB/e2e"; then
  echo "leftover mutation marker in the tree" >&2
  exit 1
fi
exit "$FAILED"
```

- [ ] **Run:** `bash scripts/mutations/pr4-onboarding-reading.sh`. Expected: every row says `RED (exit 1)`, `git diff --quiet` passes, no markers are left, and the script exits 0. Each e2e row rebuilds the bundle through its config's `webServer`, so the full run takes about 40 minutes. Paste the printed table into the PR body.
- [ ] **Commit:** `git add scripts/mutations/pr4-onboarding-reading.sh && git commit -m "test(mutation): PR 4 red runs for the paid-call and local-endpoint guards"`

---

### Task 4.14: Live end-to-end

`bun run build && bun run preview` with no exit-gate hooks: a real first run, driven in desktop Chromium and the iPhone 15 WebKit profile, against a stubbed OpenAI-compatible provider. One real-model check runs separately.

**Files:** create `e2e/onboardingReading.stub.ts`, `e2e/onboarding-reading.spec.ts`, `playwright.onboarding-reading.config.ts`, `e2e/onboarding-reading.real.spec.ts`, `playwright.onboarding-reading.real.config.ts`; modify `package.json` (scripts)

- [ ] **Config** `playwright.onboarding-reading.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PORT = Number(process.env.ONBOARDING_READING_E2E_PORT ?? 4221);
const EXTERNAL_BASE_URL = process.env.ONBOARDING_READING_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * The reading step after the chart (PR 4), driven as a real first run: NO
 * exit-gate hooks, real engine, real onboarding form. The provider is stubbed
 * with page.route. Service workers are blocked in both projects, because
 * Playwright's WebKit does not route fetches that pass through one.
 * iphone-webkit needs macOS (Linux Playwright WebKit cannot open SQLite's OPFS).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /onboarding-reading\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  use: { baseURL: BASE_URL, headless: true, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], serviceWorkers: 'block' } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 15'], serviceWorkers: 'block' } },
  ],
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
```

- [ ] **Stub** `e2e/onboardingReading.stub.ts`:

```ts
import type { Page, Route } from '@playwright/test';

import { PRODUCT_DEFAULT_MODEL } from './realModel';

type ReportSection =
  | 'core' | 'yoga' | 'guidance1' | 'guidance2' | 'remedial'
  | 'current_period' | 'year_ahead' | 'life_outlook_1' | 'life_outlook_2';

const p = (layman: string, technical: string) => ({ layman, technical });

/** v2 report sections (PR 2 shapes). Prose carries no dates, so the date guard keeps it all. */
export const REPORT_SECTION_JSON: Record<ReportSection, unknown> = {
  core: {
    summary: 'STUB SUMMARY about this chart.',
    strengths: [{ title: 'Determination', ...p('You persevere.', 'Mars-driven grit.') }],
    challenges: [{ title: 'Impatience', ...p('Slow down.', 'Mars excess.') }],
    life_themes: [{ title: 'Service', ...p('You help others.', '6th-house emphasis.') }],
  },
  yoga: { integrated_yoga_narrative: p('Your life arc bends toward leadership.', 'Raja yoga via kendra-trikona lords.') },
  guidance1: {
    health_guidance: p('Rest more.', '6th lord analysis.'),
    education_guidance: p('Keep learning.', '5th lord.'),
    career_guidance: p('Lead teams.', '10th lord strong.'),
    relationship_guidance: p('Communicate.', '7th lord.'),
    family_guidance: p('Home steadies you.', '4th lord well placed.'),
  },
  guidance2: {
    finances_guidance: p('Save steadily.', '2nd/11th lords.'),
    spiritual_guidance: p('Reflect daily.', '12th house.'),
    life_evolution_guidance: p('You grow through challenge.', 'Dasha sequence.'),
  },
  remedial: { remedial_measures: p('Meditate and journal.', 'Universal practices.') },
  current_period: {
    maha: p('A long chapter of building.', 'Saturn mahadasha.'),
    antar: p('A lighter sub-period inside it.', 'Venus antardasha.'),
    activates: [{ title: 'Work', ...p('Work asks more of you.', '10th house activated.') }],
    next_change: p('A shift comes later this year.', 'Next antardasha begins.'),
  },
  year_ahead: {
    headline: p('A year of steady gains.', 'Jupiter supports the 11th.'),
    quarters: (['Q1', 'Q2', 'Q3', 'Q4'] as const).map((key) => ({
      key,
      ...p(`STUB ${key} plain prose.`, `STUB ${key} technical prose.`),
    })),
  },
  life_outlook_1: {
    domains: ['career', 'finances', 'health', 'relationships'].map((domain) => ({
      domain,
      outlook: p(`${domain} looks steady.`, `${domain} lord in a kendra.`),
    })),
  },
  life_outlook_2: {
    domains: ['spiritual', 'education', 'family'].map((domain) => ({
      domain,
      outlook: p(`${domain} looks steady.`, `${domain} lord in a kendra.`),
    })),
  },
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function sectionOf(body: string | null): ReportSection | null {
  if (!body) return null;
  for (const key of Object.keys(REPORT_SECTION_JSON) as ReportSection[]) {
    if (body.includes(`SECTION:${key}`)) return key;
  }
  return null;
}

export interface ReportStub {
  /** Every /chat/completions request seen (key probes included). */
  readonly completions: () => number;
  readonly setProbeStatus: (status: number) => void;
  /** Fail every section except `keep` with this HTTP status (402 = out of credit). */
  readonly failSections: (status: number | null, keep?: readonly ReportSection[]) => void;
  /** Hold section answers until the returned release() is called. */
  readonly hold: () => () => void;
}

/** A stubbed OpenAI-compatible provider + OpenRouter catalog/balance, for any endpoint origin. */
export async function installReportStub(page: Page, opts: { probeStatus?: number } = {}): Promise<ReportStub> {
  let completions = 0;
  let probeStatus = opts.probeStatus ?? 200;
  let sectionStatus: number | null = null;
  let keep: readonly ReportSection[] = [];
  let held: Promise<void> | null = null;

  const errorBody = (status: number) =>
    JSON.stringify({ error: { code: status, message: status === 402 ? 'Insufficient credits' : 'No auth credentials found' } });

  await page.route('**/chat/completions', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    completions += 1;
    const section = sectionOf(route.request().postData());
    if (section === null) {
      return probeStatus === 200
        ? route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) })
        : route.fulfill({ status: probeStatus, headers: CORS, contentType: 'application/json', body: errorBody(probeStatus) });
    }
    if (held) await held;
    if (sectionStatus !== null && !keep.includes(section)) {
      return route.fulfill({ status: sectionStatus, headers: CORS, contentType: 'application/json', body: errorBody(sectionStatus) });
    }
    const content = JSON.stringify(REPORT_SECTION_JSON[section]);
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await page.route('https://openrouter.ai/api/v1/models', (route) =>
    route.fulfill({
      status: 200, headers: CORS, contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: PRODUCT_DEFAULT_MODEL, name: 'DeepSeek V4.1 Flash', pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }),
    }),
  );
  await page.route('https://openrouter.ai/api/v1/credits', (route) =>
    route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ data: { total_credits: 5, total_usage: 1 } }) }),
  );

  return {
    completions: () => completions,
    setProbeStatus: (status) => { probeStatus = status; },
    failSections: (status, keepSections = []) => { sectionStatus = status; keep = keepSections; },
    hold: () => {
      let release: () => void = () => undefined;
      held = new Promise<void>((resolve) => { release = resolve; });
      return () => { release(); held = null; };
    },
  };
}
```

- [ ] **Spec** `e2e/onboarding-reading.spec.ts`:

```ts
import { mkdirSync } from 'node:fs';

import { expect, type Page, type TestInfo } from '@playwright/test';

import { collectConsoleErrors } from './live/liveJourney';
import { installReportStub } from './onboardingReading.stub';
import { PRODUCT_DEFAULT_MODEL } from './realModel';
import { test } from './webkitProfile';

/**
 * PR 4: the reading is the step after the chart. Real first run (no hooks),
 * real engine, stubbed provider. Claims: paid calls only after "Get my
 * reading"; a local endpoint never contacts openrouter.ai; free forever.
 */
const CHAPTERS = ['overview', 'current_period', 'year_ahead', 'life_areas', 'remedies'] as const;
const GEO = {
  name: 'Bengaluru', latitude: 12.9716, longitude: 77.5946, country: 'India', country_code: 'IN',
  admin1: 'Karnataka', timezone: 'Asia/Kolkata', population: 8443675, feature_code: 'PPLA',
};
/** The only console errors a screen may show, each REQUIRED to appear there: the designed, PII-free signals of the failure on screen. */
const NETWORK_401 = /^Failed to load resource: the server responded with a status of 401/;
const NETWORK_402 = /^Failed to load resource: the server responded with a status of 402/;
const KEY_TEST_FAILED = /^\[almamesh:error:provider\.connection_test_failed\]$/;
const STREAM_FAILED = /^\[almamesh:error:interpretation\.stream_failed\]$/;

function shots(testInfo: TestInfo): (page: Page, name: string) => Promise<void> {
  const dir = `test-results/onboarding-reading/${testInfo.project.name}`;
  mkdirSync(dir, { recursive: true });
  return async (page, name) => {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  };
}

/** New console errors since `mark` must be exactly the expected kinds (each seen at least once). */
function expectConsole(errors: string[], mark: number, screen: string, expected: readonly RegExp[] = []): number {
  const fresh = errors.slice(mark);
  expect(fresh.filter((e) => !expected.some((re) => re.test(e))), `unexpected console errors on "${screen}"`).toEqual([]);
  for (const re of expected) expect(fresh.some((e) => re.test(e)), `expected ${re} on "${screen}"`).toBe(true);
  return errors.length;
}

async function typeSections(page: Page, testId: string, digits: string, trailing = ''): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 30 });
  if (trailing) await page.keyboard.type(trailing, { delay: 30 });
}

/** The real wizard up to (not including) "Skip for now" on life events. */
async function fillOnboarding(page: Page): Promise<void> {
  await page.route('https://geocoding-api.open-meteo.com/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      contentType: 'application/json',
      body: JSON.stringify({ results: [GEO] }),
    }),
  );
  await page.goto('/onboarding');
  await page.getByTestId('name-input').fill('Reading Journey');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', '08081988');
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill('Bengaluru');
  await page.locator('[role="option"]').first().click({ timeout: 120_000 });
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', '0644', 'a');
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
}

async function expectAllWritten(page: Page): Promise<void> {
  for (const id of CHAPTERS) {
    await expect(page.getByTestId(`reading-outline-${id}`)).toHaveAttribute('data-status', 'written', { timeout: 300_000 });
  }
}

test('known time, no AI: unlock → key failure → connect → your reading → tap → streams → dashboard', async ({ page }, testInfo) => {
  const shot = shots(testInfo);
  const errors = collectConsoleErrors(page);
  const stub = await installReportStub(page, { probeStatus: 401 });
  let mark = 0;

  await fillOnboarding(page);
  await page.getByTestId('skip-life-events-button').click();

  // 1. Generating: only real engine work is listed.
  await expect(page.getByText(/^Step \d of 4$/)).toBeVisible();
  await expect(page.getByText('Generating personalized insights')).toHaveCount(0);
  await shot(page, '01-generating');
  mark = expectConsole(errors, mark, 'Generating');

  // 2. Unlock your reading.
  await page.waitForURL('**/onboarding/reading', { timeout: 300_000 });
  const root = page.getByTestId('onboarding-reading');
  await expect(root).toHaveAttribute('data-step', 'unlock');
  await expect(page.getByText(/Your key stays on this device/)).toBeVisible();
  await expect(page.getByTestId('reading-skip')).toBeVisible();
  await shot(page, '02-unlock');
  mark = expectConsole(errors, mark, 'Unlock your reading');

  // 3. Key test failure: the provider's reason, Try again (Save) and Skip both available.
  await page.getByTestId('llm-openrouter-key').fill('sk-or-bad');
  await page.getByTestId('llm-save').click();
  await expect(page.getByTestId('llm-connection-result')).toBeVisible();
  await expect(page.getByTestId('llm-save')).toBeEnabled();
  await expect(page.getByTestId('reading-skip')).toBeVisible();
  await expect(root).toHaveAttribute('data-step', 'unlock');
  await shot(page, '03-key-failure');
  mark = expectConsole(errors, mark, 'Key test failure', [NETWORK_401, KEY_TEST_FAILED]);

  // Connect.
  stub.setProbeStatus(200);
  await page.getByTestId('llm-openrouter-key').fill('sk-or-good');
  await page.getByTestId('llm-save').click();
  await expect(root).toHaveAttribute('data-step', 'reading', { timeout: 60_000 });

  // 4. Your reading, before the tap: outline, model, cost, balance. Nothing sent.
  const afterConnect = stub.completions();
  await expect(page.getByTestId('reading-cost-line')).toHaveText(
    /^About \d+(–\d+)?¢ on your OpenRouter account\. AlmaMesh charges nothing\.$/,
  );
  await expect(page.getByTestId('reading-balance')).toContainText('$4.00');
  await expect(page.getByTestId('reading-model')).toContainText(PRODUCT_DEFAULT_MODEL);
  await page.waitForTimeout(5_000);
  expect(stub.completions(), 'mounting step 3 sends no completion request').toBe(afterConnect);
  await shot(page, '04-your-reading');
  mark = expectConsole(errors, mark, 'Your reading, before tap');

  // Reload: the step comes from stored data; still nothing sent.
  await page.reload();
  await expect(root).toHaveAttribute('data-step', 'reading', { timeout: 180_000 });
  await page.waitForTimeout(5_000);
  expect(stub.completions(), 'a reload of step 3 sends no completion request').toBe(afterConnect);
  mark = expectConsole(errors, mark, 'Your reading, after reload');

  // 5. Streaming: held answers, so the in-progress screen is real.
  const release = stub.hold();
  await page.getByTestId('reading-get').click();
  await expect(page.getByTestId('reading-outline-overview')).toHaveAttribute('data-status', 'writing');
  await expect(page.getByTestId('reading-go-dashboard')).toBeVisible();
  await expect(page.getByTestId('reading-report')).toBeVisible();
  expect(stub.completions()).toBeGreaterThan(afterConnect);
  await shot(page, '05-streaming');
  release();
  await expectAllWritten(page);
  mark = expectConsole(errors, mark, 'Your reading, streaming');

  // 6. Dashboard shows the saved report.
  await page.getByTestId('reading-go-dashboard').click();
  await page.waitForURL('**/dashboard');
  await expect(page.getByTestId('reading-report')).toContainText('STUB SUMMARY');
  await shot(page, '06-dashboard-report');
  expectConsole(errors, mark, 'Dashboard with the report');
});

test('402 mid-report keeps written sections, offers Retry and Go to dashboard; dashboard Get reading works later', async ({ page }, testInfo) => {
  const shot = shots(testInfo);
  const errors = collectConsoleErrors(page);
  const stub = await installReportStub(page);
  await fillOnboarding(page);
  await page.getByTestId('skip-life-events-button').click();
  await page.waitForURL('**/onboarding/reading', { timeout: 300_000 });
  await page.getByTestId('llm-openrouter-key').fill('sk-or-empty');
  await page.getByTestId('llm-save').click();
  await expect(page.getByTestId('onboarding-reading')).toHaveAttribute('data-step', 'reading', { timeout: 60_000 });

  stub.failSections(402, ['core']);
  await page.getByTestId('reading-get').click();
  await expect(page.getByTestId('reading-credits')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('reading-retry')).toBeVisible();
  await expect(page.getByTestId('reading-go-dashboard')).toBeVisible();
  await expect(page.getByTestId('reading-report')).toContainText('STUB SUMMARY');
  await shot(page, 'x-402-mid-report');
  expectConsole(errors, 0, '402 mid-report', [NETWORK_402, STREAM_FAILED]);

  stub.failSections(null);
  await page.getByTestId('reading-go-dashboard').click();
  await page.waitForURL('**/dashboard');
  await page.getByTestId('generate-reading').click();
  await expect(page.getByTestId('reading-report')).toContainText('STUB Q1 plain prose.', { timeout: 300_000 });
});

test('Skip on unlock lands on the dashboard; regenerating from Settings never opens the reading step', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await installReportStub(page);
  await fillOnboarding(page);
  await page.getByTestId('skip-life-events-button').click();
  await page.waitForURL('**/onboarding/reading', { timeout: 300_000 });
  await page.getByTestId('reading-skip').click();
  await page.waitForURL('**/dashboard');

  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  await page.evaluate(() => {
    window.history.pushState({}, '', '/settings/profile');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const birthTime = page.locator('form input[type="time"]').first();
  await expect(birthTime).toBeVisible({ timeout: 60_000 });
  await birthTime.fill('07:10');
  await birthTime.blur();
  await page.getByRole('button', { name: 'Save Changes' }).click();
  const ack = page.getByTestId('regen-flip-ack');
  if (await ack.isVisible()) await ack.check();
  await page.getByRole('button', { name: 'Confirm & Regenerate' }).click();
  for (let i = 0; i < 15; i += 1) {
    visited.push(new URL(page.url()).pathname);
    await page.waitForTimeout(1_000);
  }
  expect(visited.filter((path) => path === '/onboarding/reading')).toEqual([]);
  expectConsole(errors, 0, 'Settings regeneration');
});

test('local endpoint never contacts OpenRouter: no cost line, zero requests to openrouter.ai', async ({ page }, testInfo) => {
  const shot = shots(testInfo);
  const errors = collectConsoleErrors(page);
  const openRouterHits: string[] = [];
  page.context().on('request', (request) => {
    if (new URL(request.url()).hostname.endsWith('openrouter.ai')) openRouterHits.push(request.url());
  });
  const stub = await installReportStub(page);
  await fillOnboarding(page);
  await page.getByTestId('skip-life-events-button').click();
  await page.waitForURL('**/onboarding/reading', { timeout: 300_000 });

  await page.getByTestId('llm-advanced-summary').click();
  await page.getByTestId('llm-api-base').fill('http://localhost:11434/v1');
  await page.getByTestId('llm-model').fill('qwen3:4b');
  await page.getByTestId('llm-save-advanced').click();
  await expect(page.getByTestId('onboarding-reading')).toHaveAttribute('data-step', 'reading', { timeout: 60_000 });
  await page.waitForTimeout(5_000);
  await expect(page.getByTestId('reading-cost-line')).toHaveCount(0);
  await expect(page.getByTestId('reading-balance')).toHaveCount(0);
  await shot(page, 'x-local-endpoint');

  const before = stub.completions();
  await page.getByTestId('reading-get').click();
  await expectAllWritten(page);
  expect(stub.completions()).toBeGreaterThan(before);
  expect(openRouterHits, 'a local endpoint journey must never contact openrouter.ai').toEqual([]);
  expectConsole(errors, 0, 'Local endpoint');
});
```

- [ ] **Real spec** `e2e/onboarding-reading.real.spec.ts` (hooked build: it seeds the chart through the engine, as `interpretation.real.spec.ts` does):

```ts
import { expect, test } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { E2E_REAL_MODEL } from './realModel';

const CHAPTERS = ['overview', 'current_period', 'year_ahead', 'life_areas', 'remedies'] as const;

async function configure(page: import('@playwright/test').Page, key: string): Promise<void> {
  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: key,
    model: E2E_REAL_MODEL,
    privacyMode: 'cloud_premium',
    engine: 'openai-http',
  });
  await page.addInitScript(([k, v]) => window.localStorage.setItem(k as string, v as string), [LLM_SETTINGS_KEY, config] as const);
}

test('[real] the reading step prices, waits for the tap, and writes all five chapters on OpenRouter', async ({ page }) => {
  const KEY = process.env.OPENROUTER_API_KEY;
  test.skip(!KEY, 'OPENROUTER_API_KEY not set');
  test.setTimeout(900_000);
  await configure(page, KEY as string);
  let completions = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/chat/completions')) completions += 1;
  });

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/onboarding/reading', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('onboarding-reading')).toHaveAttribute('data-step', 'reading', { timeout: 120_000 });
  await expect(page.getByTestId('reading-cost-line')).toHaveText(/AlmaMesh charges nothing\.$/, { timeout: 60_000 });
  await expect(page.getByTestId('reading-balance')).toBeVisible();
  await page.waitForTimeout(5_000);
  expect(completions, 'nothing is sent before the tap').toBe(0);

  const started = Date.now();
  await page.getByTestId('reading-get').click();
  for (const id of CHAPTERS) {
    await expect(page.getByTestId(`reading-outline-${id}`)).toHaveAttribute('data-status', 'written', { timeout: 600_000 });
  }
  console.log(`[real] ${E2E_REAL_MODEL}: all chapters written in ${Math.round((Date.now() - started) / 1000)} s`);
  await page.screenshot({ path: 'test-results/onboarding-reading-real.png', fullPage: true });
});

test('[real] an out-of-credit OpenRouter key shows Retry and Go to dashboard', async ({ page }) => {
  const KEY = process.env.OPENROUTER_EMPTY_CREDIT_KEY;
  test.skip(!KEY, 'OPENROUTER_EMPTY_CREDIT_KEY not set (a key on an account with zero balance, nightly lane only)');
  test.setTimeout(600_000);
  await configure(page, KEY as string);
  await bootEngine(page);
  await seedChart(page);
  await page.goto('/onboarding/reading', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('reading-balance-low')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('reading-get').click();
  await expect(page.getByTestId('reading-credits')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('reading-retry')).toBeVisible();
  await expect(page.getByTestId('reading-go-dashboard')).toBeVisible();
});
```

`playwright.onboarding-reading.real.config.ts`: a copy of `playwright.interpretation.real.config.ts` with `testMatch: /onboarding-reading\.real\.spec\.ts/`, `PORT` from `ONBOARDING_READING_REAL_E2E_PORT ?? 4222`, and the same hooked `webServer` command (`VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build && VITE_API_URL= bun run preview --port ${PORT} --strictPort`).

`package.json` scripts (next to `test:e2e:rectification`):

```json
    "test:e2e:onboarding-reading": "playwright test --config=playwright.onboarding-reading.config.ts",
    "test:e2e:onboarding-reading:real": "playwright test --config=playwright.onboarding-reading.real.config.ts",
```

- [ ] **Run:** `bun run test:e2e:onboarding-reading` (both projects). `iphone-webkit` runs on macOS only, because Linux Playwright WebKit cannot open SQLite's OPFS. The PR lane in CI runs `--project=chromium`; the WebKit run happens locally on macOS and its screenshots are attached to the PR. Expected: 4 passed × 2 projects, with screenshots at `test-results/onboarding-reading/{chromium,iphone-webkit}/01-generating.png … 06-dashboard-report.png`. Then `bunx vitest run src/test/realModelSpecs.contract.test.ts` (the real spec names no model literal) and `OPENROUTER_API_KEY=… bun run test:e2e:onboarding-reading:real`. Expected: the first real test passes and logs the seconds taken; the second skips with its reason unless the empty-credit key is set.
- [ ] **Evidence table for the PR body** (fill from the run; "clean" means `expectConsole` passed with the listed expected signals only):

| Screen | Chromium screenshot | iPhone 15 WebKit screenshot | Console |
| --- | --- | --- | --- |
| Generating (no fake step) | `chromium/01-generating.png` | `iphone-webkit/01-generating.png` | clean |
| Unlock your reading | `…/02-unlock.png` | `…/02-unlock.png` | clean |
| Key test failure | `…/03-key-failure.png` | `…/03-key-failure.png` | clean apart from the required 401 network line + `provider.connection_test_failed` |
| Your reading, before tap | `…/04-your-reading.png` | `…/04-your-reading.png` | clean; 0 completions after mount and after reload |
| Your reading, streaming | `…/05-streaming.png` | `…/05-streaming.png` | clean |
| Dashboard with the report | `…/06-dashboard-report.png` | `…/06-dashboard-report.png` | clean |

- [ ] **Commit:** `git add e2e/onboardingReading.stub.ts e2e/onboarding-reading.spec.ts playwright.onboarding-reading.config.ts e2e/onboarding-reading.real.spec.ts playwright.onboarding-reading.real.config.ts package.json && git commit -m "test(e2e): reading step journeys in Chromium and iPhone 15 WebKit, plus a real-model check"`

---

### Task 4.15: Full gate and northstar

- [ ] From the repo root, run `make gate`. Expected: backend and frontend gates green. Record the vitest totals and coverage.
- [ ] Run the `frontend-quality` skill over the changed frontend files and fix what it flags: no `any`, hook hygiene in `useReadingCostQuote`, interface-over-type except the unions, a11y on the outline and buttons.
- [ ] Re-run the memory-budget lane (Task 4.11 command) and paste its `memory-report` lines.
- [ ] Prune before opening the PR: `git branch --merged main` and remote equivalents. Delete merged ones. Flag stale ones.
- [ ] Push and open the PR: `git push -u origin feat/onboarding-reading-route && gh pr create --base main --title "feat: the reading is the step after the chart (/onboarding/reading)"`. The PR body must contain:
  - Claims touched: "Paid AI calls happen only after you ask", "AlmaMesh is free forever" (and "your key goes only to the provider you choose" for the local-endpoint case).
  - **Reversed contract, said plainly:** onboarding no longer ends at `/dashboard`. Six unit assertions were inverted, not deleted. 17 e2e journeys now pass through the reading step.
  - The mutation table printed by `scripts/mutations/pr4-onboarding-reading.sh`.
  - The six-screen evidence table above, with both projects' screenshots attached.
  - Gate evidence: `make gate` result, vitest counts and coverage, the memory-budget numbers next to `main`'s, and the real-model run time on `E2E_REAL_MODEL`.
  - The Deviations list from the top of this section.
  - Ends with the attribution lines from the session reminder.
- [ ] Wait for CI to go green on the PR (`gh pr checks --watch`). Fix and re-run any red lane; never merge red.
- [ ] Dispatch the `northstar` agent against the PR, naming both claims and pointing it at the mutation table and screenshots. Require grade **A** before merge; apply its punch list and re-grade if it is lower.
- [ ] Merge with `gh pr merge --squash --delete-branch`. In the same breath, run `git worktree remove` on the PR's worktree and delete the local branch. Confirm CI is green on `main` and the deploy lands. Confirm the live build serves the new SHA (`build.json` `git_sha` equals the merge SHA, `content-type: application/json`), then run the live smoke (`bun run test:e2e:live-smoke`), which now goes through `continueToDashboard`.

---

## Cross-PR interface ledger

The sections were drafted against one contract and then reconciled. These are the final names each later PR relies on.

| Producer | Name | Final signature | Consumers |
| --- | --- | --- | --- |
| PR 1 | `AiSetupPanel` | `AiSetupPanelProps { onConnected?: (status) => void; showOffChoice?: boolean; intro?: ReactNode }` plus the five existing test seams (`resolveConfig`, `testConnection`, `fetchCredits`, `fetchModels`, `flushSettings`); keeps the `llm-*` test ids | PR 4 |
| PR 2 | `streamReportTimeline` | `(params: ReportTimelineParams) => AsyncGenerator<ReportTimelineEvent>`; `complete` = `{ timeline: ReportTimelineContent; asOfMonth: string; dateGuardRemovals: number }` | PR 3 |
| PR 2 | `ReportTimelineContent` | `{ current_period: CurrentPeriodSection \| null; year_ahead: YearAheadSection \| null; life_outlook: { life_outlook_1: LifeOutlookSection \| null; life_outlook_2: LifeOutlookSection \| null } }` | PR 3 |
| PR 2 | `buildReportMessages` | `(input: { chart; asOf? }, opts: { mode; language; lite }) => Readonly<Record<ReportSectionKey, readonly ChatMessage[]>>` | PR 4 (`useReadingEstimateMessages`, the one seam) |
| PR 2 | `estimateReadingCost` | `(messages, pricing: ModelPricing \| null, budget) => CostEstimate \| null`; free model = `{ lowUsd: 0, highUsd: 0 }` | PR 4 |
| PR 2 | `promptSet: REPORT_PROMPT_SET` on `streamNatalInterpretation` | opt-in: longer natal targets, `family_guidance`, 6k reasoning cap | PR 3 (`runNatal`) |
| PR 2 | `quarterTitle`, `quarterEvents`, `LIFE_DOMAIN_ORDER`, `usesLitePrompt` | one copy, in `@almamesh/llm` | PR 3, PR 4 |
| PR 3 | `useStreamingInterpretation` | adds `startReading()`, `refreshTimeline()`, `retryFailed()`, `timelineQueued`, `chapters: readonly ReportChapter[]`; keeps `errorKind`, `timelineErrorKind`; re-exports `ReportChapter`, `ChapterId`, `ChapterStatus` | PR 4 |
| PR 3 | `ReadingReport` | `{ chartId; reading: { interpretation, currentTimeline, chapters }; audience: ReportAudience; variant: 'dashboard' \| 'onboarding'; onGetFullYearAhead?; onRetryFailed? }`, root `data-testid="reading-report"`. The page that owns the hook passes the reading in; the component never opens a second hook instance (the double-run guard is per instance, so a second instance could buy two paid runs) | PR 4 |
| PR 3 | Store | `INTERPRETATION_PERSIST_VERSION = 7`; a v2 timeline commits only when `current_period` and `year_ahead` both parsed | PR 4 |

## Known gaps (carried, not hidden)

- The engine's quarter event text (`QuarterEvent.what`) is English only, so es and pt readers see English event lines under each quarter in PR 3. Localizing it is a follow-up issue to file when PR 3 merges.
- The P90 < 150 s assertion on the product default (flash) runs as a manual command (`REPORT_REAL_MODEL=deepseek/deepseek-v4.1-flash REPORT_P90_BUDGET_MS=150000`), because `realModelSpecs.contract.test.ts` forbids a real spec from configuring the product default. The nightly runs on `E2E_REAL_MODEL` and records P90 only. PR 2's body carries both numbers.
- The iPhone 15 WebKit profile runs on macOS only (Linux Playwright WebKit can't open SQLite's OPFS), so it is local evidence attached to each PR, not a CI lane.
- PR 4 reverses a stated contract: six unit assertions pin `navigate('/dashboard')` as the end of onboarding. They are inverted, not deleted, and the PR 4 body says so. PR 3 changes the persist-version pin (6 to 7), the hook's timeline section count (2 to 4) and the caption copy; its body lists them.
- On the key-failure and 402 screens the console is not empty by design (the browser logs the 401/402, the app logs one typed diagnostic). The e2e allows exactly those lines on exactly those screens and requires each to appear; every other screen must show zero errors.

## Self-review

| Check | Result |
| --- | --- |
| Spec coverage | Section 1 (journey, route, guards, edge cases, shared panel): PR 1 + PR 4. Section 2 (five chapters, targets, lite, quarters, date guard, cost estimate, storage v7, dashboard render): PR 2 + PR 3. Privacy table rows: each has a red run in its PR (auto-start, OpenRouter host check, no `YYYY-MM-DD`, date guard identity, cost-line strings pinned in en/es/pt, cloud disclosure `tiers.cloud_body`). Rulings 1-8: replace (PR 2/3), PDF out (none), default model + real model (PR 2), 6k reasoning cap (PR 2), `family_guidance` (PR 2/3), quarters (PR 2), lite order (PR 2/3), balance always shown (PR 4). |
| Placeholder scan | No TBD/TODO/"similar to Task" in any section. |
| Type consistency | Reconciled across sections; see the ledger above. |
| Review Focus | Five lines, each pinned to a named task. |
