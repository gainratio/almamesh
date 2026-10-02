/**
 * Journey helpers for the post-deploy live smoke (live-smoke.live.spec.ts).
 *
 * These drive a DEPLOYED origin, so they never assume a local build directory:
 * a build's fingerprint is read from the served HTML, and the engine boot is
 * observed through the page's own Worker traffic (production builds carry no
 * exit-gate hooks).
 */
import { expect, type APIRequestContext, type BrowserContext, type Page, type Request, type Worker } from '@playwright/test';

/**
 * A service worker's script and what it pulls in with importScripts (the
 * Workbox runtime and the engine-trust pair). Fetched before the worker has an
 * execution context, so a route must never evaluate in the worker for these:
 * the evaluate waits for the script, which waits for the route.
 */
const SERVICE_WORKER_SCRIPT = /^\/(sw\.js|workbox-[^/]+\.js|engine-trust-[^/]+\.js)$/;

/** What the in-page probe records: engine boot time and refused Workers. */
export interface EngineProbe {
  bootMs: number | null;
  workerErrors: string[];
}

/** Installed with `addInitScript`: time from navigation to the chart Worker's `boot` reply. */
export function probeEngineBoot(): void {
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

/** Wait (bounded) for the engine to boot, then return what the probe saw. */
export async function engineProbeAfter(page: Page, budgetMs: number): Promise<EngineProbe> {
  await page
    .waitForFunction(
      () => (window as unknown as { __engineProbe: EngineProbe }).__engineProbe.bootMs !== null,
      null,
      { timeout: budgetMs },
    )
    // A timeout is not swallowed: the probe below then reports bootMs null,
    // which the caller asserts against the budget.
    .catch(() => undefined);
  return page.evaluate(() => (window as unknown as { __engineProbe: EngineProbe }).__engineProbe);
}

/** Collect console errors and uncaught page errors for the clean-console assertion. */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

async function typeSections(page: Page, testId: string, digits: string, trailing?: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 50 });
  if (trailing) await page.keyboard.type(trailing, { delay: 50 });
}

/** The real, hook-free onboarding: name, date, city, time, confidence, skip events. */
export async function generateChart(page: Page): Promise<void> {
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

/** Onboard, then require the dashboard to render the chart. */
export async function expectChartRenders(page: Page): Promise<void> {
  await generateChart(page);
  await page.waitForURL('**/dashboard', { timeout: 60_000 });
  await expect(page.getByTestId('identity-strip')).toBeVisible();
  await expect(page.getByTestId('chart-visualization').first()).toBeVisible();
}

const ENTRY_SCRIPT = /<script[^>]+type="module"[^>]+src="(\/assets\/index-[^"]+)"/;

/** A deployment's fingerprint: the hashed entry chunk its HTML shell points at. */
export async function servedEntryChunk(request: APIRequestContext, base: string): Promise<string> {
  const url = new URL('/welcome', base);
  url.searchParams.set('live-smoke', String(Date.now()));
  const response = await request.get(url.toString(), { maxRedirects: 0 });
  const match = (await response.text()).match(ENTRY_SCRIPT);
  if (response.status() !== 200 || !match) {
    throw new Error(`${base} served no module entry script (status ${response.status()})`);
  }
  return match[1];
}

/** The entry chunk the page is ACTUALLY executing (i.e. what its service worker served). */
export async function executingEntryChunk(page: Page): Promise<string> {
  return page
    .evaluate(() => document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') ?? '(none)')
    .catch(() => '(navigating)');
}

/**
 * One step of accepting a service-worker update, run in the page: send
 * SKIP_WAITING to a waiting worker (what the update banner does), ask for an
 * update check once nothing is pending, and report `settled` only when an
 * activated worker controls the page with nothing installing or waiting.
 */
export async function workerState(): Promise<string> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return 'no registration';
  if (registration.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return 'waiting';
  }
  if (registration.installing) return 'installing';
  if (registration.active?.state !== 'activated') return 'activating';
  if (!navigator.serviceWorker.controller) return 'uncontrolled';
  await registration.update();
  if (registration.installing || registration.waiting) return 'update found';
  return 'settled';
}

