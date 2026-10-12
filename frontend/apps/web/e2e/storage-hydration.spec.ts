import { expect } from '@playwright/test';
import { test } from './webkitProfile';
import { bootEngine, seedChart, waitForEngineReady } from './interpretation.helpers';
import { gotoSettled } from './portableInvariants.helpers';

const FAULT_KEY = 'almamesh-test-reject-state-read';

/**
 * Fail the real SQLite client's canonical read response after its Worker has
 * opened the database. No stored bytes are changed. This models a rejected
 * read on a returning visit, then exercises the shipped reload recovery.
 */
test('a rejected SQLite read blocks startup and reload recovers the saved chart', async ({ page }) => {
  await bootEngine(page);
  await seedChart(page);
  await gotoSettled(page, '/dashboard');
  await expect(page.getByTestId('dashboard-time-travel-button')).toBeEnabled();
  await waitForEngineReady(page);

  await page.addInitScript((faultKey) => {
    const proof = { rejectedReads: 0, attemptedWrites: 0 };
    (window as unknown as { __storageReadProof: typeof proof }).__storageReadProof = proof;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ): void {
      const request = message as {
        id?: number;
        operation?: string;
        options?: { namespace?: string };
      } | undefined;
      if (sessionStorage.getItem(faultKey) === 'armed') {
        if (request?.operation === 'batch') proof.attemptedWrites += 1;
        if (request?.operation === 'list' && request.options?.namespace === 'canonical') {
          proof.rejectedReads += 1;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
            data: { id: request.id, ok: false, error: { name: 'Error', message: 'Injected state read failure' } },
          })));
          return;
        }
      }
      Reflect.apply(original, this, transferOrOptions === undefined ? [message] : [message, transferOrOptions]);
    };
  }, FAULT_KEY);
  await page.evaluate((faultKey) => sessionStorage.setItem(faultKey, 'armed'), FAULT_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('storage-blocked-notice')).toHaveAttribute('data-reason', 'database-unavailable');
  await expect(page.getByTestId('dashboard-time-travel-button')).toHaveCount(0);
  const proof = await page.evaluate(() => (window as unknown as {
    __storageReadProof: { rejectedReads: number; attemptedWrites: number };
  }).__storageReadProof);
  expect(proof.rejectedReads).toBeGreaterThan(0);
  expect(proof.attemptedWrites).toBe(0);
  await test.info().attach('state-read-recovery-proof', {
    body: JSON.stringify(proof), contentType: 'application/json',
  });
  await page.screenshot({ path: test.info().outputPath('storage-read-failed.png') });

  await page.evaluate((faultKey) => sessionStorage.removeItem(faultKey), FAULT_KEY);
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByTestId('storage-reload-button').click(),
  ]);
  await expect(page.getByTestId('dashboard-time-travel-button')).toBeEnabled();
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible();
  await expect(page.getByTestId('storage-blocked-notice')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('storage-read-recovered.png') });
});
