import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPFS_PROBE_TIMEOUT_MS,
  PortableStateStartupError,
  markPortableStateUnavailable,
  nonDestructiveLegacyStorage,
  openPortableStateWithFallback,
  portableStatePersistence,
  probeOpfs,
  resetPortableStatePersistenceForTests,
  selectPortablePersistence,
  subscribePortableStatePersistence,
  withStartupTimeout,
} from './portablePersistence';

afterEach(() => {
  vi.useRealTimers();
  resetPortableStatePersistenceForTests();
});

/** Safari Private Browsing / throwaway WebKit: the entrypoint exists but refuses. */
const refusingStorage = {
  getDirectory: () =>
    Promise.reject(
      new DOMException('The operation failed for an unknown transient reason.', 'UnknownError'),
    ),
};
const workingStorage = { getDirectory: () => Promise.resolve({ kind: 'directory' }) };
const hangingStorage = { getDirectory: () => new Promise<never>(() => undefined) };
/** OPFS that works but answers late: a busy low-end phone, or OPFS contended by the engine sync. */
const slowStorage = (delayMs: number) => ({
  getDirectory: () =>
    new Promise<{ kind: string }>((resolve) => setTimeout(() => resolve({ kind: 'directory' }), delayMs)),
});

describe('startup time bounds', () => {
  it('pins the documented probe budget', () => {
    expect(OPFS_PROBE_TIMEOUT_MS).toBe(5_000);
  });

  it('rejects a step that never settles with an error naming the step', async () => {
    vi.useFakeTimers();
    const bounded = withStartupTimeout(new Promise<never>(() => undefined), 1_000, 'open the state database');
    const assertion = expect(bounded).rejects.toThrow(
      'AlmaMesh startup step "open the state database" did not finish within 1000 ms.',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await expect(bounded).rejects.toBeInstanceOf(PortableStateStartupError);
  });

  it('passes a settled value through untouched', async () => {
    await expect(withStartupTimeout(Promise.resolve(7), 1_000, 'x')).resolves.toBe(7);
  });
});

describe('probeOpfs', () => {
  it('reports OPFS available when getDirectory resolves', async () => {
    await expect(probeOpfs(workingStorage)).resolves.toEqual({ status: 'available' });
  });

  it('reports refused, with the browser reason, when getDirectory rejects', async () => {
    await expect(probeOpfs(refusingStorage)).resolves.toEqual({
      status: 'refused',
      reason: 'UnknownError: The operation failed for an unknown transient reason.',
    });
  });

  it('reports refused when getDirectory throws synchronously', async () => {
    const throwing = {
      getDirectory: () => {
        throw new DOMException('Context not access storage', 'SecurityError');
      },
    };
    await expect(probeOpfs(throwing)).resolves.toEqual({
      status: 'refused',
      reason: 'SecurityError: Context not access storage',
    });
  });

  it('reports refused when the browser has no OPFS entrypoint at all', async () => {
    await expect(probeOpfs(undefined)).resolves.toEqual({
      status: 'refused',
      reason: 'navigator.storage.getDirectory is unavailable',
    });
  });

  it('reports timed-out instead of hanging when getDirectory never settles', async () => {
    vi.useFakeTimers();
    const probe = probeOpfs(hangingStorage);
    await vi.advanceTimersByTimeAsync(OPFS_PROBE_TIMEOUT_MS);
    await expect(probe).resolves.toEqual({ status: 'timed-out' });
  });
});

describe('selectPortablePersistence', () => {
  it('keeps durable OPFS SQLite when OPFS works', () => {
    expect(selectPortablePersistence({ status: 'available' })).toBe('opfs');
  });

  it('falls back to in-memory SQLite when OPFS is refused', () => {
    expect(selectPortablePersistence({ status: 'refused', reason: 'x' })).toBe('memory');
  });

  it('keeps durable OPFS SQLite when the probe is merely slow: slow is not refused', () => {
    // A memory session here would silently lose everything the user enters,
    // on a browser whose OPFS works fine. Only an explicit refusal may do that.
    expect(selectPortablePersistence({ status: 'timed-out' })).toBe('opfs');
  });
});

describe('openPortableStateWithFallback', () => {
  it('opens in-memory SQLite and reports it when OPFS is refused', async () => {
    const open = vi.fn(async (persistence: 'opfs' | 'memory') => ({ persistence }));
    const seen: string[] = [];
    subscribePortableStatePersistence(() => seen.push(portableStatePersistence()));

    const opened = await openPortableStateWithFallback({ storage: refusingStorage, open });

    expect(open).toHaveBeenCalledExactlyOnceWith('memory');
    expect(opened).toEqual({ repository: { persistence: 'memory' }, persistence: 'memory' });
    expect(portableStatePersistence()).toBe('memory');
    expect(seen).toEqual(['memory']);
  });

  it('opens durable OPFS SQLite and reports it when OPFS works', async () => {
    const open = vi.fn(async (persistence: 'opfs' | 'memory') => ({ persistence }));
    const opened = await openPortableStateWithFallback({ storage: workingStorage, open });
    expect(open).toHaveBeenCalledExactlyOnceWith('opfs');
    expect(opened.persistence).toBe('opfs');
    expect(portableStatePersistence()).toBe('opfs');
  });

  it('starts pending before any open', () => {
    expect(portableStatePersistence()).toBe('pending');
  });

  it('never selects memory mode for OPFS that is available but slow to answer', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async (persistence: 'opfs' | 'memory') => ({ persistence }));
    const opening = openPortableStateWithFallback({
      storage: slowStorage(OPFS_PROBE_TIMEOUT_MS + 1_000),
      open,
    });
    await vi.advanceTimersByTimeAsync(OPFS_PROBE_TIMEOUT_MS + 1_000);
    const opened = await opening;
    expect(open).toHaveBeenCalledExactlyOnceWith('opfs');
    expect(opened.persistence).toBe('opfs');
    expect(portableStatePersistence()).toBe('opfs');
  });

  it('waits for a slow open instead of failing it on a wall clock', async () => {
    // On slow 4G the SQLite Worker's wasm download alone can take minutes while
    // it shares the link with the engine sync. A fixed budget turned that
    // success into "database unavailable"; the Worker reports its own failures.
    vi.useFakeTimers();
    const open = vi.fn(
      (persistence: 'opfs' | 'memory') =>
        new Promise<{ persistence: string }>((resolve) =>
          setTimeout(() => resolve({ persistence }), 180_000),
        ),
    );
    const opening = openPortableStateWithFallback({ storage: workingStorage, open });
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(opening).resolves.toEqual({ repository: { persistence: 'opfs' }, persistence: 'opfs' });
    expect(portableStatePersistence()).toBe('opfs');
  });

  it('reports unavailable and rethrows when the open itself fails', async () => {
    const open = vi.fn(() => Promise.reject(new Error('SQLite OPFS Web Locks support is unavailable')));
    await expect(openPortableStateWithFallback({ storage: workingStorage, open })).rejects.toThrow(
      'SQLite OPFS Web Locks support is unavailable',
    );
    expect(portableStatePersistence()).toBe('unavailable');
  });
});

describe('nonDestructiveLegacyStorage', () => {
  it('reads legacy rows but never deletes them, so an in-memory session cannot drop the only copy', async () => {
    const legacy = {
      get: vi.fn(async (key: string) => `value-of-${key}`),
      delete: vi.fn(async () => undefined),
    };
    const guarded = nonDestructiveLegacyStorage(legacy);
    await expect(guarded.get('almamesh-profiles')).resolves.toBe('value-of-almamesh-profiles');
    await guarded.delete('almamesh-profiles');
    expect(legacy.delete).not.toHaveBeenCalled();
  });
});

describe('markPortableStateUnavailable', () => {
  it('publishes unavailable so the UI can explain instead of waiting on hydration', () => {
    const seen: string[] = [];
    subscribePortableStatePersistence(() => seen.push(portableStatePersistence()));
    markPortableStateUnavailable();
    expect(portableStatePersistence()).toBe('unavailable');
    expect(seen).toEqual(['unavailable']);
  });
});
