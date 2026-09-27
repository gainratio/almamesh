/**
 * Post-deploy live smoke: drives the DEPLOYED site the way visitors meet it.
 *
 * Run by the Dagger `deploy` function right after the live identity proof
 * (both passes; a failure rolls production back to the deployment that was
 * live before) and by the scheduled `live-probe` workflow (`--grep @fresh`).
 *
 *   @fresh      a pristine browser profile opens the site, the engine boots
 *               within ENGINE_READY_BUDGET_MS, a chart renders, console clean.
 *   @returning  a profile that first ran the PREVIOUS production deployment
 *               (its service worker and precache installed under the live
 *               origin), then upgrades to the new deploy — the path that broke
 *               on 2026-09-24, when returning visitors sat on "The chart engine
 *               is still starting up" and every fresh-profile gate stayed green.
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

  test('returning visitor: previous deploy upgrades, engine ready, chart renders', { tag: '@returning' }, async ({ context, request }) => {
    expect(PREVIOUS_URL, 'LIVE_SMOKE_PREVIOUS_URL is required for the returning pass').not.toBe('');
    const previousEntry = await servedEntryChunk(request, PREVIOUS_URL);
    const liveEntry = await servedEntryChunk(request, ORIGIN);

    const proxy = await serveOriginFrom(context, ORIGIN, PREVIOUS_URL);
    const previous = await context.newPage();
    await previous.goto(`${ORIGIN}/welcome`);
    await previous.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await previous.reload();
    await previous.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 60_000 });
    expect(await executingEntryChunk(previous), 'the visitor starts on the previous deploy').toBe(previousEntry);
    expect(proxy.serviceWorkerRequests(), 'the previous service worker installed through the proxy').toBeGreaterThan(0);
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
    expect(consoleErrors).toEqual([]);
  });
});
