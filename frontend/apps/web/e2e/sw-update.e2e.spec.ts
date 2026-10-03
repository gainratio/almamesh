// Does "Reload to update" actually put the user on the new build?
//
// The bug this gate exists for (observed live on almamesh.com, 2026-08-01):
// `build.json` served the new git SHA while returning visitors kept executing
// the OLD chunks out of the Workbox precache, with the new service worker stuck
// in `waiting`. The banner was on screen; clicking it did nothing. Deployed-SHA
// equality proved nothing, because the client never moved.
//
// So this gate asserts the only thing that matters to a user: after the click,
// the page is executing the entry chunk of the NEWLY DEPLOYED build. It runs
// against two REAL builds of this app served from one origin that swaps between
// them, in a real browser, with a real service worker and a real precache.
//
// The banner has TWO independent triggers and each gets its own test:
//   1. the /version.json poller (fires in a tab that is already open — the
//      browser has not re-checked sw.js yet, so Workbox reports nothing);
//   2. the Workbox `waiting` event (fires on a navigation that finds a new SW).
// Test 2 is the CONTROL: it passed even with the bug present. Test 1 is the one
// that reproduced the live failure. Keep both — a gate where every case fails
// tells you the harness broke, not which branch is wrong.
//
// Run:  bun run test:e2e:sw-update   (from apps/web)

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startTwoBuildServer, type TwoBuildServer } from './swUpdateServer';

const here = path.dirname(fileURLToPath(import.meta.url));

const BUILD_A = process.env.SW_UPDATE_BUILD_A ?? path.resolve(here, '../dist-sw-update/a');
const BUILD_B = process.env.SW_UPDATE_BUILD_B ?? path.resolve(here, '../dist-sw-update/b');
const PORT = Number(process.env.SW_UPDATE_E2E_PORT ?? 4198);

const BANNER_TEXT = 'A new version is available!';
const RELOAD_CTA = 'Reload to update';
const FINISHING_TEXT = 'Finishing the previous download';

/** Under the `/pyodide/*` CacheFirst route, like the real engine wasm. */
const BUSY_ENGINE_FILE = '/pyodide/busy-engine-download.bin';
/** Well past the 10 s fixed reload the click used to take. */
const BUSY_FOR_MS = 30_000;

/** The hashed entry chunk a built shell points at — the build's fingerprint. */
function entryChunkOf(buildDir: string): string {
  const html = readFileSync(path.join(buildDir, 'index.html'), 'utf8');
  const match = html.match(/<script[^>]+type="module"[^>]+src="(\/assets\/index-[^"]+)"/);
  if (!match) {
    throw new Error(`no module entry script in ${buildDir}/index.html`);
  }
  return match[1];
}

const ENTRY_A = entryChunkOf(BUILD_A);
const ENTRY_B = entryChunkOf(BUILD_B);

interface ClientState {
  entryChunk: string | null;
  entryChunkWasFetched: boolean;
  controlled: boolean;
  waiting: string | null;
}

/** What this browser is ACTUALLY running right now — not what the origin says. */
async function clientState(page: Page): Promise<ClientState> {
  return page.evaluate(async () => {
    const entry = document.querySelector('script[type="module"][src*="/assets/index-"]');
    const entryChunk = entry?.getAttribute('src') ?? null;
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      entryChunk,
      entryChunkWasFetched:
        entryChunk !== null &&
        performance.getEntriesByType('resource').some((e) => e.name.endsWith(entryChunk)),
      controlled: navigator.serviceWorker.controller !== null,
      waiting: registration?.waiting?.state ?? null,
    };
  });
}

/** `entryChunk`, tolerating the in-flight navigation a successful update causes. */
async function entryChunkOrNavigating(page: Page): Promise<string> {
  try {
    return (await clientState(page)).entryChunk ?? '(no entry script)';
  } catch {
    return '(navigating)';
  }
}

/**
 * Load the app and end up CONTROLLED by the served build's service worker —
 * the state every returning visitor is in.
 *
 * `registerType: 'prompt'` deliberately does not `clientsClaim()`, so the first
 * load installs and activates the worker without being controlled by it. One
 * reload puts the page under the worker.
 */
async function bootAsReturningVisitor(page: Page, expectedEntry: string): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 60_000,
  });
  const state = await clientState(page);
  expect(state.entryChunk, 'the visitor starts on the first build').toBe(expectedEntry);
  expect(state.entryChunkWasFetched, 'the entry chunk really loaded').toBe(true);
}

/** Is the CTA the topmost element at its own centre — i.e. can a user hit it? */
async function ctaIsReachable(page: Page): Promise<boolean> {
  return page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(label),
    );
    if (!button) return false;
    const box = button.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return topmost === button || button.contains(topmost);
  }, RELOAD_CTA);
}

