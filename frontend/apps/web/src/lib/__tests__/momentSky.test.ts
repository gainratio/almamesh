import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toTransitCtx, usePredictiveStore } from '@almamesh/store';

const policy = vi.hoisted(() => ({ periodSkyComputeAllowed: true }));
vi.mock('@almamesh/browser', async (orig) => {
  const actual = await orig<typeof import('@almamesh/browser')>();
  return { ...actual, devicePolicy: () => ({ ...actual.devicePolicy(), periodSkyComputeAllowed: policy.periodSkyComputeAllowed }) };
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
