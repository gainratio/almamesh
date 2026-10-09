/**
 * Memory-budget lane: a first-time visitor on a phone-sized Chromium boots the
 * PRODUCTION build to a ready chart without blowing the memory budget, and
 * without loading the chat embedder (MiniLM + onnxruntime, ~+95 MiB) that only
 * semantic search or chat needs.
 *
 * A second, REPORT-ONLY test prints `memory-report` lines (not gated yet): the
 * heap peak during boot, sampled every second from the first navigation, and
 * the heap after a chat search has loaded the embedder.
 *
 *   ./node_modules/.bin/vite build --outDir dist-real
 *   ./node_modules/.bin/vite preview --outDir dist-real --port 4199 &
 *   MEMORY_BUDGET_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:memory-budget
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type CDPSession, type Page, type Route } from '@playwright/test';

import { formatMemoryReport } from '../scripts/processMemory.mjs';
import { BOOT_MEMORY_BUDGET, PLACE_LOOKUP_HEAP_GROWTH_MIB, overBudget, type BootMemorySample } from './memoryBudget';

const MiB = 1024 * 1024;
const SETTLE_SAMPLES = 5;
// The report-only boot sampler. Each measureUserAgentSpecificMemory call
// interrupts every worker, so it runs in its own test, never in the gated one.
const BOOT_SAMPLE_INTERVAL_MS = 1_000;

async function typeSections(page: Page, testId: string, digits: string, trailing = ''): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 30 });
  if (trailing) await page.keyboard.type(trailing, { delay: 30 });
}

function recordMemoryReport(line: string): void {
  console.log(line);
  test.info().annotations.push({ type: 'memory-report', description: line });
}

async function settledHeap(page: Page): Promise<number[]> {
  const heap: number[] = [];
  for (let i = 0; i < SETTLE_SAMPLES; i += 1) {
    heap.push(await pageHeap(page));
    await page.waitForTimeout(1_000);
  }
  return heap;
}

/** Open chat, type a search, and wait until the on-device embedder has answered it. */
async function searchChatWithEmbedder(page: Page): Promise<void> {
  const embedderSpawned = page.waitForEvent('worker', {
    predicate: (worker) => worker.url().includes('embedder.worker'),
    timeout: 120_000,
  });
  await page.getByTestId('floating-chat-button').click();
  await page.getByTestId('chat-search-input').fill('career');
  await embedderSpawned;
  await expect(page.getByTestId('chat-search-results')).toContainText('No matching past messages.', {
    timeout: 180_000,
  });
}

/**
 * Onboarding's place search is online-first (Open-Meteo, 3.5 s cap) and falls
 * back to the bundled city list when that call fails or stalls. Left live, a
 * slow CI network made the onboarding search load the city list and the lite
 * chat test blamed chat for it. A fixed answer keeps every run on one path.
 */
const GEOCODER_URL = 'https://geocoding-api.open-meteo.com/**';
const BENGALURU = {
  name: 'Bengaluru', latitude: 12.9716, longitude: 77.5946, country: 'India', country_code: 'IN',
  admin1: 'Karnataka', timezone: 'Asia/Kolkata', population: 8443675, feature_code: 'PPLA',
};

async function answerGeocoder(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
    contentType: 'application/json',
    body: JSON.stringify({ results: [BENGALURU] }),
  });
}

async function onboardToDashboard(page: Page): Promise<void> {
  await page.route(GEOCODER_URL, answerGeocoder);
  await page.goto('/onboarding');
  await page.getByTestId('name-input').fill('Memory Budget');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', '08081988');
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill('Bengaluru');
  await page.locator('[role="option"]').first().click({ timeout: 120_000 });
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', '0644', 'a');
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();
  await page.waitForURL('**/dashboard', { timeout: 300_000 });
  await page.getByTestId('chart-visualization').first().waitFor({ state: 'attached', timeout: 300_000 });
}

function rssBytes(pid: number): number {
  if (process.platform === 'linux') {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : 0;
  }
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024;
}

async function rendererRss(session: CDPSession): Promise<number> {
  const { processInfo } = (await session.send('SystemInfo.getProcessInfo')) as {
    processInfo: { id: number; type: string }[];
  };
  return processInfo
    .filter((p) => p.type === 'renderer')
    .reduce((sum, p) => {
      try {
        return sum + rssBytes(p.id);
      } catch {
        return sum; // the process exited between listing and reading
      }
    }, 0);
}

