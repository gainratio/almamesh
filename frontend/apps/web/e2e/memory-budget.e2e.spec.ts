/**
 * Memory-budget lane: a first-time visitor on a phone-sized Chromium boots the
 * PRODUCTION build to a ready chart without blowing the memory budget, and
 * without loading the chat embedder (MiniLM + onnxruntime, ~+95 MiB) that only
 * full-tier semantic search or chat needs. Minimal/lite devices use keyword
 * recall from saved chat and never load the semantic model.
 *
 * A second, REPORT-ONLY test prints `memory-report` lines (not gated yet): the
 * heap peak during boot, sampled every second from the first navigation, and
 * the heap after a full-tier desktop chat search has loaded the embedder.
 *
 *   ./node_modules/.bin/vite build --outDir dist-real
 *   ./node_modules/.bin/vite preview --outDir dist-real --port 4199 &
 *   MEMORY_BUDGET_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:memory-budget
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { devices, expect, test, type CDPSession, type Page, type Route } from '@playwright/test';
import { detectMemoryTier, type MemoryTier } from '@gainratio/browser/sqlite';

import { formatMemoryReport } from '../scripts/processMemory.mjs';
import { BOOT_MEMORY_BUDGET, PLACE_LOOKUP_HEAP_GROWTH_MIB, overBudget, type BootMemorySample } from './memoryBudget';
import { waitForMemoryDashboard } from './timeTravelMemory.helpers';

const MiB = 1024 * 1024;
const cityManifest = JSON.parse(readFileSync(new URL('../public/cities/manifest.json', import.meta.url), 'utf8')) as { parts: number };
type PlaceLookupWindow = Window & {
  __almameshResolvePlace?: (query: string) => Promise<{ status?: string }>;
};
const SETTLE_SAMPLES = 5;
// The report-only boot sampler. Each measureUserAgentSpecificMemory call
// interrupts every worker, so it runs in its own test, never in the gated one.
const BOOT_SAMPLE_INTERVAL_MS = 1_000;
const DESKTOP_CONTEXT = {
  userAgent: devices['Desktop Chrome'].userAgent,
  viewport: devices['Desktop Chrome'].viewport,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
};

/** Full/lite cases must not inherit the lane's iPhone UA, which is always minimal. */
async function desktopMemorySignals(page: Page, deviceMemory: 4 | 8): Promise<void> {
  await page.addInitScript((memory) => {
    const signals = { deviceMemory: memory, hardwareConcurrency: 8, platform: 'Win32', maxTouchPoints: 0 };
    for (const [name, value] of Object.entries(signals)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, deviceMemory);
}

/** Check the live navigator with the same pinned detector as production policy. */
async function expectDeviceTier(page: Page, tier: MemoryTier): Promise<void> {
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
  }));
  expect(detectMemoryTier(environment), 'the journey exercises its named production tier').toBe(tier);
}

/** Ignore SW precache downloads; a page/worker model load is actual residency. */
function captureSemanticTraffic(page: Page): string[] {
  const traffic: string[] = [];
  page.on('worker', (worker) => {
    if (/embedder|onnxruntime|(?:^|\/)ort[-.]/i.test(worker.url())) traffic.push(`spawned ${worker.url()}`);
  });
  page.context().on('request', (request) => {
    if (request.serviceWorker() !== null) return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/models/') || /(?:^|\/)(?:ort[-./]|onnxruntime)|\.onnx$/i.test(path)) {
      traffic.push(`fetched ${path}`);
    }
  });
  return traffic;
}

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

/**
 * Fail fast on the CHART_GEN_001 card instead of a bare 5-minute waitForURL,
 * and say where onboarding stopped: route, visible heading, console tail.
 */
async function waitForDashboardOrExplain(page: Page, consoleTail: readonly string[]): Promise<void> {
  try {
    await waitForMemoryDashboard(page);
  } catch (error) {
    const heading = await page.getByRole('heading').first().textContent({ timeout: 1_000 }).catch(() => null);
    const where = `route=${new URL(page.url()).pathname} heading=${JSON.stringify(heading)}`;
    throw new Error(`${String(error)} ${where} console=${JSON.stringify(consoleTail.slice(-12))}`, { cause: error });
  }
}

