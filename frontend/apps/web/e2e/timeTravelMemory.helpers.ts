import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Browser, type CDPSession, type Page } from '@playwright/test';

import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import type { TimeTravelMemoryPhase } from './memoryBudget';
import { passOnboardingAiStep } from '../scripts/onboardingAiStep.mjs';

const MiB = 1024 * 1024;
export type MemoryGranularity = 'day' | 'month';

export function timeTravelMemoryOptions(): { granularity: MemoryGranularity; phase: TimeTravelMemoryPhase } {
  const granularity = process.env.TT_MEMORY_GRANULARITY ?? 'day';
  const phase = process.env.TT_MEMORY_PHASE ?? 'final';
  if (granularity !== 'day' && granularity !== 'month') throw new Error('TT_MEMORY_GRANULARITY must be day or month');
  if (phase !== 'baseline' && phase !== 'probe' && phase !== 'final') throw new Error('TT_MEMORY_PHASE must be baseline, probe or final');
  if (phase === 'final' && granularity !== 'day') throw new Error('The final memory gate requires the Day + place journey');
  return { granularity, phase };
}

/** Chromium's phone UA alone does not constrain navigator.deviceMemory. */
export async function forceMinimalTier(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 2, configurable: true });
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 2, configurable: true });
  });
}

/** Keep the existing navigation deadline while observing terminal onboarding UI. */
export async function waitForMemoryDashboard(page: Page): Promise<void> {
  let watching = true;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const navigation = Promise.resolve().then(() => passOnboardingAiStep(page, { timeout: 300_000 }));
  const error = (async () => {
    while (watching) {
      const visible = await page.getByText(/CHART_GEN_001/).first().isVisible();
      if (!watching) return;
      if (visible) throw new Error('Memory onboarding failed: CHART_GEN_001 is visible.');
      await new Promise<void>((resolve) => {
        wake = resolve;
        delay = setTimeout(resolve, 100);
      });
    }
  })();
  try {
    await Promise.race([navigation, error]);
  } finally {
    watching = false;
    clearTimeout(delay);
    wake?.();
  }
}

async function typeSections(page: Page, testId: string, digits: string, trailing = ''): Promise<void> {
  await page.locator(`[data-testid="${testId}"] [role="spinbutton"]`).first().click();
  await page.keyboard.type(digits, { delay: 30 });
  if (trailing) await page.keyboard.type(trailing, { delay: 30 });
}

/** Real onboarding, with a fixed geocoder response to keep the first offline lookup cold. */
export async function onboardForTimeTravelMemory(page: Page): Promise<void> {
  await page.route('https://geocoding-api.open-meteo.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      contentType: 'application/json',
      body: JSON.stringify({ results: [{
        name: 'Bengaluru', latitude: 12.9716, longitude: 77.5946, country: 'India', country_code: 'IN',
        admin1: 'Karnataka', timezone: 'Asia/Kolkata', population: 8443675, feature_code: 'PPLA',
      }] }),
    });
  });
  await page.goto('/onboarding');
  await page.getByTestId('name-input').fill('Time Travel Memory');
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-date-input', '08081988');
  await page.getByTestId('next-button').click();
  await page.getByTestId('location-search-input').fill('Bengaluru');
  await page.getByRole('option').first().click({ timeout: 120_000 });
  await page.getByTestId('next-button').click();
  await typeSections(page, 'birth-time-input', '0644', 'a');
  await page.getByTestId('confidence-option-exact').click();
  await page.getByTestId('next-button').click();
  await page.getByTestId('skip-life-events-button').click();
  await waitForMemoryDashboard(page);
  await page.getByTestId('chart-visualization').first().waitFor({ state: 'attached', timeout: 300_000 });
  await expect(page.getByTestId('dashboard-time-travel-button')).toBeEnabled();
  // The chart appears before today's lazy predictive compute finishes. Include
  // that resident heap in both baseline and Day-probe measurements.
  await waitForLifeAtlasAsOf(page);
}

/** Page and all workers' JS + wasm heaps; cross-origin isolation is mandatory. */
async function pageHeapMiB(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const perf = performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> };
    if (!crossOriginIsolated || !perf.measureUserAgentSpecificMemory) {
      throw new Error(`measureUserAgentSpecificMemory unavailable (crossOriginIsolated=${crossOriginIsolated})`);
    }
    return (await perf.measureUserAgentSpecificMemory()).bytes / (1024 * 1024);
  });
}

function rssBytes(pid: number): number {
  if (process.platform === 'linux') {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : Number.NaN;
  }
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024;
}

