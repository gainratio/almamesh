import { afterEach, describe, expect, it, vi } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import type { SqlBind, SqlRow } from '@gainratio/browser/sql';
import { predictiveRequestKey, type CachedPredictiveContexts } from '@almamesh/store';
import type { PredictiveContexts } from '@almamesh/browser';

import { createDerivedDbSessions, migrateDerivedDb, type SqlDatabase } from '../derivedDb';
import { createPeriodSkyCache } from '../periodSky';
import { createPeriodSkyRows, DurableReceiptError } from '../periodSkyRows';
import { failingAt } from './failingSql';
import { devicePolicy } from '@almamesh/browser';

const databases: SqlDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

async function fixture() {
  const db = await openNodeSqlDatabase({ name: `sky-${crypto.randomUUID()}` });
  databases.push(db);
  await migrateDerivedDb(db);
  const ledger = { activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false };
  const rows = createPeriodSkyRows(async () => db, { readLedger: async () => ({ ...ledger }) });
  return { db, rows, ledger };
}
const PAYLOAD = {
  transit_context: {
    instant: '2019-03-14T00:00:00Z',
    gochara: { instant: '2019-03-14T00:00:00Z', transit_ayanamsa: 24, placements: {} },
    sade_sati: { is_active: false, current_phase: 'none', natal_moon_sign: 'Aries', cycle: [], cycle_start: null, cycle_end: null },
    slow_hits: [],
    fusion: { instant: '2019-03-14T00:00:00Z', maha_lord: 'rahu', antar_lord: null, maha_lord_transit_house_from_moon: 1, maha_lord_transit_house_from_lagna: 1, reinforcing: [], afflicting: [], net_weight: 0, severity: 'neutral' },
    timeline: { window_start: '2019-03-14T00:00:00Z', window_end: '2020-03-14T00:00:00Z', events: [] },
  },
} as unknown as CachedPredictiveContexts;

