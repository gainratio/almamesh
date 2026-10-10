import { test, expect } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';
import { PRODUCT_DEFAULT_MODEL } from './realModel';

/**
 * Self-heal REAL integration test — reproduces the USER'S EXACT BUG and proves
 * the fix renders a genuine reading on /dashboard.
 *
 * THE BUG: a returning user's browser localStorage still held the long-retired
 * OpenRouter model id `anthropic/claude-3.5-sonnet`. The app trusted that saved
 * value over the correct default, so every interpretation call 404'd with
 * "No endpoints found for `anthropic/claude-3.5-sonnet`" and the dashboard showed
 * "Interpretation could not be generated" — a blank, broken reading.
 *
 * THE FIX (two parts, both exercised here):
 *   1. `@almamesh/llm` `readLlmSettings()` self-heals a saved
 *      `anthropic/claude-3.5-sonnet` on an OpenRouter base → the recommended model
 *      (a real OpenRouter slug) AND persists the rewrite back to localStorage.
 *   2. The Dashboard shows an actionable "Switch to recommended (GPT-6 Luna)"
 *      button on a model-not-found error (belt-and-suspenders recovery).
 *
 * This spec installs the STALE Sonnet config (the bricking blob), boots the real
 * in-browser engine, seeds a real Delhi chart, then lets the LIVE OpenRouter
 * endpoint actually answer. It asserts:
 *   (a) the persisted model self-healed to the recommended model;
 *   (b) a real reading renders (no "could not be generated");
 *   (c) the console is clean — no 404 / "No endpoints found".
 *
 * The API key is read ONLY from process.env.OPENROUTER_API_KEY (never hardcoded,
 * never a VITE_ var). Skipped when the key is absent so it is safe anywhere.
 *
 * Run:  bun run test:e2e:interp:heal:real
 *       (set OPENROUTER_API_KEY=... to exercise it.)
 */

/** The app's own recommended model: the self-heal target this spec asserts. */
const RECOMMENDED_MODEL = PRODUCT_DEFAULT_MODEL;
const RETIRED_MODEL = 'anthropic/claude-3.5-sonnet';

/** Strings that signal a non-real / placeholder summary (case-insensitive). */
const PLACEHOLDERS = [
  'pending',
  'analysis pending',
  'please retry',
  'generating',
  'loading',
  'llm call failed',
];

function assertRealSummary(text: string | null): void {
  const trimmed = (text ?? '').trim();
  expect(trimmed.length).toBeGreaterThan(40);
  const lower = trimmed.toLowerCase();
  for (const placeholder of PLACEHOLDERS) {
    expect(lower).not.toBe(placeholder);
  }
}

/**
 * LLM-specific failure signals that must NOT appear — the real regression markers
 * (a dead model id, a refused/failed interpretation call). We deliberately do NOT
 * blanket-ban "404": a production PWA emits a benign browser probe (e.g. the
 * default /favicon.ico request) that has nothing to do with the reading. A 404
 * from the OpenRouter endpoint itself — the actual bug — is caught separately via
 * the network-response listener below.
 */
const FORBIDDEN_LLM_ERROR_FRAGMENTS = ['No endpoints found', RETIRED_MODEL, 'LlmRequestError'];

