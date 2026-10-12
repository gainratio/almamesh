import { expect } from '@playwright/test';
import { platform } from 'node:os';

import { TIME_TRAVEL_MEMORY_BUDGET, parseWebKitBaselineMiB } from './memoryBudget';
import { startWebKitDiagnostics } from './webkitDiagnostics';
import { test } from './webkitProfile';
import { finalizeMemoryEngineDiagnostics, installMemoryEngineDiagnostics } from './memoryEngineDiagnostics';
import {
  backToTodayForMemory,
  captureMemoryConsole,
  onboardForTimeTravelMemory,
  pickMemoryMoment,
  timeTravelMemoryOptions,
} from './timeTravelMemory.helpers';

test('@iphone15 boot baseline for the time-travel WebContent budget', async ({ page }, testInfo) => {
  await installMemoryEngineDiagnostics(page);
  const consoleErrors = captureMemoryConsole(page);
  const diagnostics = startWebKitDiagnostics(testInfo, 'time-travel-boot-baseline');
  diagnostics.watch(page.context());
  let peakSingleWebMiB: number | null = null;
  let completed = false;
  let journeyFailure: { error: unknown } | undefined;
  let reference: {
    expectedCommit: string | undefined;
    servedCommit: unknown;
    measurementCommit: string | undefined;
    buildVersion: unknown;
    platform: string;
  } | undefined;
  try {
    const response = await page.request.get('/build.json');
    expect(response.ok()).toBe(true);
    const build = await response.json() as { commit?: unknown; version?: unknown };
    const expectedCommit = process.env.TT_MEMORY_BASELINE_REF;
    if (expectedCommit) expect(build.commit).toBe(expectedCommit);
    reference = {
      expectedCommit, servedCommit: build.commit, buildVersion: build.version,
      measurementCommit: process.env.TT_MEMORY_MEASUREMENT_REF, platform: platform(),
    };
    await onboardForTimeTravelMemory(page);
    // Include the settled Dashboard, as well as the boot peak.
    await page.waitForTimeout(5_000);
    completed = true;
  } catch (error) {
    journeyFailure = { error };
    throw error;
  } finally {
    await finalizeMemoryEngineDiagnostics(page, testInfo, async () => {
      const summary = await diagnostics.finish();
      peakSingleWebMiB = summary.peakSingleWebMiB;
      const report = { lane: 'iphone-15-webkit', kind: 'boot-baseline', completed, reference, repeatEachIndex: testInfo.repeatEachIndex, ...summary };
      await testInfo.attach('time-travel-memory.json', { body: JSON.stringify(report), contentType: 'application/json' });
      console.log(`time-travel-memory ${JSON.stringify(report)}`);
    }, journeyFailure);
  }
  expect(peakSingleWebMiB, 'a real macOS WebContent RSS baseline was sampled').not.toBeNull();
  expect(Number.isFinite(peakSingleWebMiB) && Number(peakSingleWebMiB) > 0).toBe(true);
  expect(consoleErrors).toEqual([]);
});

test('@iphone15 time-travel journey stays inside its WebContent RSS budget', async ({ page }, testInfo) => {
  await installMemoryEngineDiagnostics(page);
  const { granularity, phase } = timeTravelMemoryOptions();
  // Initial evidence collection is explicitly report-only. All gating journeys need a real baseline.
  const reportOnly = process.env.TT_MEMORY_REPORT_ONLY === '1';
  const baselineMiB = reportOnly ? null : parseWebKitBaselineMiB(process.env.TT_WEBKIT_BASELINE_MIB);
  const consoleErrors = captureMemoryConsole(page);
  const diagnostics = startWebKitDiagnostics(testInfo, 'time-travel-memory');
  diagnostics.watch(page.context());
  let peakSingleWebMiB: number | null = null;
  let completed = false;
  let journeyFailure: { error: unknown } | undefined;
  try {
    await onboardForTimeTravelMemory(page);
    await pickMemoryMoment(page, granularity, '2019-03-14');
    await pickMemoryMoment(page, granularity, granularity === 'day' ? '2019-03-15' : '2019-04-15');
    await pickMemoryMoment(page, granularity, '2019-03-14');
    await backToTodayForMemory(page);
    completed = true;
  } catch (error) {
    journeyFailure = { error };
    throw error;
  } finally {
    await finalizeMemoryEngineDiagnostics(page, testInfo, async () => {
      const summary = await diagnostics.finish();
      peakSingleWebMiB = summary.peakSingleWebMiB;
      const report = {
        lane: 'iphone-15-webkit', kind: 'journey', phase, granularity, completed,
        reportOnly, baselineMiB, budgetOverBaselineMiB: TIME_TRAVEL_MEMORY_BUDGET.webContentRssOverBaselineMiB,
        ...summary,
      };
      await testInfo.attach('time-travel-memory.json', { body: JSON.stringify(report), contentType: 'application/json' });
      console.log(`time-travel-memory ${JSON.stringify(report)}`);
      if (reportOnly) testInfo.annotations.push({ type: 'report-only', description: 'No baseline supplied; WebContent RSS budget NOT verified.' });
    }, journeyFailure);
  }
  expect(peakSingleWebMiB, 'the journey sampled a real macOS WebContent process').not.toBeNull();
  expect(Number.isFinite(peakSingleWebMiB) && Number(peakSingleWebMiB) > 0).toBe(true);
  if (baselineMiB !== null) {
    expect(peakSingleWebMiB).toBeLessThanOrEqual(baselineMiB + TIME_TRAVEL_MEMORY_BUDGET.webContentRssOverBaselineMiB);
  }
  expect(consoleErrors).toEqual([]);
});