describe('period sky durable rows', () => {
  it('combines the epoch fence, initial engine sweep and cache read in one session', async () => {
    const { db, ledger, rows } = await fixture();
    await rows.write('old', 'old-key', 'p1', PAYLOAD);
    await rows.write('new', 'key', 'p2', PAYLOAD);
    await db.exec("INSERT INTO cities VALUES (1, 'Delhi', 'India', 'IN', 28.6, 77.2, 1, 'delhi', 'delhi india in')");
    const entered = vi.fn();
    const combined = createPeriodSkyRows({ withDb: async (work) => {
      entered(); return work(db);
    } }, { readLedger: async () => ({ ...ledger }) });

    await expect(combined.lookup('new', 'key', true)).resolves.toEqual({ epoch: 0, hit: PAYLOAD });
    expect(entered).toHaveBeenCalledTimes(1);
    expect(await db.query('SELECT key FROM period_sky')).toEqual([{ key: 'key' }]);
    expect(await db.query('SELECT idx FROM cities')).toEqual([{ idx: 1 }]);
  });

  it('closes one precompute session before engine work and opens a separate session for the fenced write', async () => {
    let bytes: Uint8Array | undefined;
    let owned = false;
    const closed = vi.fn();
    const openDatabase = vi.fn(async () => {
      expect(owned).toBe(false);
      const db = await openNodeSqlDatabase({ name: 'period-session-batching' });
      owned = true;
      if (bytes) await db.importDatabase(bytes);
      const close = db.close.bind(db);
      db.close = async () => {
        try { bytes = await db.exportDatabase(); }
        finally { await close(); owned = false; closed(); }
      };
      return db;
    });
    let tail = Promise.resolve();
    const sessions = createDerivedDbSessions({
      openDatabase,
      removeDatabase: async () => undefined,
      epoch: async () => 0,
      locks: { request: (_name, work) => {
        const run = tail.then(work);
        tail = run.then(() => undefined, () => undefined);
        return run;
      } },
    });
    const rows = createPeriodSkyRows(sessions, {
      readLedger: async () => ({ activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false }),
    });
    const input = { profileKey: 'p1', datetimeUtc: '1990-01-15T12:00:00Z', latitude: 28.6, longitude: 77.2,
      referenceInstant: '2019-03-14T00:00:00Z', utcOffsetMinutes: 330 };
    const runtime = { identity: () => 'new', computePredictive: vi.fn(async () => {
      expect(owned).toBe(false);
      expect(openDatabase).toHaveBeenCalledTimes(1);
      expect(closed).toHaveBeenCalledTimes(1);
      return PAYLOAD as PredictiveContexts;
    }) };
    await createPeriodSkyCache({ rows, readStore: () => ({ status: 'idle' }) }).load(input, runtime, new AbortController().signal);
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(2);
    expect(owned).toBe(false);
    await expect(rows.read('new', predictiveRequestKey(input), 0)).resolves.toEqual(PAYLOAD);
  });

  it('rejects a stale lookup after waiting for its session, even if old derived rows remain', async () => {
    const { db, rows, ledger } = await fixture();
    await rows.write('a', 'key', 'p1', PAYLOAD);
    const waiting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const combined = createPeriodSkyRows({ withDb: async (work) => {
      waiting.resolve(); await resume.promise; return work(db);
    } }, { readLedger: async () => ({ ...ledger }) });
    const lookup = combined.lookup('a', 'key', true);
    await waiting.promise;
    ledger.restoreEpoch = 1;
    ledger.activeEpoch = 1;
    resume.resolve();
    await expect(lookup).resolves.toEqual({ epoch: undefined });
  });

  it('fences old rows during a restore without making them available to the compute cache', async () => {
    const { db, rows, ledger } = await fixture();
    await rows.write('a', 'key', 'p1', PAYLOAD);
    ledger.restoreEpoch = 1;
    ledger.restoreInProgress = true;
    await expect(rows.lookup('a', 'key', true)).resolves.toEqual({ epoch: undefined });
    expect(await db.query('SELECT key FROM period_sky')).toEqual([]);
    expect(await db.query('SELECT value FROM dataset_meta WHERE key = ?', ['period-sky-epoch'])).toEqual([{ value: '1' }]);
  });

  it('rejects a cached hit if the canonical epoch advances after its SQL read', async () => {
    const { db, rows, ledger } = await fixture();
    await rows.write('a', 'key', 'p1', PAYLOAD);
    const query = db.query.bind(db);
    db.query = async <R extends SqlRow>(sql: string, parameters?: SqlBind) => {
      const result = await query<R>(sql, parameters);
      if (sql.startsWith('SELECT payload')) {
        ledger.restoreEpoch = 1;
        ledger.activeEpoch = 1;
      }
      return result;
    };
    await expect(rows.lookup('a', 'key', false)).resolves.toEqual({ epoch: undefined });
  });

  it('does not repopulate a profile deleted during the compute between its lookup and write', async () => {
    const { db, rows, ledger } = await fixture();
    const input = { profileKey: 'p1', datetimeUtc: '1990-01-15T12:00:00Z', latitude: 28.6, longitude: 77.2,
      referenceInstant: '2019-03-14T00:00:00Z', utcOffsetMinutes: 330 };
    const runtime = { identity: () => 'a', computePredictive: async () => {
      ledger.restoreEpoch = 1;
      ledger.restoreInProgress = true;
      await rows.deleteForProfile('p1');
      ledger.activeEpoch = 1;
      ledger.restoreInProgress = false;
      return PAYLOAD as PredictiveContexts;
    } };
    await createPeriodSkyCache({ rows, readStore: () => ({ status: 'idle' }) }).load(input, runtime, new AbortController().signal);
    expect(await db.query('SELECT key FROM period_sky')).toEqual([]);
  });

  it('reads only the complete request key and engine when no initial sweep is needed', async () => {
    const { rows } = await fixture();
    await rows.write('a', 'key', 'p1', PAYLOAD);
    await expect(rows.lookup('b', 'key', false)).resolves.toEqual({ epoch: 0, hit: undefined });
    await expect(rows.lookup('a', 'other-key', false)).resolves.toEqual({ epoch: 0, hit: undefined });
    await expect(rows.lookup('a', 'key', false)).resolves.toEqual({ epoch: 0, hit: PAYLOAD });
  });

  it('invalidates a malformed lookup payload inside its one session', async () => {
    const { db, rows } = await fixture();
    await rows.captureEpoch!();
    await db.exec('INSERT INTO period_sky (key, engine, profile_id, payload, epoch) VALUES (?, ?, ?, ?, ?)', ['key', 'a', 'p1', '{"transit_context":null}', 0]);
    await expect(rows.lookup('a', 'key', true)).resolves.toEqual({ epoch: 0, hit: undefined });
    expect(await db.query('SELECT key FROM period_sky')).toEqual([]);
  });

  it('deletes a malformed cached fusion instead of sending null to the moment card', async () => {
    const { db, rows } = await fixture();
    await rows.captureEpoch!();
    const invalid = { ...PAYLOAD, transit_context: { ...PAYLOAD.transit_context, fusion: { ...PAYLOAD.transit_context.fusion, net_weight: null } } };
    await db.exec('INSERT INTO period_sky (key, engine, profile_id, payload, epoch) VALUES (?, ?, ?, ?, ?)', ['k', 'a', 'p1', JSON.stringify(invalid), 0]);
    expect(await rows.read('a', 'k')).toBeUndefined();
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM period_sky'))[0]?.n).toBe(0);
  });

  it('refuses to persist a malformed fusion from an untyped caller', async () => {
    const { db, rows } = await fixture();
    const invalid = { ...PAYLOAD, transit_context: { ...PAYLOAD.transit_context, fusion: { ...PAYLOAD.transit_context.fusion, net_weight: null } } };
    await expect(rows.write('a', 'k', 'p1', invalid as unknown as CachedPredictiveContexts)).rejects.toThrow(/malformed/);
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM period_sky'))[0]?.n).toBe(0);
  });

  it('round-trips by engine and complete request key', async () => {
    const { rows } = await fixture();
    await rows.write('a', 'k1', 'p1', PAYLOAD);
    expect(await rows.read('a', 'k1')).toEqual(PAYLOAD);
    expect(await rows.read('b', 'k1')).toBeUndefined();
  });

  it('refuses boot proofs on write', async () => {
    const { rows } = await fixture();
    for (const proof of [{ domain_strength_receipts: {} }, { strength_signer_public_key: 'x' }]) {
      await expect(rows.write('a', 'k', 'p1', { ...PAYLOAD, ...proof })).rejects.toBeInstanceOf(DurableReceiptError);
    }
  });

  it('the schema refuses a non-JSON payload, so one can never be read back', async () => {
    const { db, rows } = await fixture();
    await rows.captureEpoch!();
    await expect(db.exec('INSERT INTO period_sky (key, engine, profile_id, payload, epoch) VALUES (?, ?, ?, ?, ?)', ['k', 'a', 'p1', '{broken', 0])).rejects.toThrow(/CHECK/);
  });

  it.each(['null', '[]', '{}', '{"transit_context":null}', '{"transit_context":{}}', '{"transit_context":{},"domain_strength_receipts":[]}'])('deletes an invalid persisted payload: %s', async (payload) => {
    const { db, rows } = await fixture();
    await rows.captureEpoch!();
    await db.exec('INSERT INTO period_sky (key, engine, profile_id, payload, epoch) VALUES (?, ?, ?, ?, ?)', ['k', 'a', 'p1', payload, 0]);
    expect(await rows.read('a', 'k')).toBeUndefined();
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM period_sky'))[0]?.n).toBe(0);
  });

  it('sweeps old engines and purges one profile only', async () => {
    const { rows } = await fixture();
    await rows.write('old', 'k0', 'p1', PAYLOAD);
    await rows.write('new', 'k1', 'p1', PAYLOAD);
    await rows.write('new', 'k2', 'p2', PAYLOAD);
    expect(await rows.sweepOtherEngines('new')).toBe(1);
    await rows.deleteForProfile('p1');
    expect(await rows.read('new', 'k1')).toBeUndefined();
    expect(await rows.read('new', 'k2')).toEqual(PAYLOAD);
  });

  it('cannot repopulate a purged profile from a compute started before the dataset fence', async () => {
    const { rows, ledger, db } = await fixture();
    const epoch = await rows.captureEpoch!();
    ledger.restoreEpoch = 1;
    ledger.restoreInProgress = true;
    await rows.deleteForProfile('p1');
    ledger.activeEpoch = 1;
    ledger.restoreInProgress = false;
    await rows.write('a', 'late', 'p1', PAYLOAD, epoch);
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM period_sky'))[0]?.n).toBe(0);
  });

  it('clear fences a late SQL write even when its earlier ledger check returned the old epoch', async () => {
    const { db, ledger, rows } = await fixture();
    const epoch = await rows.captureEpoch!();
    let pause = false;
    const checked = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const writer = createPeriodSkyRows(async () => db, {
      readLedger: async () => {
        const value = { ...ledger };
        if (pause) { checked.resolve(); await resume.promise; }
        return value;
      },
    });
    pause = true;
    const writing = writer.write('a', 'late', 'p1', PAYLOAD, epoch);
    await checked.promise;
    ledger.restoreEpoch = 1;
    ledger.restoreInProgress = true;
    await rows.clear();
    ledger.activeEpoch = 1;
    ledger.restoreInProgress = false;
    resume.resolve();
    await writing;
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM period_sky'))[0]?.n).toBe(0);
  });

  it('rechecks the canonical epoch after waiting to acquire a database session', async () => {
    const { db, ledger, rows } = await fixture();
    const epoch = await rows.captureEpoch!();
    const waiting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const writer = createPeriodSkyRows({
      withDb: async (work) => { waiting.resolve(); await resume.promise; return work(db); },
    }, { readLedger: async () => ({ ...ledger }) });
    const write = writer.write('a', 'late', 'p1', PAYLOAD, epoch);
    await waiting.promise;
    // A failed purge or a newly reopened file can retain old derived metadata.
    // The canonical ledger remains authoritative even in that case.
    ledger.restoreEpoch = 1;
    ledger.activeEpoch = 1;
    resume.resolve();
    await write;
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM period_sky'))[0]?.n).toBe(0);
  });
});

