import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const clearAlmaBundleCache = vi.fn<(options?: { timeoutMs?: number }) => Promise<void>>();
vi.mock('@almamesh/browser', () => ({
  clearAlmaBundleCache: (options?: { timeoutMs?: number }) => clearAlmaBundleCache(options),
}));

import { registerEngineTeardown } from '../engineLifecycle';
import { clearEngineBundleCache, resetAppData } from '../resetAppData';

let unregisterTeardown: (() => void) | null = null;

beforeEach(() => {
  clearAlmaBundleCache.mockReset();
  clearAlmaBundleCache.mockResolvedValue(undefined);
});

afterEach(() => {
  unregisterTeardown?.();
  unregisterTeardown = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A mocked OPFS root: `navigator.storage.getDirectory()` → entries + removeEntry. */
function stubOpfs(names: string[], order: string[] = []) {
  const removeEntry = vi.fn((name: string) => {
    order.push(`opfs:${name}`);
    return Promise.resolve();
  });
  const root = {
    keys: async function* keys() {
      yield* names;
    },
    removeEntry,
  };
  const getDirectory = vi.fn().mockResolvedValue(root);
  return { getDirectory, removeEntry };
}

type Outcome = 'success' | 'error' | 'blocked-forever';

/** A mocked `indexedDB` whose delete requests settle as told (default: success). */
function stubIndexedDb(names: string[], order: string[] = [], outcome: Outcome = 'success') {
  const deleteDatabase = vi.fn((name: string) => {
    const request: {
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onblocked: (() => void) | null;
    } = { onsuccess: null, onerror: null, onblocked: null };
    queueMicrotask(() => {
      if (outcome === 'success') {
        order.push(`idb:${name}`);
        request.onsuccess?.();
      } else if (outcome === 'error') {
        request.onerror?.();
      } else {
        request.onblocked?.();
      }
    });
    return request;
  });
  vi.stubGlobal('indexedDB', {
    databases: vi.fn().mockResolvedValue(names.map((name) => ({ name }))),
    deleteDatabase,
  });
  return { deleteDatabase };
}

describe('resetAppData', () => {
  it('clears every stale-state source (SW + caches + localStorage + IndexedDB)', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
    });
    const cacheDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['a', 'b']),
      delete: cacheDelete,
    });
    const lsClear = vi.fn();
    vi.stubGlobal('localStorage', { clear: lsClear });
    const { deleteDatabase } = stubIndexedDb(['almamesh-x']);

    await resetAppData();

    expect(unregister).toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledTimes(2);
    expect(lsClear).toHaveBeenCalled();
    expect(deleteDatabase).toHaveBeenCalledWith('almamesh-x');
  });

  it('delete-all wipes quarantined (unreadable) interpretations too', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([]) },
    });
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue([]), delete: vi.fn() });
    const stored = new Map([
      ['almamesh-interpretations.quarantine', '[{"quarantinedAt":"2026-10-04T00:00:00.000Z"}]'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
      clear: () => stored.clear(),
    });
    stubIndexedDb([]);

    await resetAppData();

    expect(stored.has('almamesh-interpretations.quarantine')).toBe(false);
  });

  it('resolves even when one cleanup path throws (best-effort, isolated)', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockRejectedValue(new Error('SW boom')) },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn().mockRejectedValue(new Error('caches boom')),
      delete: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      clear: vi.fn(() => {
        throw new Error('ls boom');
      }),
    });
    vi.stubGlobal('indexedDB', undefined);

    await expect(resetAppData()).resolves.toBeUndefined();
  });

  it('tears down the live engine, then clears the bundle cache FIRST — before the SW/caches the clear worker may load from', async () => {
    const order: string[] = [];
    unregisterTeardown = registerEngineTeardown(() => {
      order.push('teardown');
    });
    clearAlmaBundleCache.mockImplementation(() => {
      order.push('library-clear');
      return Promise.resolve();
    });
    const opfs = stubOpfs(['chunk', 'manifest', 'active.a', 'active.b', 'memory.sqlite3'], order);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: opfs.getDirectory },
      serviceWorker: {
        getRegistrations: vi.fn(() => {
          order.push('sw-unregister');
          return Promise.resolve([]);
        }),
      },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn(() => {
        order.push('caches');
        return Promise.resolve([]);
      }),
      delete: vi.fn(),
    });
    stubIndexedDb(['edgeproc-browser-cache'], order);

    await resetAppData();

    expect(order.slice(0, 4)).toEqual(['teardown', 'library-clear', 'sw-unregister', 'caches']);
    for (const name of ['chunk', 'manifest', 'active.a', 'active.b', 'memory.sqlite3']) {
      expect(opfs.removeEntry).toHaveBeenCalledWith(name, { recursive: true });
    }
    // Resolves only AFTER the floor database's delete actually succeeded.
    expect(order.at(-1)).toBe('idb:edgeproc-browser-cache');
  });

  it('still sweeps OPFS and finishes the reset when the library clear fails', async () => {
    clearAlmaBundleCache.mockRejectedValue(new Error('worker failed to load'));
    const opfs = stubOpfs(['active']);
    vi.stubGlobal('navigator', { storage: { getDirectory: opfs.getDirectory } });
    vi.stubGlobal('caches', undefined);
    const { deleteDatabase } = stubIndexedDb(['edgeproc-browser-cache']);

    await expect(resetAppData()).resolves.toBeUndefined();

    expect(opfs.removeEntry).toHaveBeenCalledWith('active', { recursive: true });
    expect(deleteDatabase).toHaveBeenCalledWith('edgeproc-browser-cache');
  });

  it('bounds a blocked IndexedDB delete so Reset & reload can never hang', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', undefined);
    stubIndexedDb(['edgeproc-browser-cache'], [], 'blocked-forever');

    const pending = resetAppData();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeUndefined();
  });

  it('removes each OPFS entry independently (one locked file never stops the sweep)', async () => {
    const opfs = stubOpfs(['locked.sqlite3', 'active']);
    opfs.removeEntry.mockImplementationOnce(() => Promise.reject(new Error('NoModificationAllowedError')));
    vi.stubGlobal('navigator', { storage: { getDirectory: opfs.getDirectory } });
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('indexedDB', undefined);

    await expect(resetAppData()).resolves.toBeUndefined();

    expect(opfs.removeEntry).toHaveBeenCalledWith('active', { recursive: true });
  });
});