/** JS + wasm heap of the page and every worker it owns (needs cross-origin isolation). */
async function pageHeap(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const perf = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    if (!crossOriginIsolated || perf.measureUserAgentSpecificMemory === undefined) {
      throw new Error(`measureUserAgentSpecificMemory unavailable (crossOriginIsolated=${crossOriginIsolated})`);
    }
    return (await perf.measureUserAgentSpecificMemory()).bytes;
  });
}

function sampleLoop(intervalMs: number, sample: () => Promise<void>): { stop: () => Promise<void> } {
  let running = true;
  const loop = (async () => {
    while (running) {
      await sample().catch(() => undefined); // navigation can destroy the context mid-sample
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

/**
 * A string only the age library (typage) ships. Backup encryption loads it in
 * a Worker on the first seal or open, never at boot; the precache download by
 * the service worker itself is not a load.
 */
const AGE_LIBRARY_MARKER = 'scrypt work factor is too high';

test('cold boot to a ready chart stays inside the memory budget without the chat embedder', async ({ page, browser }) => {
  const ageTraffic: string[] = [];
  const scriptChecks: Promise<void>[] = [];
  page.on('worker', (worker) => {
    if (worker.url().includes('passphraseSeal.worker')) ageTraffic.push(`spawned ${new URL(worker.url()).pathname}`);
  });
  page.context().on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (response.request().serviceWorker() !== null || !pathname.endsWith('.js')) return;
    scriptChecks.push(
      response.text().then(
        (body) => {
          if (body.includes(AGE_LIBRARY_MARKER)) ageTraffic.push(`loaded ${pathname}`);
        },
        () => undefined,
      ),
    );
  });
  const embedderTraffic: string[] = [];
  // The service worker precaches the (small) embedder worker script; that is
  // not a load. A spawned embedder worker or a model/ORT fetch is.
  page.on('worker', (worker) => {
    if (worker.url().includes('embedder.worker')) embedderTraffic.push(`spawned ${new URL(worker.url()).pathname}`);
  });
  page.context().on('request', (request) => {
    if (request.serviceWorker() === null && request.url().includes('/models/')) {
      embedderTraffic.push(`fetched ${new URL(request.url()).pathname}`);
    }
  });
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // OS RSS is read from outside the page, so it can be sampled through boot.
  // The JS/wasm heap is measured only once the chart is ready: an eager
  // measureUserAgentSpecificMemory interrupts every worker, which would perturb
  // the engine boot this lane is measuring.
  const session = await browser.newBrowserCDPSession();
  const rss: { t: number; bytes: number }[] = [];
  const rssLoop = sampleLoop(500, async () => {
    rss.push({ t: Date.now(), bytes: await rendererRss(session) });
  });

  await onboardToDashboard(page);
  const readyAt = Date.now();
  const heap = await settledHeap(page);
  await rssLoop.stop();
  await session.detach();

  const settled = rss.filter((s) => s.t >= readyAt).map((s) => s.bytes).sort((a, b) => a - b);
  const sample: BootMemorySample = {
    heapPeakMiB: Math.max(...heap) / MiB,
    heapSamplesMiB: heap.map((bytes) => bytes / MiB),
    rendererRssPeakMiB: Math.max(...rss.map((s) => s.bytes)) / MiB,
    rendererRssSettledMiB: (settled[Math.floor(settled.length / 2)] ?? Number.NaN) / MiB,
  };
  console.log(`memory-budget sample ${JSON.stringify(sample)} budget ${JSON.stringify(BOOT_MEMORY_BUDGET)}`);

  expect(rss.length, 'renderer RSS was sampled').toBeGreaterThan(0);
  expect(Number.isFinite(sample.rendererRssSettledMiB), 'renderer RSS was sampled after ready').toBe(true);
  expect.soft(embedderTraffic, 'the chat embedder must not load before search or chat').toEqual([]);
  await Promise.all(scriptChecks);
  expect(scriptChecks.length, 'boot scripts were inspected').toBeGreaterThan(0);
  expect.soft(ageTraffic, 'the age library loads only when a backup is sealed or opened').toEqual([]);
  expect.soft(overBudget(sample, BOOT_MEMORY_BUDGET)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('report only: heap peak during boot, and after a chat search loads the embedder', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  const boot: number[] = [];
  // Before the first cross-origin-isolated page the call throws; the loop skips it.
  const bootLoop = sampleLoop(BOOT_SAMPLE_INTERVAL_MS, async () => {
    boot.push(await pageHeap(page));
  });
  await onboardToDashboard(page);
  const afterReady = await settledHeap(page);
  await bootLoop.stop();
  expect(boot.length, 'the heap was sampled during boot').toBeGreaterThan(0);
  recordMemoryReport(
    formatMemoryReport('boot-peak', {
      heapPeakMiB: Math.max(...boot, ...afterReady) / MiB,
      heapAfterReadyMiB: Math.max(...afterReady) / MiB,
      bootSamples: boot.length,
    }),
  );

  await searchChatWithEmbedder(page);
  const afterChat = await settledHeap(page);
  recordMemoryReport(
    formatMemoryReport('after-chat-search', {
      heapMiB: Math.max(...afterChat) / MiB,
      embedderDeltaMiB: (Math.max(...afterChat) - Math.max(...afterReady)) / MiB,
    }),
  );
  expect(consoleErrors).toEqual([]);
});

/**
 * The city list is a lazy chunk: not requested at boot, requested once (same
 * origin) by the first resolve_place, and the heap growth that costs is gated.
 * Needs the VITE_EXIT_GATE_HOOKS=1 build (window.__almameshResolvePlace).
 * PLACE_CPU_THROTTLE=4 re-runs the cold first lookup on a 4x slower CPU.
 */
test('first place lookup loads the city list once, same-origin, inside its heap growth gate', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  const throttle = Number(process.env.PLACE_CPU_THROTTLE ?? '1');
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }

  await onboardToDashboard(page);
  const hasHook = await page.evaluate(() => typeof window.__almameshResolvePlace === 'function');
  test.skip(!hasHook, 'needs a VITE_EXIT_GATE_HOOKS=1 build');
  const isCitiesChunk = (url: string): boolean => url.includes('cities.min');
  expect(urls.filter(isCitiesChunk), 'the city list is not requested at boot').toEqual([]);
  const requestsBeforeLookup = urls.length;

  const before = Math.max(...(await settledHeap(page)));
  const { result, firstLookupMs } = await page.evaluate(async () => {
    const started = performance.now();
    const found = await window.__almameshResolvePlace?.('Bogotá');
    return { result: found as { status?: string } | undefined, firstLookupMs: performance.now() - started };
  });
  const after = Math.max(...(await settledHeap(page)));

  const growthMiB = (after - before) / MiB;
  const lookupUrls = urls.slice(requestsBeforeLookup);
  const cityRequests = lookupUrls.filter(isCitiesChunk);
  const origin = new URL(page.url()).origin;
  const report = { beforeMiB: before / MiB, afterMiB: after / MiB, growthMiB, firstLookupMs, cityRequests: cityRequests.length, throttle };
  recordMemoryReport(formatMemoryReport('first-place-lookup', report));
  await test.info().attach('first-place-lookup', { body: JSON.stringify(report), contentType: 'application/json' });

  expect(result?.status).toBe('found');
  expect(cityRequests, 'exactly one request for the city list').toHaveLength(1);
  expect(cityRequests.every((url) => new URL(url).origin === origin), 'city list is same-origin').toBe(true);
  expect(lookupUrls.filter((url) => new URL(url).origin !== origin && /^https?:/.test(url)), 'no cross-origin request').toEqual([]);
  expect(growthMiB, `first lookup heap growth (limit ${PLACE_LOOKUP_HEAP_GROWTH_MIB} MiB)`).toBeLessThanOrEqual(PLACE_LOOKUP_HEAP_GROWTH_MIB);
  expect(consoleErrors).toEqual([]);
});

/**
 * Lite/minimal devices never register resolve_place, so the chat path never
 * imports the city list. The service worker still precaches the chunk at
 * install (pre-existing, from the context's request stream, not the page's);
 * what must not happen is a page-initiated request for it.
 *
 * Onboarding must not load the list either (its geocoder is answered, see
 * onboardToDashboard): once the module is loaded, a later chat import is served
 * from memory with no request, and this test could no longer see it.
 */
test('on a lite device opening chat never requests the city list', async ({ page }) => {
  await page.addInitScript((device) => {
    for (const [name, value] of Object.entries(device)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, { deviceMemory: 2, hardwareConcurrency: 2 });
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await onboardToDashboard(page);
  const isCitiesChunk = (url: string): boolean => url.includes('cities.min');
  expect(urls.filter(isCitiesChunk), 'onboarding did not load the city list, so chat is observable').toEqual([]);
  const requestsBeforeChat = urls.length;
  await page.getByTestId('floating-chat-button').click();
  await page.getByTestId('chat-search-input').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3_000);

  expect(urls.slice(requestsBeforeChat).filter(isCitiesChunk), 'no page request for the city list on lite').toEqual([]);
  expect(consoleErrors).toEqual([]);
});
