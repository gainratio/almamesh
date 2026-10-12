import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toTransitCtx, usePredictiveStore } from '@almamesh/store';
import type { ChartEngine } from '@almamesh/browser';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import type { ChartEngineContextValue } from '../../providers/chartEngineContext';

const policy = vi.hoisted(() => ({ periodSkyComputeAllowed: true }));
vi.mock('@almamesh/browser', async (orig) => {
  const actual = await orig<typeof import('@almamesh/browser')>();
  return { ...actual, devicePolicy: () => ({ ...actual.devicePolicy(), periodSkyComputeAllowed: policy.periodSkyComputeAllowed }) };
});

describe('useMomentSky explicit engine recovery', () => {
  const fault = new Error('Out of bounds memory access');
  const fresh = {} as ChartEngine;

  function context(reboot: () => Promise<ChartEngine>, error: Error | null = fault): ChartEngineContextValue {
    return { engine: null, error, reboot, stage: null, meta: null,
      startBootstrap: vi.fn(), whenReady: vi.fn(async () => { throw fault; }) };
  }

  function pendingRecovery() {
    let resolve!: (engine: ChartEngine) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ChartEngine>((yes, no) => { resolve = yes; reject = no; });
    const reboot = vi.fn(() => promise);
    return { resolve, reject, reboot };
  }

  it('does not reboot automatically, and repeated explicit Retry clicks share one reboot before recomputing', async () => {
    const pending = pendingRecovery();
    let recovered = false;
    const reboot = vi.fn(() => pending.reboot().then((engine) => { recovered = true; return engine; }));
    const loader = vi.fn(async () => { if (!recovered) throw fault; return SKY_CHART; });
    const options = input({ engine: context(reboot), loader });
    const { result, rerender } = renderHook(() => useMomentSky(options));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    rerender();
    expect(reboot).not.toHaveBeenCalled();

    act(() => { result.current.retry(); result.current.retry(); result.current.retry(); });
    await waitFor(() => expect(reboot).toHaveBeenCalledTimes(1));
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(fresh); });
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('recovers through the real period loader from a latched whenReady error', async () => {
    const pending = pendingRecovery();
    const computePredictive = vi.fn(async () => SKY_CHART);
    const ready = { computePredictive, meta: () => null } as unknown as ChartEngine;
    let current: ChartEngineContextValue = context(vi.fn(async () => {
      const engine = await pending.reboot();
      current = { ...current, engine, error: null };
      rerender();
      return engine;
    }));
    const birth = { birth_datetime_utc: '1990-01-15T12:00:00Z',
      birth_location_details: { latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' } } as ProcessedBirthData;
    const { result, rerender } = renderHook(() => useMomentSky(input({ engine: current, birth, loader: undefined })));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));

    act(() => result.current.retry());
    await waitFor(() => expect(pending.reboot).toHaveBeenCalledTimes(1));
    await act(async () => { pending.resolve(ready); });
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
    expect(computePredictive).toHaveBeenCalledTimes(1);
    expect(computePredictive.mock.calls[0]).toMatchObject([{ referenceInstant: '2019-03-01T00:00:00Z' }, { retention: 'period' }]);
  });

  it('keeps a failed reboot retryable without rerunning the loader on the closed engine', async () => {
    const reboot = vi.fn().mockRejectedValueOnce(new Error('fresh boot failed')).mockResolvedValueOnce(fresh);
    const loader = vi.fn().mockRejectedValueOnce(fault).mockResolvedValue(SKY_CHART);
    const options = input({ engine: context(reboot), loader });
    const { result } = renderHook(() => useMomentSky(options));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    await act(async () => result.current.retry());
    expect(result.current.sky.kind).toBe('failed');
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
    expect(reboot).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it.each(['moment', 'profile', 'chart', 'birth'] as const)('does not resume the old retry after its %s changes', async (change) => {
    const pending = pendingRecovery();
    const loader = vi.fn(async () => { throw fault; });
    const initial = input({ engine: context(pending.reboot), loader });
    const { result, rerender } = renderHook((props: MomentSkyInput) => useMomentSky(props), { initialProps: initial });
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    act(() => result.current.retry());
    await waitFor(() => expect(pending.reboot).toHaveBeenCalledTimes(1));
    const changed = { ...initial,
      ...(change === 'moment' ? { asOf: YEAR_2027 } : {}),
      ...(change === 'profile' ? { profileKey: 'p2' } : {}),
      ...(change === 'chart' ? { chart: { ...CHART } } : {}),
      ...(change === 'birth' ? { birth: { birth_datetime_utc: '1991-01-01T00:00:00Z' } as ProcessedBirthData } : {}),
    };
    rerender(changed);
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    const calls = loader.mock.calls.length;
    await act(async () => { pending.resolve(fresh); });
    expect(loader).toHaveBeenCalledTimes(calls);
  });

  it('does not resume a pending Retry after unmount', async () => {
    const pending = pendingRecovery();
    const loader = vi.fn(async () => { throw fault; });
    const options = input({ engine: context(pending.reboot), loader });
    const { result, unmount } = renderHook(() => useMomentSky(options));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    act(() => result.current.retry());
    await waitFor(() => expect(pending.reboot).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { pending.resolve(fresh); });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary compute Retry on the existing engine without reboot', async () => {
    const reboot = vi.fn();
    const loader = vi.fn().mockRejectedValueOnce(new Error('ordinary calculation error')).mockResolvedValueOnce(SKY_CHART);
    const options = input({ engine: context(reboot, null), loader });
    const { result } = renderHook(() => useMomentSky(options));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
    expect(reboot).not.toHaveBeenCalled();
  });
});
vi.mock('@almamesh/store', async (orig) => {
  const actual = await orig<typeof import('@almamesh/store')>();
  return { ...actual, toTransitCtx: vi.fn(actual.toTransitCtx) };
});

import { CHART, SKY_CHART } from './timingFixtures';
import { momentPeriod, useMomentSky, type MomentSkyInput } from '../momentSky';

const MARCH_2019 = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' } as const;
const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

function input(over: Partial<MomentSkyInput> = {}): MomentSkyInput {
  return { asOf: MARCH_2019, chart: CHART, profileKey: 'p1', birth: undefined, engine: null, skyAllowed: true,
    loader: vi.fn(async () => SKY_CHART), ...over };
}

describe('momentPeriod', () => {
  it('is the moment, never today', () => {
    expect(momentPeriod(MARCH_2019)).toEqual({ start: '2019-03-01', end: '2019-03-31' });
  });
});

describe('useMomentSky', () => {
  it('on a device that cannot compute the sky, says dashas only and never calls the loader', () => {
    const loader = vi.fn();
    const { result } = renderHook(() => useMomentSky(input({ skyAllowed: false, loader })));
    expect(result.current.sky).toEqual({ kind: 'dashas-only' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('works, then shows the transits for the moment (asked for the moment, not today)', async () => {
    const loader = vi.fn(async () => SKY_CHART);
    const { result } = renderHook(() => useMomentSky(input({ loader })));
    expect(result.current.sky.kind).toBe('working');
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
    expect(loader).toHaveBeenCalledWith({ start: '2019-03-01', end: '2019-03-31' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('a late result for an old moment is dropped', async () => {
    let finishOld: (value: typeof SKY_CHART) => void = () => {};
    const loader = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = renderHook((props: MomentSkyInput) => useMomentSky(props), { initialProps: input({ loader }) });
    rerender(input({ loader, asOf: YEAR_2027 }));
    await act(async () => { finishOld(SKY_CHART); });
    expect(result.current.sky.kind).toBe('working');
  });

  it('a failed compute shows failed, and retry runs it again', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('engine_unavailable')).mockResolvedValueOnce(SKY_CHART);
    const { result } = renderHook(() => useMomentSky(input({ loader })));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
  });

  it('logs a failed compute with the safe code only, never the raw error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loader = vi.fn().mockRejectedValueOnce(new Error('ephemeris range, birth 1990-05-17'));
    const { result } = renderHook(() => useMomentSky(input({ loader })));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    expect(spy.mock.calls).toEqual([['[almamesh:error:time_travel.moment_sky_failed]']]);
    spy.mockRestore();
  });

  it("never touches today's Life Atlas result in usePredictiveStore", async () => {
    const before = usePredictiveStore.getState();
    const ensure = vi.spyOn(before, 'ensurePredictive');
    const { result } = renderHook(() => useMomentSky(input({ loader: undefined, engine: null })));
    await waitFor(() => expect(result.current.sky.kind).not.toBe('working'));
    expect(ensure).not.toHaveBeenCalled();
    expect(usePredictiveStore.getState()).toBe(before);
  });

  it('with no skyAllowed given, follows the device policy', () => {
    policy.periodSkyComputeAllowed = false;
    try {
      const never = vi.fn();
      const { result } = renderHook(() => useMomentSky({ ...input({ loader: never }), skyAllowed: undefined }));
      expect(result.current.sky).toEqual({ kind: 'dashas-only' });
      expect(never).not.toHaveBeenCalled();
    } finally {
      policy.periodSkyComputeAllowed = true;
    }
    const loader = vi.fn(() => new Promise<typeof SKY_CHART>(() => {}));
    const { result } = renderHook(() => useMomentSky({ ...input({ loader }), skyAllowed: undefined }));
    expect(result.current.sky.kind).toBe('working');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('with no chart yet, says dashas only and never calls the loader', () => {
    const loader = vi.fn();
    const { result } = renderHook(() => useMomentSky(input({ chart: null, loader })));
    expect(result.current.sky).toEqual({ kind: 'dashas-only' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('a sky with no transit context is a failure, not an empty table', async () => {
    const loader = vi.fn(async () => CHART);
    const { result } = renderHook(() => useMomentSky(input({ loader })));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
  });

  it('transits that do not reshape are a failure', async () => {
    vi.mocked(toTransitCtx).mockReturnValueOnce(undefined);
    const loader = vi.fn(async () => SKY_CHART);
    const { result } = renderHook(() => useMomentSky(input({ loader })));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
  });

  it('a late failure for an old moment is dropped', async () => {
    let failOld: (error: Error) => void = () => {};
    const loader = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { failOld = reject; }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = renderHook((props: MomentSkyInput) => useMomentSky(props), { initialProps: input({ loader }) });
    rerender(input({ loader, asOf: YEAR_2027 }));
    await act(async () => { failOld(new Error('late')); });
    expect(result.current.sky.kind).toBe('working');
  });

  it('a Day moment trims the transits to the day, not a span', async () => {
    const loader = vi.fn(async () => SKY_CHART);
    const day = { start: '2019-03-05', end: '2019-03-05', granularity: 'day' } as const;
    const { result } = renderHook(() => useMomentSky(input({ loader, asOf: day })));
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
    expect(loader).toHaveBeenCalledWith({ start: '2019-03-05', end: '2019-03-05' }, expect.anything());
  });
});
