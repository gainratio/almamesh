import { afterEach, describe, expect, it, vi } from 'vitest';
import { openNodeSqlDatabase, type SqlDatabase } from '@gainratio/browser/sql/node';

import { createDerivedDbSessions, DERIVED_SCHEMA_VERSION, migrateDerivedDb, type DerivedDbLocks } from '../derivedDb';
import { cityRowAt, ensureCitiesImported } from '../geo/citySql';

const handles: SqlDatabase[] = [];
async function open(): Promise<SqlDatabase> {
  const db = await openNodeSqlDatabase({ name: 'derived-schema-test' });
  handles.push(db);
  return db;
}
afterEach(async () => { await Promise.all(handles.splice(0).map((db) => db.close())); });

describe('derived SQLite schema', () => {
  it('creates the derived tables and a trigram index on the pinned SQLite build', async () => {
    const db = await open();
    await migrateDerivedDb(db);
    const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table'");
    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining(['cities', 'cities_fts', 'dataset_meta', 'period_sky']));
    expect((await db.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version).toBe(DERIVED_SCHEMA_VERSION);
    await db.exec("INSERT INTO cities (idx, n, c, cc, lat, lon, p, name_fold, search_fold) VALUES(7, 'Bogotá', 'Colombia', 'CO', 4.61, -74.08, 100, 'bogota', 'bogota colombia co')");
    await db.exec("INSERT INTO cities_fts(cities_fts) VALUES('rebuild')");
    expect(await db.query("SELECT rowid FROM cities_fts WHERE cities_fts MATCH '" + '"ogot"' + "'")).toEqual([{ rowid: 7 }]);
  });

  it('gives a v3 file made before the state column a nullable state, keeping its rows', async () => {
    const db = await open();
    await db.exec('CREATE TABLE cities (idx INTEGER PRIMARY KEY, n TEXT NOT NULL, c TEXT NOT NULL, cc TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, p INTEGER NOT NULL, name_fold TEXT NOT NULL, search_fold TEXT NOT NULL) STRICT');
    await db.exec("INSERT INTO cities VALUES(0, 'Novato', 'United States', 'US', 38.1, -122.57, 55530, 'novato', 'novato')");
    await db.exec('PRAGMA user_version=3');
    await migrateDerivedDb(db);
    await migrateDerivedDb(db);
    expect(await db.query('SELECT n, s FROM cities')).toEqual([{ n: 'Novato', s: null }]);
    await db.exec("UPDATE cities SET s = 'California'");
    expect((await cityRowAt(db, 0))?.s).toBe('California');
  });

  it('adds the chat keyword index to a v1 database without losing rows', async () => {
    const db = await open();
    await db.exec('CREATE TABLE dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    await db.exec("INSERT INTO dataset_meta VALUES ('period-sky-epoch', '3')");
    await db.exec('PRAGMA user_version=1');
    await migrateDerivedDb(db);
    const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table'");
    expect(tables.map(({ name }) => name)).toContain('chat_fts');
    expect(await db.query('SELECT value FROM dataset_meta WHERE key=?', ['period-sky-epoch'])).toEqual([{ value: '3' }]);
    expect((await db.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version).toBe(3);
  });

  it('schema v3 replaces a v2 keyword index with a contentless one and leaves no old text behind', async () => {
    expect(DERIVED_SCHEMA_VERSION).toBe(3);
    const db = await open();
    await db.exec('CREATE TABLE dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    await db.exec("CREATE VIRTUAL TABLE chat_fts USING fts5(profile_id UNINDEXED, thread_id UNINDEXED, message_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')");
    await db.exec("INSERT INTO chat_fts VALUES ('p1', 't1', 'm1', 'my zqxjkvbeacon note')");
    await db.exec("INSERT INTO dataset_meta VALUES ('chat-fts-built', '1'), ('period-sky-epoch', '3')");
    await db.exec('PRAGMA user_version=2');
    await migrateDerivedDb(db);
    expect(await db.query('SELECT count(*) AS n FROM chat_fts')).toEqual([{ n: 0 }]);
    await db.exec("INSERT INTO chat_fts (profile_id, thread_id, message_id, text) VALUES ('p1', 't1', 'm2', 'fresh text')");
    expect(await db.query('SELECT message_id, text FROM chat_fts')).toEqual([{ message_id: 'm2', text: null }]);
    expect(await db.query('SELECT key FROM dataset_meta ORDER BY key')).toEqual([{ key: 'period-sky-epoch' }]);
    const hex = Buffer.from('zqxjkvbeacon').toString('hex');
    expect(await db.query('SELECT pgno FROM sqlite_dbpage WHERE instr(lower(hex(data)), ?) > 0', [hex])).toEqual([]);
    expect((await db.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version).toBe(3);
  });

  it('zeroes deleted content and lets a fresh database return freed pages', async () => {
    const db = await open();
    await migrateDerivedDb(db);
    expect(await db.query('PRAGMA secure_delete')).toEqual([{ secure_delete: 1 }]);
    expect(await db.query('PRAGMA auto_vacuum')).toEqual([{ auto_vacuum: 2 }]);
  });

  it('sets and reads back the durability pragmas on every connection', async () => {
    const db = await open();
    await db.exec('PRAGMA synchronous=OFF');
    await migrateDerivedDb(db);
    expect(await db.query('PRAGMA synchronous')).toEqual([{ synchronous: 2 }]);
    // Node opens this fixture in memory; on OPFS the library sets DELETE and refuses anything else.
    expect(await db.query('PRAGMA journal_mode')).toEqual([{ journal_mode: 'memory' }]);
  });

  it('refuses a connection whose durability pragmas did not apply', async () => {
    const db = await open();
    const query = db.query.bind(db);
    const ignoring = Object.assign(Object.create(db) as SqlDatabase, {
      exec: db.exec.bind(db),
      query: ((sql: string, bind?: Parameters<SqlDatabase['query']>[1]) => sql === 'PRAGMA synchronous' ? Promise.resolve([{ synchronous: 1 }]) : query(sql, bind)) as SqlDatabase['query'],
      transaction: db.transaction.bind(db),
    });
    await expect(migrateDerivedDb(ignoring)).rejects.toThrow(/durab/i);
  });

  it('the schema itself refuses malformed period-sky rows', async () => {
    const db = await open();
    await migrateDerivedDb(db);
    const insert = (key: string, profile: string, payload: string, epoch: number) =>
      db.exec('INSERT INTO period_sky (key, engine, profile_id, payload, epoch) VALUES (?, ?, ?, ?, ?)', [key, 'engine', profile, payload, epoch]);
    await insert('ok', 'p1', '{}', 0);
    await expect(insert('', 'p1', '{}', 0)).rejects.toThrow(/CHECK/);
    await expect(insert('k2', '', '{}', 0)).rejects.toThrow(/CHECK/);
    await expect(insert('k3', 'p1', 'not json', 0)).rejects.toThrow(/CHECK/);
    await expect(insert('k4', 'p1', '{}', -1)).rejects.toThrow(/CHECK/);
    expect(await db.query('SELECT key FROM period_sky')).toEqual([{ key: 'ok' }]);
  });

  it('upgrading an older file recreates period_sky with its constraints and keeps the epoch fence', async () => {
    const db = await open();
    await db.exec('CREATE TABLE dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
    await db.exec('CREATE TABLE period_sky (key TEXT PRIMARY KEY, engine TEXT NOT NULL, profile_id TEXT NOT NULL, payload TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0) STRICT');
    await db.exec("INSERT INTO period_sky VALUES ('old', 'engine', '', 'not json', 0)");
    await db.exec("INSERT INTO dataset_meta VALUES ('period-sky-epoch', '4')");
    await db.exec('PRAGMA user_version=2');
    await migrateDerivedDb(db);
    expect(await db.query('SELECT key FROM period_sky')).toEqual([]);
    await expect(db.exec("INSERT INTO period_sky VALUES ('k', 'engine', '', '{}', 0)")).rejects.toThrow(/CHECK/);
    expect(await db.query("SELECT value FROM dataset_meta WHERE key = 'period-sky-epoch'")).toEqual([{ value: '4' }]);
  });

  it('a refused VACUUM on a new file does not block the migration', async () => {
    const db = await open();
    const exec = db.exec.bind(db);
    const refusing = Object.assign(Object.create(db) as SqlDatabase, {
      exec: (sql: string, bind?: Parameters<SqlDatabase['exec']>[1]) => sql === 'VACUUM' ? Promise.reject(new Error('refused')) : exec(sql, bind),
      query: db.query.bind(db),
      transaction: db.transaction.bind(db),
    });
    await migrateDerivedDb(refusing);
    expect((await db.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version).toBe(DERIVED_SCHEMA_VERSION);
  });

  it('migration is atomic and idempotent and retains rows', async () => {
    const db = await open();
    await migrateDerivedDb(db);
    await db.exec("INSERT INTO dataset_meta VALUES ('test', 'kept')");
    await migrateDerivedDb(db);
    expect(await db.query('SELECT value FROM dataset_meta WHERE key=?', ['test'])).toEqual([{ value: 'kept' }]);
  });

  it('refuses a future schema rather than silently downgrading it', async () => {
    const db = await open();
    await db.exec('PRAGMA user_version=999');
    await expect(migrateDerivedDb(db)).rejects.toThrow(/newer/);
    expect((await db.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version).toBe(999);
  });
});

function nativeLocksDouble(): DerivedDbLocks {
  let tail = Promise.resolve();
  return {
    request: (_name, work) => {
      const result = tail.then(work, work);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

/** Real pinned SQLite bytes persist between fake OPFS owners, never shared handles. */
function persistedBackend() {
  let bytes: Uint8Array | undefined;
  let owned = false;
  const openDatabase = vi.fn(async () => {
    if (owned) throw new Error('pool-in-use');
    owned = true;
    const db = await openNodeSqlDatabase({ name: 'derived-session-test' });
    if (bytes) await db.importDatabase(bytes);
    const close = db.close.bind(db);
    db.close = async () => {
      try { bytes = await db.exportDatabase(); }
      finally { await close(); owned = false; }
    };
    return db;
  });
  const removeDatabase = vi.fn(async () => { if (owned) throw new Error('pool-in-use'); bytes = undefined; });
  return { openDatabase, removeDatabase, isOwned: () => owned };
}

describe('short derived database sessions', () => {
  it('bounds waiting for a session lock before opening a Worker', async () => {
    const openDatabase = vi.fn(async () => ({ close: async () => undefined }) as SqlDatabase);
    const session = createDerivedDbSessions({
      openDatabase, removeDatabase: async () => undefined,
      locks: { request: () => new Promise(() => undefined) }, epoch: async () => 0, timeoutMs: 5,
    });
    const lookup = session.withDb(async () => 'must not run').then(() => 'completed', (error: Error) => error.message);
    expect(await Promise.race([lookup, new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 30))])).toMatch(/timed out/);
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('bounds a stalled opener and refuses more opens until it settles', async () => {
    const opening = Promise.withResolvers<SqlDatabase>();
    const openDatabase = vi.fn(() => opening.promise);
    const close = vi.fn(async () => undefined);
    const work = vi.fn(async () => 'must not run');
    const session = createDerivedDbSessions({
      openDatabase, removeDatabase: async () => undefined,
      locks: nativeLocksDouble(), epoch: async () => 0, timeoutMs: 5,
    });
    const first = session.withDb(work).then(() => 'completed', (error: Error) => error.message);
    const outcome = await Promise.race([first, new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 30))]);
    expect(outcome).toMatch(/timed out/);
    await expect(session.withDb(work)).rejects.toThrow(/opening|retry/i);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    opening.resolve({ close } as unknown as SqlDatabase);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('reset cancels a pending opener and closes its late handle without invoking work', async () => {
    const opening = Promise.withResolvers<SqlDatabase>();
    const entered = Promise.withResolvers<void>();
    const close = vi.fn(async () => undefined);
    const work = vi.fn(async () => 'must not run');
    const removeDatabase = vi.fn(async () => undefined);
    const session = createDerivedDbSessions({
      openDatabase: () => { entered.resolve(); return opening.promise; },
      removeDatabase, locks: nativeLocksDouble(), epoch: async () => 0, timeoutMs: 100,
    });
    const first = session.withDb(work).then(() => 'completed', (error: Error) => error.message);
    await entered.promise;
    const reset = session.remove().then(() => 'removed', () => 'refused');
    expect(await Promise.race([first, new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 30))])).toMatch(/reset|changed/i);
    expect(await Promise.race([reset, new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 30))])).toMatch(/removed|refused/);
    opening.resolve({ close } as unknown as SqlDatabase);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });

  it('late-open cleanup does not hold the cross-tab session lock', async () => {
    const opening = Promise.withResolvers<SqlDatabase>();
    const closing = Promise.withResolvers<void>();
    const close = vi.fn(() => closing.promise);
    const session = createDerivedDbSessions({
      openDatabase: () => opening.promise, removeDatabase: async () => undefined,
      locks: nativeLocksDouble(), epoch: async () => 0, timeoutMs: 5,
    });
    const first = session.withDb(async () => 'must not run').then(() => 'completed', (error: Error) => error.message);
    expect(await Promise.race([first, new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 30))])).toMatch(/timed out/);
    opening.resolve({ close } as unknown as SqlDatabase);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reset = session.remove().then(() => 'removed', () => 'refused');
    expect(await Promise.race([reset, new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 30))])).toMatch(/removed|refused/);
    expect(close).toHaveBeenCalledTimes(1);
    closing.resolve();
  });

  it('lets two tab sessions query the same completed city import and releases each owner', async () => {
    const backend = persistedBackend();
    const locks = nativeLocksDouble();
    const dependencies = { ...backend, locks, epoch: async () => 0 };
    const a = createDerivedDbSessions(dependencies);
    const b = createDerivedDbSessions(dependencies);
    const part = vi.fn(async () => [{ n: 'Bogotá', c: 'Colombia', cc: 'CO', lat: 4.6, lon: -74, p: 1 }]);
    const load = async () => ({ version: 'one', parts: [part] });
    const lookup = (session: typeof a) => session.withDb(async (db) => {
      await ensureCitiesImported(db, load);
      return cityRowAt(db, 0);
    });
    const rows = await Promise.all([lookup(a), lookup(b)]);
    expect(rows.map((row) => row?.n)).toEqual(['Bogotá', 'Bogotá']);
    expect(part).toHaveBeenCalledTimes(1);
    expect(backend.openDatabase).toHaveBeenCalledTimes(2);
    expect(backend.isOwned()).toBe(false);
  });

  it('a failed partial import releases its owner and the next session rebuilds the complete version', async () => {
    const backend = persistedBackend();
    const session = createDerivedDbSessions({ ...backend, locks: nativeLocksDouble(), epoch: async () => 0 });
    const row = (n: string) => ({ n, c: 'Spain', cc: 'ES', lat: 0, lon: 0, p: 1 });
    await expect(session.withDb((db) => ensureCitiesImported(db, async () => ({
      version: 'v2', parts: [async () => [row('Partial')], async () => { throw new Error('missing batch'); }],
    })))).rejects.toThrow('missing batch');
    expect(backend.isOwned()).toBe(false);
    await session.withDb(async (db) => {
      await ensureCitiesImported(db, async () => ({ version: 'v2', parts: [async () => [row('Complete')]] }));
      expect((await cityRowAt(db, 0))?.n).toBe('Complete');
      expect(await db.query("SELECT value FROM dataset_meta WHERE key='cities_version'")).toEqual([{ value: 'v2' }]);
      expect(await cityRowAt(db, 1)).toBeUndefined();
    });
  });

  it('reset invalidates work waiting for the lock before it can reopen the database', async () => {
    const backend = persistedBackend();
    let epoch = 0;
    const session = createDerivedDbSessions({ ...backend, locks: nativeLocksDouble(), epoch: async () => epoch });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const first = session.withDb(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const firstRejection = expect(first).rejects.toThrow(/reset|changed/);
    const queued = session.withDb(async () => 'must not run');
    const rejection = expect(queued).rejects.toThrow(/reset|changed/);
    epoch = 1;
    const reset = session.remove();
    finish.resolve();
    await Promise.all([firstRejection, rejection, reset]);
    expect(backend.openDatabase).toHaveBeenCalledTimes(1);
    expect(backend.removeDatabase).toHaveBeenCalledTimes(1);
    expect(backend.isOwned()).toBe(false);
  });

  it('closes a session when its callback exceeds the lifetime bound', async () => {
    const backend = persistedBackend();
    const expireNow: Array<() => void> = [];
    const session = createDerivedDbSessions({
      ...backend, locks: nativeLocksDouble(), epoch: async () => 0,
      deadline: (expire) => { expireNow.push(expire); return () => undefined; },
    });
    const entered = Promise.withResolvers<void>();
    const stuck = session.withDb(async () => { entered.resolve(); return new Promise<void>(() => undefined); });
    await entered.promise;
    expireNow.at(-1)?.();
    await expect(stuck).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(backend.isOwned()).toBe(false));
    await expect(session.withDb(async (db) => (await db.query('SELECT 1 AS n'))[0])).resolves.toEqual({ n: 1 });
  });
});

describe('derived database page lifecycle', () => {
  /** What a healthy OPFS connection answers to the migration's pragma reads. */
  function pragmaAnswer(sql: string): readonly object[] {
    if (sql.startsWith('PRAGMA journal_mode')) return [{ journal_mode: 'delete' }];
    if (sql === 'PRAGMA synchronous') return [{ synchronous: 2 }];
    return [{ user_version: 0 }];
  }

  function databaseDouble() {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const db = {
      close,
      query: vi.fn(async (sql: string) => pragmaAnswer(sql)),
      exec: vi.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
      transaction: async (work: (connection: SqlDatabase) => Promise<unknown>) => work(db as unknown as SqlDatabase),
      storage: { persistence: 'opfs' },
    };
    return { db: db as unknown as SqlDatabase, close };
  }

  function lifecycleSession(overrides: Partial<Parameters<typeof createDerivedDbSessions>[0]> = {}) {
    const lifecycle = new EventTarget();
    const { db, close } = databaseDouble();
    const openDatabase = vi.fn(async () => db);
    const dependencies = {
      openDatabase, removeDatabase: async () => undefined, epoch: async () => 0,
      locks: nativeLocksDouble(), lifecycle, timeoutMs: 1_000,
      ...overrides,
    };
    const session = createDerivedDbSessions(dependencies);
    return { session, lifecycle, openDatabase, close, db };
  }

  async function promptOutcome(result: Promise<unknown>): Promise<unknown> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([result, new Promise((resolve) => {
        timeout = setTimeout(() => resolve('still pending'), 40);
      })]);
    } finally { clearTimeout(timeout); }
  }

  it('pagehide cancels an outer epoch wait before a SQL Worker can open', async () => {
    const epoch = Promise.withResolvers<number>();
    const fixture = lifecycleSession({ epoch: () => epoch.promise });
    const work = vi.fn(async () => 'old work');
    const result = fixture.session.withDb(work).catch((error: unknown) => error);
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    try {
      expect(await promptOutcome(result)).toMatchObject({ name: 'AbortError' });
      expect(fixture.openDatabase).not.toHaveBeenCalled();
    } finally { epoch.resolve(0); await result; }
    expect(fixture.openDatabase).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('pagehide cancels work waiting for its session lock before the callback may run', async () => {
    const lock = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const fixture = lifecycleSession({ locks: { request: (_name, work) => {
      entered.resolve();
      return lock.promise.then(work);
    } } });
    const work = vi.fn(async () => 'old work');
    const result = fixture.session.withDb(work).catch((error: unknown) => error);
    await entered.promise;
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    try {
      expect(await promptOutcome(result)).toMatchObject({ name: 'AbortError' });
    } finally { lock.resolve(); await result; }
    expect(fixture.openDatabase).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('pagehide cancels the inner epoch await after the session lock was acquired', async () => {
    const epoch = Promise.withResolvers<number>();
    const entered = Promise.withResolvers<void>();
    let reads = 0;
    const fixture = lifecycleSession({ epoch: () => {
      if (++reads === 2) { entered.resolve(); return epoch.promise; }
      return Promise.resolve(0);
    } });
    const work = vi.fn(async () => 'old work');
    const result = fixture.session.withDb(work).catch((error: unknown) => error);
    await entered.promise;
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    try {
      expect(await promptOutcome(result)).toMatchObject({ name: 'AbortError' });
    } finally { epoch.resolve(0); await result; }
    expect(fixture.openDatabase).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('rechecks pagehide in the last microtask immediately before the public SQL opener', async () => {
    const epoch = Promise.withResolvers<number>();
    const entered = Promise.withResolvers<void>();
    let reads = 0;
    const fixture = lifecycleSession({ epoch: () => {
      if (++reads === 2) { entered.resolve(); return epoch.promise; }
      return Promise.resolve(0);
    } });
    const result = fixture.session.withDb(async () => 'old work').catch((error: unknown) => error);
    await entered.promise;
    epoch.resolve(0);
    // Promise.race first settles the epoch wait, whose continuation queues
    // the opener. This event runs between that continuation and the opener.
    queueMicrotask(() => queueMicrotask(() => fixture.lifecycle.dispatchEvent(new Event('pagehide'))));
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(fixture.openDatabase).not.toHaveBeenCalled();
  });

  it('refuses new work while hidden, then pageshow permits a new session', async () => {
    const epoch = vi.fn(async () => 0);
    const fixture = lifecycleSession({ epoch });
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    const work = vi.fn(async () => 'fresh work');
    await expect(fixture.session.withDb(work)).rejects.toMatchObject({ name: 'AbortError' });
    expect(epoch).not.toHaveBeenCalled();
    expect(fixture.openDatabase).not.toHaveBeenCalled();
    fixture.lifecycle.dispatchEvent(new Event('pageshow'));
    await expect(fixture.session.withDb(work)).resolves.toBe('fresh work');
    expect(fixture.openDatabase).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('pageshow never revives old epoch work abandoned on pagehide', async () => {
    const epoch = Promise.withResolvers<number>();
    let reads = 0;
    const fixture = lifecycleSession({ epoch: () => ++reads === 1 ? epoch.promise : Promise.resolve(0) });
    const oldWork = vi.fn(async () => 'old work');
    const result = fixture.session.withDb(oldWork).catch((error: unknown) => error);
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    fixture.lifecycle.dispatchEvent(new Event('pageshow'));
    epoch.resolve(0);
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(oldWork).not.toHaveBeenCalled();
    expect(fixture.openDatabase).not.toHaveBeenCalled();
    await expect(fixture.session.withDb(async () => 'new work')).resolves.toBe('new work');
    expect(fixture.openDatabase).toHaveBeenCalledOnce();
  });

  it('closes a late handle after pagehide even when pageshow already restored the document', async () => {
    const opening = Promise.withResolvers<SqlDatabase>();
    const entered = Promise.withResolvers<void>();
    const fixture = lifecycleSession();
    fixture.openDatabase.mockImplementation(() => { entered.resolve(); return opening.promise; });
    const work = vi.fn(async () => 'old work');
    const result = fixture.session.withDb(work).catch((error: unknown) => error);
    await entered.promise;
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    fixture.lifecycle.dispatchEvent(new Event('pageshow'));
    try {
      expect(await promptOutcome(result)).toMatchObject({ name: 'AbortError' });
    } finally { opening.resolve(fixture.db); await result; }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(work).not.toHaveBeenCalled();
    fixture.openDatabase.mockResolvedValue(fixture.db);
    await expect(fixture.session.withDb(async () => 'new work')).resolves.toBe('new work');
    expect(fixture.openDatabase).toHaveBeenCalledTimes(2);
    expect(fixture.close).toHaveBeenCalledTimes(2);
  });

  it('pagehide closes an adopted handle while migration is still awaiting its query', async () => {
    const migration = Promise.withResolvers<Array<{ user_version: number }>>();
    const entered = Promise.withResolvers<void>();
    const fixture = lifecycleSession();
    vi.mocked(fixture.db.query).mockImplementationOnce(() => {
      entered.resolve();
      return migration.promise;
    });
    const work = vi.fn(async () => 'old work');
    const result = fixture.session.withDb(work).catch((error: unknown) => error);
    await entered.promise;
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    try {
      expect(await promptOutcome(result)).toMatchObject({ name: 'AbortError' });
      expect(fixture.close).toHaveBeenCalledOnce();
    } finally {
      migration.resolve([{ user_version: 0 }]);
      await result;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(work).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('rechecks pagehide after the adopted handle epoch settles before starting migration', async () => {
    const epoch = Promise.withResolvers<number>();
    const entered = Promise.withResolvers<void>();
    let reads = 0;
    const fixture = lifecycleSession({ epoch: () => {
      if (++reads === 3) { entered.resolve(); return epoch.promise; }
      return Promise.resolve(0);
    } });
    const work = vi.fn(async () => 'old work');
    const result = fixture.session.withDb(work).catch((error: unknown) => error);
    await entered.promise;
    epoch.resolve(0);
    // The epoch race settles before its await continuation runs. Teardown
    // in between must prevent migration from touching the adopted handle.
    queueMicrotask(() => fixture.lifecycle.dispatchEvent(new Event('pagehide')));
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(fixture.db.query).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('pagehide closes an adopted query and never publishes its late rows after pageshow', async () => {
    const rows = Promise.withResolvers<Array<{ value: string }>>();
    const entered = Promise.withResolvers<void>();
    const fixture = lifecycleSession();
    const publish = vi.fn();
    const result = fixture.session.withDb(async () => {
      entered.resolve();
      return rows.promise;
    }).then(publish).catch((error: unknown) => error);
    await entered.promise;
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    fixture.lifecycle.dispatchEvent(new Event('pageshow'));
    try {
      expect(await promptOutcome(result)).toMatchObject({ name: 'AbortError' });
      expect(fixture.close).toHaveBeenCalledOnce();
    } finally { rows.resolve([{ value: 'old rows' }]); await result; }
    expect(publish).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
    await expect(fixture.session.withDb(async () => 'fresh result')).resolves.toBe('fresh result');
  });

  it('pagehide during close rejects an already computed result and blocks replacement opens', async () => {
    const closing = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const fixture = lifecycleSession();
    fixture.close.mockImplementationOnce(() => { entered.resolve(); return closing.promise; });
    const publish = vi.fn();
    const result = fixture.session.withDb(async () => 'old result').then(publish).catch((error: unknown) => error);
    await entered.promise;
    fixture.lifecycle.dispatchEvent(new Event('pagehide'));
    fixture.lifecycle.dispatchEvent(new Event('pageshow'));
    try {
      await expect(fixture.session.withDb(async () => 'too soon')).rejects.toThrow(/closing|retry/i);
      expect(fixture.openDatabase).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
    } finally { closing.resolve(); }
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(publish).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
    await expect(fixture.session.withDb(async () => 'fresh result')).resolves.toBe('fresh result');
    expect(fixture.openDatabase).toHaveBeenCalledTimes(2);
  });

  async function withBrowserModule(assert: (fixture: {
    module: typeof import('../derivedDb');
    openDatabase: ReturnType<typeof vi.fn<() => Promise<SqlDatabase>>>;
    addListener: { mock: { calls: Parameters<EventTarget['addEventListener']>[] } };
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }) => Promise<void>) {
    const { db, close } = databaseDouble();
    const openDatabase = vi.fn(async () => db);
    const locks = nativeLocksDouble();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: (name: string, options: { signal?: AbortSignal }, work: () => Promise<unknown>) => locks.request(name, work, options.signal),
    } });
    vi.resetModules();
    vi.doMock('@gainratio/browser/sql', () => ({ openSqlDatabase: openDatabase, removeSqlDatabase: async () => undefined }));
    vi.doMock('@almamesh/store', () => ({ readDeletionTombstones: async () => ({ restoreEpoch: 0 }) }));
    const addListener = vi.spyOn(window as EventTarget, 'addEventListener');
    try {
      const module = await import('../derivedDb');
      await assert({ module, openDatabase, addListener, close });
    } finally {
      // Fresh module imports deliberately create document-scoped listeners.
      // Remove this fixture's pair so later tests do not inherit its state.
      for (const [type, listener, options] of addListener.mock.calls) {
        if ((type === 'pagehide' || type === 'pageshow') && listener) window.removeEventListener(type, listener, options);
      }
      addListener.mockRestore();
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
      vi.doUnmock('@gainratio/browser/sql');
      vi.doUnmock('@almamesh/store');
      vi.resetModules();
    }
  }

  it('observes pagehide before the first browser session is requested', async () => {
    await withBrowserModule(async ({ module, openDatabase }) => {
      window.dispatchEvent(new Event('pagehide'));
      await expect(module.withDerivedDb(async () => 'late first work')).rejects.toMatchObject({ name: 'AbortError' });
      expect(openDatabase).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('pageshow'));
      await expect(module.withDerivedDb(async () => 'fresh work')).resolves.toBe('fresh work');
      expect(openDatabase).toHaveBeenCalledOnce();
    });
  });

  it('installs one browser listener pair without opening SQLite and keeps it across sessions', async () => {
    await withBrowserModule(async ({ module, openDatabase, addListener, close }) => {
      const lifecycleCalls = () => addListener.mock.calls.filter(([type]) => type === 'pagehide' || type === 'pageshow');
      expect(lifecycleCalls().map(([type]) => type).sort()).toEqual(['pagehide', 'pageshow']);
      expect(openDatabase).not.toHaveBeenCalled();
      await module.withDerivedDb(async () => 'first');
      await module.withDerivedDb(async () => 'second');
      expect(lifecycleCalls()).toHaveLength(2);
      expect(openDatabase).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
    });
  });

  it('asks the SQL library for an in-memory fallback when OPFS is refused', async () => {
    await withBrowserModule(async ({ module, openDatabase }) => {
      expect(module.derivedDbStorage()).toBe('unknown');
      await module.withDerivedDb(async () => 'first');
      expect(openDatabase).toHaveBeenCalledWith({ name: 'almamesh-derived', persistence: 'opfs', fallback: 'memory' });
      expect(module.derivedDbStorage()).toBe('opfs');
    });
  });
});

describe('derived database refused-OPFS fallback', () => {
  /** A real pinned SQLite handle that reports the library's OPFS-refused fallback. */
  async function refusedOpfsDatabase(): Promise<{ db: SqlDatabase; close: ReturnType<typeof vi.fn> }> {
    const db = await openNodeSqlDatabase({ name: 'derived-memory-fallback' });
    handles.push(db);
    Object.defineProperty(db, 'storage', { value: { persistence: 'memory', reason: 'opfs-unavailable' } });
    const close = vi.fn(async () => undefined);
    Object.defineProperty(db, 'close', { value: close });
    return { db, close };
  }

  it('keeps one in-memory city import for the tab, reports it, and drops it on reset', async () => {
    const first = await refusedOpfsDatabase();
    const second = await refusedOpfsDatabase();
    const openDatabase = vi.fn().mockResolvedValueOnce(first.db).mockResolvedValueOnce(second.db);
    const onStorage = vi.fn();
    const session = createDerivedDbSessions({
      openDatabase, removeDatabase: async () => undefined, locks: nativeLocksDouble(), epoch: async () => 0, onStorage,
    });
    const part = vi.fn(async () => [{ n: 'Lisboa', c: 'Portugal', cc: 'PT', lat: 38.7, lon: -9.1, p: 1 }]);
    const load = async () => ({ version: 'one', parts: [part] });
    const lookup = () => session.withDb(async (db) => {
      await ensureCitiesImported(db, load);
      return (await cityRowAt(db, 0))?.n;
    });

    expect(await lookup()).toBe('Lisboa');
    expect(await lookup()).toBe('Lisboa');
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(part).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(onStorage).toHaveBeenLastCalledWith('memory');

    await session.remove();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(await lookup()).toBe('Lisboa');
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(part).toHaveBeenCalledTimes(2);
  });

  it('still closes an OPFS session handle after each logical operation', async () => {
    const backend = persistedBackend();
    const onStorage = vi.fn();
    const session = createDerivedDbSessions({ ...backend, locks: nativeLocksDouble(), epoch: async () => 0, onStorage });
    await session.withDb(async () => undefined);
    expect(backend.isOwned()).toBe(false);
    expect(onStorage).toHaveBeenLastCalledWith('opfs');
  });
});
