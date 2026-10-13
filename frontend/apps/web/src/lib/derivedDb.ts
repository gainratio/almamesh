/**
 * Lazy OPFS database for reference cities, recomputable period skies and the
 * chat keyword index (a cache rebuilt from the canonical chat rows).
 * This is the app's only SQL-library boundary.
 *
 * Everything here is rebuildable (bundled city batches, engine-recomputed
 * skies), so it is the one place an in-memory fallback is allowed: when the
 * browser refuses OPFS for this pool, the library opens SQLite in memory and
 * reports why. That handle is kept for the tab (re-importing the city list on
 * every keystroke would be too slow), the UI says the list lives in memory for
 * this visit, and reset drops it. User data never takes this path: the
 * portable store stays OPFS-only and blocks instead (portablePersistence.ts).
 */
import { openSqlDatabase, removeSqlDatabase, type SqlDatabase } from '@gainratio/browser/sql';
import { readDeletionTombstones, supportsPortableState } from '@almamesh/store';

export type { SqlDatabase } from '@gainratio/browser/sql';
type SqlStorage = SqlDatabase['storage'];
export const DERIVED_DB_NAME = 'almamesh-derived';
export const DERIVED_SCHEMA_VERSION = 3;
/** dataset_meta key: the keyword index was rebuilt from canonical chat at least once. */
export const CHAT_FTS_BUILT_KEY = 'chat-fts-built';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS cities (idx INTEGER PRIMARY KEY, n TEXT NOT NULL, c TEXT NOT NULL, cc TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, p INTEGER NOT NULL, name_fold TEXT NOT NULL, search_fold TEXT NOT NULL) STRICT',
  "CREATE VIRTUAL TABLE IF NOT EXISTS cities_fts USING fts5(search_fold, content='cities', content_rowid='idx', tokenize='trigram')",
  // v3: the schema refuses empty ids, non-JSON payloads and negative epochs.
  // No foreign keys: profiles live in the canonical store, a separate file.
  'CREATE TABLE IF NOT EXISTS period_sky (key TEXT PRIMARY KEY CHECK (length(key) > 0), engine TEXT NOT NULL CHECK (length(engine) > 0), profile_id TEXT NOT NULL CHECK (length(profile_id) > 0), payload TEXT NOT NULL CHECK (json_valid(payload)), epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0)) STRICT',
  'CREATE INDEX IF NOT EXISTS period_sky_profile ON period_sky(profile_id)',
  // Natal-only parts of period_sky payloads (vargas, strength, the reading's
  // natal lords), stored once per profile and natal chart, content-addressed
  // by `ref`. Additive within v3: an older build ignores the table, and every
  // period_sky purge also drops the natal rows no period row references.
  'CREATE TABLE IF NOT EXISTS period_natal (ref TEXT PRIMARY KEY CHECK (length(ref) > 0), engine TEXT NOT NULL CHECK (length(engine) > 0), profile_id TEXT NOT NULL CHECK (length(profile_id) > 0), payload TEXT NOT NULL CHECK (json_valid(payload)), epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0)) STRICT',
  'CREATE INDEX IF NOT EXISTS period_natal_profile ON period_natal(profile_id)',
  // v3: keyword search over chat messages, rebuildable from the chat store row.
  // Contentless-delete (SQLite >= 3.43; contentless_unindexed >= 3.47; the
  // pinned build is 3.53): the message text is tokenized but never stored, so
  // the only text copy stays in the canonical chat store. The UNINDEXED ids are
  // kept so rows can be filtered and purged by profile and thread.
  "CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(profile_id UNINDEXED, thread_id UNINDEXED, message_id UNINDEXED, text, content='', contentless_delete=1, contentless_unindexed=1, tokenize='unicode61 remove_diacritics 2')",
  `PRAGMA user_version=${DERIVED_SCHEMA_VERSION}`,
];

/**
 * Durability. The OPFS SAH-pool VFS has no shared memory, so WAL is out: the
 * library opens OPFS files with journal_mode=DELETE (and refuses otherwise);
 * the in-memory fallback has a memory journal by definition. synchronous=FULL
 * syncs the journal and the file at every commit. Both are read back, and a
 * connection that did not take them is refused.
 *
 * Isolation. The SAH pool holds exclusive OPFS access handles, so one
 * connection owns the file at a time; every session takes the cross-tab Web
 * Lock below first; and the client queues calls behind an open transaction.
 * Each multi-statement write is one `db.transaction` (BEGIN IMMEDIATE …
 * COMMIT, ROLLBACK on any error): it takes the write lock up front and runs no
 * non-SQL await inside.
 */
