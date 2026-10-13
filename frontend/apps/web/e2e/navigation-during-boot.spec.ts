/**
 * A visitor's own navigation always wins over the app's automatic recovery.
 *
 * WebKit (Safari and every iOS browser) cancels the outgoing page's in-flight
 * loads the moment a navigation starts, then keeps running that page's scripts
 * until the new page commits. A cancelled code-split chunk looks exactly like a
 * stale one ("Importing a module script failed."), so the chunk self-heal used
 * to answer it with a reload, and that reload replaced the navigation in
 * flight. Real Safari 26.6.1 (#337 smoke, run 38345410812): a direct visit to
 * /onboarding during the first visit's boot landed back on `/`, navigation
 * entry `{ name: '/', type: 'reload' }`.
 *
 * The test makes the race deterministic: it holds the landing chunk the first
 * visit is loading, then navigates to /onboarding with that document held back
 * long enough for any reload from the outgoing page to win. The service worker
 * is allowed, so the first visit is also installing it, as in production.
 */
import { expect, type Page, type Route } from '@playwright/test';

import { test } from './webkitProfile';

const LANDING_CHUNK = /\/assets\/Landing-[\w-]+\.js$/;
const HELD_DOCUMENT_MS = 1_500;

test.use({ serviceWorkers: 'allow' });

/** Hold the landing chunk's first request; resolves once the page is waiting on it. */
async function holdLandingChunk(page: Page): Promise<void> {
  let held: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => { held = resolve; });
  let first = true;
  await page.route(LANDING_CHUNK, async (route: Route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    held?.();
    // Never answered: only the navigation below ends this request.
  });
  await page.goto('/', { waitUntil: 'commit' });
  await requested;
}

interface Landing {
  readonly path: string;
  readonly navigation: string;
  readonly selfHealMarkers: readonly string[];
}

async function landing(page: Page): Promise<Landing> {
  return page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return {
      path: location.pathname,
      navigation: entry?.type ?? 'none',
      selfHealMarkers: Object.keys(sessionStorage).filter((key) => key.startsWith('almamesh:')).sort(),
    };
  });
}

test('a direct visit to /onboarding during the first visit boot lands on /onboarding', async ({ page }) => {
  await holdLandingChunk(page);
  await page.route('**/onboarding', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HELD_DOCUMENT_MS));
    await route.continue();
  });

  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');

  expect(await landing(page), 'the explicit navigation wins and spends no one-shot self-heal').toEqual({
    path: '/onboarding',
    navigation: 'navigate',
    selfHealMarkers: [],
  });
  // The first visit's service worker still installs: no recovery unregistered it.
  const ready = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => 'ready'),
    new Promise((resolve) => { setTimeout(() => resolve('not ready after 60 s'), 60_000); }),
  ]));
  expect(ready).toBe('ready');
});
