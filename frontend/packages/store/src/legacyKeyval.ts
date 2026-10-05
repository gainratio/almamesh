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

/** Created lazily: idb-keyval opens the database on first use, not here. */
let legacyStore: ReturnType<typeof createStore> | null = null;
function store(): ReturnType<typeof createStore> {
  legacyStore ??= createStore(LEGACY_KEYVAL_DATABASE, 'keyval');
  return legacyStore;
}

/**
 * False only when the browser can list its databases and the legacy one is
 * not there. A browser that cannot list them is treated as "maybe", so old
 * data is never stranded.
 */
export async function legacyKeyvalDatabaseExists(): Promise<boolean> {
  const factory = (globalThis as { indexedDB?: Partial<IDBFactory> }).indexedDB;
  if (factory === undefined) return false;
  if (typeof factory.databases !== 'function') return true;
  try {
    return (await factory.databases()).some((database) => database.name === LEGACY_KEYVAL_DATABASE);
  } catch {
    return true; // listing refused: fall back to the pre-check behaviour
  }
}

export async function readLegacyKeyval<T = unknown>(key: string): Promise<T | undefined> {
  if (!(await legacyKeyvalDatabaseExists())) return undefined;
  return get<T>(key, store());
}

export async function deleteLegacyKeyval(key: string): Promise<void> {
  if (!(await legacyKeyvalDatabaseExists())) return;
  await del(key, store());
}
