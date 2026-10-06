/**
 * Post-deploy live smoke: drives the DEPLOYED site the way visitors meet it.
 *
 * Run by the Dagger `deploy` function right after the live identity proof
 * (both passes; a failure rolls production back to the deployment that was
 * live before) and by the scheduled `live-probe` workflow (`--grep @fresh`).
 *
 *   @fresh      a pristine browser profile opens the site, the engine boots
 *               within ENGINE_READY_BUDGET_MS, a chart renders, console clean.
 *   @returning  a profile that first ran the PREVIOUS production deployment to
 *               completion (its service worker and precache installed under
 *               the live origin, engine ready, worker idle), then upgrades to
 *               the new deploy — the path that broke on 2026-09-24, when
 *               returning visitors sat on "The chart engine is still starting
 *               up" and every fresh-profile gate stayed green.
 *
 * Same-origin simulation (the previous deployment only exists at its own
 * `<id>.almamesh.pages.dev` origin): Playwright routes every request for the
 * live origin — including the service worker script and the worker's own
 * precache fetches (Chromium; verified with Playwright 1.62) — to the previous
 * deployment and replays its status, headers, and body. The old worker thus
 * installs with the old deployment's bytes AND headers under the real origin.
 * The route then passes every request through to the network, and the real
 * update runs against the live deploy.
 * What it does not cover: the old deployment's headers are the ones Pages
 * served on `pages.dev`, not whatever the apex CDN had cached at the time; a
 * visitor whose worker is several deploys old; browsers other than Chromium.
 *
 * Environment:
 *   LIVE_SMOKE_ORIGIN        deployed origin (default https://almamesh.com)
 *   LIVE_SMOKE_PREVIOUS_URL  previous deployment's URL (required by @returning)
 */
import { test, expect } from '@playwright/test';

import {
  collectConsoleErrors,
  engineProbeAfter,
  executingEntryChunk,
  expectChartRenders,
  probeEngineBoot,
  serveOriginFrom,
  servedEntryChunk,
  workerState,
} from './liveJourney';

const ORIGIN = new URL(process.env.LIVE_SMOKE_ORIGIN ?? 'https://almamesh.com').origin;
const PREVIOUS_URL = process.env.LIVE_SMOKE_PREVIOUS_URL ?? '';
/**
 * Local old -> new proof for the SQLite-only quarantine move (PR: SQLite is the
 * only store): the returning visitor holds an older build's localStorage
 * quarantine row, and the upgrade must move it into SQLite and only then drop
 * the key. Opt-in; remove with the legacy reader (TODO 2026-11-04).
 */
const SEED_LEGACY_QUARANTINE = process.env.LIVE_SMOKE_SEED_LEGACY_QUARANTINE === '1';
const LEGACY_QUARANTINE_KEY = 'almamesh-interpretations.quarantine';
const LEGACY_QUARANTINE_MARKER = 'legacy-quarantine-proof-7f3a';

/** True when any OPFS file's bytes contain the marker (the SQLite file holds the row). */
async function opfsContains(marker: string): Promise<boolean | 'unreadable'> {
  const needle = new TextEncoder().encode(marker);
  const scan = async (dir: FileSystemDirectoryHandle): Promise<boolean | 'unreadable'> => {
    let unreadable = false;
    for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (handle.kind === 'directory') {
        const found = await scan(handle as FileSystemDirectoryHandle);
        if (found === true) return true;
        if (found === 'unreadable') unreadable = true;
        continue;
      }
      try {
        const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
        outer: for (let i = 0; i <= bytes.length - needle.length; i += 1) {
          for (let j = 0; j < needle.length; j += 1) if (bytes[i + j] !== needle[j]) continue outer;
          return true;
        }
      } catch {
        unreadable = true;
      }
    }
    return unreadable ? 'unreadable' : false;
  };
  return scan(await navigator.storage.getDirectory());
}

/**
 * Engine-ready budget (navigation -> chart Worker `boot` reply), pinned from
 * measured production timings, Chromium against https://almamesh.com on
 * 2026-09-25. Host Chromium: fresh profile 7505, 7562, 7727, 8347, 9166,
 * 9241 ms (cold 38 MB engine download); returning 2833-3204 ms (5 runs, warm
 * caches). Inside the Dagger runner (`dagger call live-probe`): fresh 8595,
 * 8622, 9534, 9662, 10759 ms; 17295 ms once while the host ran a full gate
 * in parallel; returning 5397 ms. Budget = the slowest quiet sample x ~3,
 * rounded to 30 s: room for a slower or busier CI runner, while a refused or
 * never-starting Worker (the 2026-09-24 incident never became ready) fails.
 */
const ENGINE_READY_BUDGET_MS = 30_000;

