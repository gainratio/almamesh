import { describe, expect, it } from 'vitest';

import { BOOT_MEMORY_BUDGET, overBudget, type BootMemorySample } from '../../e2e/memoryBudget';
import { formatMemoryReport, processTreeReport } from '../../scripts/processMemory.mjs';

const WITHIN: BootMemorySample = {
  heapPeakMiB: 278,
  rendererRssPeakMiB: 989,
  rendererRssSettledMiB: 955,
};

describe('boot memory budget (memory-budget e2e lane)', () => {
  it('pins the documented budgets as literals, not as references to themselves', () => {
    expect(BOOT_MEMORY_BUDGET.heapPeakMiB).toBe(300);
    expect(BOOT_MEMORY_BUDGET.rendererRssPeakMiB).toBe(1400);
    expect(BOOT_MEMORY_BUDGET.rendererRssSettledMiB).toBe(1100);
  });

  it('passes the last measured main-run sample (278 / 989 / 955 MiB)', () => {
    expect(overBudget(WITHIN, BOOT_MEMORY_BUDGET)).toEqual([]);
  });

  it('passes a sample exactly at every budget: the limit is inclusive', () => {
    expect(
      overBudget(
        { heapPeakMiB: 300, rendererRssPeakMiB: 1400, rendererRssSettledMiB: 1100 },
        BOOT_MEMORY_BUDGET,
      ),
    ).toEqual([]);
  });

  it('fails a heap one MiB over 300 and names the line it broke', () => {
    expect(overBudget({ ...WITHIN, heapPeakMiB: 301 }, BOOT_MEMORY_BUDGET)).toEqual([
      'page+workers JS/wasm heap peak 301 MiB > budget 300 MiB',
    ]);
  });

  it('fails each RSS line on its own', () => {
    expect(overBudget({ ...WITHIN, rendererRssPeakMiB: 1401 }, BOOT_MEMORY_BUDGET)).toEqual([
      'renderer RSS peak 1401 MiB > budget 1400 MiB',
    ]);
    expect(overBudget({ ...WITHIN, rendererRssSettledMiB: 1101 }, BOOT_MEMORY_BUDGET)).toEqual([
      'renderer RSS settled 1101 MiB > budget 1100 MiB',
    ]);
  });

  it('reports every broken line at once', () => {
    expect(
      overBudget({ heapPeakMiB: 400, rendererRssPeakMiB: 2000, rendererRssSettledMiB: 1500 }, BOOT_MEMORY_BUDGET),
    ).toHaveLength(3);
  });

  it('fails the embedder-loaded heap (338 MiB): the budget sits below it on purpose', () => {
    expect(overBudget({ ...WITHIN, heapPeakMiB: 338 }, BOOT_MEMORY_BUDGET)).toHaveLength(1);
  });

  it('treats an unmeasured (NaN) sample as a failure, not a pass', () => {
    expect(overBudget({ ...WITHIN, rendererRssSettledMiB: Number.NaN }, BOOT_MEMORY_BUDGET)).toEqual([
      'renderer RSS settled NaN MiB > budget 1100 MiB',
    ]);
  });
});

describe('report-only memory samples', () => {
  it('prints one greppable line per lane with MiB rounded to whole numbers', () => {
    expect(formatMemoryReport('boot-peak', { heapPeakMiB: 281.6, samples: 12 })).toBe(
      'memory-report boot-peak {"heapPeakMiB":282,"samples":12}',
    );
  });

  it('keeps an unavailable reading as null with its reason', () => {
    expect(formatMemoryReport('webkit', { webContentRssMiB: null, reason: 'non-Linux host' })).toBe(
      'memory-report webkit {"webContentRssMiB":null,"reason":"non-Linux host"}',
    );
  });
});

describe('process-tree report fields', () => {
  it('names the peak of each requested kind, null when that kind never ran', () => {
    const peak = { totalMiB: 900.4, byKind: { 'webkit-web': 610.2 }, processes: 3, samples: 40 };
    expect(processTreeReport(peak, ['webkit-web', 'webkit-network'])).toEqual({
      totalRssPeakMiB: 900.4,
      'webkit-webRssPeakMiB': 610.2,
      'webkit-networkRssPeakMiB': null,
      processes: 3,
      samples: 40,
    });
  });

  it('says why when /proc is unavailable', () => {
    expect(processTreeReport(null, ['renderer'])).toEqual({
      totalRssPeakMiB: null,
      reason: 'no /proc on this host (RSS is read on Linux only)',
    });
  });
});
