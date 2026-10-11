import { describe, expect, it } from 'vitest';

import {
  overTimeTravelBudget,
  parseWebKitBaselineMiB,
  PLACE_LOOKUP_HEAP_GROWTH_MIB,
  TIME_TRAVEL_MEMORY_BUDGET,
  type TimeTravelMemorySample,
} from '../../e2e/memoryBudget';

const WITHIN: TimeTravelMemorySample = { heapPeakMiB: 390, revisitHeapGrowthMiB: 1, cityLookupHeapGrowthMiB: 1 };

describe('time-travel memory budget', () => {
  it('uses the same bounded SQLite city growth limit for the standalone lookup lane', () => {
    expect(PLACE_LOOKUP_HEAP_GROWTH_MIB).toBe(TIME_TRAVEL_MEMORY_BUDGET.cityLookupHeapGrowthMiB);
  });

  it('pins limits lowered after five original Day probes, never raised to pass', () => {
    expect(TIME_TRAVEL_MEMORY_BUDGET).toEqual({
      heapPeakMiB: 399.1,
      revisitHeapGrowthMiB: 5,
      cityLookupHeapGrowthMiB: 8,
      webContentRssOverBaselineMiB: 250,
    });
  });

  it('passes inclusive limits and negative growth after a collection', () => {
    expect(overTimeTravelBudget({ heapPeakMiB: 399.1, revisitHeapGrowthMiB: 5, cityLookupHeapGrowthMiB: 8 })).toEqual([]);
    expect(overTimeTravelBudget({ ...WITHIN, revisitHeapGrowthMiB: -1 })).toEqual([]);
  });

  it.each([
    ['heapPeakMiB', 400],
    ['revisitHeapGrowthMiB', 6],
    ['cityLookupHeapGrowthMiB', 9],
  ] as const)('names only the exceeded %s limit', (key, value) => {
    expect(overTimeTravelBudget({ ...WITHIN, [key]: value })).toEqual([key]);
  });

  it('an unmeasured NaN or infinite reading fails each metric', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(overTimeTravelBudget({ heapPeakMiB: value, revisitHeapGrowthMiB: value, cityLookupHeapGrowthMiB: value })).toEqual([
        'heapPeakMiB', 'revisitHeapGrowthMiB', 'cityLookupHeapGrowthMiB',
      ]);
    }
  });

  it('baseline and probe phases gate only the first-compute heap while reporting growth', () => {
    const beforeSqlite = { ...WITHIN, revisitHeapGrowthMiB: Number.NaN, cityLookupHeapGrowthMiB: 49 };
    expect(overTimeTravelBudget(beforeSqlite, 'baseline')).toEqual([]);
    expect(overTimeTravelBudget(beforeSqlite, 'probe')).toEqual([]);
    expect(overTimeTravelBudget({ ...beforeSqlite, heapPeakMiB: 400 }, 'probe')).toEqual(['heapPeakMiB']);
    expect(overTimeTravelBudget(beforeSqlite)).toEqual(['revisitHeapGrowthMiB', 'cityLookupHeapGrowthMiB']);
  });

  it.each([undefined, '', ' ', 'NaN', 'Infinity', '-1', '0'])('refuses an unavailable WebKit baseline %j', (value) => {
    expect(() => parseWebKitBaselineMiB(value)).toThrow('TT_WEBKIT_BASELINE_MIB must be a finite positive boot baseline');
  });

  it('reads an explicitly measured positive WebKit baseline', () => {
    expect(parseWebKitBaselineMiB('123.5')).toBe(123.5);
  });
});