async function onboardToDashboard(page: Page): Promise<void> {
  const consoleTail: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'debug') consoleTail.push(`${message.type()}: ${message.text()}`.slice(0, 300));
  });
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
  await waitForDashboardOrExplain(page, consoleTail);
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
  // The natal chart attaches before the lazy predictive work completes. Start
  // the settled window after that work, while retaining the whole boot RSS peak.
  await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible({ timeout: 240_000 });
  const readyAt = Date.now();
  const heap = await settledHeap(page);
  await rssLoop.stop();
  const { processInfo } = (await session.send('SystemInfo.getProcessInfo')) as {
    processInfo: { id: number; type: string }[];
  };
  console.log(`memory-budget renderer processes ${JSON.stringify(processInfo.filter((p) => p.type === 'renderer').map((p) => {
    try { return { pid: p.id, rssMiB: rssBytes(p.id) / MiB }; } catch { return { pid: p.id, exited: true }; }
  }))}`);
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

test.describe('full-tier desktop semantic memory report', () => {
  test.use(DESKTOP_CONTEXT);

  test('report only: heap peak during boot, and after a chat search loads the embedder', async ({ page }) => {
    await desktopMemorySignals(page, 8);
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    const boot: number[] = [];
    // Before the first cross-origin-isolated page the call throws; the loop skips it.
    const bootLoop = sampleLoop(BOOT_SAMPLE_INTERVAL_MS, async () => {
      boot.push(await pageHeap(page));
    });
    await onboardToDashboard(page);
    await expectDeviceTier(page, 'full');
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
});

/**
 * City reference data is lazy: not requested at boot, imported in bounded
 * same-origin parts by the first resolve_place, then queried from SQLite.
 * Service-worker precaching does not count as the page importing the data.
 * Needs the VITE_EXIT_GATE_HOOKS=1 build (window.__almameshResolvePlace).
 * PLACE_CPU_THROTTLE=4 re-runs the cold first lookup on a 4x slower CPU.
 */
test('first place lookup imports city parts once, same-origin, inside its heap growth gate', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  const urls: string[] = [];
  page.on('request', (request) => { if (request.serviceWorker() === null) urls.push(request.url()); });
  const throttle = Number(process.env.PLACE_CPU_THROTTLE ?? '1');
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }

  await onboardToDashboard(page);
  const hasHook = await page.evaluate(() => typeof (window as PlaceLookupWindow).__almameshResolvePlace === 'function');
  test.skip(!hasHook, 'needs a VITE_EXIT_GATE_HOOKS=1 build');
  const isCitiesPart = (url: string): boolean => /\/cities\/cities-part-\d+\.json$/.test(new URL(url).pathname);
  expect(urls.filter(isCitiesPart), 'city parts are not requested by the page at boot').toEqual([]);
  const requestsBeforeLookup = urls.length;

  const before = Math.max(...(await settledHeap(page)));
  const { result, firstLookupMs } = await page.evaluate(async () => {
    const started = performance.now();
    const found = await (window as PlaceLookupWindow).__almameshResolvePlace?.('Bogotá');
    return { result: found as { status?: string } | undefined, firstLookupMs: performance.now() - started };
  });
  const after = Math.max(...(await settledHeap(page)));

  const growthMiB = (after - before) / MiB;
  const lookupUrls = urls.slice(requestsBeforeLookup);
  const cityRequests = lookupUrls.filter(isCitiesPart);
  const origin = new URL(page.url()).origin;
  const report = { beforeMiB: before / MiB, afterMiB: after / MiB, growthMiB, firstLookupMs, cityRequests: cityRequests.length, throttle };
  recordMemoryReport(formatMemoryReport('first-place-lookup', report));
  await test.info().attach('first-place-lookup', { body: JSON.stringify(report), contentType: 'application/json' });

  expect(result?.status).toBe('found');
  expect(cityRequests, 'each bounded city part is imported once').toHaveLength(cityManifest.parts);
  expect(new Set(cityRequests).size, 'there are no duplicate part requests').toBe(cityManifest.parts);
  expect(cityRequests.every((url) => new URL(url).origin === origin), 'city parts are same-origin').toBe(true);
  expect(lookupUrls.filter((url) => new URL(url).origin !== origin && /^https?:/.test(url)), 'no cross-origin request').toEqual([]);
  expect(growthMiB, `first lookup heap growth (limit ${PLACE_LOOKUP_HEAP_GROWTH_MIB} MiB)`).toBeLessThanOrEqual(PLACE_LOOKUP_HEAP_GROWTH_MIB);
  await page.evaluate(async () => (window as PlaceLookupWindow).__almameshResolvePlace?.('Sao Paulo'));
  expect(urls.filter(isCitiesPart), 'the next lookup reads SQLite without reimporting city parts').toEqual(cityRequests);
  expect(consoleErrors).toEqual([]);
});

