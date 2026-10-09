/**
 * useRectification — orchestration hook tests.
 *
 * Covers:
 *  - happy path: run() transitions store idle -> loading -> ready
 *  - engine throw: error state; retry() calls reboot() then re-runs -> ready
 *  - cancel-on-unmount: unmount mid-run does NOT leave result in the store
 *  - predictive gate: active on mount, cleared on unmount
 *  - event guard: hasEnoughEvents false with no structured events
 *  - engine guard: engineReady false when context has no engine
 */

import type { ReactElement, ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useChartLibraryStore,
  useLifeEventsStore,
  useRectificationStore,
  type StoredChart,
  type LifeEvent,
} from '@almamesh/store';
import type { ChartEngine } from '@almamesh/browser';
import type { RectificationResultRaw } from '@almamesh/browser/types';
import {
  ChartEngineContext,
  type ChartEngineContextValue,
} from '../providers/chartEngineContext';
import { useRectificationGate } from '../lib/rectificationGate';
import { useRectification, toWireEvents } from './useRectification';

// ---------------------------------------------------------------------------
// Synthetic fixtures (no real PII — generic birth data)
// ---------------------------------------------------------------------------

const PROFILE_ID = 'profile-test-rect-1';
const CHART_ID = 'chart-test-rect-1';

function syntheticChart(): StoredChart {
  return {
    chart_id: CHART_ID,
    person_name: 'Asha Rao',
    is_primary: true,
    profile_id: PROFILE_ID,
    birth_data: {
      birth_datetime_utc: '1990-06-15T01:30:00Z',
      birth_datetime_local: '1990-06-15T07:00:00',
      birth_location_details: {
        city: 'Bengaluru',
        latitude: 12.97,
        longitude: 77.59,
        timezone: 'Asia/Kolkata',
      },
    },
  } as StoredChart;
}

const SYNTHETIC_RAW: RectificationResultRaw = {
  mode: 'cusp',
  candidates: [
    {
      ascendant_sign: 'Cancer',
      representative_time_local: '07:05',
      lagna_longitude_deg: 95.2,
      lagna_cusp_distance_deg: 5.2,
      is_near_cusp: false,
      fit_score: 0.75,
      supporting_events: [],
    },
  ],
  margin: 0.28,
  band: 'leans',
  discriminating_event_count: 1,
  recorded_time_sign: 'Cancer',
  honesty_note_key: 'rectify.honesty.leans',
};

// ---------------------------------------------------------------------------
// Engine context helpers
// ---------------------------------------------------------------------------

function makeEngineCtx(
  computeImpl?: () => Promise<RectificationResultRaw>,
  rebootImpl?: () => Promise<ChartEngine>,
): ChartEngineContextValue {
  const computeRectification = vi.fn(computeImpl ?? (() => Promise.resolve(SYNTHETIC_RAW)));
  const engine = { computeRectification } as unknown as ChartEngine;
  return {
    engine,
    stage: null,
    error: null,
    meta: null,
    reboot: vi.fn(rebootImpl ?? (() => Promise.resolve(engine))),
    whenReady: vi.fn(() => Promise.resolve(engine)),
    startBootstrap: vi.fn(),
  };
}

