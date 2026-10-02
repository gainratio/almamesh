import { test, expect, type Page } from '@playwright/test';

/**
 * AI / OpenRouter settings e2e gate — the OpenRouter-FIRST setup flow.
 *
 * Locks in that the AI setup is discoverable and honest end-to-end:
 * the header AI-status badge ("Set up AI") links to a dedicated `/settings/ai`
 * page whose guided Connect-AI card is OpenRouter-first — paste a key, Save,
 * and the save runs a REAL connectivity probe (test-on-save) whose verdict
 * renders in `llm-connection-result`. (The former one-click "Use OpenRouter"
 * preset button was retired with the OpenRouter-first redesign — OpenRouter IS
 * the guided path now; custom endpoints live under the Advanced panel.)
 *
 * The OpenRouter endpoints (probe, credits, model catalog) are STUBBED via
 * page.route — deterministic and CI-safe, no key and no real egress (the
 * chat.grounding pattern). What stays real: the production build, the router,
 * the settings UI, localStorage persistence, and the badge.
 *
 * This test deliberately exercises ONLY the settings UI + localStorage — it
 * never generates a chart, so it does not need the Pyodide engine / OPFS (which
 * crashes under headless Chromium in this environment). It runs against a
 * production build served by `vite preview` (see playwright.ai-settings.config.ts).
 *
 * Run:  bun run test:e2e:ai
 */

const LLM_SETTINGS_KEY = 'almamesh-llm-settings';
const OPENROUTER_BASE = 'openrouter.ai';
const RECOMMENDED_CLOUD_MODEL = 'deepseek/deepseek-v4.1-flash';
const DUMMY_KEY = 'sk-or-test-dummy-key-1234567890';

/**
 * Stub every OpenRouter API surface the settings page can touch:
 *  - POST …/chat/completions  → the test-on-save connectivity probe (succeeds)
 *  - GET  …/credits           → the auto-triggered balance read
 *  - GET  …/models            → the ModelCombobox catalog (empty is valid)
 * Everything else to openrouter.ai is refused loudly so a new egress can't
 * sneak in unnoticed.
 */
async function stubOpenRouter(page: Page) {
  await page.route('https://openrouter.ai/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/chat/completions')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
        }),
      });
      return;
    }
    if (url.includes('/credits')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { total_credits: 10, total_usage: 2 } }),
      });
      return;
    }
    if (url.includes('/models')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
      return;
    }
    await route.fulfill({ status: 418, body: 'unexpected OpenRouter call in e2e' });
  });
}

/**
 * Start every test from a clean localStorage so the badge begins life in its
 * unconfigured ("Set up AI") state. We land on /settings/ai first (no chart
 * generation on this route), then wipe storage and reload to a pristine page.
 */
async function gotoCleanAiSettings(page: Page) {
  await page.goto('/settings/ai');
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}

test.describe('AI settings — discover and connect OpenRouter (guided, test-on-save)', () => {
  test('user can reach /settings/ai, connect with a key, and the badge reflects it', async ({
    page,
  }) => {
    await stubOpenRouter(page);
    await gotoCleanAiSettings(page);

    // --- Step 1: the AI Model page + the guided Connect-AI card are reachable
    await expect(page).toHaveURL(/\/settings\/ai/);
    await expect(page.getByRole('heading', { name: 'AI Model' })).toBeVisible();

    const tierNone = page.getByTestId('tier-none');
    const tierCloud = page.getByTestId('tier-cloud');
    await expect(tierNone).toBeVisible(); // "no AI" is a first-class choice
    await expect(tierCloud).toBeVisible();

    // --- Step 2: header badge starts in the unconfigured state --------------
    const badge = page.getByTestId('ai-status-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/Set up AI/);

    // --- Step 3: the guided card is OpenRouter-first -------------------------
    // A key-creation link and a key field are right there; Save stays disabled
    // until a key is entered (no silent no-op saves).
    await expect(page.getByTestId('llm-openrouter-link')).toHaveAttribute(
      'href',
      /openrouter\.ai\/keys/,
    );
    const keyField = page.getByTestId('llm-openrouter-key');
    await expect(keyField).toBeVisible();
    const save = page.getByTestId('llm-save');
    await expect(save).toBeDisabled();

    // --- Step 4: paste a key, Save → test-on-save reports Connected ----------
    await keyField.fill(DUMMY_KEY);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId('llm-connection-result')).toContainText(/Connected/, {
      timeout: 15_000,
    });

    // --- Step 5a: after a reload the badge reads "AI: OpenRouter" ------------
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('ai-status-badge')).toHaveText(/AI:\s*OpenRouter/);

    // --- Step 5b: localStorage persisted the OpenRouter settings ------------
    const saved = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    }, LLM_SETTINGS_KEY);

    expect(saved).not.toBeNull();
    expect(String(saved?.apiBase)).toContain(OPENROUTER_BASE);
    expect(saved?.apiKey).toBe(DUMMY_KEY);
    expect(saved?.privacyMode).toBe('cloud_premium');
    expect(saved?.interpretationModel).toBe(RECOMMENDED_CLOUD_MODEL);
  });
});
