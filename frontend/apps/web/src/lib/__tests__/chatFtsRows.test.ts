import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';

import { migrateDerivedDb, type SqlDatabase } from '../derivedDb';
import { CHAT_FTS_MAX_ROWS, createChatFtsRows, type ChatFtsLedger } from '../chatFtsRows';
import { failingAt } from './failingSql';

const databases: SqlDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

async function fixture(maxRows?: number) {
  const db = await openNodeSqlDatabase({ name: `chat-fts-${crypto.randomUUID()}` });
  databases.push(db);
  await migrateDerivedDb(db);
  const ledger = { profileIds: [] as string[], threadIds: [] as string[], activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false };
  const readLedger = async (): Promise<ChatFtsLedger> => ({ ...ledger });
  const rows = createChatFtsRows(async () => db, { readLedger, generation: () => 0, maxRows });
  return { db, rows, ledger };
}

function row(id: string, text: string, profile = 'p1', thread = 't1') {
  return { profile_id: profile, thread_id: thread, message_id: id, text };
}

/** The secret is lowercase so FTS5 keeps it as one term, and shares no prefix with the filler. */
const SECRET = 'zqxjkvbeacon';
const secretHex = Buffer.from(SECRET).toString('hex');

function holdsSecret(value: unknown): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(SECRET);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex').includes(secretHex);
  return false;
}

/** Every shadow-table cell and every database page (free pages included) that still holds the secret. */
async function traces(db: SqlDatabase): Promise<readonly string[]> {
  const found: string[] = [];
  const shadows = await db.query<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'chat_fts_%'");
  for (const { name } of shadows) {
    const rows = await db.query(`SELECT * FROM "${name}"`);
    if (rows.some((cells) => Object.values(cells).some(holdsSecret))) found.push(name);
  }
  const pages = await db.query<{ pgno: number }>('SELECT pgno FROM sqlite_dbpage WHERE instr(lower(hex(data)), ?) > 0', [secretHex]);
  return [...found, ...pages.map(({ pgno }) => `page ${pgno}`)];
}

async function seedSecret(rows: ReturnType<typeof createChatFtsRows>): Promise<void> {
  for (let i = 0; i < 40; i += 1) await rows.index(row(`keep${i}`, 'alpha bravo charlie delta', 'p2', 't2'));
  await rows.index(row('secret', `my ${SECRET} note`, 'p1', 't1'));
}

async function count(db: SqlDatabase): Promise<number> {
  return (await db.query<{ n: number }>('SELECT count(*) AS n FROM chat_fts'))[0]?.n ?? 0;
}

