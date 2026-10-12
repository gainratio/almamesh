import { expect, test, type BrowserContext, type Page } from '@playwright/test';

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

/**
 * Headless Chromium has the File System Access pickers, which no test can
 * drive; without them the app falls back to a plain download and file input.
 */
function removeFilePickers(): void {
  for (const target of [window, Window.prototype]) {
    Reflect.deleteProperty(target, 'showSaveFilePicker');
    Reflect.deleteProperty(target, 'showOpenFilePicker');
  }
}

async function privateContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(refuseOpfs);
  await context.addInitScript(removeFilePickers);
}

const PASSPHRASE = 'private-window-passphrase';

test.beforeEach(async ({ context }) => {
  await privateContext(context);
});

/** Settings > Data export, reached in-app: a reload would empty in-memory SQLite. */
async function exportBackup(page: Page, path: string): Promise<void> {
  await expect(page.getByTestId('backup-export-button')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('backup-passphrase-input').fill(PASSPHRASE);
  await page.getByTestId('backup-passphrase-confirm-input').fill(PASSPHRASE);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByTestId('backup-export-button').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^almamesh-backup-.*\.almamesh$/);
  expect(await download.failure()).toBeNull();
  await download.saveAs(path);
  // The download fallback cannot see the file land, so it says so honestly.
  await expect(page.getByTestId('backup-status')).toHaveText(/^Backup download/);
  await expect(page.getByTestId('backup-error')).toHaveCount(0);
}

/** Settings > Data import of `path` into an empty browser. */
async function importBackup(page: Page, path: string): Promise<void> {
  await expect(page.getByTestId('backup-import-button')).toBeVisible({ timeout: 60_000 });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('backup-import-button').click(),
  ]);
  await chooser.setFiles(path);
  await page.getByTestId('backup-passphrase-prompt-input').fill(PASSPHRASE);
  await page.getByTestId('backup-passphrase-prompt-submit').click();
  await page.getByTestId('backup-confirm-import').click();
}

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

test('OPFS refused: onboarding reaches a chart, the backup the notice asks for exports, and it restores into a fresh private window', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(420_000);
  const errors = collectConsoleErrors(page);
  await page.goto('/onboarding');
  await expect(page.getByTestId('in-memory-storage-notice')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('storage-blocked-notice')).toHaveCount(0);
  await expectChartRenders(page);
  const notice = page.getByTestId('in-memory-storage-notice');
  await expect(notice).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('private-mode-dashboard.png'), fullPage: true });

  // The notice says "Export a backup to keep it": follow it and do exactly that.
  const backupPath = test.info().outputPath('private-mode-backup.almamesh');
  await notice.getByRole('link').click();
  await expect(page).toHaveURL(/\/settings\/data$/);
  await exportBackup(page, backupPath);
  await page.screenshot({ path: test.info().outputPath('private-mode-export.png'), fullPage: true });
  expect(errors).toEqual([]);

  // A second private window starts empty and gets the person back from the file.
  const fresh = await browser.newContext({ baseURL, acceptDownloads: true });
  await privateContext(fresh);
  const restored = await fresh.newPage();
  const restoredErrors = collectConsoleErrors(restored);
  await restored.goto('/settings/data');
  await expect(restored.getByTestId('in-memory-storage-notice')).toBeVisible({ timeout: 30_000 });
  await importBackup(restored, backupPath);
  // Restored in place: a reload would empty in-memory SQLite and lose it again.
  await expect(restored.getByTestId('backup-status')).toHaveText(/^Restored\. This tab still keeps nothing/, {
    timeout: 120_000,
  });
  await restored.getByRole('link', { name: /Back to Dashboard/ }).click();
  await expect(restored.getByTestId('identity-strip')).toContainText('Reference Native', { timeout: 120_000 });
  await expect(restored.getByTestId('chart-visualization').first()).toBeVisible();
  await expect(restored.getByTestId('in-memory-storage-notice')).toBeVisible();
  await restored.screenshot({ path: test.info().outputPath('private-mode-restored.png'), fullPage: true });
  expect(restoredErrors).toEqual([]);
  await fresh.close();
});
