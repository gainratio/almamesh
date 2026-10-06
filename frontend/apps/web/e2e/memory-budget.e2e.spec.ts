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
import { expect, test, type CDPSession, type Page } from '@playwright/test';

import { formatMemoryReport } from '../scripts/processMemory.mjs';
import { BOOT_MEMORY_BUDGET, overBudget, type BootMemorySample } from './memoryBudget';

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

async function onboardToDashboard(page: Page): Promise<void> {
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

test('cold boot to a ready chart stays inside the memory budget without the chat embedder', async ({ page, browser }) => {
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
