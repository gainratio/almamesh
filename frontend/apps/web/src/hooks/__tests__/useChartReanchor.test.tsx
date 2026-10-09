/**
 * The chart's ONE analysis instant follows the user's day.
 *
 * Every surface reads the chart's own instant (#274), and the predictive layer
 * is pinned to it. Without re-anchoring, a chart calculated on Jun 26 would show
 * "As of Jun 26" everywhere forever. On the first render of a new chart-local
 * day, the booted engine recomputes the chart as of now.
 */
import { StrictMode, type ReactElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiderealChart } from '@almamesh/browser/types';
import { useChartLibraryStore, useProfilesStore, type StoredChart } from '@almamesh/store';

import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import { ChartEngineContext, type ChartEngineContextValue } from '../../providers/chartEngineContext';
import { REANCHOR_WAIT_LIMIT_MS, useChartReanchor } from '../useChartReanchor';
import { useChartReanchorStatus } from '../../lib/chartReanchorStatus';

const ENGINE_CHART = (golden as Record<string, SiderealChart>)['1990-01-15T12:00:00+00:00']!;
/** The same chart as stored before snapshots: only `calculation_timestamp` records its instant. */
const { snapshot: _snapshot, ...PRE_SNAPSHOT_CHART } = ENGINE_CHART;
const TODAY = new Date('2026-10-07T18:00:00.000Z');

function chartCalculatedOn(instant: string): StoredChart {
  return {
    chart_id: 'chart-1',
    profile_id: 'p1',
    person_name: 'Asha Rao',
    is_primary: true,
    birth_data: {
      birth_datetime_utc: '1990-01-15T12:00:00+00:00',
      birth_datetime_local: '1990-01-15T17:30:00',
      birth_location_details: {
        city: 'Delhi',
        latitude: 28.6139,
        longitude: 77.209,
        timezone: 'Asia/Kolkata',
      },
    },
    astronomical_calculations: { calculation_timestamp: instant },
    sidereal_chart: PRE_SNAPSHOT_CHART,
  } as unknown as StoredChart;
}

function engineCtx(generateChart: () => Promise<SiderealChart>): ChartEngineContextValue {
  return {
    engine: { generateChart } as unknown as ChartEngineContextValue['engine'],
    stage: null,
    error: null,
    meta: null,
    reboot: () => Promise.reject(new Error('not used')),
    whenReady: () => Promise.reject(new Error('not used')),
    startBootstrap: () => {},
  };
}

function renderReanchor(ctx: ChartEngineContextValue | null): void {
  const client = new QueryClient();
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={client}>
      <ChartEngineContext.Provider value={ctx}>{children}</ChartEngineContext.Provider>
    </QueryClientProvider>
  );
  renderHook(() => useChartReanchor(), { wrapper: Wrapper });
}

interface MountedReanchor {
  readonly bringUpEngine: (ctx: ChartEngineContextValue) => void;
  readonly unmount: () => void;
}

