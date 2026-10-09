import type { PredictiveContexts } from '@almamesh/browser';
import { predictiveRequestKey, usePredictiveStore, type EnsurePredictiveInput } from '@almamesh/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PERIOD_SKY_TIMEOUT_MS,
  PeriodSkyTimeoutError,
  __resetPeriodSkyCacheForTest,
  createPeriodSkyCache,
  periodReferenceInstant,
  periodSkyCache,
} from '../periodSky';

const SKY = { transit_context: { instant: 'x' } } as unknown as PredictiveContexts;
const PERIOD = { retention: 'period' };

function input(day: string): EnsurePredictiveInput {
  return {
    profileKey: 'p1',
    datetimeUtc: '1990-01-15T12:00:00.000Z',
    latitude: 28.6139,
    longitude: 77.209,
    referenceInstant: periodReferenceInstant(day),
    utcOffsetMinutes: 330,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const idle = () => ({ status: 'idle' });
const signal = () => new AbortController().signal;

afterEach(() => {
  usePredictiveStore.getState().reset();
  __resetPeriodSkyCacheForTest();
  vi.useRealTimers();
});

describe('periodReferenceInstant', () => {
  it('is UTC midnight of the day, the engine reference shape', () => {
    expect(periodReferenceInstant('2019-06-01')).toBe('2019-06-01T00:00:00Z');
  });
});

describe('createPeriodSkyCache', () => {
  it('pins the 140 s deadline literal (under the 150 s tool cap)', () => {
    expect(PERIOD_SKY_TIMEOUT_MS).toBe(140_000);
  });

  it("reuses the predictive store's result when it holds the exact key (no engine call)", async () => {
    const runtime = { computePredictive: vi.fn() };
    const key = predictiveRequestKey(input('2026-10-08'));
    const cache = createPeriodSkyCache({
      readStore: () => ({ status: 'ready', requestKey: key, rawContexts: SKY }),
    });
    await expect(cache.load(input('2026-10-08'), runtime, signal())).resolves.toBe(SKY);
    expect(runtime.computePredictive).not.toHaveBeenCalled();
  });

  it("computes when the store holds a different key or is not ready", async () => {
    const runtime = { computePredictive: vi.fn(async () => SKY) };
    const key = predictiveRequestKey(input('2026-10-08'));
    const other = createPeriodSkyCache({
      readStore: () => ({ status: 'ready', requestKey: 'another-day', rawContexts: SKY }),
    });
    const loading = createPeriodSkyCache({
      readStore: () => ({ status: 'loading', requestKey: key, rawContexts: SKY }),
    });
    await other.load(input('2026-10-08'), runtime, signal());
    await loading.load(input('2026-10-08'), runtime, signal());
    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
  });

  it("never touches the Life Atlas's store slot", async () => {
    usePredictiveStore.setState({ status: 'ready', profileKey: 'p1', requestKey: 'today-key' });
    const runtime = { computePredictive: vi.fn(async () => SKY) };
    const cache = createPeriodSkyCache({});
    await cache.load(input('2019-06-01'), runtime, signal());
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
    expect(usePredictiveStore.getState().requestKey).toBe('today-key');
  });

  it("sends the store's exact engine input (same memo key) under the period retention bound", async () => {
    const runtime = { computePredictive: vi.fn(async () => SKY) };
    await createPeriodSkyCache({ readStore: idle }).load(input('2019-06-01'), runtime, signal());
    expect(runtime.computePredictive).toHaveBeenCalledWith(
      {
        datetimeUtc: '1990-01-15T12:00:00.000Z',
        latitude: 28.6139,
        longitude: 77.209,
        referenceInstant: '2019-06-01T00:00:00Z',
        utcOffsetMinutes: 330,
      },
      PERIOD,
    );
  });

  it('retains no settled payload itself: a repeat ask goes back to the (memoized) engine', async () => {
    const runtime = { computePredictive: vi.fn(async () => SKY) };
    const cache = createPeriodSkyCache({ readStore: idle });
    await cache.load(input('2019-06-01'), runtime, signal());
    await cache.load(input('2019-06-01'), runtime, signal());
    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
  });

  it('joins a second request for the same period while it is in flight', async () => {
    const gate = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn(() => gate.promise) };
    const cache = createPeriodSkyCache({ readStore: idle });
    const first = cache.load(input('2019-06-01'), runtime, signal());
    const second = cache.load(input('2019-06-01'), runtime, signal());
    gate.resolve(SKY);
    await expect(Promise.all([first, second])).resolves.toEqual([SKY, SKY]);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it('runs one period compute at a time', async () => {
    const gate = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(SKY) };
    const cache = createPeriodSkyCache({ readStore: idle });
    const first = cache.load(input('2019-06-01'), runtime, signal());
    const second = cache.load(input('2027-01-01'), runtime, signal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
    gate.resolve(SKY);
    await Promise.all([first, second]);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
  });

  it('a failed compute does not block the queue or poison the next ask: it recomputes', async () => {
    const runtime = {
      computePredictive: vi.fn().mockRejectedValueOnce(new Error('engine down')).mockResolvedValue(SKY),
    };
    const cache = createPeriodSkyCache({ readStore: idle });
    await expect(cache.load(input('2019-06-01'), runtime, signal())).rejects.toThrow('engine down');
    await expect(cache.load(input('2019-06-01'), runtime, signal())).resolves.toBe(SKY);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
  });

  it('a timed-out waiter does not cancel the compute; a later ask joins it', async () => {
    const gate = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn(() => gate.promise) };
    const shortWait = createPeriodSkyCache({ readStore: idle, timeoutMs: 5 });
    await expect(shortWait.load(input('2019-06-01'), runtime, signal())).rejects.toBeInstanceOf(
      PeriodSkyTimeoutError,
    );
    // The second load starts its own 5 ms timer, but gate.resolve runs
    // synchronously first, so it resolves with SKY from the same compute.
    const joined = shortWait.load(input('2019-06-01'), runtime, signal()).catch((error: unknown) => error);
    gate.resolve(SKY);
    await expect(joined).resolves.toBe(SKY);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it('rejects at once when the turn is cancelled', async () => {
    const runtime = { computePredictive: vi.fn(() => new Promise<PredictiveContexts>(() => {})) };
    const cache = createPeriodSkyCache({ readStore: idle });
    const controller = new AbortController();
    const pending = cache.load(input('2019-06-01'), runtime, controller.signal);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('starts no compute for an already-cancelled turn', async () => {
    const runtime = { computePredictive: vi.fn(async () => SKY) };
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const cache = createPeriodSkyCache({ readStore: idle });
    await expect(cache.load(input('2019-06-01'), runtime, controller.signal)).rejects.toThrow('cancelled');
    expect(runtime.computePredictive).not.toHaveBeenCalled();
  });
});

describe('periodSkyCache', () => {
  it('is one queue per tab until reset', () => {
    const first = periodSkyCache();
    expect(periodSkyCache()).toBe(first);
    __resetPeriodSkyCacheForTest();
    expect(periodSkyCache()).not.toBe(first);
  });
});