/**
 * The previous visit must COMPLETE before the visitor leaves it: engine ready,
 * service worker idle. A real returning visitor's last visit did finish, and
 * the upgrade depends on it: Chromium activates a worker that called
 * `skipWaiting()` only once the active worker has no in-flight work
 * (`ServiceWorkerRegistration::IsReadyToActivate`: `active->HasNoWork()`,
 * else a five-minute lame-duck limit), and a Workbox CacheFirst fetch event
 * lives until the whole body is written to the cache. This pass used to leave
 * at `controller !== null`, mid engine download (bundle + Pyodide, ~68 MB),
 * and the next page, still the previous build under the previous worker,
 * started that download again through it. The deploy of fe5b447c
 * (2026-10-01, rolled back) failed here with the new worker in `waiting` for
 * the whole 120 s poll; the same upgrade settles in ~20 s from an idle worker
 * (3/3 against the same two deployments), and holding one of the old
 * worker's responses open for 60 s held activation for exactly that long
 * after SKIP_WAITING. Reproduced red locally with one engine file throttled
 * (scripts/serve-returning-pair.ts).
 *
 * Budget: a precondition bound, not a product measurement (the live build's
 * engine is still held to ENGINE_READY_BUDGET_MS). The cold download runs
 * through the Playwright proxy: the fresh pass booted cold in 13.5 s on the
 * runner on 2026-10-01 (~5 MB/s); x13 for the proxy's buffering and a busy
 * runner. A previous build that cannot boot in this budget fails here,
 * explicitly, rather than as a stalled upgrade.
 */
const PREVIOUS_VISIT_BUDGET_MS = 180_000;