function makeWrapper(ctx: ChartEngineContextValue | null) {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return <ChartEngineContext.Provider value={ctx}>{children}</ChartEngineContext.Provider>;
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  useChartLibraryStore.setState({
    charts: { [CHART_ID]: syntheticChart() },
    hydrated: true,
  });
  useLifeEventsStore.setState({
    eventsByProfile: {
      [PROFILE_ID]: [
        {
          id: 'evt-s1',
          date: '2015-09-20',
          category: 'career_change',
          createdAt: '2015-09-20T00:00:00Z',
        },
      ],
    },
    hydrated: true,
  });
  useRectificationStore.getState().reset();
  useRectificationGate.setState({ active: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRectification', () => {
  it('run() surfaces a missing birthplace timezone as an error instead of computing in UTC', async () => {
    const chart = syntheticChart();
    const noZone = {
      ...chart,
      birth_data: {
        ...chart.birth_data!,
        birth_location_details: { ...chart.birth_data!.birth_location_details, timezone: '' },
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { [CHART_ID]: noZone }, hydrated: true });
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await result.current.run('cusp');
    });

    expect(result.current.state.status).toBe('error');
    expect(result.current.state.error).toMatch(/timezone is missing/);
    const compute = (ctx.engine as unknown as { computeRectification: ReturnType<typeof vi.fn> })
      .computeRectification;
    expect(compute).not.toHaveBeenCalled();
  });

  it('run() transitions store idle -> loading -> ready with the adapted result', async () => {
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await result.current.run('cusp');
    });

    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.result).not.toBeNull();
    expect(result.current.state.result?.mode).toBe('cusp');
    expect(result.current.state.result?.band).toBe('leans');
    expect(result.current.state.result?.discriminatingEventCount).toBe(1);
    expect(result.current.state.error).toBeNull();
  });

  // Spec 062: the wire input carries the E5 anchor prior explicitly, matching
  // the engine defaults ('about' for cusp — a recorded time exists; 'unknown'
  // for window) so absent and explicit are byte-identical. spanMinutes is
  // threaded only when the caller supplies it.
  it('run("cusp") sends anchorConfidence "about" and omits spanMinutes by default', async () => {
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await result.current.run('cusp');
    });

    const compute = (ctx.engine as unknown as { computeRectification: ReturnType<typeof vi.fn> })
      .computeRectification;
    const wire = compute.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(wire.anchorConfidence).toBe('about');
    expect('spanMinutes' in wire).toBe(false);
  });

  it('run("window", spanMinutes) sends anchorConfidence "unknown" and threads spanMinutes', async () => {
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await result.current.run('window', 90);
    });

    const compute = (ctx.engine as unknown as { computeRectification: ReturnType<typeof vi.fn> })
      .computeRectification;
    const wire = compute.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(wire.anchorConfidence).toBe('unknown');
    expect(wire.spanMinutes).toBe(90);
  });

  it('engine throw produces error state; retry() calls reboot() then re-runs -> ready', async () => {
    let callCount = 0;
    const computeImpl = (): Promise<RectificationResultRaw> => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('Engine exploded'));
      return Promise.resolve(SYNTHETIC_RAW);
    };
    // reboot resolves with the same engine (which now succeeds on second compute call)
    const ctx = makeEngineCtx(computeImpl);

    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    // First run -> error
    await act(async () => {
      await result.current.run('cusp');
    });
    expect(result.current.state.status).toBe('error');
    expect(result.current.state.error).toBe('Engine exploded');

    // retry() -> calls reboot(), then re-runs -> ready
    await act(async () => {
      await result.current.retry();
    });
    expect(ctx.reboot).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.result?.mode).toBe('cusp');
  });

  it('unmount mid-run does NOT leave result in the store (calls reset after resolve)', async () => {
    let resolveEngine!: (v: RectificationResultRaw) => void;
    const enginePromise = new Promise<RectificationResultRaw>((res) => {
      resolveEngine = res;
    });
    const ctx = makeEngineCtx(() => enginePromise);

    const { result, unmount } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    // Fire run without awaiting so we can intercept mid-flight
    const runPromise = result.current.run('cusp');

    // The store's run() sets 'loading' synchronously before the await
    expect(useRectificationStore.getState().status).toBe('loading');

    // Unmount the hook (sets cancelledRef.current = true via useEffect cleanup)
    unmount();

    // Now resolve the engine; the store will write 'ready', then the hook
    // checks cancelledRef.current (true) and immediately calls reset() -> 'idle'
    await act(async () => {
      resolveEngine(SYNTHETIC_RAW);
      await runPromise;
    });

    expect(useRectificationStore.getState().status).toBe('idle');
    expect(useRectificationStore.getState().result).toBeNull();
  });

  it('predictive gate is active while mounted and cleared on unmount', () => {
    const ctx = makeEngineCtx();
    const { unmount } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(useRectificationGate.getState().active).toBe(true);

    unmount();

    expect(useRectificationGate.getState().active).toBe(false);
  });

  it('hasEnoughEvents is false when the profile has no structured life events', () => {
    useLifeEventsStore.setState({ eventsByProfile: { [PROFILE_ID]: [] } });

    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.hasEnoughEvents).toBe(false);
  });

  it('hasEnoughEvents is false when all events are unstructured (missing date or category)', () => {
    useLifeEventsStore.setState({
      eventsByProfile: {
        [PROFILE_ID]: [
          // Missing category -> not structured
          { id: 'e1', date: '2015-01-01', createdAt: '2015-01-01T00:00:00Z' },
          // Missing date -> not structured
          { id: 'e2', date: '', category: 'marriage', createdAt: '2015-01-02T00:00:00Z' },
        ],
      },
    });

    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.hasEnoughEvents).toBe(false);
  });

  it('engineReady is false when the context provides no engine', () => {
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(null),
    });

    expect(result.current.engineReady).toBe(false);
  });

  it('run() is a no-op when the engine is not ready (no store mutation)', async () => {
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(null),
    });

    await act(async () => {
      await result.current.run('cusp');
    });

    expect(useRectificationStore.getState().status).toBe('idle');
  });

  it('reset() returns the store to idle', async () => {
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await result.current.run('cusp');
    });
    expect(result.current.state.status).toBe('ready');

    act(() => {
      result.current.reset();
    });
    expect(result.current.state.status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// detectedMode — auto-selects 'window' for unknown/rough, 'cusp' otherwise
// ---------------------------------------------------------------------------

describe('detectedMode', () => {
  it('is "window" when birth_time_confidence is "unknown"', () => {
    const chart = {
      ...syntheticChart(),
      birth_data: {
        ...syntheticChart().birth_data,
        birth_time_confidence: 'unknown',
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { [CHART_ID]: chart }, hydrated: true });

    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.detectedMode).toBe('window');
  });

  it('is "window" when birth_time_confidence is "rough"', () => {
    const chart = {
      ...syntheticChart(),
      birth_data: {
        ...syntheticChart().birth_data,
        birth_time_confidence: 'rough',
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { [CHART_ID]: chart }, hydrated: true });

    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.detectedMode).toBe('window');
  });

  it('is "cusp" when birth_time_confidence is "exact"', () => {
    const chart = {
      ...syntheticChart(),
      birth_data: {
        ...syntheticChart().birth_data,
        birth_time_confidence: 'exact',
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { [CHART_ID]: chart }, hydrated: true });

    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.detectedMode).toBe('cusp');
  });

  it('is "cusp" when birth_time_confidence is "approximate"', () => {
    const chart = {
      ...syntheticChart(),
      birth_data: {
        ...syntheticChart().birth_data,
        birth_time_confidence: 'approximate',
      },
    } as StoredChart;
    useChartLibraryStore.setState({ charts: { [CHART_ID]: chart }, hydrated: true });

    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.detectedMode).toBe('cusp');
  });

  it('defaults to "cusp" when birth_time_confidence is absent', () => {
    // syntheticChart() has no birth_time_confidence — default should be 'cusp'
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.detectedMode).toBe('cusp');
  });
});