describe('clearEngineBundleCache', () => {
  it('clears ONLY the signed-bundle cache via the library — no OPFS sweep, no user data touched', async () => {
    const opfs = stubOpfs(['memory.sqlite3']);
    const lsClear = vi.fn();
    vi.stubGlobal('navigator', { storage: { getDirectory: opfs.getDirectory } });
    vi.stubGlobal('localStorage', { clear: lsClear });
    const { deleteDatabase } = stubIndexedDb([]);

    await expect(clearEngineBundleCache()).resolves.toBe(true);

    expect(clearAlmaBundleCache).toHaveBeenCalledTimes(1);
    expect(clearAlmaBundleCache.mock.calls[0]?.[0]?.timeoutMs).toBeGreaterThan(0);
    expect(opfs.getDirectory).not.toHaveBeenCalled();
    expect(lsClear).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it('treats a failed or timed-out clear as a failure: tears down again and retries exactly once', async () => {
    const order: string[] = [];
    unregisterTeardown = registerEngineTeardown(() => {
      order.push('teardown');
    });
    clearAlmaBundleCache
      .mockImplementationOnce(() => {
        order.push('clear-1');
        return Promise.reject(new Error('bundle cache clear timed out after 8000 ms'));
      })
      .mockImplementationOnce(() => {
        order.push('clear-2');
        return Promise.resolve();
      });

    await expect(clearEngineBundleCache()).resolves.toBe(true);
    expect(order).toEqual(['teardown', 'clear-1', 'teardown', 'clear-2']);
  });

  it('never rejects (best-effort) and reports failure after the single retry', async () => {
    clearAlmaBundleCache.mockRejectedValue(new Error('lock'));
    await expect(clearEngineBundleCache()).resolves.toBe(false);
    expect(clearAlmaBundleCache).toHaveBeenCalledTimes(2);
  });
});