/**
 * Serve `origin` from `previous` inside this browser context: every request
 * for the live origin — including the service worker script and the worker's
 * own precache fetches — is answered with the previous deployment's status,
 * headers, and body. Redirects are passed through, with a Location on the
 * previous host rewritten onto the live origin.
 *
 * `switchToLive()` keeps the route installed but continues every later request
 * to the real network. Removing the route instead (`unroute`) left Chromium's
 * interception of the service worker half-detached: the next worker hung in
 * `activating` forever, while the same upgrade through a pass-through route
 * activated within seconds — a harness artifact, not a site defect.
 *
 * `requestTimeoutMs` bounds each proxied fetch. Playwright's default is 30 s,
 * which cut off the previous build's cold engine download (its 47 MB bundle
 * takes ~34 s on the runner's link) and left that build's worker to fetch it
 * again during the upgrade.
 *
 * `inFlightServiceWorkerRequests()` counts requests the context's service
 * workers have started and not yet finished or failed, through the proxy and
 * after it. Chromium activates a worker that called `skipWaiting()` only once
 * the active worker has no in-flight work, so the returning pass drains this
 * to 0 before the previous visit ends (see the spec's PREVIOUS_VISIT_BUDGET_MS).
 *
 * Only the previous deployment's own worker is served. Chromium re-checks
 * sw.js on its own during the visit, in the browser process where no route
 * sees it, so it finds the LIVE deploy's worker and starts installing it
 * while the previous deployment is being served. Workbox writes each precache
 * entry as it arrives, so that install cached the previous shell under the
 * live revision key before a live-only chunk 404'd it, and the real live
 * install later kept that key: the upgrade "settled" on the previous entry
 * chunk with 404s (2026-10-01). A worker that is not the registration's active
 * one gets its precache fetches aborted, so its install fails before it caches
 * anything; its script and imports (workbox + engine-trust, present in every
 * deploy) are let through, because a worker whose import fails still reaches
 * `installed` without its module body and then ignores SKIP_WAITING.
 */
export async function serveOriginFrom(
  context: BrowserContext,
  origin: string,
  previous: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<{
  serviceWorkerRequests: () => number;
  inFlightServiceWorkerRequests: () => number;
  switchToLive: () => void;
}> {
  const previousOrigin = new URL(previous).origin;
  let live = false;
  let serviceWorkerRequests = 0;
  let inFlightServiceWorkerRequests = 0;
  const settled = (request: Request) => {
    if (request.serviceWorker()) inFlightServiceWorkerRequests -= 1;
  };
  context.on('request', (request) => {
    if (request.serviceWorker()) inFlightServiceWorkerRequests += 1;
  });
  context.on('requestfinished', settled);
  context.on('requestfailed', settled);
  const foreignInstaller = new Map<Worker, Promise<boolean>>();
  const isForeignInstaller = (worker: Worker): Promise<boolean> => {
    let verdict = foreignInstaller.get(worker);
    if (!verdict) {
      verdict = worker
        .evaluate(() => {
          // ServiceWorkerGlobalScope; the e2e tsconfig has no WebWorker lib.
          const scope = self as unknown as { registration: { active: unknown }; serviceWorker: unknown };
          return scope.registration.active !== null && scope.registration.active !== scope.serviceWorker;
        })
        .catch(() => false);
      foreignInstaller.set(worker, verdict);
    }
    return verdict;
  };
  await context.route(`${origin}/**`, async (route) => {
    if (live) return route.continue();
    const requested = new URL(route.request().url());
    const worker = route.request().serviceWorker();
    if (worker) {
      serviceWorkerRequests += 1;
      if (!SERVICE_WORKER_SCRIPT.test(requested.pathname) && (await isForeignInstaller(worker))) {
        return route.abort('failed');
      }
    }
    const target = new URL(`${requested.pathname}${requested.search}`, previousOrigin);
    const response = await route.fetch({
      url: target.toString(),
      maxRedirects: 0,
      timeout: options.requestTimeoutMs,
    });
    const headers = response.headers();
    if (headers.location?.startsWith(previousOrigin)) {
      headers.location = `${origin}${headers.location.slice(previousOrigin.length)}`;
    }
    await route.fulfill({ response, headers });
  });
  return {
    serviceWorkerRequests: () => serviceWorkerRequests,
    inFlightServiceWorkerRequests: () => inFlightServiceWorkerRequests,
    switchToLive: () => {
      live = true;
    },
  };
}
