/**
 * Returning-visitor engine gate (production build, hooks OFF).
 *
 * The regression this pins: after the app became cross-origin isolated (#157),
 * returning visitors sat on "The chart engine is still starting up" forever.
 * Workbox had precached `chartWorker-<hash>.js` BEFORE isolation shipped, and it
 * reuses an entry whose hashed URL is unchanged — headers and all. An isolated
 * page refuses a dedicated Worker whose script response lacks
 * `Cross-Origin-Embedder-Policy: require-corp`, so the chart Worker never
 * started. Every other gate boots a pristine profile and could not see it.
 *
 * The journey, on ONE origin and ONE production build, for each shape of
 * "previous deploy" a returning visitor can be running:
 *   - `pre-keyed service worker`: every sw.js shipped before the precache was
 *     keyed on response headers (#164 and older). Content-hashed chunks carry
 *     no revision, revisioned files carry other revisions, and there is no
 *     precache-isolation heal. This is what real visitors have installed.
 *   - `keyed on different headers`: a sw.js from this scheme whose key was
 *     computed from a `_headers` WITHOUT the COOP/COEP pair — i.e. the next time
 *     any header changes. The key is recomputed here with the real algorithm,
 *     so a key that ignores the headers makes this case red.
 *   1. The previous deploy is served without COOP/COEP; a first visit installs
 *      its service worker, which precaches the worker chunks without COEP
 *      (asserted, so the gate can never silently test nothing).
 *   2. "this deploy": the production COOP/COEP pair and the real sw.js. The
 *      visitor accepts the update (SKIP_WAITING, what the update banner sends).
 *   3. The visitor generates a chart: the engine must report ready within
 *      ENGINE_READY_BUDGET_MS and the dashboard must render the chart, with a
 *      clean console.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFileSync } from 'node:fs';

import { responseHeadersKey } from '../src/lib/precacheHeadersKey';
import { startTwoBuildServer, type TwoBuildServer } from './swUpdateServer';

const PORT = Number(process.env.RETURNING_VISITOR_E2E_PORT ?? 4197);
const BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.env.RETURNING_VISITOR_BUILD_DIR ?? 'dist-real');
/** A warm returning boot takes ~3 s locally; a cold CI boot well under a minute. */
const ENGINE_READY_BUDGET_MS = 60_000;
/** A runtime-cached engine entry; the CacheFirst `*-immutable` caches must outlive any precache re-key. */
const ENGINE_CACHE_SENTINEL = { cache: 'almamesh-pyodide-immutable', url: '/pyodide/__returning-visitor-sentinel__' };

/** Record when the chart Worker answers its `boot` request, and any Worker load failure. */
function probeEngineBoot(): void {
  const started = performance.now();
  const probe = { bootMs: null as number | null, workerErrors: [] as string[] };
  (window as unknown as { __engineProbe: typeof probe }).__engineProbe = probe;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const name = String(url).split('/').pop()?.split('?')[0] ?? '';
      this.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { kind?: string; ok?: boolean } | null;
        if (data?.kind === 'boot' && data.ok === true && probe.bootMs === null) {
          probe.bootMs = Math.round(performance.now() - started);
        }
      });
      this.addEventListener('error', () => probe.workerErrors.push(name));
    }
  };
}

const HEADERS_SALT = /headers-[0-9a-f]{16}/g;

