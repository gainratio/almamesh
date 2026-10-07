/**
 * usePredictiveLayer — the auto-mode contract.
 *
 * The Life Atlas makes the predictive synthesis FOUNDATIONAL: `auto: true`
 * fires the (idempotent) compute when the booted engine + a chart with birth
 * data are both present. To avoid STARVING the single serial Pyodide worker the
 * instant the dashboard mounts (which would queue interactive engine calls —
 * e.g. the rectification live-preview — behind the ~30s predictive job), the
 * kickoff is DEFERRED (idle/short-timeout) and CANCELLED on unmount. So:
 *   - it must NOT fire synchronously on mount (deferred),
 *   - it must fire once the deferred timer elapses while still mounted,
 *   - unmounting before the timer elapses must CANCEL the kickoff (freeing the
 *     engine for interactive work like the rectification preview),
 *   - it must NOT loop on an error (recovery stays a human decision),
 *   - it must recompute when the active profile changes under a ready store,
 *   - it must never double-fire.
 */

import type { ReactElement, ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useChartLibraryStore,
  usePredictiveStore,
  useProfilesStore,
  type EnsurePredictiveInput,
  type PredictiveRuntime,
  type StoredChart,
  predictiveRequestKey,
} from '@almamesh/store';
import type { TransitCtx } from '@almamesh/shared-types';
import type { PredictiveContexts } from '@almamesh/browser/types';

import { ChartEngineContext, type ChartEngineContextValue } from '../../providers/chartEngineContext';
import { usePredictiveLayer } from '../usePredictiveLayer';

function storedChart(chartId = 'chart-1', personName = 'Asha Rao'): StoredChart {
  return {
    chart_id: chartId,
    profile_id: chartId,
    person_name: personName,
    is_primary: true,
    birth_data: {
      birth_datetime_utc: '1990-03-30T06:30:00Z',
      birth_datetime_local: '1990-03-30T12:00:00',
      birth_location_details: {
        city: 'Bengaluru',
        latitude: 12.97,
        longitude: 77.59,
        timezone: 'Asia/Kolkata',
      },
    },
  } as StoredChart;
}

/** A booted-engine context value; the engine object is never invoked here. */
function engineCtx(): ChartEngineContextValue {
  return {
    engine: {} as ChartEngineContextValue['engine'],
    stage: null,
    error: null,
    meta: null,
    reboot: () => Promise.reject(new Error('not used')),
    whenReady: () => Promise.reject(new Error('not used')),
    startBootstrap: () => {},
  };
}

function makeWrapper(ctx: ChartEngineContextValue | null) {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return <ChartEngineContext.Provider value={ctx}>{children}</ChartEngineContext.Provider>;
  };
}

/** A spying ensurePredictive that marks the store ready for the input's key. */
function readyingEnsure() {
  return vi.fn((_runtime: PredictiveRuntime, input: EnsurePredictiveInput): Promise<void> => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: input.profileKey,
      requestKey: predictiveRequestKey(input),
    });
    return Promise.resolve();
  });
}

