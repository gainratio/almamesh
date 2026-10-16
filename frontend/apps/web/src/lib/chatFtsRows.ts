/**
 * Keyword index over chat messages: one SQLite FTS5 row per message in the
 * derived database. It is a cache, rebuildable from the canonical chat store
 * row (SQLite on OPFS stays the only system of record), capped at a fixed row
 * count with the oldest rows evicted first, and purged with its profile,
 * thread or dataset.
 *
 * The table is contentless (derivedDb.ts): it holds index terms and ids, never
 * the message text. Search returns ids and scores; the caller reads the text
 * from the canonical chat store.
 */
import { readDeletionTombstones, readObservedDatasetEpoch, type DeletionTombstones } from '@almamesh/store';

import { searchTerms } from './chatSearchFusion';
import { CHAT_FTS_BUILT_KEY, withDerivedDb, type DerivedDbAccess, type SqlDatabase } from './derivedDb';

/** Default row cap: about 8 MB of index at most, on disk, never in the JS heap. */
export const CHAT_FTS_MAX_ROWS = 2000;
/** Longer messages index their first 4,000 characters. */
const MAX_TEXT_CHARS = 4000;

export type ChatFtsLedger = Pick<DeletionTombstones, 'profileIds' | 'threadIds' | 'activeEpoch' | 'restoreEpoch' | 'restoreInProgress'>;

interface ChatFtsRow {
  readonly profile_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly text: string;
}

/** One bm25 match: which message, and how well it matched (higher is better). */
export interface ChatKeywordHit {
  readonly thread_id: string;
  readonly message_id: string;
  readonly score: number;
}

export interface ChatFtsRows {
  index(row: ChatFtsRow): Promise<void>;
  /** Replace every row (restore, or the first search after the upgrade). */
  rebuild(rows: readonly ChatFtsRow[]): Promise<void>;
  /** True once a rebuild ran, so an empty index is known to be complete. */
  isBuilt(): Promise<boolean>;
  /** Best bm25 matches first, only for `profileId`. */
  search(query: string, profileId: string, k: number): Promise<readonly ChatKeywordHit[]>;
  deleteForProfile(profileId: string): Promise<void>;
  deleteForThread(threadId: string): Promise<void>;
  clear(): Promise<void>;
}

/** Quoted prefix terms: FTS operators typed by the user are plain words. */
function matchExpression(query: string): string | undefined {
  const terms = searchTerms(query);
  return terms.length === 0 ? undefined : terms.map((term) => `"${term}"*`).join(' OR ');
}

/** The vector store's write fence: no restore running, and this tab's generation is still the active one. */
function fenceOpen(ledger: ChatFtsLedger, generation: number): boolean {
  return !ledger.restoreInProgress && ledger.activeEpoch === generation && ledger.restoreEpoch === generation;
}

function live(ledger: ChatFtsLedger, row: ChatFtsRow): boolean {
  return !ledger.profileIds.includes(row.profile_id) && !ledger.threadIds.includes(row.thread_id) && row.text.trim().length > 0;
}

/** The statement surface shared by a connection and its transaction. */
type SqlExec = Pick<SqlDatabase, 'exec'>;

async function insert(db: SqlExec, row: ChatFtsRow): Promise<void> {
  await db.exec('DELETE FROM chat_fts WHERE message_id = ?', [row.message_id]);
  await db.exec(
    'INSERT INTO chat_fts (profile_id, thread_id, message_id, text) VALUES (?, ?, ?, ?)',
    [row.profile_id, row.thread_id, row.message_id, row.text.slice(0, MAX_TEXT_CHARS)],
  );
}

/** A fresh INSERT takes rowid max + 1, so rowid order is write order. */
async function evict(db: SqlExec, maxRows: number): Promise<void> {
  await db.exec('DELETE FROM chat_fts WHERE rowid IN (SELECT rowid FROM chat_fts ORDER BY rowid DESC LIMIT -1 OFFSET ?)', [maxRows]);
}

/**
 * A contentless-delete FTS5 DELETE only marks the row deleted; its terms stay
 * in the old index segments until a merge. 'optimize' merges every segment
 * into one without the deleted rows, secure_delete (derivedDb.ts) zeroes the
 * freed bytes, and incremental_vacuum returns the freed pages to the OS where
 * auto_vacuum is on.
 */
