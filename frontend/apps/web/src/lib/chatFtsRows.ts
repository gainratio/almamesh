/**
 * Keyword index over chat messages: one SQLite FTS5 row per message in the
 * derived database. It is a cache, rebuildable from the canonical chat store
 * row (SQLite on OPFS stays the only system of record), capped at a fixed row
 * count with the oldest rows evicted first, and purged with its profile,
 * thread or dataset.
 */
import { readDeletionTombstones, readObservedDatasetEpoch, type DeletionTombstones } from '@almamesh/store';

import type { ChatSearchHit } from './chatSearchFusion';
import { searchTerms } from './chatSearchFusion';
import { withDerivedDb, type DerivedDbAccess, type SqlDatabase } from './derivedDb';

/** Default row cap: about 8 MB of text at most, on disk, never in the JS heap. */
export const CHAT_FTS_MAX_ROWS = 2000;
/** Longer messages index their first 4,000 characters. */
const MAX_TEXT_CHARS = 4000;
const BUILT_KEY = 'chat-fts-built';

export type ChatFtsLedger = Pick<DeletionTombstones, 'profileIds' | 'threadIds' | 'activeEpoch' | 'restoreEpoch' | 'restoreInProgress'>;

interface ChatFtsRow {
  readonly profile_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly text: string;
}

export interface ChatFtsRows {
  index(row: ChatFtsRow): Promise<void>;
  /** Replace every row (restore, or the first search after the v2 upgrade). */
  rebuild(rows: readonly ChatFtsRow[]): Promise<void>;
  /** True once a rebuild ran, so an empty index is known to be complete. */
  isBuilt(): Promise<boolean>;
  /** Best bm25 matches first, only for `profileId`. */
  search(query: string, profileId: string, k: number): Promise<readonly ChatSearchHit[]>;
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
  const purge = (sql: string, binds: readonly string[]): Promise<void> => withDb(async (db) => { await db.exec(sql, [...binds]); });

  return {
    // The ledger is read inside the write transaction, under the derived
    // session lock. A delete records its tombstone before it purges, and the
    // purge waits for this transaction: a write either commits before the
    // purge (which then removes it) or sees the tombstone and drops itself.
    async index(row) {
      const generation = observedGeneration();
      await withDb((db) => db.transaction(async (tx) => {
        const ledger = await readLedger();
        if (!fenceOpen(ledger, generation) || !live(ledger, row)) return;
        await insert(tx, row);
        await evict(tx, maxRows);
      }));
    },
    async rebuild(rows) {
      const generation = observedGeneration();
      await withDb((db) => db.transaction(async (tx) => {
        const ledger = await readLedger();
        if (!fenceOpen(ledger, generation)) return;
        await tx.exec('DELETE FROM chat_fts');
        for (const row of rows) if (live(ledger, row)) await insert(tx, row);
        await evict(tx, maxRows);
        await tx.exec('INSERT OR REPLACE INTO dataset_meta (key, value) VALUES (?, ?)', [BUILT_KEY, '1']);
      }));
    },
    isBuilt: () => withDb(async (db) => (await db.query('SELECT 1 FROM dataset_meta WHERE key = ?', [BUILT_KEY])).length > 0),
    async search(query, profileId, k) {
      const expression = matchExpression(query);
      if (expression === undefined || k <= 0) return [];
      const found = await withDb((db) => db.query<{ thread_id: string; message_id: string; text: string; rank: number }>(
        "SELECT thread_id, message_id, snippet(chat_fts, 3, '', '', '…', 32) AS text, bm25(chat_fts) AS rank FROM chat_fts WHERE chat_fts MATCH ? AND profile_id = ? ORDER BY rank LIMIT ?",
        [expression, profileId, Math.floor(k)],
      ));
      return found.map((hit) => ({ source: 'message' as const, thread_id: hit.thread_id, message_id: hit.message_id, text: hit.text, score: -hit.rank }));
    },
    deleteForProfile: (profileId) => purge('DELETE FROM chat_fts WHERE profile_id = ?', [profileId]),
    deleteForThread: (threadId) => purge('DELETE FROM chat_fts WHERE thread_id = ?', [threadId]),
    // Dropping the marker makes the next search backfill from canonical chat.
    clear: () => withDb((db) => db.transaction(async (tx) => {
      await tx.exec('DELETE FROM chat_fts');
      await tx.exec('DELETE FROM dataset_meta WHERE key = ?', [BUILT_KEY]);
    })),
  };
}

let shared: ChatFtsRows | undefined;
export function chatFtsRows(): ChatFtsRows {
  shared ??= createChatFtsRows({ withDb: withDerivedDb });
  return shared;
}
