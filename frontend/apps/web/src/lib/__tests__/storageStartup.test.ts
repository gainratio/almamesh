import { describe, expect, it } from 'vitest';
import type { PortableStatePersistence } from '@almamesh/store';

import { startupOutcome, type StorageStartupDeps } from '../storageStartup';

/** A persistence source the test drives, like the store's subscribe/read pair. */
function persistence(initial: PortableStatePersistence, siteBlocked = false) {
  let state = initial;
  const listeners = new Set<() => void>();
  const deps: StorageStartupDeps = {
    read: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    siteBlocked: () => siteBlocked,
  };
  const set = (next: PortableStatePersistence) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return { deps, set, listeners };
}

const never = new Promise<void>(() => undefined);

describe('startupOutcome', () => {
  // The bootstrap awaited hydration before the first render. With OPFS refused
  // hydration waits for "Check again", so React never mounted and the block
  // screen never showed: a blank page (WebKit, 2026-10-05).
  it('reports blocked when storage is refused while hydration is still waiting', async () => {
    const source = persistence('pending');
    const outcome = startupOutcome(never, source.deps);
    source.set('blocked');
    await expect(outcome).resolves.toBe('blocked');
    expect(source.listeners.size).toBe(0);
  });

  it('reports blocked at once when storage was already refused', async () => {
    await expect(startupOutcome(never, persistence('blocked').deps)).resolves.toBe('blocked');
  });

  it('reports blocked at once when the browser refuses all site storage', async () => {
    await expect(startupOutcome(never, persistence('pending', true).deps)).resolves.toBe('blocked');
  });

  it('reports ready when hydration finishes', async () => {
    const source = persistence('pending');
    await expect(startupOutcome(Promise.resolve(), source.deps)).resolves.toBe('ready');
    expect(source.listeners.size).toBe(0);
  });

  it('reports ready when hydration fails, so the app renders and explains', async () => {
    const source = persistence('pending');
    await expect(startupOutcome(Promise.reject(new Error('worker crashed')), source.deps)).resolves.toBe(
      'ready',
    );
  });
});
