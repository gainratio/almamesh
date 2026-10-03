import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import {
  chartLibraryStoreCreator,
  migrateChartLibraryPersistedState,
  setActiveProfileScope,
  type ChartLibraryStore,
  type StoredChart,
} from './chartLibrary';

function makeChart(id: string, primary: boolean, profileId?: string): StoredChart {
  return {
    chart_id: id,
    person_name: `Person ${id}`,
    is_primary: primary,
    profile_id: profileId,
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
  };
}

function newStore() {
  return createStore<ChartLibraryStore>(chartLibraryStoreCreator);
}

describe('migrateChartLibraryPersistedState (defensive hydration)', () => {
  it('passes a valid previous-shape blob through unchanged', () => {
    const blob = { charts: { a: makeChart('a', true) } };
    expect(migrateChartLibraryPersistedState(blob, 0)).toEqual(blob);
  });

  it('does NOT throw on a malformed / corrupt blob, returns a clean empty map', () => {
    for (const corrupt of [null, undefined, 'oops', 42, [], {}, { charts: 'x' }, { charts: 9 }]) {
      expect(() => migrateChartLibraryPersistedState(corrupt, 0)).not.toThrow();
      expect(migrateChartLibraryPersistedState(corrupt, 0)).toEqual({ charts: {} });
    }
  });
});

describe('chartLibraryStore', () => {
  beforeEach(() => {
    setActiveProfileScope(null); // default: show-all (back-compat / pre-migration)
  });

  afterEach(() => vi.unstubAllGlobals());

  it('saves and retrieves a chart by id', () => {
    const store = newStore();
    store.getState().saveChart(makeChart('a', true));
    expect(store.getState().getChart('a')?.person_name).toBe('Person a');
    expect(store.getState().listCharts()).toHaveLength(1);
  });

  it('does not persist a localStorage routing mirror when charts change', () => {
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem, removeItem });
    const store = newStore();

    store.getState().saveChart(makeChart('a', true));
    store.getState().deleteChart('a');

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('keeps exactly one primary chart', () => {
    const store = newStore();
    store.getState().saveChart(makeChart('a', true));
    store.getState().saveChart(makeChart('b', true));
    const primaries = store.getState().listCharts().filter((c) => c.is_primary);
    expect(primaries).toHaveLength(1);
    expect(store.getState().getPrimaryChart()?.chart_id).toBe('b');
  });

  it('falls back to the first chart when none is marked primary', () => {
    const store = newStore();
    store.getState().saveChart(makeChart('a', false));
    expect(store.getState().getPrimaryChart()?.chart_id).toBe('a');
  });

  it('deletes a chart', () => {
    const store = newStore();
    store.getState().saveChart(makeChart('a', true));
    store.getState().deleteChart('a');
    expect(store.getState().getChart('a')).toBeUndefined();
    expect(store.getState().listCharts()).toHaveLength(0);
  });

  describe('profile scoping', () => {
    it('a profile-less (orphan) chart is visible under any active scope', () => {
      const store = newStore();
      store.getState().saveChart(makeChart('orphan', true)); // no profile_id
      setActiveProfileScope('p1');
      expect(store.getState().listCharts()).toHaveLength(1);
      expect(store.getState().getPrimaryChart()?.chart_id).toBe('orphan');
    });

    it('listCharts filters to the active profile scope', () => {
      const store = newStore();
      store.getState().saveChart(makeChart('a', true, 'p1'));
      store.getState().saveChart(makeChart('b', true, 'p2'));
      setActiveProfileScope('p1');
      expect(store.getState().listCharts().map((c) => c.chart_id)).toEqual(['a']);
      setActiveProfileScope('p2');
      expect(store.getState().listCharts().map((c) => c.chart_id)).toEqual(['b']);
    });

    it('primacy is per-profile: each profile keeps its own primary', () => {
      const store = newStore();
      store.getState().saveChart(makeChart('a', true, 'p1'));
      store.getState().saveChart(makeChart('b', true, 'p2'));
      // Saving p2's primary must NOT demote p1's primary.
      setActiveProfileScope('p1');
      expect(store.getState().getPrimaryChart()?.chart_id).toBe('a');
      setActiveProfileScope('p2');
      expect(store.getState().getPrimaryChart()?.chart_id).toBe('b');
    });

    it('getPrimaryChart resolves within the active scope only', () => {
      const store = newStore();
      store.getState().saveChart(makeChart('a', true, 'p1'));
      store.getState().saveChart(makeChart('b', false, 'p2'));
      setActiveProfileScope('p2');
      expect(store.getState().getPrimaryChart()?.chart_id).toBe('b');
    });

    it('deleteChartsForProfile removes only that profile’s charts', () => {
      const store = newStore();
      store.getState().saveChart(makeChart('a', true, 'p1'));
      store.getState().saveChart(makeChart('b', true, 'p2'));
      store.getState().deleteChartsForProfile('p1');
      expect(store.getState().listAllCharts().map((c) => c.chart_id)).toEqual(['b']);
    });

    it('assignOrphanChartsToProfile is idempotent and claims only orphans', () => {
      const store = newStore();
      store.getState().saveChart(makeChart('orphan', true));
      store.getState().saveChart(makeChart('owned', true, 'p9'));
      const first = store.getState().assignOrphanChartsToProfile('p1');
      const second = store.getState().assignOrphanChartsToProfile('p1');
      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(store.getState().getChart('orphan')?.profile_id).toBe('p1');
      expect(store.getState().getChart('owned')?.profile_id).toBe('p9');
    });
  });
});
