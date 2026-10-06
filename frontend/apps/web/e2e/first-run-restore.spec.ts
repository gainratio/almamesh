import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

import {
  PASSPHRASE,
  expectCleanBrowser,
  expectDashboardChart,
  exportBackup,
  fakeThirdParties,
  forceDownloadAndFileInputPaths,
  gotoSettled,
  onboard,
  watchBrowser,
  type Native,
} from './portableInvariants.helpers';

/**
 * First-run restore — "I moved to a new phone; restore my backup."
 *
 * Browser A onboards a real person through the real UI (real engine) and
 * exports an encrypted .almamesh file. Browser B is a brand-new persistent
 * profile that has never run AlmaMesh: it opens `/`, clicks "Restore from a
 * backup" on the landing page, and must land on the dashboard showing the
 * restored person and chart, without being asked to make a safety copy of an
 * empty browser. A wrong file and a wrong password are refused on the way and
 * leave the browser empty.
 *
 * Run:  bunx playwright test --config=playwright.first-run-restore.config.ts
 */

const PERSON: Native = {
  name: 'Restore Ada',
  date: '08081988',
  time: '0644',
  meridiem: 'a',
  city: 'Bengaluru',
};

test.skip(
  ({ browserName }) => browserName === 'webkit' && process.platform === 'linux',
  'Linux Playwright WebKit has no nested-Worker OPFS',
);

function originOf(testInfo: TestInfo): string {
  return new URL(testInfo.project.use.baseURL as string).origin;
}

/**
 * Empty the origin before the app ever runs. macOS WebKit keeps website data
 * (OPFS included) outside the per-launch profile directory, so a "new" profile
 * could otherwise see browser A's data. robots.txt runs no app code.
 */
async function wipeOrigin(page: Page): Promise<void> {
  await page.goto('/robots.txt');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
    for (const db of await indexedDB.databases()) {
      if (db.name) {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(db.name as string);
          request.onsuccess = request.onerror = request.onblocked = resolve;
        });
      }
    }
    for (const key of await caches.keys()) await caches.delete(key);
    localStorage.clear();
    sessionStorage.clear();
  });
}

interface FreshBrowser {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly problems: ReturnType<typeof watchBrowser>;
  readonly downloads: string[];
  close(): Promise<void>;
}

/** A brand-new on-disk profile (WebKit refuses OPFS in an ephemeral context). */
async function freshBrowser(browser: Browser, testInfo: TestInfo): Promise<FreshBrowser> {
  const profileDir = await mkdtemp(join(tmpdir(), 'almamesh-first-run-restore-'));
  const webkit = browser.browserType().name() === 'webkit';
  const context = await browser.browserType().launchPersistentContext(profileDir, {
    baseURL: testInfo.project.use.baseURL,
    acceptDownloads: true,
    headless: true,
    // Playwright's WebKit does not route a service worker's fetches; block it
    // there so the geocoder fake is honoured (Chromium keeps its worker).
    ...(webkit ? { serviceWorkers: 'block' as const } : {}),
  });
  await forceDownloadAndFileInputPaths(context);
  await fakeThirdParties(context);
  const problems = watchBrowser(context, originOf(testInfo));
  const page = context.pages()[0] ?? (await context.newPage());
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await wipeOrigin(page);
  return {
    context,
    page,
    problems,
    downloads,
    close: async () => {
      await context.close();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

async function chooseOnLanding(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Restore from a backup' }).click(),
  ]);
  await chooser.setFiles(file);
}

test('a brand-new browser restores a backup from the landing page and opens the dashboard', async ({ browser }, testInfo) => {
  const exportPath = testInfo.outputPath('first-run.almamesh');

  const a = await freshBrowser(browser, testInfo);
  await test.step('browser A: onboard a real person and export', async () => {
    await gotoSettled(a.page, '/onboarding');
    await onboard(a.page, PERSON);
    await exportBackup(a.page, exportPath);
    expectCleanBrowser(a.problems, 'browser A');
  });
  await a.close();

  const b = await freshBrowser(browser, testInfo);
  const page = b.page;
  await test.step('browser B: the landing offers restore before any chart exists', async () => {
    await gotoSettled(page, '/');
    await expect(page.getByTestId('hero-cta')).toContainText('Generate my chart');
    await expect(page.getByRole('button', { name: 'Restore from a backup' })).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  await test.step('a file that is not a backup is refused inline; the browser stays empty', async () => {
    const junk = testInfo.outputPath('not-a-backup.txt');
    writeFileSync(junk, 'hello, this is not an AlmaMesh backup');
    await chooseOnLanding(page, junk);
    await expect(page.getByTestId('first-run-restore-error')).toContainText("isn't an AlmaMesh backup");
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.getByTestId('hero-cta')).toContainText('Generate my chart');
  });

  await test.step('a wrong password is refused; nothing is imported', async () => {
    await chooseOnLanding(page, exportPath);
    await page.getByTestId('backup-passphrase-prompt-input').fill('not the password at all');
    await page.getByTestId('backup-passphrase-prompt-submit').click();
    await expect(page.getByRole('alert')).toContainText('Wrong password');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  await test.step('the right password restores without a safety copy and opens the dashboard', async () => {
    await page.getByTestId('backup-passphrase-prompt-input').fill(PASSPHRASE);
    await page.getByTestId('backup-passphrase-prompt-submit').click();
    const confirm = page.getByTestId('backup-confirm-import');
    await expect(confirm).toBeVisible();
    await expect(page.getByText(/nothing on this browser yet/i)).toBeVisible();
    await expect(page.getByTestId('backup-safety-passphrase-input')).toHaveCount(0);
    await Promise.all([page.waitForURL('**/dashboard', { timeout: 120_000 }), confirm.click()]);
    await expectDashboardChart(page, PERSON.name);
    expect(b.downloads, 'an empty browser has nothing to back up first').toEqual([]);
  });

  await test.step('the restored browser stays restored across a reload', async () => {
    await page.waitForLoadState('networkidle');
    await gotoSettled(page, '/');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/dashboard');
    await expectDashboardChart(page, PERSON.name);
    expectCleanBrowser(b.problems, 'browser B');
  });
  await b.close();
});