// ---------------------------------------------------------------------------
// Engine warming + recovery (the primary UX defect this fix targets)
// ---------------------------------------------------------------------------

/**
 * A context whose engine is NOT yet ready (warming / errored). `reboot()` and
 * `whenReady()` resolve to a working engine so the recovery path can be tested.
 */
function makeWarmingCtx(
  overrides: Partial<ChartEngineContextValue> = {},
): ChartEngineContextValue {
  const computeRectification = vi.fn(() => Promise.resolve(SYNTHETIC_RAW));
  const readyEngine = { computeRectification } as unknown as ChartEngine;
  return {
    engine: null,
    stage: null,
    error: null,
    meta: null,
    reboot: vi.fn(() => Promise.resolve(readyEngine)),
    whenReady: vi.fn(() => Promise.resolve(readyEngine)),
    startBootstrap: vi.fn(),
    ...overrides,
  };
}

describe('useRectification — engine warming + recovery', () => {
  it('exposes engineError from the engine context error', () => {
    const ctx = makeWarmingCtx({ error: new Error('Boot failed') });
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });
    expect(result.current.engineError).toBe('Boot failed');
  });

  it('engineError is null when the engine context reports no error', () => {
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });
    expect(result.current.engineError).toBeNull();
  });

  it('missingBirth is true when no stored chart matches the profile', () => {
    useChartLibraryStore.setState({ charts: {}, hydrated: true });
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });
    expect(result.current.missingBirth).toBe(true);
  });

  it('missingBirth is false when the profile has a stored chart with a location', () => {
    const ctx = makeEngineCtx();
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });
    expect(result.current.missingBirth).toBe(false);
  });

  it('eagerly warms the engine on mount via startBootstrap when no engine yet', () => {
    const ctx = makeWarmingCtx();
    renderHook(() => useRectification(PROFILE_ID), { wrapper: makeWrapper(ctx) });
    expect(ctx.startBootstrap).toHaveBeenCalled();
  });

  it('attempts an in-app reboot on mount when the engine arrived already errored', () => {
    const ctx = makeWarmingCtx({ error: new Error('stale bundle') });
    renderHook(() => useRectification(PROFILE_ID), { wrapper: makeWrapper(ctx) });
    expect(ctx.reboot).toHaveBeenCalled();
    expect(ctx.startBootstrap).not.toHaveBeenCalled();
  });

  it('logs a WARNING when the pre-warm reboot fails (best-effort, but never silent)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ctx = makeWarmingCtx({
        error: new Error('stale bundle'),
        reboot: vi.fn(() => Promise.reject(new Error('reboot exploded'))),
      });
      renderHook(() => useRectification(PROFILE_ID), { wrapper: makeWrapper(ctx) });
      await waitFor(() => expect(warnSpy).toHaveBeenCalled());
      expect(warnSpy).toHaveBeenCalledWith('[almamesh:warn:engine.prewarm_failed]');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warmingTimedOut flips true after the warm timeout when the engine never boots', () => {
    vi.useFakeTimers();
    try {
      const ctx = makeWarmingCtx();
      const { result } = renderHook(() => useRectification(PROFILE_ID), {
        wrapper: makeWrapper(ctx),
      });
      expect(result.current.warmingTimedOut).toBe(false);
      act(() => {
        vi.advanceTimersByTime(90_000);
      });
      expect(result.current.warmingTimedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warmingTimedOut stays false when the engine is already ready', () => {
    vi.useFakeTimers();
    try {
      const ctx = makeEngineCtx(); // engine present
      const { result } = renderHook(() => useRectification(PROFILE_ID), {
        wrapper: makeWrapper(ctx),
      });
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(result.current.warmingTimedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retry() recovers even when run() was never called (engine errored before any run)', async () => {
    // Engine never came up; reboot() resolves to a working engine. The user never
    // managed to click Run (the button was disabled / no-op), so lastMode is unset
    // — retry must fall back to the detected mode and still recompute.
    const ctx = makeWarmingCtx({ error: new Error('boot failed') });
    const { result } = renderHook(() => useRectification(PROFILE_ID), {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await result.current.retry();
    });

    expect(ctx.reboot).toHaveBeenCalled();
    expect(useRectificationStore.getState().status).toBe('ready');
  });

  it('resets a stale ready store on mount so a new visit recomputes', () => {
    // Simulate a previous, completed run left in the global (transient) store.
    useRectificationStore.setState({
      status: 'ready',
      result: { mode: 'cusp' } as never,
      error: null,
    });

    const ctx = makeEngineCtx();
    renderHook(() => useRectification(PROFILE_ID), { wrapper: makeWrapper(ctx) });

    expect(useRectificationStore.getState().status).toBe('idle');
    expect(useRectificationStore.getState().result).toBeNull();
  });
});

describe('toWireEvents', () => {
  it('wire events default precision to exact, and carry the stored precision', () => {
    const events = [
      { id: 'a', date: '2005-06-01', category: 'marriage', createdAt: 't' },
      { id: 'b', date: '2010-01-01', category: 'relocation', precision: 'year', createdAt: 't' },
    ] as LifeEvent[];
    const wire = toWireEvents(events);
    expect(wire[0].precision).toBe('exact');
    expect(wire[1].precision).toBe('year');
  });

  it('filters out unstructured events (missing date or category)', () => {
    const events = [
      { id: 'a', date: '2005-06-01', category: 'marriage', createdAt: 't' },
      { id: 'b', date: '', category: 'relocation', createdAt: 't' },
      { id: 'c', date: '2010-01-01', category: undefined, createdAt: 't' },
    ] as LifeEvent[];
    const wire = toWireEvents(events);
    expect(wire).toHaveLength(1);
    expect(wire[0].precision).toBe('exact');
  });
});