/** Mount the hook with an engine that can come up later, optionally under StrictMode. */
function mountReanchor(strict = false): MountedReanchor {
  const client = new QueryClient();
  let ctx: ChartEngineContextValue | null = null;
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => {
    const tree = (
      <QueryClientProvider client={client}>
        <ChartEngineContext.Provider value={ctx}>{children}</ChartEngineContext.Provider>
      </QueryClientProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  const { rerender, unmount } = renderHook(() => useChartReanchor(), { wrapper: Wrapper });
  return {
    bringUpEngine: (next) => {
      ctx = next;
      rerender();
    },
    unmount,
  };
}

/** A recompute that stays in flight until the test fails it (freeing the shared queue). */
function heldGenerateChart(): { readonly generateChart: () => Promise<SiderealChart>; readonly fail: () => void } {
  let reject: (reason: Error) => void = () => {};
  const generateChart = vi.fn(
    () => new Promise<SiderealChart>((_resolve, rejectRun) => {
      reject = rejectRun;
    }),
  );
  return { generateChart, fail: () => reject(new Error('released by test')) };
}

function storedInstant(): string | undefined {
  return useChartLibraryStore.getState().getChart('chart-1')?.astronomical_calculations
    .calculation_timestamp;
}

describe('useChartReanchor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TODAY);
    useProfilesStore.setState({ activeProfileId: 'p1' });
  });

  afterEach(() => {
    vi.useRealTimers();
    useChartLibraryStore.setState({ charts: {} });
    useChartReanchorStatus.setState({ pendingChartIds: new Set() });
  });

  function isPending(): boolean {
    return useChartReanchorStatus.getState().pendingChartIds.has('chart-1');
  }

  it('reports the chart as re-anchoring until the recompute lands', async () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    let finish!: (chart: SiderealChart) => void;
    const generateChart = vi.fn(
      () => new Promise<SiderealChart>((resolve) => {
        finish = resolve;
      }),
    );
    renderReanchor(engineCtx(generateChart));

    await waitFor(() => expect(generateChart).toHaveBeenCalledTimes(1));
    expect(isPending()).toBe(true);

    finish(ENGINE_CHART);
    await waitFor(() => expect(storedInstant()).toBe(TODAY.toISOString()));
    await waitFor(() => expect(isPending()).toBe(false));
  });

  it('stops reporting the re-anchor when it fails, so chat is never locked', async () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    let fail!: (reason: Error) => void;
    const generateChart = vi.fn(
      () => new Promise<SiderealChart>((_resolve, reject) => {
        fail = reject;
      }),
    );
    renderReanchor(engineCtx(generateChart));

    await waitFor(() => expect(generateChart).toHaveBeenCalledTimes(1));
    expect(isPending()).toBe(true);

    fail(new Error('engine down'));
    await waitFor(() => expect(isPending()).toBe(false));
    expect(storedInstant()).toBe('2026-06-26T17:00:00.000Z');
  });

  it('waits 30 s at most, so a hung engine cannot lock chat until reload', async () => {
    expect(REANCHOR_WAIT_LIMIT_MS).toBe(30_000);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(TODAY);
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    let unhang!: (reason: Error) => void;
    const generateChart = vi.fn(
      () => new Promise<SiderealChart>((_resolve, reject) => {
        unhang = reject;
      }),
    );
    renderReanchor(engineCtx(generateChart));

    // The attempt starts on mount; flush its microtasks without moving the clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(generateChart).toHaveBeenCalledTimes(1);
    expect(isPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(isPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(isPending()).toBe(false);

    // Free the shared re-anchor queue for the next test.
    unhang(new Error('worker gone'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('never reports a re-anchor for a chart already as of today', async () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-10-07T17:00:00.000Z') },
      hydrated: true,
    });
    renderReanchor(engineCtx(vi.fn(async () => ENGINE_CHART)));
    await Promise.resolve();
    expect(isPending()).toBe(false);
  });

  it('recomputes a chart calculated on an earlier day as of now', async () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    const generateChart = vi.fn(async () => ENGINE_CHART);
    renderReanchor(engineCtx(generateChart));

    await waitFor(() => expect(storedInstant()).toBe(TODAY.toISOString()));
    expect(generateChart).toHaveBeenCalledTimes(1);
  });

  it('leaves a chart already as of today alone', async () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-10-07T17:00:00.000Z') },
      hydrated: true,
    });
    const generateChart = vi.fn(async () => ENGINE_CHART);
    renderReanchor(engineCtx(generateChart));

    await Promise.resolve();
    expect(generateChart).not.toHaveBeenCalled();
    expect(storedInstant()).toBe('2026-10-07T17:00:00.000Z');
  });

  it('waits for the engine, and does nothing without one', () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    renderReanchor(null);
    expect(storedInstant()).toBe('2026-06-26T17:00:00.000Z');
  });

  // Nightly chat.rag.real, 2026-10-08/09: chat opened while the engine was
  // still booting. Nothing was listed yet, so Send was enabled, the question
  // went out, the engine came up, the re-anchor landed mid-answer and the paid
  // answer was discarded ("Your chart changed while this answer was being written").
  it('reports a due re-anchor before the engine is up, so chat waits for it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(TODAY);
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    const generateChart = vi.fn(async () => ENGINE_CHART);
    const client = new QueryClient();
    let ctx: ChartEngineContextValue | null = null;
    const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
      <QueryClientProvider client={client}>
        <ChartEngineContext.Provider value={ctx}>{children}</ChartEngineContext.Provider>
      </QueryClientProvider>
    );
    const { rerender } = renderHook(() => useChartReanchor(), { wrapper: Wrapper });

    await vi.advanceTimersByTimeAsync(0);
    expect(isPending()).toBe(true);
    expect(generateChart).not.toHaveBeenCalled();

    ctx = engineCtx(generateChart);
    rerender();
    await vi.advanceTimersByTimeAsync(0);
    expect(generateChart).toHaveBeenCalledTimes(1);
    expect(storedInstant()).toBe(TODAY.toISOString());
    expect(isPending()).toBe(false);
  });

  it('stops waiting for an engine that never comes up after 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(TODAY);
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    renderReanchor(null);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(isPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(isPending()).toBe(false);
  });

  it('tries once per day when the engine fails, never in a loop', async () => {
    useChartLibraryStore.setState({
      charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
      hydrated: true,
    });
    const generateChart = vi.fn(async (): Promise<SiderealChart> => {
      throw new Error('engine down');
    });
    renderReanchor(engineCtx(generateChart));

    await waitFor(() => expect(generateChart).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(generateChart).toHaveBeenCalledTimes(1);
    expect(storedInstant()).toBe('2026-06-26T17:00:00.000Z');
  });

  describe('the wait chat sees', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(TODAY);
      useChartLibraryStore.setState({
        charts: { 'chart-1': chartCalculatedOn('2026-06-26T17:00:00.000Z') },
        hydrated: true,
      });
    });

    // Northstar on #308: after the 30 s cap, an engine that boots late started
    // the recompute with chat unblocked, worse than main on slow phones.
    it('waits again when the recompute starts after the cap expired', async () => {
      const held = heldGenerateChart();
      const mounted = mountReanchor();
      await vi.advanceTimersByTimeAsync(REANCHOR_WAIT_LIMIT_MS);
      expect(isPending()).toBe(false);

      mounted.bringUpEngine(engineCtx(held.generateChart));
      await vi.advanceTimersByTimeAsync(0);
      expect(held.generateChart).toHaveBeenCalledTimes(1);
      expect(isPending()).toBe(true);

      held.fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(isPending()).toBe(false);
    });

    // src/main.tsx renders under StrictMode: mount, unmount, mount again.
    it('waits under StrictMode while the engine boots', async () => {
      mountReanchor(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(isPending()).toBe(true);
    });

    it('waits under StrictMode while the recompute runs, and stops when it lands', async () => {
      const held = heldGenerateChart();
      const timersBefore = vi.getTimerCount();
      const mounted = mountReanchor(true);
      mounted.bringUpEngine(engineCtx(held.generateChart));
      await vi.advanceTimersByTimeAsync(0);
      expect(held.generateChart).toHaveBeenCalledTimes(1);
      expect(isPending()).toBe(true);

      held.fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(isPending()).toBe(false);
      mounted.unmount();
      expect(vi.getTimerCount(), 'the wait limit timer is cleared').toBe(timersBefore);
    });

    it('releases the wait and leaves no timer behind on unmount', async () => {
      const timersBefore = vi.getTimerCount();
      const mounted = mountReanchor();
      await vi.advanceTimersByTimeAsync(0);
      expect(isPending()).toBe(true);
      const timersMounted = vi.getTimerCount();
      expect(timersMounted).toBeGreaterThan(timersBefore);

      mounted.unmount();
      expect(isPending()).toBe(false);
      expect(vi.getTimerCount(), 'the wait limit timer is cleared').toBe(timersBefore);
    });
  });
});
