import { expect, test } from '@playwright/test';

import { TIME_TRAVEL_MEMORY_BUDGET, overTimeTravelBudget, type TimeTravelMemorySample } from './memoryBudget';
import {
  backToTodayForMemory,
  captureMemoryConsole,
  forceMinimalTier,
  onboardForTimeTravelMemory,
  pickMemoryMoment,
  startChromiumTimeTravelMemory,
  timeTravelMemoryOptions,
} from './timeTravelMemory.helpers';

test('time-travel journey stays inside TIME_TRAVEL_MEMORY_BUDGET (minimal, iPhone UA)', async ({ page, browser }, testInfo) => {
  const { granularity, phase } = timeTravelMemoryOptions();
  await forceMinimalTier(page);
  const consoleErrors = captureMemoryConsole(page);
  let placeModuleUrl: string | undefined;
  page.on('request', (request) => {
    if (/\/assets\/placeLookup-[^/]+\.js$/.test(new URL(request.url()).pathname)) placeModuleUrl = request.url();
  });
  const sampler = await startChromiumTimeTravelMemory(page, browser);
  let sample: TimeTravelMemorySample = { heapPeakMiB: Number.NaN, revisitHeapGrowthMiB: Number.NaN, cityLookupHeapGrowthMiB: Number.NaN };
  let completed = false;
  try {
    await onboardForTimeTravelMemory(page);
    const cityLookupHeapGrowthMiB = await pickMemoryMoment(page, granularity, '2019-03-14', sampler.settledHeapMiB);
    sample = { ...sample, cityLookupHeapGrowthMiB };
    await pickMemoryMoment(page, granularity, granularity === 'day' ? '2019-03-15' : '2019-04-15');
    const beforeRevisit = await sampler.settledHeapMiB();
    await pickMemoryMoment(page, granularity, '2019-03-14');
    const revisitHeapGrowthMiB = (await sampler.settledHeapMiB()) - beforeRevisit;
    await backToTodayForMemory(page);
    sample = { ...sample, revisitHeapGrowthMiB, cityLookupHeapGrowthMiB };
    completed = true;
  } finally {
    const memory = await sampler.stop();
    sample = { ...sample, heapPeakMiB: memory.heapPeakMiB };
    const report = {
      lane: 'chromium-iphone', phase, granularity, completed, sample,
      budget: TIME_TRAVEL_MEMORY_BUDGET, ...memory,
      growthGated: phase === 'final',
      cityLookupMeasured: granularity === 'day',
    };
    await testInfo.attach('time-travel-memory.json', { body: JSON.stringify(report), contentType: 'application/json' });
    console.log(`time-travel-memory ${JSON.stringify(report)}`);
    if (!completed && placeModuleUrl && !page.isClosed()) {
      // Diagnose a real production failure through the app's existing public
      // module, after memory sampling has stopped. No exit hook is required.
      const diagnostic = await page.evaluate(async (url) => {
        try {
          const module = await import(url) as { lookupPlaceOffline(query: string): Promise<unknown> };
          return await module.lookupPlaceOffline('Bogotá');
        } catch (error) { return { error: error instanceof Error ? error.message : 'lookup failed' }; }
      }, placeModuleUrl).catch(() => ({ error: 'diagnostic page unavailable' }));
      await testInfo.attach('failed-place-lookup.json', { body: JSON.stringify(diagnostic), contentType: 'application/json' });
      console.log(`time-travel failed-place-lookup ${JSON.stringify(diagnostic)}`);
    }
  }
  expect(overTimeTravelBudget(sample, phase)).toEqual([]);
  expect(consoleErrors, 'real onboarding and time travel keep a clean console').toEqual([]);
});