async function rendererRssMiB(session: CDPSession): Promise<number> {
  const { processInfo } = await session.send('SystemInfo.getProcessInfo') as { processInfo: { id: number; type: string }[] };
  const renderers = processInfo.filter((entry) => entry.type === 'renderer');
  if (renderers.length === 0) return Number.NaN;
  let measured = false;
  let bytes = 0;
  for (const renderer of renderers) {
    try {
      const rss = rssBytes(renderer.id);
      if (Number.isFinite(rss)) { measured = true; bytes += rss; }
    } catch { /* A renderer may exit between CDP listing and the OS sample. */ }
  }
  return measured ? bytes / MiB : Number.NaN;
}

export interface ChromiumTimeTravelMemory {
  readonly heapSamplesMiB: readonly number[];
  readonly rendererRssSamplesMiB: readonly number[];
  readonly heapPeakMiB: number;
  readonly rendererRssPeakMiB: number;
}

/** Starts before navigation and samples through the FIRST engine compute, not just after it. */
export async function startChromiumTimeTravelMemory(page: Page, browser: Browser): Promise<{
  settledHeapMiB(): Promise<number>;
  stop(): Promise<ChromiumTimeTravelMemory>;
}> {
  const session = await browser.newBrowserCDPSession();
  const heap: number[] = [];
  const rss: number[] = [];
  let running = true;
  let heapTail: Promise<unknown> = Promise.resolve();
  // measureUserAgentSpecificMemory interrupts workers; serialize background and settled reads.
  const takeHeap = (): Promise<number> => {
    const next = heapTail.then(() => pageHeapMiB(page));
    heapTail = next.catch(() => undefined);
    return next.then((value) => { heap.push(value); return value; });
  };
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 500));
  const heapLoop = (async () => {
    while (running) {
      await takeHeap().catch(() => undefined); // The first page is not yet isolated; navigation can destroy a sample.
      await delay();
    }
  })();
  const rssLoop = (async () => {
    while (running) {
      const value = await rendererRssMiB(session).catch(() => Number.NaN);
      if (Number.isFinite(value)) rss.push(value);
      await delay();
    }
  })();
  return {
    async settledHeapMiB() {
      const samples: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        samples.push(await takeHeap());
        if (index < 4) await delay();
      }
      return Math.max(...samples);
    },
    async stop() {
      running = false;
      await Promise.all([heapLoop, rssLoop]);
      await session.detach().catch(() => undefined); // Preserve the original journey failure if the browser closed.
      return {
        heapSamplesMiB: heap,
        rendererRssSamplesMiB: rss,
        heapPeakMiB: heap.length ? Math.max(...heap) : Number.NaN,
        rendererRssPeakMiB: rss.length ? Math.max(...rss) : Number.NaN,
      };
    },
  };
}

export async function pickMemoryMoment(
  page: Page,
  granularity: MemoryGranularity,
  day: string,
  measureHeap?: () => Promise<number>,
): Promise<number> {
  await page.getByTestId('dashboard-time-travel-button').click();
  await page.getByTestId(`time-travel-tab-${granularity}`).click();
  let cityLookupHeapGrowthMiB = Number.NaN;
  if (granularity === 'day') {
    await page.getByTestId('time-travel-day').fill(day);
    const before = measureHeap ? await measureHeap() : Number.NaN;
    await page.getByTestId('time-travel-where-input').fill('Bogotá');
    const candidate = page.getByTestId('time-travel-where-option-0');
    await expect(candidate).toContainText('Bogotá', { timeout: 120_000 });
    const after = measureHeap ? await measureHeap() : Number.NaN;
    cityLookupHeapGrowthMiB = after - before;
    await candidate.click();
  } else {
    await page.getByTestId('time-travel-month').selectOption(day.slice(5, 7));
    await page.getByTestId('time-travel-month-year').selectOption(day.slice(0, 4));
  }
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
  if (granularity === 'day') {
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 240_000 });
    await expect(page.getByTestId('dashboard-time-travel-banner')).toContainText('Bogotá');
  } else {
    await expect(page.getByTestId('time-travel-moment-transits').or(page.getByTestId('time-travel-moment-dashas-only')))
      .toBeVisible({ timeout: 240_000 });
  }
  return cityLookupHeapGrowthMiB;
}

export async function backToTodayForMemory(page: Page): Promise<void> {
  await page.getByTestId('dashboard-time-travel-back').click();
  await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0);
  await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
}

export function captureMemoryConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}