describe('usePredictiveLayer({ auto: true })', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
    useProfilesStore.setState({ activeProfileId: 'chart-1' });
    usePredictiveStore.getState().reset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does NOT fire synchronously on mount (the kickoff is deferred)', () => {
    const ensure = readyingEnsure();
    usePredictiveStore.setState({ ensurePredictive: ensure });

    renderHook(() => usePredictiveLayer({ auto: true }), { wrapper: makeWrapper(engineCtx()) });

    // Mounted but timers not yet advanced — the engine must be free.
    expect(ensure).not.toHaveBeenCalled();
  });

  it('fires compute exactly once after the deferred timer elapses while mounted', () => {
    const ensure = readyingEnsure();
    usePredictiveStore.setState({ ensurePredictive: ensure });

    const { rerender } = renderHook(() => usePredictiveLayer({ auto: true }), {
      wrapper: makeWrapper(engineCtx()),
    });

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(usePredictiveStore.getState().status).toBe('ready');
  });

  it('CANCELS the deferred kickoff if unmounted before it elapses (frees the engine)', () => {
    const ensure = readyingEnsure();
    usePredictiveStore.setState({ ensurePredictive: ensure });

    const { unmount } = renderHook(() => usePredictiveLayer({ auto: true }), {
      wrapper: makeWrapper(engineCtx()),
    });

    // User navigates away before the deferred kickoff fires.
    unmount();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(ensure).not.toHaveBeenCalled();
  });

  it('does not fire while the engine is still warming (no engine in context)', () => {
    const ensure = vi.fn((): Promise<void> => Promise.resolve());
    usePredictiveStore.setState({ ensurePredictive: ensure });

    renderHook(() => usePredictiveLayer({ auto: true }), { wrapper: makeWrapper(null) });
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(ensure).not.toHaveBeenCalled();
  });

  it('never auto-retries an error (status stays error, no further compute)', () => {
    const ensure = vi.fn((): Promise<void> => Promise.resolve());
    usePredictiveStore.setState({
      status: 'error',
      error: 'boom',
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-07-12T00:00:00Z',
      }),
      ensurePredictive: ensure,
    });

    const { rerender } = renderHook(() => usePredictiveLayer({ auto: true }), {
      wrapper: makeWrapper(engineCtx()),
    });

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(usePredictiveStore.getState().status).toBe('error');
  });

  it('recomputes when the active profile switches under an already-ready store', () => {
    const ensure = readyingEnsure();
    // Already ready for chart-1.
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-07-12T00:00:00Z',
      }),
      ensurePredictive: ensure,
    });

    const { rerender } = renderHook(() => usePredictiveLayer({ auto: true }), {
      wrapper: makeWrapper(engineCtx()),
    });
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    rerender();
    expect(ensure).not.toHaveBeenCalled(); // already current

    // Switch the active profile to a second chart.
    act(() => {
      useChartLibraryStore.setState({
        charts: { 'chart-2': storedChart('chart-2', 'Ben') },
        hydrated: true,
      });
      useProfilesStore.setState({ activeProfileId: 'chart-2' });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[1].profileKey).toBe('chart-2');
  });

  it('recomputes when rectification changes the birth instant under the same profile and day', () => {
    const ensure = readyingEnsure();
    const originalInput: EnsurePredictiveInput = {
      profileKey: 'chart-1',
      datetimeUtc: '1990-03-30T06:30:00Z',
      latitude: 12.97,
      longitude: 77.59,
      referenceInstant: '2026-07-12T00:00:00Z',
    };
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey(originalInput),
      ensurePredictive: ensure,
    });

    const { rerender } = renderHook(() => usePredictiveLayer({ auto: true }), {
      wrapper: makeWrapper(engineCtx()),
    });

    act(() => {
      const rectified = storedChart();
      const birth = rectified.birth_data!;
      rectified.birth_data = {
        ...birth,
        birth_datetime_utc: '1990-03-30T06:45:00Z',
      };
      useChartLibraryStore.setState({ charts: { 'chart-1': rectified }, hydrated: true });
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[1].datetimeUtc).toBe('1990-03-30T06:45:00Z');
  });

  it('withholds stale predictive contexts from a regenerated natal chart', () => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:15:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-07-12T00:00:00Z',
      }),
      transitCtx: { instant: 'stale-aquarius' } as TransitCtx,
    });

    const { result } = renderHook(() => usePredictiveLayer(), {
      wrapper: makeWrapper(engineCtx()),
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.transitCtx).toBeUndefined();
  });

  it("recomputes after the viewer's reference day rolls over", () => {
    // A chart that records no instant reads as of the viewer's today (#277).
    vi.stubEnv('TZ', 'UTC');
    vi.setSystemTime(new Date('2026-07-12T23:59:58Z'));
    const ensure = readyingEnsure();
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-07-12T00:00:00Z',
      }),
      ensurePredictive: ensure,
    });
    renderHook(() => usePredictiveLayer({ auto: true }), {
      wrapper: makeWrapper(engineCtx()),
    });

    act(() => {
      // The day-change timer resolves to within a second past midnight.
      vi.advanceTimersByTime(3_100);
    });
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[1].referenceInstant).toBe('2026-07-13T00:00:00Z');
    vi.unstubAllEnvs();
  });

  it('does not double-fire when the deferred timer is rescheduled across re-renders', () => {
    const ensure = readyingEnsure();
    usePredictiveStore.setState({ ensurePredictive: ensure });

    const { rerender } = renderHook(() => usePredictiveLayer({ auto: true }), {
      wrapper: makeWrapper(engineCtx()),
    });

    // Several re-renders before the timer elapses must not stack kickoffs.
    rerender();
    rerender();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    rerender();
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(ensure).toHaveBeenCalledTimes(1);
  });
});

describe('usePredictiveLayer — raw engine contexts passthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    useChartLibraryStore.setState({ charts: { 'chart-1': storedChart() }, hydrated: true });
    useProfilesStore.setState({ activeProfileId: 'chart-1' });
    usePredictiveStore.getState().reset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('surfaces rawContexts (Spec 062 delta) once cached for the exact input', () => {
    const rawContexts = { domains_context: { instant: 'raw' } } as unknown as PredictiveContexts;
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-07-12T00:00:00Z',
      }),
      rawContexts,
    });

    const { result } = renderHook(() => usePredictiveLayer(), {
      wrapper: makeWrapper(engineCtx()),
    });

    expect(result.current.rawContexts).toBe(rawContexts);
  });

  it('withholds rawContexts from a stale cache (mismatched request key)', () => {
    usePredictiveStore.setState({
      status: 'ready',
      profileKey: 'chart-1',
      requestKey: predictiveRequestKey({
        profileKey: 'chart-1',
        datetimeUtc: '1990-03-30T06:15:00Z', // does not match storedChart()'s birth time
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-07-12T00:00:00Z',
      }),
      rawContexts: { domains_context: { instant: 'stale' } } as unknown as PredictiveContexts,
    });

    const { result } = renderHook(() => usePredictiveLayer(), {
      wrapper: makeWrapper(engineCtx()),
    });

    expect(result.current.rawContexts).toBeUndefined();
  });
});
