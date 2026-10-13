/** Recomputable personal sky rows. Separate from canonical state and never exported. */
import { devicePolicy } from '@almamesh/browser';
import { readDeletionTombstones, type CachedPredictiveContexts } from '@almamesh/store';

import { withDerivedDb, type DerivedDbAccess, type SqlDatabase } from './derivedDb';
import { isCachedTransitContext } from './periodSkyValidation';

const EPOCH_KEY = 'period-sky-epoch';
const MAX_PAYLOAD_CHARACTERS = 4_000_000;
type Ledger = Pick<Awaited<ReturnType<typeof readDeletionTombstones>>, 'activeEpoch' | 'restoreEpoch' | 'restoreInProgress'>;

export class DurableReceiptError extends Error {
  override readonly name = 'DurableReceiptError';
  constructor() { super('A period sky with a boot-signed receipt cannot be stored.'); }
}

export interface PeriodSkyRows {
  /** Fence, optionally sweep, and read within one short database session. */
  lookup(engineHash: string, requestKey: string, sweep: boolean): Promise<{
    readonly epoch: number | undefined;
    readonly hit?: CachedPredictiveContexts;
  }>;
  /** Undefined while the canonical dataset is being replaced or deleted. */
  captureEpoch?(): Promise<number | undefined>;
  read(engineHash: string, requestKey: string, epoch?: number): Promise<CachedPredictiveContexts | undefined>;
  write(engineHash: string, requestKey: string, profileKey: string, payload: CachedPredictiveContexts, epoch?: number): Promise<void>;
  deleteForProfile(profileKey: string): Promise<void>;
  sweepOtherEngines(engineHash: string): Promise<number>;
  clear(): Promise<void>;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function carriesBootProof(payload: object): boolean {
  return 'domain_strength_receipts' in payload || 'strength_signer_public_key' in payload;
}

function payloadFromText(text: string): CachedPredictiveContexts | undefined {
  if (text.length > MAX_PAYLOAD_CHARACTERS) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!plainRecord(value) || carriesBootProof(value) || !isCachedTransitContext(value.transit_context)) return undefined;
    for (const field of ['varga_context_full', 'strength_context', 'domains_context']) {
      if (field in value && !plainRecord(value[field])) return undefined;
    }
    return value as unknown as CachedPredictiveContexts;
  } catch { return undefined; }
}

