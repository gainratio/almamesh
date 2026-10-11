import type { PredictiveInput } from '@almamesh/browser/types';
import type { PredictiveContexts } from '@almamesh/browser';
import {
  predictiveRequestKey,
  usePredictiveStore,
  type CachedPredictiveContexts,
  type EnsurePredictiveInput,
  type PredictiveRuntime,
} from '@almamesh/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PERIOD_SKY_TIMEOUT_MS,
  PeriodSkyTimeoutError,
  __resetPeriodSkyCacheForTest,
  createPeriodSkyCache,
  periodReferenceInstant,
  periodSkyCache,
  periodEngineCallCount,
} from '../periodSky';
import type { PeriodSkyRows } from '../periodSkyRows';

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

function durableRows() {
  const values = new Map<string, CachedPredictiveContexts>();
  const rows: PeriodSkyRows = {
    captureEpoch: vi.fn(async () => 0),
    read: vi.fn(async (h, k) => values.get(`${h}|${k}`)),
    write: vi.fn(async (h, k, _p, value) => { values.set(`${h}|${k}`, value); }),
    deleteForProfile: vi.fn(async () => undefined),
    sweepOtherEngines: vi.fn(async () => 0),
    clear: vi.fn(async () => { values.clear(); }),
  };
  return { rows, values };
}

describe('durable period sky', () => {
  it('revisits a day in another cache instance without another engine call', async () => {
    const { rows, values } = durableRows();
    const fresh = { ...SKY, domain_strength_receipts: [], strength_signer_public_key: 'x' } as unknown as PredictiveContexts;
    const runtime = { computePredictive: vi.fn(async () => fresh), identity: () => 'hash-a' };
    const before = periodEngineCallCount();
    await createPeriodSkyCache({ rows, readStore: idle }).load(input('2019-06-01'), runtime, signal());
    await createPeriodSkyCache({ rows, readStore: idle }).load(input('2019-06-01'), runtime, signal());
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
    expect(periodEngineCallCount() - before).toBe(1);
    expect([...values.values()][0]).not.toHaveProperty('domain_strength_receipts');
    expect([...values.values()][0]).not.toHaveProperty('strength_signer_public_key');
  });

  it('joins while a durable read is pending, before computing', async () => {
    const { rows } = durableRows();
    const read = Promise.withResolvers<CachedPredictiveContexts | undefined>();
    rows.read = vi.fn(() => read.promise);
    const runtime = { computePredictive: vi.fn(async () => SKY), identity: () => 'hash-a' };
    const cache = createPeriodSkyCache({ rows, readStore: idle });
    const first = cache.load(input('2019-06-01'), runtime, signal());
    const second = cache.load(input('2019-06-01'), runtime, signal());
    read.resolve(undefined);
    await Promise.all([first, second]);
    expect(rows.read).toHaveBeenCalledTimes(1);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it('sweeps once per engine identity and captures the epoch before computing', async () => {
    const { rows } = durableRows();
    const cache = createPeriodSkyCache({ rows, readStore: idle });
    for (const hash of ['a', 'a', 'b']) {
      await cache.load(input('2019-06-01'), { computePredictive: async () => SKY, identity: () => hash }, signal());
    }
    expect(rows.sweepOtherEngines).toHaveBeenCalledTimes(2);
    expect(rows.write).toHaveBeenCalledWith('a', predictiveRequestKey(input('2019-06-01')), 'p1', SKY, 0);
  });

  it('without a stable epoch or manifest identity, never persists a payload', async () => {
    const { rows } = durableRows();
    const runtime = { computePredictive: vi.fn(async () => SKY), identity: () => 'a' };
    rows.captureEpoch = async () => undefined;
    await createPeriodSkyCache({ rows, readStore: idle }).load(input('2019-06-01'), runtime, signal());
    await createPeriodSkyCache({ rows, readStore: idle }).load(input('2019-06-01'), { computePredictive: runtime.computePredictive }, signal());
    expect(rows.write).not.toHaveBeenCalled();
  });

  it('storage read/write failure still returns the fresh calculation', async () => {
    const { rows } = durableRows();
    rows.read = vi.fn(async () => { throw new Error('disk'); });
    rows.write = vi.fn(async () => { throw new Error('disk'); });
    const runtime = { computePredictive: vi.fn(async () => SKY), identity: () => 'a' };
    await expect(createPeriodSkyCache({ rows, readStore: idle }).load(input('2019-06-01'), runtime, signal())).resolves.toEqual(SKY);
    expect(rows.write).toHaveBeenCalled();
  });
});

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

  it('drops every queued unique date whose last waiter cancels before engine start', async () => {
    const active = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn().mockReturnValueOnce(active.promise).mockResolvedValue(SKY) };
    const cache = createPeriodSkyCache({ readStore: idle, rows: null });
    const first = cache.load(input('2019-06-01'), runtime, signal());
    await vi.waitFor(() => expect(runtime.computePredictive).toHaveBeenCalledTimes(1));
    for (const day of ['2019-06-02', '2019-06-03', '2019-06-04']) {
      const controller = new AbortController();
      const wait = cache.load(input(day), runtime, controller.signal);
      controller.abort(new DOMException('back to today', 'AbortError'));
      await expect(wait).rejects.toThrow('back to today');
    }
    active.resolve(SKY);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it('retains queued work while another joined consumer still needs it', async () => {
    const active = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn().mockReturnValueOnce(active.promise).mockResolvedValue(SKY) };
    const cache = createPeriodSkyCache({ readStore: idle, rows: null });
    const first = cache.load(input('2019-06-01'), runtime, signal());
    const controller = new AbortController();
    const canceled = cache.load(input('2019-06-02'), runtime, controller.signal);
    const joined = cache.load(input('2019-06-02'), runtime, signal());
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(canceled).rejects.toThrow('cancelled');
    active.resolve(SKY);
    await Promise.all([first, joined]);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
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

describe('periodSky and the 24-month window', () => {
  const TWELVE: EnsurePredictiveInput = {
    profileKey: 'p1',
    datetimeUtc: '1990-01-15T12:00:00Z',
    latitude: 28.6139,
    longitude: 77.209,
    referenceInstant: '2027-01-01T00:00:00Z',
    utcOffsetMinutes: 330,
  };

  it('never answers a 24-month period from the 12-month Life Atlas reading', async () => {
    const stored = { transit_context: 'stored' } as unknown as CachedPredictiveContexts;
    const fresh = { transit_context: 'fresh' } as unknown as CachedPredictiveContexts;
    const computePredictive = vi.fn(async (_input: PredictiveInput) => fresh);
    const runtime = { computePredictive } as unknown as PredictiveRuntime;
    const cache = createPeriodSkyCache({
      readStore: () => ({ status: 'ready', requestKey: predictiveRequestKey(TWELVE), rawContexts: stored }),
    });
    await expect(cache.load(TWELVE, runtime, new AbortController().signal)).resolves.toBe(stored);
    await expect(cache.load({ ...TWELVE, windowMonths: 24 }, runtime, new AbortController().signal)).resolves.toBe(fresh);
    expect(computePredictive).toHaveBeenCalledTimes(1);
    expect(computePredictive.mock.calls[0]?.[0]).toMatchObject({ windowMonths: 24 });
  });
});
