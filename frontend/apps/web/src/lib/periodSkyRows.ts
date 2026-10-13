/** Recomputable personal sky rows. Separate from canonical state and never exported. */
import { devicePolicy } from '@almamesh/browser';
import { readDeletionTombstones, type CachedPredictiveContexts } from '@almamesh/store';

import { withDerivedDb, type DerivedDbAccess, type SqlDatabase } from './derivedDb';
import { isCachedNatalLords, isCachedPeriodReading, isCachedTransitContext } from './periodSkyValidation';

const EPOCH_KEY = 'period-sky-epoch';
const MAX_PAYLOAD_CHARACTERS = 4_000_000;
/** The period row's pointer to its natal row, stored in the period payload JSON and stripped on read. */
const NATAL_REF = 'natal_ref';
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

function parseRecord(text: string): Record<string, unknown> | undefined {
  if (text.length > MAX_PAYLOAD_CHARACTERS) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return plainRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function payloadFromText(text: string): Record<string, unknown> | undefined {
  const value = parseRecord(text);
  if (!value || carriesBootProof(value) || !isCachedTransitContext(value.transit_context)) return undefined;
  for (const field of ['varga_context_full', 'strength_context', 'domains_context']) {
    if (field in value && !plainRecord(value[field])) return undefined;
  }
  if ('period_reading' in value && !isCachedPeriodReading(value.period_reading)) return undefined;
  if (NATAL_REF in value && typeof value[NATAL_REF] !== 'string') return undefined;
  return value;
}

// --- natal split (spec 2026-10-13, "Storage") ---

/** The natal-only parts: identical for every period of one natal chart. */
interface NatalParts {
  readonly varga_context_full?: unknown;
  readonly strength_context?: unknown;
  readonly natal_lords?: unknown;
}

function natalFromText(text: string): NatalParts | undefined {
  const value = parseRecord(text);
  if (!value) return undefined;
  for (const field of ['varga_context_full', 'strength_context']) {
    if (field in value && !plainRecord(value[field])) return undefined;
  }
  return 'natal_lords' in value && !isCachedNatalLords(value.natal_lords) ? undefined : value;
}

/** Split a payload into its period-only row and natal-only parts (undefined when it has none). */
function splitNatal(payload: Record<string, unknown>): { readonly period: Record<string, unknown>; readonly natal?: NatalParts } {
  const { varga_context_full: varga, strength_context: strength, period_reading: reading, ...period } = payload;
  const { natal_lords: lords, ...slice } = plainRecord(reading) ? reading : {};
  const natal = {
    ...(varga === undefined ? {} : { varga_context_full: varga }),
    ...(strength === undefined ? {} : { strength_context: strength }),
    ...(lords === undefined ? {} : { natal_lords: lords }),
  };
  const periodRow = reading === undefined ? period : { ...period, period_reading: plainRecord(reading) ? slice : reading };
  return Object.keys(natal).length === 0 ? { period: periodRow } : { period: periodRow, natal };
}

/** The inverse of splitNatal: callers still see one CachedPredictiveContexts. */
function joinNatal(period: Record<string, unknown>, natal: NatalParts): Record<string, unknown> {
  const { [NATAL_REF]: _ref, period_reading: reading, ...rest } = period;
  const { natal_lords: lords, ...contexts } = natal;
  const joinedReading = reading === undefined ? {} : {
    period_reading: lords === undefined ? reading : { ...(reading as Record<string, unknown>), natal_lords: lords },
  };
  return { ...rest, ...contexts, ...joinedReading };
}

/** Content address of one natal chart's parts, per engine and profile. */
async function natalRef(engineHash: string, profileKey: string, natalText: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([engineHash, profileKey, natalText]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Drop every natal row no period row points at. Runs inside each purge's transaction. */
const ORPHAN_NATAL_SQL = `DELETE FROM period_natal WHERE ref NOT IN (SELECT json_extract(payload, '$.${NATAL_REF}') FROM period_sky WHERE json_extract(payload, '$.${NATAL_REF}') IS NOT NULL)`;

interface PreparedWrite {
  readonly text: string;
  readonly natal?: { readonly ref: string; readonly text: string };
}

async function prepareWrite(engineHash: string, profileKey: string, payload: CachedPredictiveContexts): Promise<PreparedWrite> {
  if (carriesBootProof(payload)) throw new DurableReceiptError();
  const whole = payloadFromText(JSON.stringify(payload));
  if (!whole) throw new Error('The period sky payload is malformed.');
  const { period, natal } = splitNatal(whole);
  if (!natal) return { text: JSON.stringify(period) };
  const natalText = JSON.stringify(natal);
  if (!natalFromText(natalText)) throw new Error('The period sky payload is malformed.');
  const ref = await natalRef(engineHash, profileKey, natalText);
  return { text: JSON.stringify({ ...period, [NATAL_REF]: ref }), natal: { ref, text: natalText } };
}

/** A stored row back to the caller's shape; undefined when it or its natal row is unusable. */
function joinedPayload(row: { readonly payload: string; readonly natal: string | null }): CachedPredictiveContexts | undefined {
  const period = payloadFromText(row.payload);
  if (!period) return undefined;
  if (!(NATAL_REF in period)) return period as unknown as CachedPredictiveContexts;
  const natal = row.natal === null ? undefined : natalFromText(row.natal);
  return natal ? joinNatal(period, natal) as unknown as CachedPredictiveContexts : undefined;
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
      if (clear) {
        await tx.exec('DELETE FROM period_sky');
        await tx.exec('DELETE FROM period_natal');
      } else if (profileKey !== undefined) {
        await tx.exec('DELETE FROM period_sky WHERE profile_id = ?', [profileKey]);
        await tx.exec('DELETE FROM period_natal WHERE profile_id = ?', [profileKey]);
      }
      await tx.exec('DELETE FROM period_sky WHERE epoch <> (SELECT CAST(value AS INTEGER) FROM dataset_meta WHERE key = ?)', [EPOCH_KEY]);
      await tx.exec('DELETE FROM period_natal WHERE epoch <> (SELECT CAST(value AS INTEGER) FROM dataset_meta WHERE key = ?)', [EPOCH_KEY]);
      await tx.exec(ORPHAN_NATAL_SQL);
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
    const found = await conn.query<{ payload: string; natal: string | null }>(
      `SELECT payload, (SELECT n.payload FROM period_natal n WHERE n.ref = json_extract(period_sky.payload, '$.${NATAL_REF}') AND n.epoch = period_sky.epoch) AS natal FROM period_sky WHERE key = ? AND engine = ? AND epoch = ? AND epoch = (SELECT CAST(value AS INTEGER) FROM dataset_meta WHERE key = ?)`,
      [requestKey, engineHash, epoch, EPOCH_KEY],
    );
    if (!found[0]) return undefined;
    const payload = joinedPayload(found[0]);
    if (payload && await accepts(epoch)) return payload;
    await conn.transaction(async (tx) => {
      await tx.exec('DELETE FROM period_sky WHERE key = ? AND engine = ? AND epoch = ?', [requestKey, engineHash, epoch]);
      await tx.exec(ORPHAN_NATAL_SQL);
    });
    return undefined;
  }

  function sweepInDb(db: SqlDatabase, engineHash: string): Promise<number> {
    return db.transaction(async (tx) => {
      const stale = await tx.query<{ n: number }>('SELECT count(*) AS n FROM period_sky WHERE engine <> ?', [engineHash]);
      await tx.exec('DELETE FROM period_sky WHERE engine <> ?', [engineHash]);
      await tx.exec('DELETE FROM period_natal WHERE engine <> ?', [engineHash]);
      await tx.exec(ORPHAN_NATAL_SQL);
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
      // Validate, split and hash before any session: no non-SQL await runs inside a transaction.
      const prepared = await prepareWrite(engineHash, profileKey, payload);
      const epoch = expectedEpoch ?? await captureEpoch();
      if (epoch === undefined || !(await accepts(epoch))) return;
      await withDb(async (db) => {
        if (!(await accepts(epoch))) return;
        await db.transaction(async (tx) => {
          if (prepared.natal) {
            await tx.exec(
              'INSERT OR REPLACE INTO period_natal (ref, engine, profile_id, payload, epoch) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dataset_meta WHERE key = ? AND CAST(value AS INTEGER) = ?)',
              [prepared.natal.ref, engineHash, profileKey, prepared.natal.text, epoch, EPOCH_KEY, epoch],
            );
          }
          await tx.exec(
            'INSERT OR REPLACE INTO period_sky (key, engine, profile_id, payload, epoch) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dataset_meta WHERE key = ? AND CAST(value AS INTEGER) = ?)',
            [requestKey, engineHash, profileKey, prepared.text, epoch, EPOCH_KEY, epoch],
          );
          // INSERT OR REPLACE gives the row a fresh rowid (max + 1), so rowid
          // order is write order: keep the newest maxRows, evict the rest.
          await tx.exec('DELETE FROM period_sky WHERE rowid IN (SELECT rowid FROM period_sky ORDER BY rowid DESC LIMIT -1 OFFSET ?)', [maxRows]);
          // Natal rows are bounded by the period cap: none outlives its last period row.
          await tx.exec(ORPHAN_NATAL_SQL);
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