describe('period sky writes are one transaction (atomic)', () => {
  it('a write that fails at its eviction persists nothing', async () => {
    const { db, ledger, rows } = await fixture();
    await rows.write('engine', 'landed', 'p1', PAYLOAD);
    const failing = createPeriodSkyRows(async () => failingAt(db, /ORDER BY rowid DESC LIMIT -1/), { readLedger: async () => ({ ...ledger }) });
    await expect(failing.write('engine', 'key', 'p1', PAYLOAD, 0)).rejects.toThrow(/injected/);
    expect(await db.query('SELECT key FROM period_sky')).toEqual([{ key: 'landed' }]);
  });

  it('a profile purge that fails after advancing the epoch fence leaves the fence and rows as they were', async () => {
    const { db, ledger, rows } = await fixture();
    await rows.write('engine', 'key', 'p1', PAYLOAD);
    ledger.restoreEpoch = 1;
    const failing = createPeriodSkyRows(async () => failingAt(db, /WHERE profile_id = \?/), { readLedger: async () => ({ ...ledger }) });
    await expect(failing.deleteForProfile('p1')).rejects.toThrow(/injected/);
    expect(await db.query("SELECT value FROM dataset_meta WHERE key = 'period-sky-epoch'")).toEqual([{ value: '0' }]);
    expect(await db.query('SELECT key FROM period_sky')).toEqual([{ key: 'key' }]);
  });
});

