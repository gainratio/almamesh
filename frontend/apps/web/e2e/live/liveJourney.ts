/**
 * Journey helpers for the post-deploy live smoke (live-smoke.live.spec.ts).
 *
 * These drive a DEPLOYED origin, so they never assume a local build directory:
 * a build's fingerprint is read from the served HTML, and the engine boot is
 * observed through the page's own Worker traffic (production builds carry no
 * exit-gate hooks).
 */
import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

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
 */
export async function serveOriginFrom(
  context: BrowserContext,
  origin: string,
  previous: string,
): Promise<{ serviceWorkerRequests: () => number; switchToLive: () => void }> {
  const previousOrigin = new URL(previous).origin;
  let live = false;
  let serviceWorkerRequests = 0;
  await context.route(`${origin}/**`, async (route) => {
    if (live) return route.continue();
    const requested = new URL(route.request().url());
    if (route.request().serviceWorker()) serviceWorkerRequests += 1;
    const target = new URL(`${requested.pathname}${requested.search}`, previousOrigin);
    const response = await route.fetch({ url: target.toString(), maxRedirects: 0 });
    const headers = response.headers();
    if (headers.location?.startsWith(previousOrigin)) {
      headers.location = `${origin}${headers.location.slice(previousOrigin.length)}`;
    }
    await route.fulfill({ response, headers });
  });
  return {
    serviceWorkerRequests: () => serviceWorkerRequests,
    switchToLive: () => {
      live = true;
    },
  };
}
