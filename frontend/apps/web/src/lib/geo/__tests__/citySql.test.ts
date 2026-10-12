// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import { __setDerivedDbForTest, migrateDerivedDb, type SqlDatabase } from '../../derivedDb';
import { cityCandidates, cityRowAt, ensureCitiesImported, CITY_SQL_CANDIDATES, type CityPartLoader } from '../citySql';
import { searchCityRowsOffline, type CityRow } from '../cityLookup';
import golden from './cityLookupParity.golden.json';

const databases: SqlDatabase[] = [];
async function freshDb() {
  const db = await openNodeSqlDatabase({ name: `cities-${Math.random()}` });
  databases.push(db);
  await migrateDerivedDb(db);
  return db;
}
const row = (n: string, p = 1): CityRow => ({ n, c: 'Spain', cc: 'ES', lat: 0, lon: 0, p });
const load = (version: string, parts: readonly (readonly CityRow[])[]): CityPartLoader =>
  async () => ({ version, parts: parts.map((part) => async () => part) });

afterEach(async () => {
  __setDerivedDbForTest(undefined);
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) await db.close();
});

describe('bounded city storage', () => {
  it('imports once per version, preserves row indices and shares concurrent imports', async () => {
    const db = await freshDb();
    const part = vi.fn(async () => [row('A'), row('Bogotá')]);
    const loader = async () => ({ version: 'v1', parts: [part] });
    await Promise.all([ensureCitiesImported(db, loader), ensureCitiesImported(db, loader)]);
    await ensureCitiesImported(db, loader);
    expect(part).toHaveBeenCalledTimes(1);
    expect((await cityRowAt(db, 1))?.n).toBe('Bogotá');
    expect(await cityRowAt(db, 99)).toBeUndefined();
  });

  it('retries a failed partial import and only marks a complete version present', async () => {
    const db = await freshDb();
    await ensureCitiesImported(db, load('v1', [[row('Old')]]));
    const broken = async () => ({ version: 'v2', parts: [async () => [row('Partial')], async () => { throw new Error('chunk failed'); }] });
    await expect(ensureCitiesImported(db, broken)).rejects.toThrow('chunk failed');
    expect(await db.query("SELECT value FROM dataset_meta WHERE key = 'cities_version'")).toEqual([]);
    await ensureCitiesImported(db, load('v2', [[row('New')]]));
    expect((await cityRowAt(db, 0))?.n).toBe('New');
    expect(await cityRowAt(db, 1)).toBeUndefined();
  });

  it('caps each SQL result batch and pages past rejected qualifier matches', async () => {
    const db = await freshDb();
    const rows = Array.from({ length: 500 }, (_, i) => row(`San ${i}`, 1000 + i));
    rows.push(row('San Francisco', 1));
    await ensureCitiesImported(db, load('v1', [rows]));
    expect(await cityCandidates(db, 'san')).toHaveLength(CITY_SQL_CANDIDATES);
    const candidates = await cityCandidates(db, 'san francisco ca', 400);
    expect(candidates.some((candidate) => candidate.row.n === 'San Francisco')).toBe(true);
    __setDerivedDbForTest(db);
    // Avoid triggering the real dataset import while testing pagination.
    const manifest = JSON.parse(await readFile(resolve(__dirname, '../../../../public/cities/manifest.json'), 'utf8')) as { version: string };
    await db.exec("UPDATE dataset_meta SET value = ? WHERE key = 'cities_version'", [manifest.version]);
    expect((await searchCityRowsOffline('san francisco ca'))[0]?.match.city).toBe('San Francisco');
  });

  it('keeps a valid country-only match with rank zero', async () => {
    const db = await freshDb();
    await ensureCitiesImported(db, load('v1', [[row('Madrid')]]));
    expect((await cityCandidates(db, 'spain')).map(({ row: result }) => result.n)).toEqual(['Madrid']);
  });

  it.each([
    [404, 'missing', 'City data could not be loaded (404).'],
    [200, '[]', 'City data does not match this app version.'],
    [200, 'x'.repeat(256_001), 'City data batch is too large.'],
  ])('refuses a failed, stale or oversized public data batch (%s)', async (status, text, message) => {
    const db = await freshDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status })));
    await expect(ensureCitiesImported(db)).rejects.toThrow(message);
    expect(await db.query("SELECT value FROM dataset_meta WHERE key = 'cities_version'")).toEqual([]);
  });

  it('refuses invalid reference rows and an incomplete manifest', async () => {
    const db = await freshDb();
    await expect(ensureCitiesImported(db, load('invalid', [[{ ...row('Bad'), lat: Number.NaN }]])))
      .rejects.toThrow('City data batch is invalid.');
    await expect(ensureCitiesImported(db, async () => ({ version: 'missing', rows: 2, parts: [async () => [row('One')]] })))
      .rejects.toThrow('City data is incomplete.');
  });

  it('refuses invalid row indices without asking SQLite and handles empty candidate text', async () => {
    const db = await freshDb();
    const query = vi.spyOn(db, 'query');
    expect(await cityRowAt(db, -1)).toBeUndefined();
    expect(await cityRowAt(db, 1.5)).toBeUndefined();
    expect(await cityCandidates(db, ' , ')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('loads public JSON as fetch batches and preserves all captured lookup answers', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const pathname = typeof url === 'string' ? url : url instanceof URL ? url.pathname : url.url;
      const text = await readFile(resolve(__dirname, '../../../../public', pathname.replace(/^\//, '')), 'utf8');
      return new Response(text, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const db = await freshDb();
    __setDerivedDbForTest(db);
    for (const { query, results } of golden) {
      expect((await searchCityRowsOffline(query, 8)).map(({ index }) => index), query).toEqual(results);
    }
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls).toHaveLength(25);
    expect(calls.every((url) => /^\/cities\/cities-part-\d{2}\.json$/.test(url))).toBe(true);
    await searchCityRowsOffline('Bogotá');
    expect(fetchMock).toHaveBeenCalledTimes(25);
  }, 120_000);
});
