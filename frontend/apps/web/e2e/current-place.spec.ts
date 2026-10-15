import { mkdirSync } from 'node:fs';

import { expect, type Page, type TestInfo } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { stubModelCatalog } from './modelCatalog.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { captureReloadConsole } from './reloadConsole';
import { test } from './webkitProfile';

/**
 * "Where do you live now?" (feat/current-place): set once in Profile settings
 * with the shared on-device place box, it persists across a reload and the
 * time-travel "Where?" box offers it as a one-click suggestion next to the
 * birth place. Picking and saving it sends nothing over the network.
 * Chromium only: the place box is the same on every engine.
 */
const NOVATO = 'Novato, California, United States';
const DESKTOP_SHOT = 'test-results/current-place-settings-desktop.png';
const PHONE_SHOT = 'test-results/current-place-settings-390.png';
const SHEET_SHOT = 'test-results/current-place-time-travel.png';
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
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

/** Every request the page makes from now on. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

test.skip(({ browserName }) => browserName !== 'chromium', 'The place box is engine-independent; one project is enough.');
test.describe.configure({ timeout: 600_000 });

test('[contract] "novato, ca" set in Profile settings persists across a reload and is offered in time travel', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/settings/profile');

  const row = page.getByTestId('current-place');
  const input = page.getByTestId('current-place-input');
  await expect(page.getByLabel('Where do you live now?')).toBeVisible();
  await expect(input, 'unset: nothing assumed, not even the birth place').toHaveValue('');

  const origin = new URL(page.url()).origin;
  const typing = recordRequests(page);
  await input.pressSequentially('novato, ca');
  await expect(page.getByTestId('current-place-option-0')).toHaveText(NOVATO, { timeout: 60_000 });
  expect(typing.filter((url) => !url.startsWith(origin)), 'the city search stays on this device').toEqual([]);

  const saving = recordRequests(page);
  await input.press('Enter');
  await expect(input).toHaveValue(NOVATO);
  await expect(page.getByTestId('current-place-clear')).toBeVisible();
  await expect(page.getByTestId('current-place-status')).toHaveText('Saved');
  await page.waitForTimeout(1_000);
  expect(saving, 'picking and saving the place makes no network request at all').toEqual([]);
  mkdirSync('test-results', { recursive: true });
  await row.screenshot({ path: DESKTOP_SHOT });

  await page.reload();
  await expect(page.getByTestId('current-place-input'), 'it persists in SQLite across a reload').toHaveValue(NOVATO, { timeout: 60_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({ path: PHONE_SHOT });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'no horizontal scroll at 390px').toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });

  await gotoSettled(page, '/dashboard');
  await waitForLifeAtlasAsOf(page);
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await page.getByTestId('time-travel-button').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
  await page.getByTestId('time-travel-tab-month').click();
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue('');
  const home = page.getByTestId('time-travel-where-home');
  await expect(home).toHaveText(`Use ${NOVATO} (where you live now)`);
  await expect(page.getByTestId('time-travel-where-suggestion'), 'the birth place is still offered beside it').toBeVisible();
  await page.getByTestId('time-travel-sheet').screenshot({ path: SHEET_SHOT });
  await home.click();
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue(NOVATO);
  await expect(page.getByTestId('time-travel-go')).toBeEnabled();

  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

/**
 * "Saved" means on disk (2026-10-14). It used to show the moment the place changed in memory, before
 * the SQLite write, and a reload right after it lost the place. Every worker message (the SQLite
 * write among them) is held while the place is picked: "Saved" must not show until they are
 * released and the write commits; then a reload at once keeps the place.
 */
test('[contract] "Saved" shows only after the place is on disk, and a reload right after it keeps the place', async ({ page }, testInfo) => {
  const consoleErrors = await prepare(page, testInfo);
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    const held: Array<[Worker, Parameters<Worker['postMessage']>]> = [];
    const w = window as unknown as { __holdWrites: boolean; __releaseWrites: () => void };
    w.__holdWrites = false;
    w.__releaseWrites = () => {
      w.__holdWrites = false;
      for (const [worker, args] of held.splice(0)) post.apply(worker, args);
    };
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      if (w.__holdWrites) {
        held.push([this, args]);
        return;
      }
      return post.apply(this, args);
    } as Worker['postMessage'];
  });
  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/settings/profile');
  const shots = process.env.TRAVELFIX_SHOTS ?? 'test-results';
  mkdirSync(shots, { recursive: true });

  const input = page.getByTestId('current-place-input');
  const status = page.getByTestId('current-place-status');
  await input.pressSequentially('novato, ca');
  await expect(page.getByTestId('current-place-option-0')).toHaveText(NOVATO, { timeout: 60_000 });
  await page.evaluate(() => { (window as unknown as { __holdWrites: boolean }).__holdWrites = true; });
  await input.press('Enter');
  await expect(input).toHaveValue(NOVATO);
  await page.waitForTimeout(1_500);
  await expect(status, '"Saved" waits for the SQLite write').not.toHaveText('Saved');

  await page.evaluate(() => (window as unknown as { __releaseWrites: () => void }).__releaseWrites());
  await expect(status).toHaveText('Saved', { timeout: 30_000 });
  const row = page.getByTestId('current-place');
  await row.screenshot({ path: `${shots}/settings-saved-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await row.screenshot({ path: `${shots}/settings-saved-390.png` });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.reload();
  await expect(page.getByTestId('current-place-input'), 'a reload right after "Saved" keeps the place').toHaveValue(NOVATO, { timeout: 60_000 });
  await row.screenshot({ path: `${shots}/settings-after-reload-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await row.screenshot({ path: `${shots}/settings-after-reload-390.png` });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
