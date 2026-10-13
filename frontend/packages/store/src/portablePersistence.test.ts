import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPFS_PROBE_TIMEOUT_MS,
  PortableStateStartupError,
  markPortableStateUnavailable,
  markPortableStorageBlockedByEngine,
  checkPortableStorageAgain,
  openPortableStateWhenAllowed,
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

  // CONTRACT REVERSED AGAIN (2026-10-12, AGENTS.md "If OPFS is refused, fall
  // back to in-memory SQLite with an honest notice"). From 2026-10-05 this
  // test required 'blocked': Safari Private Browsing hit a wall instead of
  // the app. A refused OPFS now runs SQLite in memory and says so.
  it('falls back to in-memory SQLite when OPFS is refused (Safari Private Browsing)', () => {
    expect(selectPortablePersistence({ status: 'refused', reason: 'x' })).toBe('memory');
  });

  // CONTRACT REVERSED (2026-10-05): a timed-out probe used to select OPFS and
  // then open with no time limit, which could hang on "Loading" forever. A
  // probe that never answers is now treated like a refusal: bounded, blocked,
  // and recoverable through checkPortableStorageAgain().
  it('blocks when the probe timed out instead of opening unbounded', () => {
    expect(selectPortablePersistence({ status: 'timed-out' })).toBe('blocked');
  });
});

/**
 * Site storage blocked ("Block all cookies") that the user lifts mid-test.
 * That realm still shows the block screen; only a refused OPFS runs in memory.
 */
function switchableStorage() {
  let allowed = false;
  return {
    allow: () => {
      allowed = true;
    },
    storage: workingStorage,
    storageBlocked: () => !allowed,
  };
}

const notBlocked = () => false;
const inMemory = { durable: false };
const openInMemory = vi.fn(async () => inMemory);