/**
 * Opening chat does not perform a place lookup, so it never imports city
 * rows. The service worker still precaches the reference parts at
 * install (pre-existing, from the context's request stream, not the page's);
 * what must not happen is a page-initiated request for it.
 *
 * Onboarding must not load the list either (its geocoder is answered, see
 * onboardToDashboard): once the module is loaded, a later chat import is served
 * from memory with no request, and this test could no longer see it.
 */
test.describe('true lite desktop memory policy', () => {
  test.use(DESKTOP_CONTEXT);

  test('on a lite device opening chat never requests the city list', async ({ page }) => {
    await desktopMemorySignals(page, 4);
    const urls: string[] = [];
    page.on('request', (request) => { if (request.serviceWorker() === null) urls.push(request.url()); });
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    await onboardToDashboard(page);
    await expectDeviceTier(page, 'lite');
    const isCitiesPart = (url: string): boolean => /\/cities\/cities-part-\d+\.json$/.test(new URL(url).pathname);
    expect(urls.filter(isCitiesPart), 'onboarding did not import city parts, so chat is observable').toEqual([]);
    const requestsBeforeChat = urls.length;
    await page.getByTestId('floating-chat-button').click();
    await page.getByTestId('chat-search-input').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(3_000);

    expect(urls.slice(requestsBeforeChat).filter(isCitiesPart), 'opening chat makes no page request for city reference data').toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

for (const tier of ['minimal', 'lite'] as const) {
  test.describe(`${tier} saved-chat keyword recall`, () => {
    if (tier === 'lite') test.use(DESKTOP_CONTEXT);

    test('a saved keyword hit and unmatched query never load the semantic model', async ({ page }) => {
      if (tier === 'lite') await desktopMemorySignals(page, 4);
      const semanticTraffic = captureSemanticTraffic(page);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      const question = 'Please keep this career note in our conversation.';
      const answer = 'Career note: steady practice supports patient progress.';
      let chatRequests = 0;
      await page.addInitScript(() => {
        localStorage.setItem('almamesh-llm-settings', JSON.stringify({
          apiBase: 'https://openrouter.ai/api/v1', apiKey: 'test-key',
          model: 'deepseek/deepseek-v4-pro', privacyMode: 'cloud_premium', engine: 'openai-http',
        }));
      });
      await page.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
        const body = route.request().postDataJSON() as { stream?: boolean; messages?: Array<{ role?: string; content?: unknown }> };
        if (body.messages?.some((message) => message.role === 'user' && String(message.content).includes(question))) chatRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: body.stream ? 'text/event-stream' : 'application/json',
          body: body.stream
            ? `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`
            : JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }),
        });
      });

      await onboardToDashboard(page);
      await expectDeviceTier(page, tier);
      await page.getByTestId('floating-chat-button').click();
      await page.getByTestId('chat-input').fill(question);
      await expect(page.getByTestId('chat-send-button')).toBeEnabled();
      await page.getByTestId('chat-send-button').click();
      await expect(page.getByText(answer, { exact: true })).toBeVisible();
      // Send stays disabled for an empty composer. This control is disabled
      // only while the turn is running, which includes its canonical save.
      await expect(page.getByTestId('time-travel-button'), 'the turn finished settling its saved answer').toBeEnabled();
      expect(chatRequests, 'the saved answer came from the locally fulfilled provider').toBeGreaterThan(0);

      // Search after reopening the app: a transient draft or duplicate corpus
      // cannot satisfy the canonical saved-history recall assertion.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('chart-visualization').first().waitFor({ state: 'attached', timeout: 300_000 });
      await expectDeviceTier(page, tier);
      await page.getByTestId('floating-chat-button').click();
      const search = page.getByTestId('chat-search-input');
      const results = page.getByTestId('chat-search-results');
      await search.fill('career');
      await expect(results.getByRole('button').filter({ hasText: answer })).toHaveCount(1);
      await search.fill('zzqxunmatchedkeyword');
      await expect(results).toHaveText('No matching past messages.');
      await expect(results.getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('chat-search-model-loading')).toHaveCount(0);
      expect(semanticTraffic, 'constrained sends and searches never start the embedder, MiniLM or ORT').toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  });
}
