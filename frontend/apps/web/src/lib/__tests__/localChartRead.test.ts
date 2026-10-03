/**
 * Regression: the chart-library store rehydrates from IndexedDB asynchronously,
 * so on a fresh document load (PWA reopen / hard refresh on /dashboard) the
 * store is still empty when a page first renders. `readLocalPrimaryChart()`
 * must WAIT for hydration before reading — reading early returns a false
 * "no chart" miss that strands the dashboard on an infinite loading spinner.
 *
 * Regression 2: `saveChart` updates memory before its SQLite write commits. A
 * dashboard that showed the in-memory chart let a reload in that window revert a
 * rectified chart (CI: report-pdf.e2e.spec.ts:973, "after reload the rectified
 * lagna (Cancer) must persist", received Leo). The read must wait for the write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredChart } from '@almamesh/store';

// Controllable test doubles for the persist hydration hooks + the read.
const hasHydrated = vi.fn<() => boolean>();
const finishHydrationCallbacks: Array<() => void> = [];
const onFinishHydration = vi.fn((cb: () => void) => {
  finishHydrationCallbacks.push(cb);
  return () => {
    const i = finishHydrationCallbacks.indexOf(cb);
    if (i >= 0) finishHydrationCallbacks.splice(i, 1);
  };
});
const getPrimaryChart = vi.fn<() => StoredChart | undefined>();
const persisted = { current: Promise.resolve() as Promise<void> };

vi.mock('@almamesh/store', () => ({
  useChartLibraryStore: {
    getState: () => ({ getPrimaryChart }),
    persist: {
      hasHydrated: () => hasHydrated(),
      onFinishHydration: (cb: () => void) => onFinishHydration(cb),
    },
  },
  // The real helper closes over the mocked store above.
  whenChartLibraryHydrated: (): Promise<void> => {
    if (hasHydrated()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const unsub = onFinishHydration(() => {
        unsub?.();
        resolve();
      });
    });
  },
  whenChartLibraryPersisted: (): Promise<void> => persisted.current,
}));

function makePrimaryChart(): StoredChart {
  return {
    chart_id: 'chart-123',
    person_name: 'Ada Lovelace',
    is_primary: true,
    astronomical_calculations: {
      sidereal_ctx: {
        julian_day: 0,
        ayanamsa_value: 24,
        ayanamsa_type: 'lahiri',
        house_system: 'whole_sign',
        sidereal_time: 0,
        lagna: {},
        planets: {},
      },
      calculation_timestamp: '1970-01-01T00:00:00.000Z',
      software_version: 'test',
    },
  } as StoredChart;
}

describe('readLocalPrimaryChart hydration race', () => {
  beforeEach(() => {
    hasHydrated.mockReset();
    onFinishHydration.mockClear();
    getPrimaryChart.mockReset();
    finishHydrationCallbacks.length = 0;
    persisted.current = Promise.resolve();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns the chart immediately when already hydrated', async () => {
    hasHydrated.mockReturnValue(true);
    getPrimaryChart.mockReturnValue(makePrimaryChart());

    const { readLocalPrimaryChart } = await import('../localChartRead');
    const res = await readLocalPrimaryChart();

    expect(res.success).toBe(true);
    expect(res.person_name).toBe('Ada Lovelace');
  });

  it('WAITS for hydration instead of returning a premature miss', async () => {
    // Cold load: store NOT hydrated yet, and the chart is not readable until it is.
    hasHydrated.mockReturnValue(false);
    getPrimaryChart.mockImplementation(() =>
      hasHydrated() ? makePrimaryChart() : undefined,
    );

    const { readLocalPrimaryChart } = await import('../localChartRead');
    const pending = readLocalPrimaryChart();

    // It must not have read (and thus not resolved a false miss) before hydration.
    expect(getPrimaryChart).not.toHaveBeenCalled();

    // Hydration finishes: store now has the chart and fires the persist callback.
    hasHydrated.mockReturnValue(true);
    finishHydrationCallbacks.forEach((cb) => cb());

    const res = await pending;
    expect(res.success).toBe(true);
    expect(res.person_name).toBe('Ada Lovelace');
    expect(res.message).toBe('Chart loaded from device.');
  });

  it('returns a benign miss after hydration when the device has no chart', async () => {
    hasHydrated.mockReturnValue(true);
    getPrimaryChart.mockReturnValue(undefined);

    const { readLocalPrimaryChart } = await import('../localChartRead');
    const res = await readLocalPrimaryChart();

    expect(res.success).toBe(false);
    expect(res.message).toBe('No chart found on this device.');
  });
});

describe('readLocalPrimaryChart durable-write barrier', () => {
  afterEach(() => {
    persisted.current = Promise.resolve();
    vi.resetModules();
  });

  it('does not return a chart whose write has not reached durable storage', async () => {
    hasHydrated.mockReturnValue(true);
    getPrimaryChart.mockReturnValue(makePrimaryChart());
    let commit = (): void => {};
    persisted.current = new Promise<void>((resolve) => {
      commit = resolve;
    });

    const { readLocalPrimaryChart } = await import('../localChartRead');
    let settled = false;
    const pending = readLocalPrimaryChart().then((res) => {
      settled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled, 'the dashboard read resolved before the chart was durable').toBe(false);

    commit();
    await expect(pending).resolves.toMatchObject({ success: true, chart_id: 'chart-123' });
  });
});
