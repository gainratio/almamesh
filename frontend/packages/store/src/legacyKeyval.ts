import { createStore, del, get } from 'idb-keyval';

/**
 * The pre-SQLite idb-keyval database. The one-time migration reads it and
 * reset deletes its rows; nothing writes it.
 *
 * Opening an IndexedDB database that does not exist CREATES it, which is a
 * write. On a browser that never ran a pre-SQLite build there is nothing to
 * migrate, so every access first checks that the database exists. Found by
 * the WebKit gate (2026-10-05): a fresh profile gained an empty
 * `keyval-store` database just from the migration's read.
 *
 * TODO(remove after 2026-11-04, one release after the SQLite-only move).
 */
const LEGACY_KEYVAL_DATABASE = 'keyval-store';

/**
 * Created lazily: idb-keyval opens the database on first use, not here. Keyed
 * to the factory it was made for (one per page in production; one per test).
 */
let legacyStore: { factory: unknown; store: ReturnType<typeof createStore> } | null = null;
function store(): ReturnType<typeof createStore> {
  const factory = (globalThis as { indexedDB?: unknown }).indexedDB;
  if (legacyStore !== null && legacyStore.factory === factory) return legacyStore.store;
  const created = createStore(LEGACY_KEYVAL_DATABASE, 'keyval');
  legacyStore = { factory, store: created };
  return created;
}

/**
 * Existence without creation, for browsers that cannot list databases
 * (Firefox < 126) or refuse to: open with no version, and if `upgradeneeded`
 * fires the database did not exist, so abort the version change. An aborted
 * first upgrade leaves no database behind.
 */
function probeByOpening(factory: Pick<IDBFactory, 'open'>): Promise<boolean> {
  return new Promise((resolve) => {
    let created = false;
    const request = factory.open(LEGACY_KEYVAL_DATABASE);
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(!created);
    };
    request.onerror = (event) => {
      event.preventDefault(); // the abort above, or a refused open: nothing to read
      resolve(false);
    };
    request.onblocked = () => resolve(true);
  });
}

/** False when the legacy database is not there; never creates it to find out. */
export async function legacyKeyvalDatabaseExists(): Promise<boolean> {
  const factory = (globalThis as { indexedDB?: Partial<IDBFactory> }).indexedDB;
  if (factory === undefined) return false;
  if (typeof factory.databases === 'function') {
    try {
      return (await factory.databases()).some((database) => database.name === LEGACY_KEYVAL_DATABASE);
    } catch {
      // Listing refused: probe instead.
    }
  }
  return typeof factory.open === 'function' ? probeByOpening(factory as Pick<IDBFactory, 'open'>) : false;
}

export async function readLegacyKeyval<T = unknown>(key: string): Promise<T | undefined> {
  if (!(await legacyKeyvalDatabaseExists())) return undefined;
  return get<T>(key, store());
}

export async function deleteLegacyKeyval(key: string): Promise<void> {
  if (!(await legacyKeyvalDatabaseExists())) return;
  await del(key, store());
}