/** The `_headers` a pre-isolation deploy served: the same file without COOP/COEP. */
function headersWithoutIsolation(): string {
  return readFileSync(path.join(BUILD_DIR, '_headers'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s+Cross-Origin-(Opener|Embedder)-Policy:/.test(line))
    .join('\n');
}

/** Mark the script as a distinct deploy, so the browser installs a new worker. */
function asPreviousDeploy(source: string): string {
  return `${source}\n// previous deploy\n`;
}

/**
 * sw.js as shipped before the precache was keyed on headers: hashed chunks
 * unrevisioned, revisioned files with other revisions, no heal.
 */
function preKeyedServiceWorker(source: string): string {
  const rewritten = source
    .replace(/revision:"headers-[0-9a-f]{16}"/g, 'revision:null')
    .replace(/revision:"([0-9a-f]+)(?:\.headers-[0-9a-f]{16})?"/g, 'revision:"previous-$1"');
  if (!rewritten.includes('revision:"previous-')) throw new Error('sw.js has no revisioned precache entries to rewrite');
  return asPreviousDeploy(rewritten);
}

/** sw.js keyed, by the real algorithm, on the pre-isolation `_headers`. */
function differentHeadersServiceWorker(source: string): string {
  const previousKey = responseHeadersKey([{ path: 'public/_headers', content: headersWithoutIsolation() }]);
  return asPreviousDeploy(source.replace(HEADERS_SALT, `headers-${previousKey}`));
}

/**
 * The precache revision marker only the previous deploy's entries carry, or
 * null when its key equals this deploy's (then nothing distinguishes them and
 * only the engine outcome can tell).
 */
function previousDeployMarker(previous: (source: string) => string): string | null {
  if (previous === preKeyedServiceWorker) return '__WB_REVISION__=previous-';
  const key = (content: string) => responseHeadersKey([{ path: 'public/_headers', content }]);
  const previousKey = key(headersWithoutIsolation());
  const currentKey = key(readFileSync(path.join(BUILD_DIR, '_headers'), 'utf8'));
  return previousKey === currentKey ? null : `headers-${previousKey}`;
}

async function precachedChartWorkerCoep(page: Page): Promise<string | null | 'missing'> {
  return page.evaluate(async () => {
    const name = (await caches.keys()).find((key) => key.includes('-precache-'));
    if (!name) return 'missing';
    const cache = await caches.open(name);
    const request = (await cache.keys()).find((r) => r.url.includes('chartWorker-'));
    if (!request) return 'missing';
    return (await cache.match(request))?.headers.get('cross-origin-embedder-policy') ?? null;
  });
}

async function visitPreviousDeploy(context: BrowserContext, origin: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${origin}/welcome`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  expect(await precachedChartWorkerCoep(page), 'previous deploy must precache the worker without COEP').toBeNull();
  // Stand-in for the ~38 MB engine download: re-keying the precache must never evict it.
  await page.evaluate(async (entry) => {
    await (await caches.open(entry.cache)).put(entry.url, new Response('engine bytes'));
  }, ENGINE_CACHE_SENTINEL);
  await page.close();
}

async function engineCacheSurvived(context: BrowserContext, origin: string): Promise<boolean> {
  const page = await context.newPage();
  await page.goto(`${origin}/welcome`);
  const survived = await page.evaluate(
    async (entry) => (await (await caches.open(entry.cache)).match(entry.url)) !== undefined,
    ENGINE_CACHE_SENTINEL,
  );
  await page.close();
  return survived;
}

/**
 * Accept the update the way the banner does (SKIP_WAITING), and only return
 * once THIS deploy's worker is the settled, active one. The decisive signal is
 * the precache itself: after activation no entry of the previous deploy's
 * revisions may remain. Polled from the test side with `expect.poll`:
 * `page.waitForFunction` does not await an async predicate (the returned
 * Promise is truthy), which made the first version of this gate racy. The
 * app reloads on controllerchange, so a destroyed context just means "again".
 */
async function acceptUpdate(context: BrowserContext, origin: string, marker: string | null): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${origin}/welcome`);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
  await expect.poll(() => page.evaluate(async (previousMarker) => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return 'no registration';
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      return 'waiting';
    }
    if (registration.installing) return 'installing';
    if (registration.active?.state !== 'activated') return 'activating';
    const name = (await caches.keys()).find((key) => key.includes('-precache-'));
    if (!name) return 'no precache';
    const keys = await (await caches.open(name)).keys();
    if (previousMarker !== null && keys.some((request) => request.url.includes(previousMarker))) {
      await registration.update();
      return 'previous deploy still active';
    }
    return 'updated';
    // Accepting the update reloads the page (controllerchange); poll again.
  }, marker).catch(() => 'reloading'), { timeout: 90_000, intervals: [500, 1_000] }).toBe('updated');
  await page.close();
}

async function typeSections(page: Page, testId: string, digits: string, trailing?: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 50 });
  if (trailing) await page.keyboard.type(trailing, { delay: 50 });
}

async function generateChart(page: Page): Promise<void> {
  await page.getByTestId('name-input').fill('Reference Native');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', '08081988');
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill('Bengaluru');
  await page.locator('[role="option"]').first().click();
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', '0644', 'a');
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();
}

test.describe('returning visitor engine boot across the isolation deploy', () => {
  let server: TwoBuildServer;

  test.beforeAll(async () => {
    server = await startTwoBuildServer(BUILD_DIR, PORT);
  });
  test.afterAll(async () => {
    await server.close();
  });

  for (const [shape, previous] of [
    ['pre-keyed service worker', preKeyedServiceWorker],
    ['keyed on different headers', differentHeadersServiceWorker],
  ] as const) {
    test(`${shape}: engine becomes ready within budget and a chart renders`, async ({ context }) => {
      server.configure({ isolation: false, rewriteServiceWorker: previous });
      await visitPreviousDeploy(context, server.origin);

      server.configure({ isolation: true, rewriteServiceWorker: null });
      await acceptUpdate(context, server.origin, previousDeployMarker(previous));
      expect(await engineCacheSurvived(context, server.origin), 'engine cache kept across the re-key').toBe(true);

      await context.addInitScript(probeEngineBoot);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      await page.goto(`${server.origin}/onboarding`);
      expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

      await page.waitForFunction(
        () => (window as unknown as { __engineProbe: { bootMs: number | null } }).__engineProbe.bootMs !== null,
        null,
        { timeout: ENGINE_READY_BUDGET_MS },
      ).catch(() => undefined);
      const probe = await page.evaluate(
        () => (window as unknown as { __engineProbe: { bootMs: number | null; workerErrors: string[] } }).__engineProbe,
      );
      expect(probe.workerErrors, 'no Worker may be refused').toEqual([]);
      expect(probe.bootMs, `engine ready within ${ENGINE_READY_BUDGET_MS} ms`).not.toBeNull();
      expect(probe.bootMs).toBeLessThanOrEqual(ENGINE_READY_BUDGET_MS);

      await generateChart(page);
      await page.waitForURL('**/dashboard', { timeout: 60_000 });
      await expect(page.getByTestId('identity-strip')).toBeVisible();
      await expect(page.getByTestId('chart-visualization').first()).toBeVisible();
      expect(consoleErrors).toEqual([]);
    });
  }
});