describe('period sky row cap', () => {
  async function capped(maxRows?: number) {
    const db = await openNodeSqlDatabase({ name: `sky-cap-${crypto.randomUUID()}` });
    databases.push(db);
    await migrateDerivedDb(db);
    const rows = createPeriodSkyRows(async () => db, {
      readLedger: async () => ({ activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false }),
      ...(maxRows === undefined ? {} : { maxRows }),
    });
    const keys = async () => (await db.query<{ key: string }>('SELECT key FROM period_sky ORDER BY key')).map(({ key }) => key);
    return { rows, keys };
  }

  it('evicts the oldest-written rows beyond the cap and keeps the newest', async () => {
    const { rows, keys } = await capped(3);
    for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) await rows.write('a', key, 'p1', PAYLOAD);
    expect(await keys()).toEqual(['k3', 'k4', 'k5']);
    expect(await rows.read('a', 'k5')).toEqual(PAYLOAD);
  });

  it('a rewritten period counts as the newest row', async () => {
    const { rows, keys } = await capped(2);
    await rows.write('a', 'k1', 'p1', PAYLOAD);
    await rows.write('a', 'k2', 'p1', PAYLOAD);
    await rows.write('a', 'k1', 'p1', PAYLOAD);
    await rows.write('a', 'k3', 'p1', PAYLOAD);
    expect(await keys()).toEqual(['k1', 'k3']);
  });

  it('defaults to this device tier\'s cap', async () => {
    const cap = devicePolicy().periodSkyRowCap;
    const { rows, keys } = await capped();
    for (let i = 0; i <= cap; i += 1) await rows.write('a', `k${String(i).padStart(4, '0')}`, 'p1', PAYLOAD);
    const kept = await keys();
    expect(kept).toHaveLength(cap);
    expect(kept[0]).toBe('k0001');
  });
});
