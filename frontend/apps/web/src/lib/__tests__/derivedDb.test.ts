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
    await db.exec("INSERT INTO cities VALUES(7, 'Bogotá', 'Colombia', 'CO', 4.61, -74.08, 100, 'bogota', 'bogota colombia co')");
    await db.exec("INSERT INTO cities_fts(cities_fts) VALUES('rebuild')");
    expect(await db.query("SELECT rowid FROM cities_fts WHERE cities_fts MATCH '" + '"ogot"' + "'")).toEqual([{ rowid: 7 }]);
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
    // The deadline now includes opening/importing this real SQLite fixture.
    const session = createDerivedDbSessions({ ...backend, locks: nativeLocksDouble(), epoch: async () => 0, timeoutMs: 50 });
    await expect(session.withDb(async () => new Promise<void>(() => undefined))).rejects.toThrow(/timed out/);
    expect(backend.isOwned()).toBe(false);
    await expect(session.withDb(async (db) => (await db.query('SELECT 1 AS n'))[0])).resolves.toEqual({ n: 1 });
  });
});