async function requireDurability(db: SqlDatabase): Promise<void> {
  await db.exec('PRAGMA synchronous=FULL');
  const journal = (await db.query<{ journal_mode: string }>('PRAGMA journal_mode=DELETE'))[0]?.journal_mode;
  const synchronous = (await db.query<{ synchronous: number }>('PRAGMA synchronous'))[0]?.synchronous;
  const expectedJournal = db.storage?.persistence === 'memory' ? 'memory' : 'delete';
  if (journal !== expectedJournal || synchronous !== 2) {
    throw new Error('The derived database durability pragmas were not applied.');
  }
}

/**
 * secure_delete zeroes deleted rows and freed pages, so a purged chat message
 * leaves no bytes behind. The library already sets it on OPFS connections;
 * setting it here covers the in-memory fallback too. auto_vacuum only takes
 * effect before the first table exists, so only a new database gets it; on an
 * older file incremental_vacuum is a no-op and secure_delete does the zeroing.
 */
export async function migrateDerivedDb(db: SqlDatabase): Promise<void> {
  await requireDurability(db);
  await db.exec('PRAGMA secure_delete=ON');
  // auto_vacuum is ignored inside a transaction, and once any table exists
  // (sqlite-vector adds one at open) it needs a VACUUM to apply. Only a new
  // file (user_version 0, nearly empty, so the VACUUM is cheap) gets it.
  if ((await db.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version === 0) {
    await db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    // Space reclaim only: without it freed pages stay in the file, zeroed by
    // secure_delete. Never let it block the city list or the keyword index.
    await db.exec('VACUUM').catch(() => undefined);
  }
  await db.transaction(async (tx) => {
    const version = (await tx.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version ?? 0;
    if (version > DERIVED_SCHEMA_VERSION) throw new Error('Derived database uses a newer schema. Update the app.');
    // v2 stored message text in chat_fts_content. Drop it (secure_delete
    // zeroes the pages) and let the next search backfill from canonical chat.
    if (version === 2) await tx.exec('DROP TABLE IF EXISTS chat_fts');
    // A recomputable cache: recreate it with the v3 constraints.
    if (version > 0 && version < 3) await tx.exec('DROP TABLE IF EXISTS period_sky');
    for (const sql of SCHEMA) await tx.exec(sql);
    if (version === 2) await tx.exec('DELETE FROM dataset_meta WHERE key = ?', [CHAT_FTS_BUILT_KEY]);
  });
}

export interface DerivedDbAccess {
  withDb<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T>;
}
export interface DerivedDbLocks {
  request<T>(name: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export interface DerivedDbSessions extends DerivedDbAccess { remove(): Promise<void>; }
/** Where the derived database lives: not opened yet, on OPFS, or in memory because OPFS was refused. */
export type DerivedDbStorage = 'unknown' | 'opfs' | 'memory';

/** A library fallback ('opfs-unavailable' / 'pool-in-use'), never an explicit memory request. */
function classifyStorage(storage: SqlStorage | undefined): Exclude<DerivedDbStorage, 'unknown'> {
  return storage?.persistence === 'memory' && storage.reason !== 'requested' ? 'memory' : 'opfs';
}
export const DERIVED_SESSION_TIMEOUT_MS = 30_000;
const SESSION_LOCK = 'almamesh-derived-session-v1';

interface DocumentLifecycle {
  isHidden(): boolean;
  generation(): number;
  subscribePagehide(cancel: () => void): () => void;
}
const documentLifecycles = new WeakMap<EventTarget, DocumentLifecycle>();
function documentLifecycle(target: EventTarget): DocumentLifecycle {
  const existing = documentLifecycles.get(target);
  if (existing) return existing;
  let hidden = false;
  let generation = 0;
  const cancellations = new Set<() => void>();
  target.addEventListener('pagehide', () => {
    hidden = true;
    generation += 1;
    for (const cancel of cancellations) cancel();
  });
  target.addEventListener('pageshow', () => { hidden = false; });
  const lifecycle = {
    isHidden: () => hidden,
    generation: () => generation,
    subscribePagehide: (cancel: () => void) => {
      cancellations.add(cancel);
      return () => { cancellations.delete(cancel); };
    },
  };
  documentLifecycles.set(target, lifecycle);
  return lifecycle;
}
// Observe teardown before the first lookup: a caller can still be awaiting
// canonical hydration when pagehide occurs. This creates no SQL Worker.
if (typeof window !== 'undefined') documentLifecycle(window);
const teardownError = () => new DOMException('The derived database lookup was cancelled because the page is unloading.', 'AbortError');

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
  readonly lifecycle?: EventTarget;
  readonly onStorage?: (storage: Exclude<DerivedDbStorage, 'unknown'>) => void;
}): DerivedDbSessions {
  const lifecycle = options.lifecycle ? documentLifecycle(options.lifecycle) : undefined;
  let generation = 0;
  let pendingOpen: Promise<SqlDatabase> | undefined;
  let pendingClose: Promise<void> | undefined;
  /** The refused-OPFS fallback handle, kept for the tab until reset. */
  let memory: SqlDatabase | undefined;
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
      if (lifecycle?.isHidden()) throw teardownError();
      const expectedGeneration = generation;
      const expectedDocumentGeneration = lifecycle?.generation();
      const controller = new AbortController();
      const cancel = () => controller.abort(resetError());
      const unsubscribeLifecycle = lifecycle?.subscribePagehide(() => controller.abort(teardownError()));
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
        if (lifecycle?.isHidden() || lifecycle?.generation() !== expectedDocumentGeneration) throw teardownError();
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
            const opening = Promise.resolve().then(() => {
              // WebKit refuses Worker construction after pagehide. Recheck in
              // this microtask, immediately before entering the public opener.
              check();
              return memory ?? options.openDatabase();
            }).then(async (opened) => {
              if (controller.signal.aborted) {
                // This runs outside the expired lock callback. A late handle is
                // closed before migration or user work can observe it. The
                // retained in-memory handle stays open for the next lookup.
                if (opened !== memory) await close(opened);
                controller.signal.throwIfAborted();
              }
              db = opened;
              adopted = true;
              const storage = classifyStorage(opened.storage);
              if (storage === 'memory') memory = opened;
              options.onStorage?.(storage);
              return opened;
            });
            pendingOpen = opening;
            const clear = () => { if (pendingOpen === opening) pendingOpen = undefined; };
            void opening.then(clear, clear);
            await bounded(opening);
            check();
            if (await bounded(options.epoch()) !== expectedEpoch) throw resetError();
            check();
            const operation = (async () => {
              await migrateDerivedDb(db!);
              check();
              const value = await work(db!);
              check();
              return value;
            })();
            return await bounded(operation);
          } finally {
            // An adopted connection rolls back and releases its owner before
            // this lock is released. Only an opener without a handle detaches.
            if (db && db !== memory) await close(db);
          }
        }, controller.signal);
        try {
          const value = await bounded(locked);
          // A completed callback still awaits close under the lock. Teardown
          // during that close must not publish an old document's result.
          check();
          return value;
        }
        catch (error) {
          // Ready handles finish their rollback/close before callers retry.
          // A stalled opener has no handle to wait on and releases promptly.
          if (adopted) await locked.catch(() => undefined);
          throw error;
        }
      } finally {
        clearTimeout(timeout);
        activeCancellations.delete(cancel);
        unsubscribeLifecycle?.();
      }
    },
    remove() {
      generation += 1;
      for (const cancel of activeCancellations) cancel();
      return options.locks.request(SESSION_LOCK, async () => {
        const dropped = memory;
        memory = undefined;
        if (dropped) await close(dropped);
        await options.removeDatabase();
      });
    },
  };
}

