import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createSharedFakeGoogleDrive, type SharedFakeGoogleDrive } from './driveFake';
import {
  expectCleanBrowser,
  expectDashboardChart,
  fakeThirdParties,
  forceDownloadAndFileInputPaths,
  gotoSettled,
  onboard,
  PASSPHRASE,
  spaNavigate,
  watchBrowser,
  type Native,
} from './portableInvariants.helpers';

const PERSON: Native = {
  name: 'Drive Priya',
  date: '08081988',
  time: '0644',
  meridiem: 'a',
  city: 'Bengaluru',
};

const CANARIES = ['Drive Priya', '1988', 'Bengaluru', PASSPHRASE] as const;

test.skip(
  ({ browserName }) => browserName === 'webkit' && process.platform === 'linux',
  'Linux Playwright WebKit has no nested-Worker OPFS',
);

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
          const req = indexedDB.deleteDatabase(db.name as string);
          req.onsuccess = req.onerror = req.onblocked = resolve;
        });
      }
    }
    for (const key of await caches.keys()) await caches.delete(key);
    localStorage.clear();
    sessionStorage.clear();
  });
}

async function openDevice(
  browser: Browser,
  testInfo: TestInfo,
  fakeDrive: SharedFakeGoogleDrive,
): Promise<{ context: BrowserContext; page: Page; problems: ReturnType<typeof watchBrowser>; close(): Promise<void> }> {
  const profileDir = await mkdtemp(join(tmpdir(), 'almamesh-drive-backup-'));
  const webkit = browser.browserType().name() === 'webkit';
  const context = await browser.browserType().launchPersistentContext(profileDir, {
    baseURL: testInfo.project.use.baseURL,
    acceptDownloads: true,
    headless: true,
    ...(webkit ? { serviceWorkers: 'block' as const } : {}),
  });
  await forceDownloadAndFileInputPaths(context);
  await fakeThirdParties(context);
  await fakeDrive.attach(context);
  const origin = new URL(testInfo.project.use.baseURL as string).origin;
  const problems = watchBrowser(context, origin);
  const page = context.pages()[0] ?? (await context.newPage());
  await wipeOrigin(page);
  return {
    context,
    page,
    problems,
    close: async () => {
      await context.close();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

test('device A backs up encrypted chart to Google Drive (incl. silent renewal) and device B restores it cleanly', async ({
  browser,
}, testInfo) => {
  const sharedDrive = createSharedFakeGoogleDrive();

  const deviceA = await openDevice(browser, testInfo, sharedDrive);
  await test.step('device A: onboard real chart, connect Google Drive, back up, and verify silent renewal', async () => {
    await gotoSettled(deviceA.page, '/onboarding');
    await onboard(deviceA.page, PERSON);
    expect(sharedDrive.log).toHaveLength(0);

    await spaNavigate(deviceA.page, '/settings/data');
    await expect(deviceA.page.getByTestId('drive-connect-button')).toBeVisible();
    await deviceA.page.getByTestId('drive-connect-button').click();
    await expect(deviceA.page.getByTestId('drive-backup-now-button')).toBeVisible();

    await deviceA.page.getByTestId('drive-backup-now-button').click();
    await deviceA.page.getByTestId('drive-passphrase-input').fill(PASSPHRASE);
    await deviceA.page.getByTestId('drive-passphrase-confirm-input').fill(PASSPHRASE);
    await deviceA.page.getByTestId('drive-passphrase-submit').click();
    await expect(deviceA.page.getByTestId('drive-status')).toContainText('verified');
    await expect(deviceA.page.getByTestId('drive-backup-row')).toHaveCount(1);

    // Simulate 1 h token expiry -> clicking Refresh triggers one silent prompt=none bounce and recovers!
    await deviceA.page.evaluate(async () => {
      await window.__almameshExpireDriveToken?.();
    });
    await deviceA.page.getByTestId('drive-refresh-button').click();
    await expect.poll(() => sharedDrive.silentAuthCount).toBe(1);
    await expect(deviceA.page.getByTestId('drive-backup-row')).toHaveCount(1);
    expectCleanBrowser(deviceA.problems, 'device A');
  });
  await deviceA.close();

  const deviceB = await openDevice(browser, testInfo, sharedDrive);
  await test.step('device B: fresh browser restores from Google Drive on landing and renders chart', async () => {
    await gotoSettled(deviceB.page, '/');
    await expect(deviceB.page.getByTestId('first-run-drive-restore-button')).toBeVisible();
    await deviceB.page.getByTestId('first-run-drive-restore-button').click();
    await deviceB.page.getByTestId('first-run-drive-connect-button').click();

    await expect(deviceB.page.getByTestId('drive-restore-entry')).toBeVisible();
    await deviceB.page.getByTestId('drive-restore-entry').click();
    await deviceB.page.getByTestId('backup-passphrase-prompt-input').fill(PASSPHRASE);
    await deviceB.page.getByTestId('backup-passphrase-prompt-submit').click();

    const confirm = deviceB.page.getByTestId('backup-confirm-import');
    await expect(confirm).toBeVisible();
    await Promise.all([deviceB.page.waitForURL('**/dashboard', { timeout: 120_000 }), confirm.click()]);
    await expectDashboardChart(deviceB.page, PERSON.name);
    expectCleanBrowser(deviceB.problems, 'device B');
  });
  await deviceB.close();

  await test.step('network audit: only age ciphertext and neutral names ever touched Google', async () => {
    expect(sharedDrive.log.length).toBeGreaterThan(0);
    for (const entry of sharedDrive.log) {
      for (const canary of CANARIES) {
        expect(entry.url).not.toContain(canary);
        expect(JSON.stringify(entry.headers)).not.toContain(canary);
        expect(entry.bodyText).not.toContain(canary);
      }
      if (entry.method === 'PUT' && entry.url.includes('/upload/drive/v3/files')) {
        expect(entry.bodyBytes.subarray(0, 22).toString('latin1')).toBe('age-encryption.org/v1\n');
      }
    }
  });
});
