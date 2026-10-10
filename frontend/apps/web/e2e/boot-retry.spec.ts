/**
 * The engine recovers from a one-off boot fault without user action.
 *
 * On a hooks build (VITE_EXIT_GATE_HOOKS=1), arming
 * `window.__almameshArmBootWasmFault` makes the FIRST boot's Pyodide Worker
 * execute a wasm `unreachable`: a real WebAssembly.RuntimeError, the class
 * WebKit raised on a cold compile ("Out of bounds memory access"). The runtime
 * must log one `engine.boot_retry` line, boot a fresh Worker, and the real
 * onboarding must reach a rendered chart with no recovery card ever shown and
 * an otherwise clean console.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test as base, webkit, type Page } from '@playwright/test';

const RETRY_LINE = '[almamesh] engine.boot_retry error=RuntimeError';
const RECOVERY_CARD = '[data-testid="reset-app-data-button"]';

/**
 * WebKit needs an on-disk profile: a default WebKit context is an ephemeral
 * store that refuses OPFS, and SQLite on OPFS is the app's only store. macOS
 * WebKit shares OPFS across profiles, so the origin is wiped first.
 */
const test = base.extend({
  context: async ({ browserName, context, baseURL, viewport, userAgent, serviceWorkers }, provide) => {
    if (browserName !== 'webkit') {
      await provide(context);
      return;
    }
    const profile = await mkdtemp(join(tmpdir(), 'almamesh-boot-retry-'));
    const persistent = await webkit.launchPersistentContext(profile, {
      baseURL, viewport, userAgent, serviceWorkers, headless: true,
    });
    try {
      const page = persistent.pages()[0] ?? (await persistent.newPage());
      await page.goto('/robots.txt');
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
        for (const name of names) await root.removeEntry(name, { recursive: true });
        for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
        localStorage.clear();
      });
      await provide(persistent);
    } finally {
      await persistent.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
  page: async ({ context }, provide) => {
    await provide(context.pages()[0] ?? (await context.newPage()));
  },
});

async function typeSections(page: Page, testId: string, digits: string, trailing?: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 50 });
  if (trailing) await page.keyboard.type(trailing, { delay: 50 });
}

test('a wasm trap on the first boot is retried once in a fresh Worker; the chart renders', async ({ page }) => {
  const consoleLines: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    consoleLines.push(message.text());
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.addInitScript((card) => {
    (window as unknown as Record<string, unknown>).__almameshArmBootWasmFault = true;
    // Record the recovery card if it is EVER rendered, not only at the end.
    const seen = (): void => {
      if (document.querySelector(card)) (window as unknown as Record<string, unknown>).__recoveryCardSeen = true;
    };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true });
  }, RECOVERY_CARD);

  await page.goto('/onboarding');
  await expect.poll(() => consoleLines.filter((line) => line.includes('engine.boot_retry'))).toEqual([RETRY_LINE]);

  await page.getByTestId('name-input').fill('Reference Native');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', '08081988');
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill('Bengaluru');
  await page.locator('[role="option"]').first().click();
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', '0644', 'a');
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();

  await page.waitForURL('**/dashboard', { timeout: 120_000 });
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('dashboard-after-boot-retry.png') });

  expect(consoleLines.filter((line) => line.includes('engine.boot_retry'))).toEqual([RETRY_LINE]);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__recoveryCardSeen ?? false)).toBe(false);
  expect(consoleErrors).toEqual([]);
});