let sessions: DerivedDbSessions | undefined;
let injected: SqlDatabase | undefined;
let storageState: DerivedDbStorage = 'unknown';
const storageListeners = new Set<() => void>();

function recordStorage(next: DerivedDbStorage): void {
  if (next === storageState) return;
  storageState = next;
  for (const listener of storageListeners) listener();
}

/** Where the derived database lives right now (for the honest in-memory notice). */
export function derivedDbStorage(): DerivedDbStorage { return storageState; }

export function subscribeDerivedDbStorage(listener: () => void): () => void {
  storageListeners.add(listener);
  return () => { storageListeners.delete(listener); };
}

function browserSessions(): DerivedDbSessions {
  if (!navigator.locks) throw new Error('Derived SQLite requires Web Locks and OPFS.');
  sessions ??= createDerivedDbSessions({
    openDatabase: () => openSqlDatabase({ name: DERIVED_DB_NAME, persistence: 'opfs', fallback: 'memory' }),
    removeDatabase: () => removeSqlDatabase(DERIVED_DB_NAME),
    locks: { request: (name, work, signal) => navigator.locks.request(name, { signal }, work) },
    epoch: async () => (await readDeletionTombstones()).restoreEpoch,
    lifecycle: typeof window === 'undefined' ? undefined : window,
    onStorage: recordStorage,
  });
  return sessions;
}

export function withDerivedDb<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T> {
  return injected ? work(injected) : browserSessions().withDb(work);
}

export function removeDerivedDb(): Promise<void> { return browserSessions().remove(); }

/** Node/prerender and browsers without OPFS SQLite have no derived database. */
export function derivedDbAvailable(): boolean {
  return injected !== undefined || supportsPortableState();
}

/** Inject the same pinned SQLite API in unit tests without opening browser OPFS. */
export function __setDerivedDbForTest(db: SqlDatabase | undefined): void {
  injected = db;
}

/** Drive the in-memory notice in component tests without opening SQLite. */
export function __setDerivedDbStorageForTest(storage: DerivedDbStorage): void {
  recordStorage(storage);
}
