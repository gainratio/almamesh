import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import { claimSessionMirror, SESSION_MIRROR_DATABASE, type MirrorLocks } from './portableMirror';

/** A Web Locks double: the first claimant holds the lock until released. */
function fakeLocks(): MirrorLocks & { readonly held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    request: (name, _options, callback) => {
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name }));
    },
  };
}

describe('claimSessionMirror', () => {
  it('round-trips the SQLite bytes through IndexedDB for the next page load', async () => {
    const locks = fakeLocks();
    const first = await claimSessionMirror({ locks, indexedDB, name: 'round-trip' });
    expect(first).toBeDefined();
    await first!.save(new Uint8Array([1, 2, 3]));

    locks.held.clear(); // the page reloaded: its lock went with it
    const next = await claimSessionMirror({ locks, indexedDB, name: 'round-trip' });
    expect(Array.from((await next!.load()) ?? [])).toEqual([1, 2, 3]);
  });

  it('gives a second tab no mirror, so it cannot overwrite the first tab’s data', async () => {
    const locks = fakeLocks();
    expect(await claimSessionMirror({ locks, indexedDB, name: 'two-tabs' })).toBeDefined();
    expect(await claimSessionMirror({ locks, indexedDB, name: 'two-tabs' })).toBeUndefined();
  });

  it('forgets the bytes on clear', async () => {
    const locks = fakeLocks();
    const mirror = await claimSessionMirror({ locks, indexedDB, name: 'clear' });
    await mirror!.save(new Uint8Array([9]));
    await mirror!.clear();
    expect(await mirror!.load()).toBeUndefined();
  });

  it('declines when the browser has no Web Locks or no IndexedDB', async () => {
    expect(await claimSessionMirror({ locks: undefined, indexedDB, name: 'no-locks' })).toBeUndefined();
    expect(await claimSessionMirror({ locks: fakeLocks(), indexedDB: undefined, name: 'no-idb' })).toBeUndefined();
  });

  it('declines when IndexedDB refuses to open (Safari "Block all cookies")', async () => {
    const refusing = {
      open: () => {
        throw new DOMException('IDBFactory.open() called in an invalid security context', 'SecurityError');
      },
    } as unknown as IDBFactory;
    expect(await claimSessionMirror({ locks: fakeLocks(), indexedDB: refusing, name: 'blocked' })).toBeUndefined();
  });

  it('names its own database so a full data reset clears it with the rest of IndexedDB', () => {
    expect(SESSION_MIRROR_DATABASE).toBe('almamesh-session-mirror');
  });
});
