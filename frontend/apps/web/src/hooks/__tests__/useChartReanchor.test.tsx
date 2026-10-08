/**
 * The chart's ONE analysis instant follows the user's day.
 *
 * Every surface reads the chart's own instant (#274), and the predictive layer
 * is pinned to it. Without re-anchoring, a chart calculated on Jun 26 would show
 * "As of Jun 26" everywhere forever. On the first render of a new chart-local
 * day, the booted engine recomputes the chart as of now.
 */
import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiderealChart } from '@almamesh/browser/types';
import { useChartLibraryStore, useProfilesStore, type StoredChart } from '@almamesh/store';

import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import { ChartEngineContext, type ChartEngineContextValue } from '../../providers/chartEngineContext';
import { useChartReanchor } from '../useChartReanchor';
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
});
