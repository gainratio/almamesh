import { expect, test } from '@playwright/test';

import { collectConsoleErrors, expectChartRenders } from './live/liveJourney';

/**
 * Safari Private Browsing: `navigator.storage.getDirectory()` exists but
 * rejects. A default (ephemeral) Playwright WebKit context already refuses
 * OPFS the same way; the init script makes Chromium refuse it too, so both
 * projects prove one contract (rule 2026-10-11): SQLite runs in memory, the
 * app is usable, and it says plainly that nothing is kept. Never the
 * BlockedStartup wall.
 */
function refuseOpfs(): void {
  StorageManager.prototype.getDirectory = function getDirectory() {
    return Promise.reject(new DOMException(
      'The operation failed for an unknown transient reason (e.g. out of memory).',
      'UnknownError',
    ));
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(refuseOpfs);
});

test('OPFS refused: the home page runs in memory with the notice, not the block screen', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  const notice = page.getByTestId('in-memory-storage-notice');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText('This browser is not saving your data.');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByTestId('storage-blocked-notice')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('private-mode-home.png'), fullPage: true });

  // Settings > Data is where the notice sends people to export.
  await notice.getByRole('link').click();
  await expect(page).toHaveURL(/\/settings\/data$/);
  await expect(page.getByTestId('storage-blocked-notice')).toHaveCount(0);
  // Nothing falls back to IndexedDB: SQLite is the only store.
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name))).toEqual([]);
  expect(errors).toEqual([]);
});

test('OPFS refused: onboarding reaches a rendered chart on in-memory SQLite', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectConsoleErrors(page);
  await page.goto('/onboarding');
  await expect(page.getByTestId('in-memory-storage-notice')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('storage-blocked-notice')).toHaveCount(0);
  await expectChartRenders(page);
  await expect(page.getByTestId('in-memory-storage-notice')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('private-mode-dashboard.png'), fullPage: true });
  expect(errors).toEqual([]);
});
