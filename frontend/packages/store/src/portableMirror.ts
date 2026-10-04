/**
 * A copy of the in-memory SQLite file in IndexedDB, for browsers that refuse
 * OPFS but still allow IndexedDB (Safari Private Browsing, some WebViews,
 * every throwaway Playwright WebKit context).
 *
 * Without it, the memory fallback lost the chart on a plain reload. With it,
 * the repository saves the whole SQLite file here after every commit and
 * re-imports it on the next page load. The browser still decides how long
 * IndexedDB lives (Private Browsing erases it when the window closes), so the
 * UI keeps saying "export a backup".
 *
 * Only one tab may own the copy. Each tab in this mode has its own in-memory
 * database, so two writers would overwrite each other and could bring back a
 * profile one tab deleted. The owner holds a Web Lock for its lifetime; any
 * other tab gets no mirror and stays session-only, as before.
 */

export const SESSION_MIRROR_DATABASE = 'almamesh-session-mirror';
const OBJECT_STORE = 'sqlite';
const SNAPSHOT_KEY = 'canonical';
const LOCK_NAME = 'almamesh-session-mirror-owner';

export interface PortableSnapshotMirror {
  load(): Promise<Uint8Array | undefined>;
  save(bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

interface MirrorLock {
  readonly name: string;
}

/** The slice of `navigator.locks` this module needs. */
export interface MirrorLocks {
  request(
    name: string,
    options: { readonly mode: 'exclusive'; readonly ifAvailable: true },
    callback: (lock: MirrorLock | null) => unknown,
  ): Promise<unknown>;
}

export interface SessionMirrorEnvironment {
  readonly locks: MirrorLocks | undefined;
  readonly indexedDB: IDBFactory | undefined;
  /** Database name; tests isolate themselves, production uses the default. */
  readonly name?: string;
}

function browserEnvironment(): SessionMirrorEnvironment {
  const scope = globalThis as {
    navigator?: { locks?: MirrorLocks };
    indexedDB?: IDBFactory;
  };
  return { locks: scope.navigator?.locks, indexedDB: scope.indexedDB };
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(OBJECT_STORE);
  return settle(request);
}

async function run<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const transaction = database.transaction(OBJECT_STORE, mode);
  const result = settle(action(transaction.objectStore(OBJECT_STORE)));
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
  return result;
}

/** Hold the owner lock for the life of this page; resolve whether we got it. */
function claimOwnership(locks: MirrorLocks): Promise<boolean> {
  return new Promise((resolve, reject) => {
    locks
      .request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock === null ? undefined : new Promise<never>(() => undefined);
      })
      .catch(reject);
  });
}

function mirrorOver(database: IDBDatabase): PortableSnapshotMirror {
  return {
    load: async () => {
      const value = await run(database, 'readonly', (store) => store.get(SNAPSHOT_KEY));
      return value instanceof Uint8Array ? value : undefined;
    },
    save: async (bytes) => {
      await run(database, 'readwrite', (store) => store.put(bytes, SNAPSHOT_KEY));
    },
    clear: async () => {
      await run(database, 'readwrite', (store) => store.delete(SNAPSHOT_KEY));
    },
  };
}

/** The mirror if this tab may own it and IndexedDB opens; otherwise undefined. Never throws. */
export async function claimSessionMirror(
  environment: SessionMirrorEnvironment = browserEnvironment(),
): Promise<PortableSnapshotMirror | undefined> {
  const { locks, indexedDB: factory } = environment;
  if (locks === undefined || factory === undefined) return undefined;
  try {
    if (!(await claimOwnership(locks))) return undefined;
    return mirrorOver(await openDatabase(factory, environment.name ?? SESSION_MIRROR_DATABASE));
  } catch {
    return undefined;
  }
}
