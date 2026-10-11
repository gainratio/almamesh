/** Recomputable personal sky rows. Separate from canonical state and never exported. */
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
  options: { readonly readLedger?: () => Promise<Ledger> } = {},
): PeriodSkyRows {
  const readLedger = options.readLedger ?? readDeletionTombstones;
  const withDb: DerivedDbAccess['withDb'] = typeof access === 'function'
    ? async (work) => work(await access()) : (work) => access.withDb(work);

  // The monotonic fence and purge are one transaction in the derived database.
  // A write whose canonical check raced a deletion still fails its SQL condition.
  async function fence(epoch: number, profileKey?: string, clear = false): Promise<void> {
    await withDb((db) => db.transaction(async (tx) => {
      await tx.exec(
        'INSERT INTO dataset_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(dataset_meta.value AS INTEGER)',
        [EPOCH_KEY, String(epoch)],
      );
      if (clear) await tx.exec('DELETE FROM period_sky');
      else if (profileKey !== undefined) await tx.exec('DELETE FROM period_sky WHERE profile_id = ?', [profileKey]);
      await tx.exec('DELETE FROM period_sky WHERE epoch <> (SELECT CAST(value AS INTEGER) FROM dataset_meta WHERE key = ?)', [EPOCH_KEY]);
    }));
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

  return {
    captureEpoch,
    async read(engineHash, requestKey, expectedEpoch) {
      const epoch = expectedEpoch ?? await captureEpoch();
      if (epoch === undefined || !(await accepts(epoch))) return undefined;
      return withDb(async (conn) => {
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
      });
    },
    async write(engineHash, requestKey, profileKey, payload, expectedEpoch) {
      if (carriesBootProof(payload)) throw new DurableReceiptError();
      const text = JSON.stringify(payload);
      if (!payloadFromText(text)) throw new Error('The period sky payload is malformed.');
      const epoch = expectedEpoch ?? await captureEpoch();
      if (epoch === undefined || !(await accepts(epoch))) return;
      await withDb(async (db) => {
        if (!(await accepts(epoch))) return;
        await db.exec(
          'INSERT OR REPLACE INTO period_sky (key, engine, profile_id, payload, epoch) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dataset_meta WHERE key = ? AND CAST(value AS INTEGER) = ?)',
          [requestKey, engineHash, profileKey, text, epoch, EPOCH_KEY, epoch],
        );
      });
    },
    async deleteForProfile(profileKey) {
      await fence((await readLedger()).restoreEpoch, profileKey);
    },
    async sweepOtherEngines(engineHash) {
      return withDb((db) => db.transaction(async (tx) => {
        const stale = await tx.query<{ n: number }>('SELECT count(*) AS n FROM period_sky WHERE engine <> ?', [engineHash]);
        await tx.exec('DELETE FROM period_sky WHERE engine <> ?', [engineHash]);
        return stale[0]?.n ?? 0;
      }));
    },
    async clear() { await fence((await readLedger()).restoreEpoch, undefined, true); },
  };
}

let shared: PeriodSkyRows | undefined;
export function periodSkyRows(): PeriodSkyRows {
  shared ??= createPeriodSkyRows({ withDb: withDerivedDb });
  return shared;
}
