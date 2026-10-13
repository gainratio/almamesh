import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';

import { migrateDerivedDb, type SqlDatabase } from '../derivedDb';
import { CHAT_FTS_MAX_ROWS, createChatFtsRows, type ChatFtsLedger } from '../chatFtsRows';

const databases: SqlDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

async function fixture(maxRows?: number) {
  const db = await openNodeSqlDatabase({ name: `chat-fts-${crypto.randomUUID()}` });
  databases.push(db);
  await migrateDerivedDb(db);
  const ledger = { profileIds: [] as string[], threadIds: [] as string[], activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false };
  const readLedger = async (): Promise<ChatFtsLedger> => ({ ...ledger });
  const rows = createChatFtsRows(async () => db, { readLedger, maxRows });
  return { db, rows, ledger };
}

function row(id: string, text: string, profile = 'p1', thread = 't1') {
  return { profile_id: profile, thread_id: thread, message_id: id, text };
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
    expect(hits[0]).toMatchObject({ source: 'message', thread_id: 't1' });
    expect(hits[0]?.text).toContain('Saturn');
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