test.describe('live smoke', () => {
  test('fresh visitor: engine ready within budget, chart renders, console clean', { tag: '@fresh' }, async ({ context }) => {
    await context.addInitScript(probeEngineBoot);
    const page = await context.newPage();
    const consoleErrors = collectConsoleErrors(page);
    await page.goto(`${ORIGIN}/onboarding`);
    expect(await page.evaluate(() => crossOriginIsolated), 'page is cross-origin isolated').toBe(true);

    const probe = await engineProbeAfter(page, ENGINE_READY_BUDGET_MS);
    console.log(`live-smoke fresh engine_boot_ms=${probe.bootMs ?? 'timeout'}`);
    expect(probe.workerErrors, 'no Worker may be refused').toEqual([]);
    expect(probe.bootMs, `engine ready within ${ENGINE_READY_BUDGET_MS} ms`).not.toBeNull();
    expect(probe.bootMs ?? Infinity).toBeLessThanOrEqual(ENGINE_READY_BUDGET_MS);

    await expectChartRenders(page);
    expect(consoleErrors).toEqual([]);
  });

  // CONTRACT REVERSED (2026-10-05, "sqlite persistent is the only option").
  // This used to run SQLite session-only in memory and require the legacy key
  // to be retired. With OPFS refused the app now shows the storage block screen
  // and opens no SQLite at all, so there is nowhere to move the row: it must be
  // KEPT for the visit on which storage is allowed.
  test('OPFS-refused visitor holding an old localStorage quarantine row: block screen, the row is kept', { tag: '@memory-quarantine' }, async ({ context }) => {
    test.skip(!SEED_LEGACY_QUARANTINE, 'opt-in: LIVE_SMOKE_SEED_LEGACY_QUARANTINE=1');
    await context.addInitScript(() => {
      const storage = navigator.storage as StorageManager & { getDirectory: () => Promise<FileSystemDirectoryHandle> };
      storage.getDirectory = () => Promise.reject(new DOMException('refused for the smoke', 'SecurityError'));
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${ORIGIN}/robots.txt`);
    await page.evaluate(([key, marker]) => {
      window.localStorage.setItem(key, JSON.stringify([
        { quarantinedAt: new Date().toISOString(), source: 'legacy-local-storage', raw: marker },
      ]));
    }, [LEGACY_QUARANTINE_KEY, LEGACY_QUARANTINE_MARKER] as const);
    await page.goto(`${ORIGIN}/onboarding`);
    await expect(page.getByTestId('storage-blocked-notice')).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByTestId('storage-blocked-notice')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LEGACY_QUARANTINE_KEY)).toContain(
      LEGACY_QUARANTINE_MARKER,
    );
    expect(pageErrors).toEqual([]);
  });

  test('returning visitor: previous deploy upgrades, engine ready, chart renders', { tag: '@returning' }, async ({ context, request }) => {
    expect(PREVIOUS_URL, 'LIVE_SMOKE_PREVIOUS_URL is required for the returning pass').not.toBe('');
    const previousEntry = await servedEntryChunk(request, PREVIOUS_URL);
    const liveEntry = await servedEntryChunk(request, ORIGIN);

    const proxy = await serveOriginFrom(context, ORIGIN, PREVIOUS_URL, {
      requestTimeoutMs: PREVIOUS_VISIT_BUDGET_MS,
    });
    const previous = await context.newPage();
    await previous.addInitScript(probeEngineBoot);
    // /onboarding, not /welcome: since #227 /welcome never boots the engine (so
    // an accepted update can activate), and a previous deploy that contains
    // #227 would leave this visit waiting the whole budget for an engine that
    // was never asked to start (deploy of 0c800e6, 2026-10-03, run 37162823046).
    // /onboarding boots it, the same page the fresh pass holds to the budget.
    await previous.goto(`${ORIGIN}/onboarding`);
    // The worker claims the page on activation (clientsClaim + clients.claim()
    // in engine-trust-install.js), so one load ends controlled; no reload.
    // Chromium still re-checks sw.js on its own during this visit and finds the
    // LIVE worker (see serveOriginFrom, which keeps that worker from caching the
    // previous shell under live keys).
    await previous.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await previous.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 60_000 });
    expect(await executingEntryChunk(previous), 'the visitor starts on the previous deploy').toBe(previousEntry);
    if (SEED_LEGACY_QUARANTINE) {
      await previous.evaluate(([key, marker]) => {
        window.localStorage.setItem(key, JSON.stringify([
          { quarantinedAt: new Date().toISOString(), source: 'legacy-local-storage', raw: marker },
        ]));
      }, [LEGACY_QUARANTINE_KEY, LEGACY_QUARANTINE_MARKER] as const);
    }
    expect(proxy.serviceWorkerRequests(), 'the previous service worker installed through the proxy').toBeGreaterThan(0);

    // The previous visit completes before the visitor leaves (PREVIOUS_VISIT_BUDGET_MS).
    const previousVisitDeadline = Date.now() + PREVIOUS_VISIT_BUDGET_MS;
    const previousProbe = await engineProbeAfter(previous, PREVIOUS_VISIT_BUDGET_MS);
    console.log(`live-smoke previous engine_boot_ms=${previousProbe.bootMs ?? 'timeout'}`);
    expect(previousProbe.bootMs, `the previous deploy's engine is ready within ${PREVIOUS_VISIT_BUDGET_MS} ms`).not.toBeNull();
    await expect
      .poll(() => proxy.inFlightServiceWorkerRequests(), {
        message: 'the previous service worker has no request in flight when the visitor leaves',
        timeout: Math.max(10_000, previousVisitDeadline - Date.now()),
      })
      .toBe(0);
    await previous.close();
    proxy.switchToLive();

    // Accept the update the way the banner does (SKIP_WAITING) until this
    // deploy's worker is the settled controller AND the page executes the
    // live entry chunk. The app reloads on controllerchange, so an in-flight
    // navigation just means "poll again".
    const upgrading = await context.newPage();
    await upgrading.goto(`${ORIGIN}/welcome`);
    await expect.poll(async () => {
      const worker = await upgrading.evaluate(workerState).catch(() => 'navigating');
      if (worker !== 'settled') return worker;
      await upgrading.reload().catch(() => undefined);
      return `settled:${await executingEntryChunk(upgrading)}`;
    }, { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }).toBe(`settled:${liveEntry}`);
    await upgrading.close();

    await context.addInitScript(probeEngineBoot);
    const page = await context.newPage();
    const consoleErrors = collectConsoleErrors(page);
    await page.goto(`${ORIGIN}/onboarding`);
    expect(await page.evaluate(() => crossOriginIsolated), 'page is cross-origin isolated').toBe(true);

    const probe = await engineProbeAfter(page, ENGINE_READY_BUDGET_MS);
    console.log(`live-smoke returning engine_boot_ms=${probe.bootMs ?? 'timeout'}`);
    expect(probe.workerErrors, 'no Worker may be refused').toEqual([]);
    expect(probe.bootMs, `engine ready within ${ENGINE_READY_BUDGET_MS} ms`).not.toBeNull();
    expect(probe.bootMs ?? Infinity).toBeLessThanOrEqual(ENGINE_READY_BUDGET_MS);

    await expectChartRenders(page);
    if (SEED_LEGACY_QUARANTINE) {
      await expect
        .poll(() => page.evaluate((key) => window.localStorage.getItem(key), LEGACY_QUARANTINE_KEY), {
          message: 'the old build\'s localStorage quarantine is retired after the SQLite copy',
        })
        .toBeNull();
      const inSqlite = await page.evaluate(opfsContains, LEGACY_QUARANTINE_MARKER);
      console.log(`live-smoke legacy quarantine row in OPFS SQLite: ${inSqlite}`);
      expect(inSqlite, 'the quarantined row now lives in the OPFS SQLite file').not.toBe(false);
    }
    expect(consoleErrors).toEqual([]);
  });
});
