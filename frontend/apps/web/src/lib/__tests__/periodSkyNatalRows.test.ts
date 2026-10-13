/**
 * Natal-only data (varga_context_full, strength_context, period_reading.natal_lords)
 * is stored once per profile, not in every period_sky row (spec 2026-10-13,
 * "Storage"). Lookup joins it back, so callers still get one CachedPredictiveContexts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import type { CachedPredictiveContexts } from '@almamesh/store';

import { migrateDerivedDb, type SqlDatabase } from '../derivedDb';
import { createPeriodSkyRows } from '../periodSkyRows';
import { periodReadingFixture } from './periodReadingFixtures';

const databases: SqlDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

async function fixture(maxRows = 16) {
  const db = await openNodeSqlDatabase({ name: `natal-${crypto.randomUUID()}` });
  databases.push(db);
  await migrateDerivedDb(db);
  const ledger = { activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false };
  const rows = createPeriodSkyRows(async () => db, { readLedger: async () => ({ ...ledger }), maxRows });
  return { db, rows, ledger };
}

const TRANSIT = {
  instant: '2019-03-14T00:00:00Z',
  gochara: { instant: '2019-03-14T00:00:00Z', transit_ayanamsa: 24, placements: {} },
  sade_sati: { is_active: false, current_phase: 'none', natal_moon_sign: 'Aries', cycle: [], cycle_start: null, cycle_end: null },
  slow_hits: [],
  fusion: { instant: '2019-03-14T00:00:00Z', maha_lord: 'rahu', antar_lord: null, maha_lord_transit_house_from_moon: 1, maha_lord_transit_house_from_lagna: 1, reinforcing: [], afflicting: [], net_weight: 0, severity: 'neutral' },
  timeline: { window_start: '2019-03-14T00:00:00Z', window_end: '2020-03-14T00:00:00Z', events: [] },
};
const VARGA = { charts: { D9: { chart: 'D9', lagna_sign: 'leo', lagna_sign_lord: 'sun', placements: {} } }, vargottama: [], shadvarga_own_sign: [], vimshopaka: [] };
const STRENGTH = { sunrise_utc_iso: '1990-01-15T01:40:00Z', ashtakavarga: { bhinna: {}, sarva: { bindus: { aries: 28 }, total: 337 } }, shadbala: { planets: {} } };

function payload(reading = periodReadingFixture('delhi-2019-05'), varga: object = VARGA): CachedPredictiveContexts {
  return {
    transit_context: TRANSIT,
    varga_context_full: varga,
    strength_context: STRENGTH,
    domains_context: { instant: '2019-05-01T00:00:00Z', forecasts: {} },
    domain_strength_assays: {},
    period_reading: reading,
  } as unknown as CachedPredictiveContexts;
}

async function count(db: SqlDatabase, table: 'period_sky' | 'period_natal'): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n ?? -1;
}

describe('period sky rows keep natal data once per profile', () => {
  it('write then lookup returns exactly the input', async () => {
    const { rows } = await fixture();
    const input = payload();
    await rows.write('engine', 'may', 'p1', input);
    await expect(rows.lookup('engine', 'may', false)).resolves.toEqual({ epoch: 0, hit: input });
    await expect(rows.read('engine', 'may')).resolves.toEqual(input);
  });

  it('two periods of one profile store one natal row, and no period row carries natal data', async () => {
    const { db, rows } = await fixture();
    await rows.write('engine', 'may', 'p1', payload());
    await rows.write('engine', 'year', 'p1', payload(periodReadingFixture('delhi-2019-year')));
    expect(await count(db, 'period_sky')).toBe(2);
    expect(await count(db, 'period_natal')).toBe(1);
    for (const { payload: text } of await db.query<{ payload: string }>('SELECT payload FROM period_sky')) {
      expect(text).not.toContain('varga_context_full');
      expect(text).not.toContain('strength_context');
      expect(text).not.toContain('natal_lords');
    }
    expect((await rows.read('engine', 'year'))?.period_reading?.natal_lords.saturn?.rules).toEqual([8, 9]);
  });

  it('a changed natal chart (rectified birth time) gets its own natal row; each period joins its own', async () => {
    const { db, rows } = await fixture();
    const rectified = { ...VARGA, vargottama: [{ point: 'lagna', sign: 'leo' }] };
    await rows.write('engine', 'old-birth', 'p1', payload());
    await rows.write('engine', 'new-birth', 'p1', payload(undefined, rectified));
    expect(await count(db, 'period_natal')).toBe(2);
    expect((await rows.read('engine', 'old-birth'))?.varga_context_full).toEqual(VARGA);
    expect((await rows.read('engine', 'new-birth'))?.varga_context_full).toEqual(rectified);
  });

  it('a profile delete removes its natal row and leaves other profiles alone', async () => {
    const { db, rows } = await fixture();
    await rows.write('engine', 'a', 'p1', payload());
    await rows.write('engine', 'b', 'p2', payload(undefined, { ...VARGA, vimshopaka: [] , shadvarga_own_sign: [{ graha: 'sun', own_sign_count: 1, charts_in_own_sign: ['D1'] }] }));
    await rows.deleteForProfile('p1');
    expect(await db.query('SELECT profile_id FROM period_natal')).toEqual([{ profile_id: 'p2' }]);
    await rows.clear();
    expect(await count(db, 'period_natal')).toBe(0);
  });

  it('eviction at the row cap drops a natal row no period row references any more', async () => {
    const { db, rows } = await fixture(1);
    await rows.write('engine', 'a', 'p1', payload());
    await rows.write('engine', 'b', 'p2', payload(undefined, { ...VARGA, vargottama: [{ point: 'sun', sign: 'leo' }] }));
    expect(await db.query('SELECT key FROM period_sky')).toEqual([{ key: 'b' }]);
    expect(await db.query('SELECT profile_id FROM period_natal')).toEqual([{ profile_id: 'p2' }]);
  });

  it('the engine sweep and the epoch fence purge natal rows with their period rows', async () => {
    const { db, rows, ledger } = await fixture();
    await rows.write('old', 'a', 'p1', payload());
    await rows.sweepOtherEngines('new');
    expect(await count(db, 'period_natal')).toBe(0);
    await rows.write('new', 'a', 'p1', payload());
    ledger.restoreEpoch = 1;
    ledger.activeEpoch = 1;
    await rows.captureEpoch!();
    expect(await count(db, 'period_sky')).toBe(0);
    expect(await count(db, 'period_natal')).toBe(0);
  });

  it('a period row whose natal row is missing or malformed is a miss and is deleted', async () => {
    const { db, rows } = await fixture();
    await rows.write('engine', 'a', 'p1', payload());
    await db.exec('DELETE FROM period_natal');
    await expect(rows.lookup('engine', 'a', false)).resolves.toEqual({ epoch: 0, hit: undefined });
    expect(await count(db, 'period_sky')).toBe(0);
    await rows.write('engine', 'a', 'p1', payload());
    await db.exec(`UPDATE period_natal SET payload = '{"natal_lords":[]}'`);
    await expect(rows.read('engine', 'a')).resolves.toBeUndefined();
    expect(await count(db, 'period_sky')).toBe(0);
  });

  it('a row written before the split (natal data inline, no reading) still reads back unchanged', async () => {
    const { db, rows } = await fixture();
    const { period_reading: _reading, ...legacy } = payload();
    await rows.captureEpoch!();
    await db.exec('INSERT INTO period_sky (key, engine, profile_id, payload, epoch) VALUES (?, ?, ?, ?, 0)', ['old', 'engine', 'p1', JSON.stringify(legacy)]);
    await expect(rows.read('engine', 'old')).resolves.toEqual(legacy);
  });

  it('refuses to persist a malformed period reading', async () => {
    const { db, rows } = await fixture();
    const reading = { ...periodReadingFixture('delhi-2019-05'), themes: [{ domain: 'career' }] };
    await expect(rows.write('engine', 'a', 'p1', payload(reading as never))).rejects.toThrow(/malformed/);
    expect(await count(db, 'period_sky')).toBe(0);
    expect(await count(db, 'period_natal')).toBe(0);
  });
});