/** Click the CTA and require the page to end up on the newly deployed build. */
async function expectClickLandsOnNewBuild(page: Page): Promise<void> {
  // `getByRole('status')` alone is ambiguous — the app's loading spinner also
  // carries role=status. Scope to the banner's own text.
  await expect(page.getByRole('status').filter({ hasText: BANNER_TEXT })).toBeVisible();

  // Reachability is part of the fix, not a detail: the banner and the landing
  // header were both z-50, and the header (later in the DOM) won the tie and
  // buried the CTA. Assert it explicitly so a future z-index change is caught
  // here rather than by a user who cannot update.
  await expect
    .poll(() => ctaIsReachable(page), {
      message: 'the "Reload to update" CTA must not be covered by the app chrome',
      timeout: 15_000,
    })
    .toBe(true);

  await page.getByRole('button', { name: RELOAD_CTA }).click();
  await expect
    .poll(() => entryChunkOrNavigating(page), {
      message:
        'clicking "Reload to update" must leave the user executing the NEWLY DEPLOYED entry chunk',
      timeout: 60_000,
    })
    .toBe(ENTRY_B);
}

let server: TwoBuildServer;

test.beforeAll(async () => {
  expect(ENTRY_A, 'the two fixture builds must differ').not.toBe(ENTRY_B);
  server = await startTwoBuildServer(BUILD_A, PORT);
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(() => {
  server.deploy(BUILD_A);
});

test.describe('service worker update path', () => {
  test('a banner raised by the version poller lands the user on the new build', async ({
    page,
  }) => {
    await bootAsReturningVisitor(page, ENTRY_A);

    server.deploy(BUILD_B);

    // How a deploy reaches a tab that is ALREADY open: the /version.json poller
    // re-checks on window focus. The browser has not re-checked sw.js at this
    // point, so there is no waiting worker yet and Workbox reports nothing.
    // This is the exact live condition — and the branch that used to run a bare
    // window.location.reload(), which cannot activate a waiting worker.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expectClickLandsOnNewBuild(page);
  });

  test('a banner raised by the Workbox waiting event lands the user on the new build', async ({
    page,
  }) => {
    await bootAsReturningVisitor(page, ENTRY_A);

    server.deploy(BUILD_B);

    // Put a worker in `waiting` the only way that actually works here.
    //
    // Measured, not assumed: after a deploy, a plain navigation leaves
    // `registration.waiting` null indefinitely — Chromium does not re-check
    // sw.js on these reloads. An explicit `registration.update()` produces a
    // waiting worker in about a second. That is precisely why the fix re-checks
    // rather than trusting Workbox's `needRefresh`, and why this control has to
    // arrange the state by hand instead of by navigating.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect
      .poll(async () => (await clientState(page)).waiting, { timeout: 60_000 })
      .toBe('installed');

    await expectClickLandsOnNewBuild(page);
  });

  test('a click while the previous worker is mid-download still lands on the new build', async ({
    page,
  }) => {
    // Low-end device, slow link: the visitor clicks "Reload to update" while
    // the OLD worker is still writing an engine file into its CacheFirst cache.
    // Chromium will not promote the new worker until that fetch finishes (up
    // to 5 min). The click used to reload after a fixed 10 s, which the OLD
    // worker served: the user landed back on the old build. Hold the download
    // for 30 s, well past that 10 s, and require the NEW build anyway.
    test.setTimeout(120_000);
    await bootAsReturningVisitor(page, ENTRY_A);
    server.slowBody(BUSY_ENGINE_FILE, BUSY_FOR_MS);
    await page.evaluate((url) => {
      void fetch(url).then((r) => r.arrayBuffer()).catch(() => undefined);
    }, BUSY_ENGINE_FILE);

    server.deploy(BUILD_B);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const landedOn: string[] = [];
    page.on('load', () => {
      void entryChunkOrNavigating(page).then((entry) => landedOn.push(entry));
    });
    await page.getByRole('button', { name: RELOAD_CTA }).click();

    // While the old worker is busy, the user is told why nothing happens yet.
    await expect.soft(page.getByRole('status').filter({ hasText: FINISHING_TEXT })).toBeVisible();
    await expect.soft(page.getByRole('button', { name: 'Reload now' })).toBeVisible();

    await expect
      .poll(() => entryChunkOrNavigating(page), {
        message: 'a click during a busy download must still end on the NEWLY DEPLOYED build',
        timeout: BUSY_FOR_MS + 30_000,
      })
      .toBe(ENTRY_B);
    // Ending on B is not enough: the old click reloaded at 10 s, the OLD
    // worker served that reload, and the user sat on the old build until a
    // later takeover reloaded them again. Every load after the click is B.
    expect(landedOn, 'no reload after the click may land on the old build').toEqual([ENTRY_B]);
  });
});
