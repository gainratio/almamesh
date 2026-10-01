import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { bootEngine, seedChart, LLM_SETTINGS_KEY } from './interpretation.helpers';

/**
 * Current-timeline REAL integration test — REAL chart, LIVE OpenRouter.
 *
 * Guards the "Some timeline sections could not be generated: The road ahead"
 * regression: after the natal reading, the user asks for the current timeline
 * and BOTH timeline sections (The road ahead + the current sky) must render,
 * with no partial-failure notice and a clean console.
 *
 * Every OpenRouter response for the upcoming_periods section is saved to
 * test-results/ so a failure carries the raw model output, not just a symptom.
 *
 * Run:  OPENROUTER_API_KEY=... bunx playwright test --config=playwright.timeline.real.config.ts
 */

const MODEL = process.env.TIMELINE_REAL_MODEL ?? 'deepseek/deepseek-v4-pro';

test('[real] current timeline generates The road ahead against live OpenRouter', async ({ page }) => {
  const KEY = process.env.OPENROUTER_API_KEY;
  test.skip(!KEY, 'OPENROUTER_API_KEY not set');
  test.setTimeout(2_400_000);

  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: KEY,
    model: MODEL,
    privacyMode: 'cloud_premium',
    engine: 'openai-http',
  });
  await page.addInitScript(
    ([key, cfg]) => {
      window.localStorage.setItem(key as string, cfg as string);
    },
    [LLM_SETTINGS_KEY, config] as const,
  );

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e)}`));

  const roadAheadResponses: string[] = [];
  page.on('response', async (res) => {
    const body = res.request().postData() ?? '';
    if (!res.url().includes('openrouter.ai') || !body.includes('upcoming_periods')) return;
    try {
      roadAheadResponses.push(`HTTP ${res.status()}\nREQUEST ${body}\nRESPONSE ${await res.text()}`);
    } catch (err) {
      roadAheadResponses.push(`HTTP ${res.status()} (body unreadable: ${String(err)})`);
    }
  });

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // The timeline is generated on its own (explicit button), independent of the
  // natal reading, so the journey does not wait on the five natal sections.
  const generate = page.getByTestId('generate-timeline').or(page.getByTestId('regenerate-timeline'));
  await expect(generate).toBeEnabled({ timeout: 120_000 });
  await generate.click();

  const settled = page
    .getByTestId('current-timeline-section')
    .or(page.getByTestId('timeline-partial-failure'))
    .or(page.getByTestId('timeline-retry'));
  await expect(settled.first()).toBeVisible({ timeout: 1_200_000 });
  await expect(page.getByTestId('timeline-progress')).toHaveCount(0, { timeout: 1_200_000 });

  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/timeline-real-road-ahead-responses.txt', roadAheadResponses.join('\n\n----\n\n'));
  writeFileSync('test-results/timeline-real-console.txt', errors.join('\n'));
  await page.screenshot({ path: 'test-results/timeline-real-openrouter.png', fullPage: true });

  await expect(page.getByTestId('timeline-partial-failure')).toHaveCount(0);
  const section = page.getByTestId('current-timeline-section');
  await expect(section).toBeVisible();
  await expect(section).toContainText(/the road ahead/i);
  expect(errors.filter((e) => e.startsWith('[error]') || e.startsWith('[pageerror]'))).toEqual([]);
});
