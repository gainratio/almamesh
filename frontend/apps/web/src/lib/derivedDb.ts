/**
 * Lazy OPFS database for reference cities and recomputable period skies.
 * This is the app's only SQL-library boundary. No in-memory fallback.
 */
import { openSqlDatabase, removeSqlDatabase, type SqlDatabase } from '@gainratio/browser/sql';
import { readDeletionTombstones } from '@almamesh/store';

export type { SqlDatabase } from '@gainratio/browser/sql';
export const DERIVED_DB_NAME = 'almamesh-derived';
export const DERIVED_SCHEMA_VERSION = 1;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS cities (idx INTEGER PRIMARY KEY, n TEXT NOT NULL, c TEXT NOT NULL, cc TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, p INTEGER NOT NULL, name_fold TEXT NOT NULL, search_fold TEXT NOT NULL) STRICT',
  "CREATE VIRTUAL TABLE IF NOT EXISTS cities_fts USING fts5(search_fold, content='cities', content_rowid='idx', tokenize='trigram')",
  'CREATE TABLE IF NOT EXISTS period_sky (key TEXT PRIMARY KEY, engine TEXT NOT NULL, profile_id TEXT NOT NULL, payload TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0) STRICT',
  'CREATE INDEX IF NOT EXISTS period_sky_profile ON period_sky(profile_id)',
  `PRAGMA user_version=${DERIVED_SCHEMA_VERSION}`,
];

export async function migrateDerivedDb(db: SqlDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    const version = (await tx.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version ?? 0;
    if (version > DERIVED_SCHEMA_VERSION) throw new Error('Derived database uses a newer schema. Update the app.');
    for (const sql of SCHEMA) await tx.exec(sql);
  });
}

export interface DerivedDbAccess {
  withDb<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T>;
}
export interface DerivedDbLocks {
  request<T>(name: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface DerivedDbSessions extends DerivedDbAccess { remove(): Promise<void>; }
export const DERIVED_SESSION_TIMEOUT_MS = 30_000;
const SESSION_LOCK = 'almamesh-derived-session-v1';

/**
 * The SQL library owns its sahpool exclusively until close. Keep that ownership
 * only for a logical import/query/transaction, never for the lifetime of a tab.
 * The native lock covers the complete city import, including its version marker.
 */
export function createDerivedDbSessions(options: {
  readonly openDatabase: () => Promise<SqlDatabase>;
  readonly removeDatabase: () => Promise<unknown>;
  readonly locks: DerivedDbLocks;
  readonly epoch: () => Promise<number>;
  readonly timeoutMs?: number;
}): DerivedDbSessions {
  let generation = 0;
  let pendingOpen: Promise<SqlDatabase> | undefined;
  let pendingClose: Promise<void> | undefined;
  const activeCancellations = new Set<() => void>();
  const resetError = () => new Error('The derived database changed during a reset. Retry the lookup.');
  function close(db: SqlDatabase): Promise<void> {
    const closing = Promise.resolve().then(() => db.close());
    pendingClose = closing;
    const clear = () => { if (pendingClose === closing) pendingClose = undefined; };
    void closing.then(clear, clear);
    return closing;
  }
  return {
    async withDb(work) {
      const expectedGeneration = generation;
      const controller = new AbortController();
      const cancel = () => controller.abort(resetError());
      const stopped = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      void stopped.catch(() => undefined);
      activeCancellations.add(cancel);
      const timeout = setTimeout(() => controller.abort(new Error('The derived database session timed out. Retry the lookup.')), options.timeoutMs ?? DERIVED_SESSION_TIMEOUT_MS);
      const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, stopped]);
      const check = () => {
        controller.signal.throwIfAborted();
        if (generation !== expectedGeneration) throw resetError();
      };
      try {
        const expectedEpoch = await bounded(options.epoch());
        check();
        let adopted = false;
        const locked = options.locks.request(SESSION_LOCK, async () => {
          check();
          if (await bounded(options.epoch()) !== expectedEpoch) throw resetError();
          // The public SQL API cannot abort a Worker before its handle exists.
          // Refuse retries while that opener/cleanup is unsettled, so a stalled
          // startup cannot accumulate Workers. Other tabs can acquire the lock.
          if (pendingOpen || pendingClose) throw new Error('The derived database is still opening or closing. Retry the lookup.');
          let db: SqlDatabase | undefined;
          try {
            const opening = Promise.resolve().then(() => options.openDatabase()).then(async (opened) => {
              if (controller.signal.aborted) {
                // This runs outside the expired lock callback. A late handle is
                // closed before migration or user work can observe it.
                await close(opened);
                controller.signal.throwIfAborted();
              }
              db = opened;
              adopted = true;
              return opened;
            });
            pendingOpen = opening;
            const clear = () => { if (pendingOpen === opening) pendingOpen = undefined; };
            void opening.then(clear, clear);
            await bounded(opening);
            check();
            if (await bounded(options.epoch()) !== expectedEpoch) throw resetError();
            const operation = (async () => { await migrateDerivedDb(db!); check(); return work(db!); })();
            return await bounded(operation);
          } finally {
            // An adopted connection rolls back and releases its owner before
            // this lock is released. Only an opener without a handle detaches.
            if (db) await close(db);
          }
        }, controller.signal);
        try { return await bounded(locked); }
        catch (error) {
          // Ready handles finish their rollback/close before callers retry.
          // A stalled opener has no handle to wait on and releases promptly.
          if (adopted) await locked.catch(() => undefined);
          throw error;
        }
      } finally {
        clearTimeout(timeout);
        activeCancellations.delete(cancel);
      }
    },
    remove() {
      generation += 1;
      for (const cancel of activeCancellations) cancel();
      return options.locks.request(SESSION_LOCK, async () => { await options.removeDatabase(); });
    },
  };
}

let sessions: DerivedDbSessions | undefined;
let injected: SqlDatabase | undefined;

function browserSessions(): DerivedDbSessions {
  if (!navigator.locks) throw new Error('Derived SQLite requires Web Locks and OPFS.');
  sessions ??= createDerivedDbSessions({
    openDatabase: () => openSqlDatabase({ name: DERIVED_DB_NAME, persistence: 'opfs', fallback: 'none' }),
    removeDatabase: () => removeSqlDatabase(DERIVED_DB_NAME),
    locks: { request: (name, work, signal) => navigator.locks.request(name, { signal }, work) },
    epoch: async () => (await readDeletionTombstones()).restoreEpoch,
  });
  return sessions;
}

export function withDerivedDb<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T> {
  return injected ? work(injected) : browserSessions().withDb(work);
}

export function removeDerivedDb(): Promise<void> { return browserSessions().remove(); }

/** Inject the same pinned SQLite API in unit tests without opening browser OPFS. */
export function __setDerivedDbForTest(db: SqlDatabase | undefined): void {
  injected = db;
}
