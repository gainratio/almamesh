import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base, webkit, type Page } from '@playwright/test';

import { startWebKitDiagnostics } from './webkitDiagnostics';

/**
 * Empty this origin's OPFS, IndexedDB, Cache Storage and web storage, and
 * unregister its service workers (they live in the same shared store, so an
 * earlier run's worker would otherwise still control the page), from a page
 * that runs no app code.
 */
async function wipeOrigin(page: Page): Promise<void> {
  await page.goto('/robots.txt');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
    for (const db of await indexedDB.databases()) {
      if (!db.name) continue;
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(db.name as string);
        request.onsuccess = request.onerror = request.onblocked = resolve;
      });
    }
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    for (const key of await caches.keys()) await caches.delete(key);
    localStorage.clear();
    sessionStorage.clear();
  });
}

/**
 * `test` with a WebKit context that can run AlmaMesh. A default WebKit context
 * is an ephemeral data store that refuses OPFS, and SQLite on OPFS is the app's
 * only store, so the app (correctly) shows its storage block screen there, as
 * Safari does in a Private window. Real Safari and iOS give a normal page a
 * persistent store, so on WebKit each test gets an on-disk profile.
 *
 * The device fields are passed through by name, so a project such as
 * `devices['iPhone 13']` still runs as a phone (viewport, touch, mobile UA).
 * WebKit on macOS keeps OPFS in one store shared across profiles
 * (~/Library/WebKit/org.webkit.Playwright/WebsiteData), so the origin is wiped
 * before the test starts. Other browsers keep Playwright's default context.
 */
export const test = base.extend({
  context: async (
    {
      browserName,
      context,
      contextOptions,
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      locale,
      timezoneId,
      serviceWorkers,
      video,
    },
    provide,
    testInfo,
  ) => {
    if (browserName !== 'webkit') {
      await provide(context);
      return;
    }
    const profile = await mkdtemp(join(tmpdir(), 'almamesh-webkit-profile-'));
    const diagnostics = startWebKitDiagnostics(testInfo);
    const videoMode = typeof video === 'string' ? video : video.mode;
    const persistent = await webkit.launchPersistentContext(profile, {
      ...contextOptions,
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
      locale,
      timezoneId,
      serviceWorkers,
      headless: true,
      logger: diagnostics.logger,
      recordVideo: videoMode === 'off' ? undefined : { dir: testInfo.outputPath('video') },
    });
    diagnostics.watch(persistent);
    try {
      await wipeOrigin(persistent.pages()[0] ?? (await persistent.newPage()));
      await provide(persistent);
    } finally {
      await persistent.close();
      await diagnostics.finish();
      await rm(profile, { recursive: true, force: true });
      const passed = testInfo.status === testInfo.expectedStatus;
      if (videoMode === 'retain-on-failure' && passed) await rm(testInfo.outputPath('video'), { recursive: true, force: true });
    }
  },
  page: async ({ context }, provide) => {
    await provide(context.pages()[0] ?? (await context.newPage()));
  },
});
