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

async function prepare(page: Page, testInfo: TestInfo, pinFullTier = true): Promise<string[]> {
  const capture = captureReloadConsole(page, testInfo);
  if (pinFullTier) {
    await page.addInitScript((tier) => {
      for (const [name, value] of Object.entries(tier)) {
        Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
      }
    }, FULL_TIER);
  }
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  await stubModelCatalog(page);
  return capture.errors;
}

test.describe.configure({ timeout: 360_000 });

test('Dashboard varga switcher, Context Bar location, 7-day Panchang & D60 Kundli cards, and instant search work end-to-end', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  const appOrigin = new URL(testInfo.project.use.baseURL ?? 'http://127.0.0.1:4299').origin;
  const offOrigin: string[] = [];
  const modelPaths: string[] = [];
  page.context().on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/models/')) modelPaths.push(url.pathname);
    if (url.origin !== appOrigin && url.origin !== PROVIDER_ORIGIN) offOrigin.push(req.url());
  });

  let mode: 'weekly' | 'd60' = 'weekly';
  await page.route(`${LLM_CONFIG.apiBase}/chat/completions`, async (route) => {
    const body = chatToolBody(route.request().postData());
    if (!body) return fulfillEmpty(route);
    if (mode === 'weekly') {
      return fulfillReadThenAnswer(
        route, body, readPeriodArgs('this_week', { focus: 'panchang' }),
        'Your seven-day outlook in Novato balances steady Lunar Tarabala windows.',
      );
    }
    if (toolResults(body).some((r) => r.name === 'read_varga')) {
      return fulfillToolCall(route, { name: 'answer', args: generalAnswer('In your D60 Shashtiamsa chart, subtle karmic placements refine your Rasi promise.') });
    }
    return fulfillToolCall(route, { name: 'read_varga', args: { division: 'D60', focus_planets: null } });
  });

  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await waitForLifeAtlasAsOf(page);
  await expect(page.getByTestId('dashboard-varga-switcher')).toBeVisible();
  await page.getByTestId('dashboard-varga-D9').click();
  await expect(page.getByTestId('dashboard-varga-D9')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('dashboard-varga-D60').click();
  await expect(page.getByTestId('dashboard-varga-D60')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => document.documentElement.classList.add('light'));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.evaluate(() => document.documentElement.classList.remove('light'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('dashboard-guide-ask-vargas').click();
  await expect(page.getByTestId('chat-context-bar')).toBeVisible();
  await expect(page.getByTestId('chat-specialist-pill')).toHaveAttribute('data-specialist', 'natal_varga');
  await page.getByTestId('chat-location-chip').click();
  await page.getByTestId('chat-context-place-input').pressSequentially('novato, ca');
  await expect(page.getByTestId('chat-context-place-option-0')).toHaveText(NOVATO, { timeout: 60_000 });
  await page.getByTestId('chat-context-place-input').press('Enter');
  await expect(page.getByTestId('chat-location-chip')).toContainText('Novato, California');
  mode = 'weekly';
  await page.getByTestId('chat-input').fill('What is my status for this week?');
  await page.getByTestId('chat-input').press('Enter');
  const weeklyCard = page.getByTestId('tool-card-weekly-outlook');
  await expect(weeklyCard).toBeVisible({ timeout: 60_000 });
  await expect(weeklyCard.locator('[data-testid^="weekly-day-"]')).toHaveCount(7);
  mode = 'd60';
  await page.getByTestId('chat-input').fill('Inspect my D60 Shashtiamsa chart');
  await page.getByTestId('chat-input').press('Enter');
  const vargaCard = page.getByTestId('tool-card-varga-chart');
  await expect(vargaCard).toBeVisible({ timeout: 60_000 });
  await expect(vargaCard).toHaveAttribute('data-varga', 'D60');
  expect(await vargaCard.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

  const modelsBeforeSearch = modelPaths.length;
  await page.getByTestId('chat-search-input').fill('Shashtiamsa');
  await expect(page.getByTestId('chat-search-results').locator('mark').first()).toContainText(/Shashtiamsa/i);
  expect(modelPaths.length).toBe(modelsBeforeSearch);
  expect(offOrigin).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('[contract/iphone] @iphone returning iPhone visitor reload + Low Power Mode worker crash still serves "outlook today?", 7-day Panchang, and D60 Kundli', async ({ page }, testInfo) => {
  await prepare(page, testInfo, false);
  let turn: 'seed' | 'today' | 'week' | 'd60' = 'seed';
  await page.route(`${LLM_CONFIG.apiBase}/chat/completions`, async (route) => {
    const body = chatToolBody(route.request().postData());
    if (!body) return fulfillEmpty(route);
    if (toolResults(body).some((r) => r.content.includes('"available":false'))) {
      return fulfillToolCall(route, { name: 'answer', args: generalAnswer('Day reading unavailable.') });
    }
    if (turn === 'seed') return fulfillToolCall(route, { name: 'answer', args: generalAnswer('Saturn builds steady foundations.') });
    if (turn === 'today') return fulfillReadThenAnswer(route, body, readPeriodArgs('today', { place: 'Novato, CA' }), 'Your outlook today in Novato is grounded in calculated timing.');
    if (turn === 'week') return fulfillReadThenAnswer(route, body, readPeriodArgs('this_week', { focus: 'panchang' }), 'Your week ahead in Novato tracks seven daily Panchang marks.');
    if (toolResults(body).some((r) => r.name === 'read_varga')) {
      return fulfillToolCall(route, { name: 'answer', args: generalAnswer('Your D60 Shashtiamsa refines your natal promise.') });
    }
    return fulfillToolCall(route, { name: 'read_varga', args: { division: 'D60', focus_planets: null } });
  });

  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await waitForLifeAtlasAsOf(page);
  await page.getByTestId('floating-chat-button').click();
  await page.getByTestId('chat-location-chip').click();
  await page.getByTestId('chat-context-place-input').pressSequentially('novato, ca');
  await expect(page.getByTestId('chat-context-place-option-0')).toHaveText(NOVATO, { timeout: 60_000 });
  await page.getByTestId('chat-context-place-input').press('Enter');
  await expect(page.getByTestId('chat-location-chip')).toContainText('Novato, California');
  await expect(page.getByTestId('chat-location-chip')).toHaveAttribute('data-saving', 'false');
  const barBox = await page.getByTestId('chat-context-bar').boundingBox();
  expect(barBox?.height ?? 99).toBeLessThanOrEqual(48);

  await page.getByTestId('chat-input').fill('my chart appears to be very weak like tesla');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-viewport')).toContainText('Saturn builds steady foundations.');

  await page.addInitScript(() => {
    let crashed = false;
    window.Worker = new Proxy(window.Worker, {
      construct(Target, args: [string | URL, WorkerOptions?]) {
        const worker = Reflect.construct(Target, args) as Worker;
        if (!String(args[0]).includes('chartWorker') || crashed) return worker;
        const post = worker.postMessage.bind(worker);
        worker.postMessage = ((req: { kind: string }, transfer?: Transferable[] | StructuredSerializeOptions) => {
          if (!crashed && (req.kind === 'computePredictive' || req.kind === 'computeMoonWindow')) {
            crashed = true;
            queueMicrotask(() => worker.dispatchEvent(new ErrorEvent('error', { message: 'WebKit Low Power Mode worker jetsam' })));
            return;
          }
          if (Array.isArray(transfer)) post(req, transfer); else post(req, transfer);
        }) as Worker['postMessage'];
        return worker;
      },
    });
  });

  await page.reload();
  await expect(page.getByTestId('floating-chat-button')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('floating-chat-button').click();
  await expect(page.getByTestId('chat-location-chip')).toContainText('Novato, California');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  turn = 'today';
  await page.getByTestId('chat-input').fill('outlook today?');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-viewport')).toContainText('Your outlook today in Novato is grounded in calculated timing.', { timeout: 180_000 });
  await expect(page.locator('[data-testid="chat-tool-call"][data-tool-name="read_period"]').first()).toHaveAttribute('data-status', 'complete');
  await expect(page.getByTestId('tool-card-weekly-outlook').first()).toBeVisible();

  turn = 'week';
  await page.getByTestId('chat-input').fill('What is my status for this week?');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-viewport')).toContainText('Your week ahead in Novato tracks seven daily Panchang marks.', { timeout: 180_000 });
  await expect(page.getByTestId('tool-card-weekly-outlook').nth(1).locator('[data-testid^="weekly-day-"]')).toHaveCount(7);

  turn = 'd60';
  await page.getByTestId('chat-input').fill('Inspect my D60 Shashtiamsa chart');
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('tool-card-varga-chart')).toBeVisible({ timeout: 180_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('iphone-outlook-today-recovered.png') });
});
