import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import type { CachedPredictiveContexts } from '@almamesh/store';

import { migrateDerivedDb, type SqlDatabase } from '../derivedDb';
import { createPeriodSkyRows, DurableReceiptError } from '../periodSkyRows';

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

  it.each(['{broken', 'null', '[]', '{}', '{"transit_context":null}', '{"transit_context":{}}', '{"transit_context":{},"domain_strength_receipts":[]}'])('deletes an invalid persisted payload: %s', async (payload) => {
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