describe('chat keyword index (SQLite FTS5)', () => {
  it('pins a bounded default row cap', () => {
    expect(CHAT_FTS_MAX_ROWS).toBe(2000);
  });

  it('finds a message by keyword and ranks the denser match first (bm25)', async () => {
    const { rows } = await fixture();
    await rows.index(row('m1', 'Your career looks steady this year.'));
    await rows.index(row('m2', 'Saturn returns. Saturn slows career, Saturn rewards patience.'));
    await rows.index(row('m3', 'Venus favours love.'));
    const hits = await rows.search('saturn', 'p1', 8);
    expect(hits.map((hit) => hit.message_id)).toEqual(['m2']);
    expect(hits[0]).toMatchObject({ thread_id: 't1' });
    expect(hits[0]?.score).toBeGreaterThan(0);
    const career = await rows.search('saturn career', 'p1', 8);
    expect(career.map((hit) => hit.message_id)).toEqual(['m2', 'm1']);
  });

  it('matches a typed prefix and ignores case and accents', async () => {
    const { rows } = await fixture();
    await rows.index(row('m1', 'Tu carrera mejora en Júpiter.'));
    expect((await rows.search('JUPI', 'p1', 8)).map((hit) => hit.message_id)).toEqual(['m1']);
  });

  it('treats FTS syntax in the query as plain words', async () => {
    const { rows } = await fixture();
    await rows.index(row('m1', 'near the moon'));
    await expect(rows.search('"moon* AND NEAR(', 'p1', 8)).resolves.toHaveLength(1);
    await expect(rows.search('***', 'p1', 8)).resolves.toEqual([]);
  });

  it('only returns rows of the requested profile', async () => {
    const { rows } = await fixture();
    await rows.index(row('mine', 'moon in cancer', 'p1'));
    await rows.index(row('theirs', 'moon in cancer', 'p2', 't2'));
    expect((await rows.search('moon', 'p2', 8)).map((hit) => hit.message_id)).toEqual(['theirs']);
  });

  it('re-indexing a message replaces its row', async () => {
    const { db, rows } = await fixture();
    await rows.index(row('m1', 'first draft about mars'));
    await rows.index(row('m1', 'final answer about mars'));
    expect(await count(db)).toBe(1);
    expect((await rows.search('final', 'p1', 8)).map((hit) => hit.message_id)).toEqual(['m1']);
  });

  it('evicts the oldest rows beyond the cap', async () => {
    const { db, rows } = await fixture(2);
    await rows.index(row('old', 'rahu one'));
    await rows.index(row('mid', 'rahu two'));
    await rows.index(row('new', 'rahu three'));
    expect(await count(db)).toBe(2);
    expect((await rows.search('rahu', 'p1', 8)).map((hit) => hit.message_id).sort()).toEqual(['mid', 'new']);
  });

  it('refuses to index a deleted profile or thread, or during a restore', async () => {
    const { db, rows, ledger } = await fixture();
    ledger.profileIds = ['gone'];
    ledger.threadIds = ['dead'];
    await rows.index(row('a', 'ketu', 'gone', 't9'));
    await rows.index(row('b', 'ketu', 'p1', 'dead'));
    ledger.restoreInProgress = true;
    await rows.index(row('c', 'ketu'));
    expect(await count(db)).toBe(0);
  });

  describe('a write queued before a delete (TOCTOU)', () => {
    /** The first connection waits for `release`; later ones (the purge) open at once. */
    async function heldFixture() {
      const db = await openNodeSqlDatabase({ name: `chat-fts-${crypto.randomUUID()}` });
      databases.push(db);
      await migrateDerivedDb(db);
      const ledger = { profileIds: [] as string[], threadIds: [] as string[], activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false };
      const held = Promise.withResolvers<void>();
      let opens = 0;
      const access = async () => { if (opens++ === 0) await held.promise; return db; };
      const rows = createChatFtsRows(access, { readLedger: async () => ({ ...ledger }), generation: () => 0 });
      return { db, rows, ledger, release: held.resolve };
    }

    it('drops the write when its profile is deleted before it commits', async () => {
      const { db, rows, ledger, release } = await heldFixture();
      const write = rows.index(row('m1', 'zebraquux secret', 'p1', 't1'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      ledger.profileIds = ['p1'];
      await rows.deleteForProfile('p1');
      release();
      await write;
      expect(await count(db)).toBe(0);
    });

    it('drops the write when its thread is deleted before it commits', async () => {
      const { db, rows, ledger, release } = await heldFixture();
      const write = rows.index(row('m1', 'zebraquux secret', 'p1', 't1'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      ledger.threadIds = ['t1'];
      await rows.deleteForThread('t1');
      release();
      await write;
      expect(await count(db)).toBe(0);
    });

    it('drops the write when the dataset generation moves before it commits', async () => {
      const { db, rows, ledger, release } = await heldFixture();
      const write = rows.index(row('m1', 'zebraquux secret', 'p1', 't1'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      ledger.activeEpoch = 1;
      ledger.restoreEpoch = 1;
      await rows.clear();
      release();
      await write;
      expect(await count(db)).toBe(0);
    });

    it('drops a rebuild row whose profile is deleted before the rebuild commits', async () => {
      const { db, rows, ledger, release } = await heldFixture();
      const write = rows.rebuild([row('m1', 'zebraquux secret', 'p1', 't1'), row('m2', 'kept', 'p2', 't2')]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      ledger.profileIds = ['p1'];
      await rows.deleteForProfile('p1');
      release();
      await write;
      expect(await db.query('SELECT message_id FROM chat_fts')).toEqual([{ message_id: 'm2' }]);
    });
  });

  it('refuses a write from a tab that observed an older dataset generation', async () => {
    const { db, ledger } = await fixture();
    ledger.activeEpoch = 2;
    ledger.restoreEpoch = 2;
    const stale = createChatFtsRows(async () => db, { readLedger: async () => ({ ...ledger }), generation: () => 1 });
    await stale.index(row('m1', 'zebraquux secret'));
    expect(await count(db)).toBe(0);
  });

  it('a rebuild from an older generation leaves the index as it was', async () => {
    const { db, rows, ledger } = await fixture();
    await rows.index(row('m1', 'current generation'));
    ledger.activeEpoch = 1;
    ledger.restoreEpoch = 1;
    await rows.rebuild([row('old', 'stale snapshot')]);
    expect(await db.query('SELECT message_id FROM chat_fts')).toEqual([{ message_id: 'm1' }]);
    expect(await rows.isBuilt()).toBe(false);
  });

  it('keeps no message text in the derived database, only the index terms', async () => {
    const { db, rows } = await fixture();
    await rows.index(row('m1', `my ${SECRET} note`));
    expect(await db.query('SELECT message_id, text FROM chat_fts')).toEqual([{ message_id: 'm1', text: null }]);
    expect((await rows.search(SECRET, 'p1', 8)).map((hit) => hit.message_id)).toEqual(['m1']);
  });

  describe('a purge leaves no trace of the deleted text (remanence)', () => {
    it('after a profile purge', async () => {
      const { db, rows } = await fixture();
      await seedSecret(rows);
      expect(await traces(db)).not.toEqual([]);
      await rows.deleteForProfile('p1');
      expect(await traces(db)).toEqual([]);
      expect(await count(db)).toBe(40);
    });

    it('after a thread purge', async () => {
      const { db, rows } = await fixture();
      await seedSecret(rows);
      await rows.deleteForThread('t1');
      expect(await traces(db)).toEqual([]);
      expect(await count(db)).toBe(40);
    });

    it('after clearing the whole index', async () => {
      const { db, rows } = await fixture();
      await seedSecret(rows);
      await rows.clear();
      expect(await traces(db)).toEqual([]);
    });
  });

  describe('every write is one transaction (atomic)', () => {
    const quietLedger = async (): Promise<ChatFtsLedger> => ({ profileIds: [], threadIds: [], activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false });

    it('an index write that fails after its insert persists nothing', async () => {
      const { db } = await fixture();
      const rows = createChatFtsRows(async () => failingAt(db, /ORDER BY rowid DESC LIMIT -1/), { readLedger: quietLedger, generation: () => 0 });
      await expect(rows.index(row('m1', 'half written'))).rejects.toThrow(/injected/);
      expect(await count(db)).toBe(0);
    });

    it('a purge that fails at optimize keeps every row, so the caller sees the failure and retries', async () => {
      const { db, rows } = await fixture();
      await rows.index(row('a', 'sun', 'p1', 't1'));
      await rows.index(row('b', 'sun', 'p2', 't2'));
      const failing = createChatFtsRows(async () => failingAt(db, /'optimize'/), { readLedger: quietLedger, generation: () => 0 });
      await expect(failing.deleteForProfile('p1')).rejects.toThrow(/injected/);
      expect(await count(db)).toBe(2);
    });

    it('a rebuild that fails before its marker keeps the old rows and stays unbuilt', async () => {
      const { db, rows } = await fixture();
      await rows.index(row('old', 'mercury'));
      const failing = createChatFtsRows(async () => failingAt(db, /dataset_meta/), { readLedger: quietLedger, generation: () => 0 });
      await expect(failing.rebuild([row('new', 'mars')])).rejects.toThrow(/injected/);
      expect(await db.query('SELECT message_id FROM chat_fts')).toEqual([{ message_id: 'old' }]);
      expect(await rows.isBuilt()).toBe(false);
    });
  });

  it('purges by profile, by thread, and entirely', async () => {
    const { db, rows } = await fixture();
    await rows.index(row('a', 'sun', 'p1', 't1'));
    await rows.index(row('b', 'sun', 'p1', 't2'));
    await rows.index(row('c', 'sun', 'p2', 't3'));
    await rows.deleteForThread('t2');
    expect((await db.query('SELECT message_id FROM chat_fts ORDER BY message_id'))).toEqual([{ message_id: 'a' }, { message_id: 'c' }]);
    await rows.deleteForProfile('p1');
    expect((await db.query('SELECT message_id FROM chat_fts'))).toEqual([{ message_id: 'c' }]);
    await rows.clear();
    expect(await count(db)).toBe(0);
  });

  it('rebuild replaces every row from durable chat', async () => {
    const { db, rows } = await fixture();
    await rows.index(row('stale', 'mercury'));
    await rows.rebuild([row('m1', 'mercury retrograde'), row('m2', '   '), row('m3', 'mars', 'p2', 't2')]);
    expect((await db.query('SELECT message_id FROM chat_fts ORDER BY message_id'))).toEqual([{ message_id: 'm1' }, { message_id: 'm3' }]);
    expect(await rows.isBuilt()).toBe(true);
  });

  it('reports an empty, never-built index so callers can backfill it once', async () => {
    const { rows } = await fixture();
    expect(await rows.isBuilt()).toBe(false);
    await rows.rebuild([]);
    expect(await rows.isBuilt()).toBe(true);
  });
});