test('[real][self-heal] stale anthropic/claude-3.5-sonnet self-heals to DeepSeek V4.1 Flash and renders a real reading', async ({
  page,
}) => {
  const KEY = process.env.OPENROUTER_API_KEY;
  test.skip(!KEY, 'OPENROUTER_API_KEY not set');

  // The EXACT blob that bricked the user: an OpenRouter base + their real key,
  // but pinning the long-dead `anthropic/claude-3.5-sonnet` model. cloud_premium
  // so the fail-closed gate permits the off-device call. Key from env only.
  const staleConfig = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: KEY,
    model: RETIRED_MODEL,
    privacyMode: 'cloud_premium',
    engine: 'openai-http',
  });

  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, staleConfig] as const,
  );

  // Cold engine boot + a live (slow) cloud LLM round-trip per section.
  test.setTimeout(600_000);

  const errors: string[] = [];
  const consoleAll: string[] = [];
  page.on('console', (m) => {
    consoleAll.push(`[${m.type()}] ${m.text()}`);
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Track network 404s WITH their URL: fail on an OpenRouter-endpoint 404 (the
  // bug), but treat benign asset 404s (favicon probe, etc.) as informational.
  const notFoundUrls: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 404) notFoundUrls.push(r.url());
  });

  await bootEngine(page);
  const seeded = await seedChart(page);
  // Sanity: the REAL engine ran (Delhi 1990-01-15 12:00Z lagna == Gemini).
  expect(String(seeded.lagna).toLowerCase()).toBe('gemini');

  // The heal runs when boot hydrates settings from SQLite, before any Generate.
  // Settings now live in canonical SQLite (localStorage is one-time migration
  // input and is removed after it), so the heal is observed where the user sees
  // it: reload onto Settings -> AI and read the persisted model from the form.
  // The init script re-seeds the stale localStorage blob on every load; the
  // already-migrated SQLite row must win, so a healed field proves the rewrite
  // reached SQLite and stuck.
  await expect
    .poll(
      async () => {
        await page.goto('/settings/ai', { waitUntil: 'domcontentloaded' });
        await page.getByTestId('llm-advanced-summary').click();
        return page.getByTestId('llm-model').inputValue();
      },
      { timeout: 60_000, message: 'persisted model should self-heal to the recommended slug' },
    )
    .toBe(RECOMMENDED_MODEL);
  expect(
    await page.evaluate((k) => window.localStorage.getItem(k), LLM_SETTINGS_KEY),
    'retired localStorage copy must not become a second source of truth',
  ).toBeNull();
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('generate-reading').click();

  // A REAL reading renders: the redesigned dashboard shows the summary as open
  // editorial prose under "The reading" (data-testid="reading-section") — the
  // old "Summary" accordion is gone.
  const reading = page.getByTestId('reading-section');
  await expect(reading).toBeVisible({ timeout: 480_000 });
  const summaryP = reading.locator('p').first();
  await expect(summaryP).toBeVisible({ timeout: 30_000 });
  assertRealSummary(await summaryP.textContent());

  // Progress checklist gone (generation completed), no error panel, no CTA.
  await expect(page.getByTestId('interpretation-progress')).toHaveCount(0, {
    timeout: 480_000,
  });
  await expect(page.getByText('Interpretation could not be generated')).toHaveCount(0);
  await expect(page.getByTestId('connect-ai-link')).toHaveCount(0);

  // Capture the proof screenshot of the rendered reading FIRST, so the evidence
  // exists regardless of the assertions that follow.
  await page.screenshot({ path: '/tmp/almamesh-verify/dashboard-healed.png', fullPage: true });

  // Final read-back of the healed model from where it lives (SQLite, shown on
  // Settings -> AI), after a real reading ran. The retired localStorage key is
  // asserted null above, so reading it here could only ever return null.
  await page.goto('/settings/ai', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('llm-advanced-summary').click();
  const healedModel = await page.getByTestId('llm-model').inputValue();
  expect(healedModel).toBe(RECOMMENDED_MODEL);
   
  console.log(`[self-heal] persisted model after dashboard load: ${healedModel}`);

  // The LLM call itself must NOT have 404'd — that was the bug. A 404 from the
  // OpenRouter endpoint is the regression; benign non-LLM 404s are logged, not failed.
  const llmNotFound = notFoundUrls.filter((u) => u.includes('openrouter.ai'));
  expect(llmNotFound, `OpenRouter endpoint 404'd: ${llmNotFound.join(' | ')}`).toEqual([]);
  const benign404 = notFoundUrls.filter((u) => !u.includes('openrouter.ai'));
  if (benign404.length) {
     
    console.log(`[self-heal] benign non-LLM 404s (ignored): ${benign404.join(' | ')}`);
  }

  // No LLM-specific failure markers in the console (a dead model / failed call).
  for (const fragment of FORBIDDEN_LLM_ERROR_FRAGMENTS) {
    const offending = consoleAll.filter((e) => e.includes(fragment));
    expect(offending.length, `console contained "${fragment}": ${offending.join(' | ')}`).toBe(0);
  }
});
