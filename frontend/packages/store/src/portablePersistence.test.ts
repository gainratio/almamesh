import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPFS_PROBE_TIMEOUT_MS,
  PortableStateStartupError,
  markPortableStateUnavailable,
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

  // CONTRACT REVERSED (2026-10-05, product rule "SQLite on OPFS or no dice"):
  // this test used to require an in-memory SQLite fallback ('memory') on
  // refusal. A refused OPFS now blocks the app until the user allows storage.
  it('blocks, never falls back to in-memory SQLite, when OPFS is refused', () => {
    expect(selectPortablePersistence({ status: 'refused', reason: 'x' })).toBe('blocked');
  });

  // CONTRACT REVERSED (2026-10-05): a timed-out probe used to select OPFS and
  // then open with no time limit, which could hang on "Loading" forever. A
  // probe that never answers is now treated like a refusal: bounded, blocked,
  // and recoverable through checkPortableStorageAgain().
  it('blocks when the probe timed out instead of opening unbounded', () => {
    expect(selectPortablePersistence({ status: 'timed-out' })).toBe('blocked');
  });
});

/** A storage whose refusal can be lifted mid-test, as when the user allows site data. */
function switchableStorage() {
  let allowed = false;
  return {
    allow: () => {
      allowed = true;
    },
    storage: {
      getDirectory: () =>
        allowed
          ? Promise.resolve({ kind: 'directory' })
          : Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')),
    },
  };
}

const notBlocked = () => false;

describe('openPortableStateWhenAllowed', () => {
  it('starts pending before any open', () => {
    expect(portableStatePersistence()).toBe('pending');
  });

  it('opens durable OPFS SQLite and reports it when OPFS works', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    const seen: string[] = [];
    subscribePortableStatePersistence(() => seen.push(portableStatePersistence()));
    await expect(
      openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: notBlocked, open }),
    ).resolves.toEqual({ durable: true });
    expect(open).toHaveBeenCalledOnce();
    expect(portableStatePersistence()).toBe('opfs');
    expect(seen).toEqual(['opfs']);
  });

  // CONTRACT REVERSED (2026-10-05): this used to open in-memory SQLite and
  // report 'memory' when OPFS was refused. Now: report 'blocked', never open,
  // and keep the caller waiting (no throw, no RAM repository).
  it('reports blocked and never opens when OPFS is refused', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    let settled = false;
    void openPortableStateWhenAllowed({ storage: refusingStorage, storageBlocked: notBlocked, open }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(open).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it('reports blocked when the browser blocks site storage even if OPFS answers', async () => {
    const open = vi.fn(async () => ({ durable: true }));
    void openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: () => true, open });
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    expect(open).not.toHaveBeenCalled();
  });

  // CONTRACT REVERSED (2026-10-05): slow OPFS used to stay on OPFS and open
  // with no wall clock. A probe that never answers is now bounded and blocked.
  it('reports blocked, bounded by the probe budget, when the probe never answers', async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => ({ durable: true }));
    void openPortableStateWhenAllowed({ storage: hangingStorage, storageBlocked: notBlocked, open });
    await vi.advanceTimersByTimeAsync(OPFS_PROBE_TIMEOUT_MS);
    expect(portableStatePersistence()).toBe('blocked');
    expect(open).not.toHaveBeenCalled();
  });

  it('a hydration waiting on a refused open completes after checkPortableStorageAgain once storage is allowed', async () => {
    const switchable = switchableStorage();
    const open = vi.fn(async () => ({ durable: true }));
    const waiting = openPortableStateWhenAllowed({
      storage: switchable.storage,
      storageBlocked: notBlocked,
      open,
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
    void openPortableStateWhenAllowed({ storage: refusingStorage, storageBlocked: notBlocked, open }).then(
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
      storageBlocked: notBlocked,
      open,
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
    const opening = openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: notBlocked, open });
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(opening).resolves.toEqual({ durable: true });
    expect(portableStatePersistence()).toBe('opfs');
  });

  it('reports unavailable and rethrows when the open itself fails', async () => {
    const open = vi.fn(() => Promise.reject(new Error('SQLite OPFS Web Locks support is unavailable')));
    await expect(
      openPortableStateWhenAllowed({ storage: workingStorage, storageBlocked: notBlocked, open }),
    ).rejects.toThrow('SQLite OPFS Web Locks support is unavailable');
    expect(portableStatePersistence()).toBe('unavailable');
  });

  it('reports unavailable when the open fails after a successful recheck', async () => {
    const switchable = switchableStorage();
    const open = vi.fn(() => Promise.reject(new Error('Worker crashed')));
    const waiting = openPortableStateWhenAllowed({
      storage: switchable.storage,
      storageBlocked: notBlocked,
      open,
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
