import { expect, type Page, type TestInfo } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { stubModelCatalog } from './modelCatalog.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { captureReloadConsole } from './reloadConsole';
import {
  chatToolBody,
  fulfillEmpty,
  fulfillReadThenAnswer,
  fulfillToolCall,
  generalAnswer,
  readPeriodArgs,
  toolResults,
} from './stubChatProvider';
import { test } from './webkitProfile';

const NOVATO = 'Novato, California, United States';
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
const PROVIDER_ORIGIN = new URL(LLM_CONFIG.apiBase).origin;
const FULL_TIER = { deviceMemory: 8, hardwareConcurrency: 8 };

async function prepare(page: Page, testInfo: TestInfo): Promise<string[]> {
  const capture = captureReloadConsole(page, testInfo);
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  await stubModelCatalog(page);
  return capture.errors;
}

test.describe.configure({ timeout: 300_000 });

test('Dashboard varga switcher, Context Bar location, 7-day Panchang & D60 Kundli cards, and instant search work end-to-end', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  const appOrigin = new URL(testInfo.project.use.baseURL ?? 'http://127.0.0.1:4299').origin;
  const offOrigin: string[] = [];
  const modelPaths: string[] = [];
  page.context().on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/models/')) modelPaths.push(url.pathname);
    if (url.origin !== appOrigin && url.origin !== PROVIDER_ORIGIN) {
      offOrigin.push(req.url());
    }
  });

  let mode: 'weekly' | 'd60' = 'weekly';
  await page.route(`${LLM_CONFIG.apiBase}/chat/completions`, async (route) => {
    const body = chatToolBody(route.request().postData());
    if (!body) return fulfillEmpty(route);
    if (mode === 'weekly') {
      return fulfillReadThenAnswer(
        route,
        body,
        readPeriodArgs('this_week', { focus: 'panchang' }),
        'Your seven-day outlook in Novato balances steady Lunar Tarabala windows.',
      );
    }
    const results = toolResults(body);
    if (results.some((r) => r.name === 'read_varga')) {
      return fulfillToolCall(route, {
        name: 'answer',
        args: generalAnswer('In your D60 Shashtiamsa chart, subtle karmic placements refine your Rasi promise.'),
      });
    }
    return fulfillToolCall(route, {
      name: 'read_varga',
      args: { division: 'D60', focus_planets: null },
    });
  });

  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await waitForLifeAtlasAsOf(page);

  // 1. Dashboard D1 / D9 / D60 Kundli switcher + light/dark + mobile viewport
  await expect(page.getByTestId('dashboard-varga-switcher')).toBeVisible();
  await page.getByTestId('dashboard-varga-D9').click();
  await expect(page.getByTestId('dashboard-varga-D9')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('dashboard-varga-D60').click();
  await expect(page.getByTestId('dashboard-varga-D60')).toHaveAttribute('aria-pressed', 'true');

  // Verify light theme toggle and mobile 390px overflow = 0
  await page.evaluate(() => document.documentElement.classList.add('light'));
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(mobileOverflow).toBeLessThanOrEqual(0);
  await page.evaluate(() => document.documentElement.classList.remove('light'));
  await page.setViewportSize({ width: 1280, height: 900 });

  // 2. Quick-launch strip opens Guide drawer with specialist routing
  await page.getByTestId('dashboard-guide-ask-vargas').click();
  await expect(page.getByTestId('chat-context-bar')).toBeVisible();
  await expect(page.getByTestId('chat-specialist-pill')).toHaveAttribute('data-specialist', 'natal_varga');

  // 3. Context Bar location chip sets Novato, CA on-device and persists
  await page.getByTestId('chat-location-chip').click();
  await expect(page.getByTestId('chat-location-popover')).toBeVisible();
  const locInput = page.getByTestId('chat-context-place-input');
  await locInput.pressSequentially('novato, ca');
  await expect(page.getByTestId('chat-context-place-option-0')).toHaveText(NOVATO, { timeout: 60_000 });
  await locInput.press('Enter');
  await expect(page.getByTestId('chat-location-chip')).toContainText('Novato, California');

  // 4. Multi-day "status for this week" turn -> real Python 7-day Panchang -> WeeklyOutlookCard
  mode = 'weekly';
  const composer = page.getByTestId('chat-input');
  await composer.fill('What is my status for this week?');
  await composer.press('Enter');
  const weeklyCard = page.getByTestId('tool-card-weekly-outlook');
  await expect(weeklyCard).toBeVisible({ timeout: 60_000 });
  await expect(weeklyCard.locator('[data-testid^="weekly-day-"]')).toHaveCount(7);
  await expect(page.getByTestId('chat-viewport')).toContainText('seven-day outlook in Novato');

  // 5. D60 predictive turn -> real Python computeVargaDetail -> VargaChartCard with Kundli SVG
  mode = 'd60';
  await composer.fill('Inspect my D60 Shashtiamsa chart');
  await composer.press('Enter');
  const vargaCard = page.getByTestId('tool-card-varga-chart');
  await expect(vargaCard).toBeVisible({ timeout: 60_000 });
  await expect(vargaCard).toHaveAttribute('data-varga', 'D60');
  await expect(page.getByTestId('varga-card-kundli').locator('svg')).toBeVisible();
  await expect(page.getByTestId('varga-lagna-amsa')).toContainText('Lagna Amsa #');
  const cardOverflow = await vargaCard.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(cardOverflow, 'VargaChartCard has zero horizontal clipping inside the drawer').toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/agentic-chat-vargas-desktop.png' });

  // 6. Instant Phase-1 FTS5 ChatSearch finds messages with <mark> highlight and zero /models/ download
  const modelsBeforeSearch = modelPaths.length;
  const searchInput = page.getByTestId('chat-search-input');
  await searchInput.fill('Shashtiamsa');
  const searchResults = page.getByTestId('chat-search-results');
  await expect(searchResults).toBeVisible();
  await expect(searchResults.locator('mark').first()).toContainText(/Shashtiamsa/i);
  expect(modelPaths.length, 'Phase 1 lexical search does not force MiniLM download').toBe(modelsBeforeSearch);

  expect(offOrigin, 'zero unexpected off-origin requests').toEqual([]);
  expect(consoleErrors, 'clean browser console').toEqual([]);
});