export function createPeriodSkyRows(
  access: (() => Promise<SqlDatabase>) | DerivedDbAccess,
  options: {
    readonly readLedger?: () => Promise<Ledger>;
    /** Row cap; the oldest-written rows go first. Default: this device tier's cap. */
    readonly maxRows?: number;
  } = {},
): PeriodSkyRows {
  const readLedger = options.readLedger ?? readDeletionTombstones;
  const maxRows = options.maxRows ?? devicePolicy().periodSkyRowCap;
  const withDb: DerivedDbAccess['withDb'] = typeof access === 'function'
    ? async (work) => work(await access()) : (work) => access.withDb(work);

  // The monotonic fence and purge are one transaction in the derived database.
  // A write whose canonical check raced a deletion still fails its SQL condition.
  async function fenceInDb(db: SqlDatabase, epoch: number, profileKey?: string, clear = false): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.exec(
        'INSERT INTO dataset_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(dataset_meta.value AS INTEGER)',
        [EPOCH_KEY, String(epoch)],
      );
      if (clear) await tx.exec('DELETE FROM period_sky');
      else if (profileKey !== undefined) await tx.exec('DELETE FROM period_sky WHERE profile_id = ?', [profileKey]);
      await tx.exec('DELETE FROM period_sky WHERE epoch <> (SELECT CAST(value AS INTEGER) FROM dataset_meta WHERE key = ?)', [EPOCH_KEY]);
    });
  }

  function fence(epoch: number, profileKey?: string, clear = false): Promise<void> {
    return withDb((db) => fenceInDb(db, epoch, profileKey, clear));
  }

  async function captureEpoch(): Promise<number | undefined> {
    const ledger = await readLedger();
    await fence(ledger.restoreEpoch);
    return !ledger.restoreInProgress && ledger.activeEpoch === ledger.restoreEpoch ? ledger.activeEpoch : undefined;
  }

  async function accepts(epoch: number): Promise<boolean> {
    const ledger = await readLedger();
    return !ledger.restoreInProgress && ledger.activeEpoch === epoch && ledger.restoreEpoch === epoch;
  }

  async function readInDb(conn: SqlDatabase, engineHash: string, requestKey: string, epoch: number): Promise<CachedPredictiveContexts | undefined> {
    if (!(await accepts(epoch))) return undefined;
    const found = await conn.query<{ payload: string }>(
      'SELECT payload FROM period_sky WHERE key = ? AND engine = ? AND epoch = ? AND epoch = (SELECT CAST(value AS INTEGER) FROM dataset_meta WHERE key = ?)',
      [requestKey, engineHash, epoch, EPOCH_KEY],
    );
    if (!found[0]) return undefined;
    const payload = payloadFromText(found[0].payload);
    if (payload && await accepts(epoch)) return payload;
    await conn.exec('DELETE FROM period_sky WHERE key = ? AND engine = ? AND epoch = ?', [requestKey, engineHash, epoch]);
    return undefined;
  }

  function sweepInDb(db: SqlDatabase, engineHash: string): Promise<number> {
    return db.transaction(async (tx) => {
      const stale = await tx.query<{ n: number }>('SELECT count(*) AS n FROM period_sky WHERE engine <> ?', [engineHash]);
      await tx.exec('DELETE FROM period_sky WHERE engine <> ?', [engineHash]);
      return stale[0]?.n ?? 0;
    });
  }

  return {
    async lookup(engineHash, requestKey, sweep) {
      const ledger = await readLedger();
      return withDb(async (db) => {
        await fenceInDb(db, ledger.restoreEpoch);
        const epoch = !ledger.restoreInProgress && ledger.activeEpoch === ledger.restoreEpoch ? ledger.activeEpoch : undefined;
        if (epoch === undefined || !(await accepts(epoch))) return { epoch: undefined };
        // A failed sweep/read is a cache miss; a failed epoch fence is not a
        // usable generation. The later write still checks both durable fences.
        if (sweep) await sweepInDb(db, engineHash).catch(() => undefined);
        const hit = await readInDb(db, engineHash, requestKey, epoch).catch(() => undefined);
        return await accepts(epoch) ? { epoch, hit } : { epoch: undefined };
      });
    },
    captureEpoch,
    async read(engineHash, requestKey, expectedEpoch) {
      const epoch = expectedEpoch ?? await captureEpoch();
      if (epoch === undefined || !(await accepts(epoch))) return undefined;
      return withDb((conn) => readInDb(conn, engineHash, requestKey, epoch));
    },
    async write(engineHash, requestKey, profileKey, payload, expectedEpoch) {
      if (carriesBootProof(payload)) throw new DurableReceiptError();
      const text = JSON.stringify(payload);
      if (!payloadFromText(text)) throw new Error('The period sky payload is malformed.');
      const epoch = expectedEpoch ?? await captureEpoch();
      if (epoch === undefined || !(await accepts(epoch))) return;
      await withDb(async (db) => {
        if (!(await accepts(epoch))) return;
        await db.transaction(async (tx) => {
          await tx.exec(
            'INSERT OR REPLACE INTO period_sky (key, engine, profile_id, payload, epoch) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dataset_meta WHERE key = ? AND CAST(value AS INTEGER) = ?)',
            [requestKey, engineHash, profileKey, text, epoch, EPOCH_KEY, epoch],
          );
          // INSERT OR REPLACE gives the row a fresh rowid (max + 1), so rowid
          // order is write order: keep the newest maxRows, evict the rest.
          await tx.exec('DELETE FROM period_sky WHERE rowid IN (SELECT rowid FROM period_sky ORDER BY rowid DESC LIMIT -1 OFFSET ?)', [maxRows]);
        });
      });
    },
    async deleteForProfile(profileKey) {
      await fence((await readLedger()).restoreEpoch, profileKey);
    },
    async sweepOtherEngines(engineHash) {
      return withDb((db) => sweepInDb(db, engineHash));
    },
    async clear() { await fence((await readLedger()).restoreEpoch, undefined, true); },
  };
}

let shared: PeriodSkyRows | undefined;
export function periodSkyRows(): PeriodSkyRows {
  shared ??= createPeriodSkyRows({ withDb: withDerivedDb });
  return shared;
}