describe('openPortableStateWhenAllowed', () => {
  it('starts pending before any open', () => {
    expect(portableStatePersistence()).toBe('pending');
  });

  it('opens durable OPFS SQLite and reports it when OPFS works', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    const seen: string[] = [];
    subscribePortableStatePersistence(() => seen.push(portableStatePersistence()));
    await expect(
      openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: notBlocked, open, openInMemory }),
    ).resolves.toEqual({ durable: true });
    expect(open).toHaveBeenCalledOnce();
    expect(portableStatePersistence()).toBe('opfs');
    expect(seen).toEqual(['opfs']);
  });

  // CONTRACT REVERSED AGAIN (2026-10-12): from 2026-10-05 a refused OPFS
  // reported 'blocked' and kept the caller waiting behind the block screen.
  // Now it opens SQLite in memory, reports 'memory', and never touches OPFS.
  it('opens in-memory SQLite and reports memory when OPFS is refused', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    const seen: string[] = [];
    subscribePortableStatePersistence(() => seen.push(portableStatePersistence()));
    await expect(
      openPortableStateWhenAllowed({ storage: refusingStorage, storageBlocked: notBlocked, open, openInMemory }),
    ).resolves.toBe(inMemory);
    expect(open).not.toHaveBeenCalled();
    expect(portableStatePersistence()).toBe('memory');
    expect(seen).toEqual(['memory']);
    // Nothing is left pending: a recheck reports memory, it does not reopen.
    await expect(checkPortableStorageAgain()).resolves.toBe('memory');
  });

  it('reports unavailable when even the in-memory open fails', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    const failingMemory = vi.fn(() => Promise.reject(new Error('no Worker')));
    await expect(
      openPortableStateWhenAllowed({ storage: refusingStorage, storageBlocked: notBlocked, open, openInMemory: failingMemory }),
    ).rejects.toThrow('no Worker');
    expect(portableStatePersistence()).toBe('unavailable');
  });

  it('reports blocked when the browser blocks site storage even if OPFS answers', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    void openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: () => true, open, openInMemory });
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    expect(open).not.toHaveBeenCalled();
  });

  // CONTRACT REVERSED (2026-10-05): slow OPFS used to stay on OPFS and open
  // with no wall clock. A probe that never answers is now bounded and blocked.
  it('reports blocked, bounded by the probe budget, when the probe never answers', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => ({ durable: true }));
    void openPortableStateWhenAllowed({ storage: hangingStorage, storageBlocked: notBlocked, open, openInMemory });
    await vi.advanceTimersByTimeAsync(OPFS_PROBE_TIMEOUT_MS);
    expect(portableStatePersistence()).toBe('blocked');
    expect(open).not.toHaveBeenCalled();
  });

  it('a hydration waiting on a refused open completes after checkPortableStorageAgain once storage is allowed', async () => {
    const switchable = switchableStorage();
    const open = vi.fn(async () => ({ durable: true }));
    const waiting = openPortableStateWhenAllowed({
      storage: switchable.storage,
      storageBlocked: switchable.storageBlocked,
      open,
      openInMemory,
    });
    const hydrated = waiting.then((repository) => ({ hydratedFrom: repository }));
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));

    switchable.allow();
    await expect(checkPortableStorageAgain()).resolves.toBe('opfs');

    await expect(hydrated).resolves.toEqual({ hydratedFrom: { durable: true } });
    expect(open).toHaveBeenCalledOnce();
    expect(portableStatePersistence()).toBe('opfs');
  });

  it('keeps waiting and reports blocked when the recheck is still refused', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    let settled = false;
    void openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: () => true, open, openInMemory }).then(
      () => (settled = true),
    );
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    await expect(checkPortableStorageAgain()).resolves.toBe('blocked');
    expect(open).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it('concurrent rechecks open the database exactly once', async () => {
    const switchable = switchableStorage();
    const open = vi.fn(async () => ({ durable: true }));
    const waiting = openPortableStateWhenAllowed({
      storage: switchable.storage,
      storageBlocked: switchable.storageBlocked,
      open,
      openInMemory,
    });
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    switchable.allow();
    const results = await Promise.all([checkPortableStorageAgain(), checkPortableStorageAgain()]);
    expect(results).toEqual(['opfs', 'opfs']);
    await expect(waiting).resolves.toEqual({ durable: true });
    expect(open).toHaveBeenCalledOnce();
  });

  it('a recheck with nothing waiting reports the current state without probing', async () => {
    await expect(checkPortableStorageAgain()).resolves.toBe('pending');
  });

  it('waits for a slow open instead of failing it on a wall clock', async () => {
    // On slow 4G the SQLite Worker's wasm download alone can take minutes while
    // it shares the link with the engine sync. A fixed budget turned that
    // success into "database unavailable"; the Worker reports its own failures.
    vi.useFakeTimers();
    const open = vi.fn(
      () => new Promise<{ durable: boolean }>((resolve) => setTimeout(() => resolve({ durable: true }), 180_000)),
    );
    const opening = openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: notBlocked, open, openInMemory });
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(opening).resolves.toEqual({ durable: true });
    expect(portableStatePersistence()).toBe('opfs');
  });

  it('reports unavailable and rethrows when the open itself fails', async () => {
    const open = vi.fn(() => Promise.reject(new Error('SQLite OPFS Web Locks support is unavailable')));
    await expect(
      openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: notBlocked, open, openInMemory }),
    ).rejects.toThrow('SQLite OPFS Web Locks support is unavailable');
    expect(portableStatePersistence()).toBe('unavailable');
  });

  it('reports unavailable when the open fails after a successful recheck', async () => {
    const switchable = switchableStorage();
    const open = vi.fn(() => Promise.reject(new Error('Worker crashed')));
    const waiting = openPortableStateWhenAllowed({
      storage: switchable.storage,
      storageBlocked: switchable.storageBlocked,
      open,
      openInMemory,
    });
    const outcome = waiting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    switchable.allow();
    await expect(checkPortableStorageAgain()).resolves.toBe('unavailable');
    await expect(outcome).resolves.toBeInstanceOf(Error);
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

// The app's SQLite opened, but the engine's own cache was refused
// (@gainratio/browser cacheFallback "none", reason "opfs-unavailable"). The
// same block screen must show, and "Check again" must recover it in place.
describe('markPortableStorageBlockedByEngine', () => {
  it('reports blocked, and a recheck that finds storage allowed reports opfs again', async () => {
    let storage: { getDirectory: () => Promise<unknown> } = refusingStorage;
    markPortableStorageBlockedByEngine({ storage: { getDirectory: () => storage.getDirectory() } });
    expect(portableStatePersistence()).toBe('blocked');

    await expect(checkPortableStorageAgain()).resolves.toBe('blocked');
    expect(portableStatePersistence()).toBe('blocked');

    storage = workingStorage;
    const changes: string[] = [];
    subscribePortableStatePersistence(() => changes.push(portableStatePersistence()));
    await expect(checkPortableStorageAgain()).resolves.toBe('opfs');
    expect(portableStatePersistence()).toBe('opfs');
    expect(changes).toContain('opfs');
    // Recovered: nothing is left pending to re-run.
    await expect(checkPortableStorageAgain()).resolves.toBe('opfs');
  });
});
