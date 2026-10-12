import { describe, it, expect, vi } from 'vitest';

import { WorkerCrashError, WorkerTimeoutError, type ChartEngine } from '@almamesh/browser';
import { resolveReadyEngine, type EngineReadiness } from '../resolveReadyEngine';

const engineA = { tag: 'A' } as unknown as ChartEngine;
const engineB = { tag: 'B' } as unknown as ChartEngine;

function makeReadiness(over: Partial<EngineReadiness>): EngineReadiness {
  return {
    engine: null,
    error: null,
    reboot: vi.fn().mockResolvedValue(engineB),
    whenReady: vi.fn().mockResolvedValue(engineA),
    ...over,
  };
}

describe('resolveReadyEngine', () => {
  it('returns the already-ready engine immediately without rebooting or waiting', async () => {
    const reboot = vi.fn();
    const whenReady = vi.fn();
    const r = makeReadiness({ engine: engineA, reboot, whenReady });

    await expect(resolveReadyEngine(r)).resolves.toBe(engineA);
    expect(reboot).not.toHaveBeenCalled();
    expect(whenReady).not.toHaveBeenCalled();
  });

  it('reboots (re-syncs) when bootstrap previously failed, and returns the recovered engine', async () => {
    const reboot = vi.fn().mockResolvedValue(engineB);
    const whenReady = vi.fn();
    const r = makeReadiness({ engine: null, error: new Error('bundle 404'), reboot, whenReady });

    await expect(resolveReadyEngine(r)).resolves.toBe(engineB);
    expect(reboot).toHaveBeenCalledTimes(1);
    expect(whenReady).not.toHaveBeenCalled();
  });

  it('awaits the in-flight bootstrap (whenReady) during the warming race — no reboot', async () => {
    const reboot = vi.fn();
    const whenReady = vi.fn().mockResolvedValue(engineA);
    const r = makeReadiness({ engine: null, error: null, reboot, whenReady });

    await expect(resolveReadyEngine(r)).resolves.toBe(engineA);
    expect(whenReady).toHaveBeenCalledTimes(1);
    expect(reboot).not.toHaveBeenCalled();
  });

  it('rejects with a timeout if the engine never becomes ready within the budget', async () => {
    vi.useFakeTimers();
    try {
      const whenReady = vi.fn().mockReturnValue(new Promise<ChartEngine>(() => {}));
      const r = makeReadiness({ engine: null, error: null, whenReady });

      const promise = resolveReadyEngine(r, 5_000);
      const assertion = expect(promise).rejects.toThrow(/engine|warm|tim/i);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // The budget is an IDLE budget, not a wall clock. On a slow mobile link the
  // cold sync alone takes two minutes while reporting progress the whole way;
  // a fixed 90 s wait rejected it and left the user on the "Connection Issue"
  // card even though the engine became ready 30 s later (measured on slow 4G).
  it('keeps waiting while the bootstrap keeps reporting progress, then resolves', async () => {
    vi.useFakeTimers();
    try {
      let progressAt = Date.now();
      let finish: (engine: ChartEngine) => void = () => {};
      const whenReady = vi.fn().mockReturnValue(
        new Promise<ChartEngine>((resolve) => {
          finish = resolve;
        }),
      );
      const r = makeReadiness({
        engine: null,
        error: null,
        whenReady,
        lastProgressAt: () => progressAt,
      });

      const promise = resolveReadyEngine(r, 5_000);
      let settled = false;
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Three times the budget, with progress every second.
      for (let second = 0; second < 15; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        progressAt = Date.now();
      }
      expect(settled).toBe(false);

      finish(engineA);
      await expect(promise).resolves.toBe(engineA);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects once the bootstrap has been silent for the whole budget', async () => {
    vi.useFakeTimers();
    try {
      const progressAt = Date.now();
      const whenReady = vi.fn().mockReturnValue(new Promise<ChartEngine>(() => {}));
      const r = makeReadiness({
        engine: null,
        error: null,
        whenReady,
        lastProgressAt: () => progressAt,
      });

      const promise = resolveReadyEngine(r, 5_000);
      let settled = false;
      promise.catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
      await expect(promise).rejects.toThrow(/did not become ready/i);
    } finally {
      vi.useRealTimers();
    }
  });
  // CI run 38267574533: under load one OPFS step in the sync Worker stalled, the
  // first boot failed with "engine request 1 (sync) was idle for 60000ms", and
  // the provider booted again 250 ms later and became ready. Onboarding had
  // been awaiting that first attempt, so it showed CHART_GEN_001 and stayed on
  // the error card although the engine was ready seconds later.
  it('follows the automatic boot retry when the in-flight boot fails with a transient Worker timeout', async () => {
    const reboot = vi.fn();
    const whenReady = vi
      .fn()
      .mockRejectedValueOnce(new WorkerTimeoutError('engine request 1 (sync) was idle for 60000ms'))
      .mockResolvedValueOnce(engineA);
    const r = makeReadiness({ engine: null, error: null, reboot, whenReady });

    await expect(resolveReadyEngine(r)).resolves.toBe(engineA);
    expect(whenReady).toHaveBeenCalledTimes(2);
    expect(reboot).not.toHaveBeenCalled();
  });

  it('follows the automatic boot retry after a stalled bundle fetch or a Worker crash', async () => {
    const whenReady = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch /public.key failed: stalled: no bytes for 30000ms'))
      .mockRejectedValueOnce(new WorkerCrashError('engine worker crashed'))
      .mockResolvedValueOnce(engineA);
    const r = makeReadiness({ engine: null, error: null, whenReady });

    await expect(resolveReadyEngine(r)).resolves.toBe(engineA);
    expect(whenReady).toHaveBeenCalledTimes(3);
  });

  it('surfaces a non-transient boot failure (integrity, rollback) without waiting for another boot', async () => {
    const integrity = new Error('bundle signature verification failed');
    const whenReady = vi.fn().mockRejectedValue(integrity);
    const r = makeReadiness({ engine: null, error: null, whenReady });

    await expect(resolveReadyEngine(r)).rejects.toBe(integrity);
    expect(whenReady).toHaveBeenCalledTimes(1);
  });

  it('gives up after three transient boot failures in a row and surfaces the last one', async () => {
    const last = new WorkerTimeoutError('engine request 3 (sync) was idle for 60000ms');
    const whenReady = vi
      .fn()
      .mockRejectedValueOnce(new WorkerTimeoutError('engine request 1 (sync) was idle for 60000ms'))
      .mockRejectedValueOnce(new WorkerTimeoutError('engine request 2 (sync) was idle for 60000ms'))
      .mockRejectedValueOnce(last)
      .mockResolvedValue(engineA);
    const r = makeReadiness({ engine: null, error: null, whenReady });

    await expect(resolveReadyEngine(r)).rejects.toBe(last);
    expect(whenReady).toHaveBeenCalledTimes(3);
  });
});