async function forget(db: SqlExec): Promise<void> {
  await db.exec("INSERT INTO chat_fts(chat_fts) VALUES('optimize')");
  await db.exec('PRAGMA incremental_vacuum');
}

export function createChatFtsRows(
  access: (() => Promise<SqlDatabase>) | DerivedDbAccess,
  options: {
    readonly readLedger?: () => Promise<ChatFtsLedger>;
    /** The dataset generation this tab observed (the vector store's fence). */
    readonly generation?: () => number;
    readonly maxRows?: number;
  } = {},
): ChatFtsRows {
  const readLedger = options.readLedger ?? readDeletionTombstones;
  const observedGeneration = options.generation ?? readObservedDatasetEpoch;
  const maxRows = options.maxRows ?? CHAT_FTS_MAX_ROWS;
  const withDb: DerivedDbAccess['withDb'] = typeof access === 'function'
    ? async (work) => work(await access()) : (work) => access.withDb(work);

  /**
   * The ledger is read inside the derived session (one session at a time,
   * across tabs: derivedDb.ts), then the statements run in one transaction,
   * the same shape as the period-sky writes. A delete records its tombstone
   * before it purges, and its purge is a session too: a write either ends
   * before the purge starts (and is purged) or reads the tombstone and drops
   * itself.
   */
  function fencedWrite(write: (tx: SqlExec, ledger: ChatFtsLedger) => Promise<void>): Promise<void> {
    const generation = observedGeneration();
    return withDb(async (db) => {
      const ledger = await readLedger();
      if (!fenceOpen(ledger, generation)) return;
      await db.transaction((tx) => write(tx, ledger));
    });
  }

  function purge(statements: readonly (readonly [string, readonly string[]])[]): Promise<void> {
    return withDb((db) => db.transaction(async (tx) => {
      for (const [sql, binds] of statements) await tx.exec(sql, [...binds]);
      await forget(tx);
    }));
  }

  return {
    index: (row) => fencedWrite(async (tx, ledger) => {
      if (!live(ledger, row)) return;
      await insert(tx, row);
      await evict(tx, maxRows);
    }),
    rebuild: (rows) => fencedWrite(async (tx, ledger) => {
      await tx.exec('DELETE FROM chat_fts');
      for (const row of rows) if (live(ledger, row)) await insert(tx, row);
      await evict(tx, maxRows);
      await forget(tx);
      await tx.exec('INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)', [CHAT_FTS_BUILT_KEY, '1']);
    }),
    isBuilt: () => withDb(async (db) => (await db.query('SELECT 1 FROM dataset_meta WHERE key = ?', [CHAT_FTS_BUILT_KEY])).length > 0),
    async search(query, profileId, k) {
      const expression = matchExpression(query);
      if (expression === undefined || k <= 0) return [];
      const found = await withDb((db) => db.query<{ thread_id: string; message_id: string; rank: number }>(
        'SELECT thread_id, message_id, bm25(chat_fts) AS rank FROM chat_fts WHERE chat_fts MATCH ? AND profile_id = ? ORDER BY rank LIMIT ?',
        [expression, profileId, Math.floor(k)],
      ));
      return found.map((hit) => ({ thread_id: hit.thread_id, message_id: hit.message_id, score: -hit.rank }));
    },
    deleteForProfile: (profileId) => purge([['DELETE FROM chat_fts WHERE profile_id = ?', [profileId]]]),
    deleteForThread: (threadId) => purge([['DELETE FROM chat_fts WHERE thread_id = ?', [threadId]]]),
    // Dropping the marker makes the next search backfill from canonical chat.
    clear: () => purge([['DELETE FROM chat_fts', []], ['DELETE FROM dataset_meta WHERE key = ?', [CHAT_FTS_BUILT_KEY]]]),
  };
}

let shared: ChatFtsRows | undefined;
export function chatFtsRows(): ChatFtsRows {
  shared ??= createChatFtsRows({ withDb: withDerivedDb });
  return shared;
}
