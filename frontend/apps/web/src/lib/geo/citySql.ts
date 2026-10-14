/** Bounded reference-data import and queries on the derived OPFS database. */
import manifest from '../../data/cities.manifest.json';
import type { SqlDatabase } from '../derivedDb';
import { citySearchText, foldPlaceText, placeTokens, splitPlaceQuery, type CityRow } from './cityMatch';

export const CITY_SQL_CANDIDATES = 200;
export const CITY_PART_ROWS = 1000;
export interface IndexedCityRow { readonly index: number; readonly row: CityRow; }
/** SQLite hands back NULL for a row with no state; the row shape has none. */
type SqlCityRow = Omit<CityRow, 's'> & { s: string | null };

function fromSql({ s, ...row }: SqlCityRow): CityRow {
  return s === null ? row : { ...row, s };
}
export type CityPartLoader = () => Promise<{
  version: string;
  parts: readonly (() => Promise<readonly CityRow[]>)[];
  rows?: number;
}>;

function validRow(value: unknown): value is CityRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CityRow>;
  return typeof row.n === 'string' && row.n.length > 0
    && (row.s === undefined || (typeof row.s === 'string' && row.s.length > 0))
    && typeof row.c === 'string' && typeof row.cc === 'string'
    && typeof row.lat === 'number' && Number.isFinite(row.lat) && Math.abs(row.lat) <= 90
    && typeof row.lon === 'number' && Number.isFinite(row.lon) && Math.abs(row.lon) <= 180
    && typeof row.p === 'number' && Number.isSafeInteger(row.p) && row.p >= 0;
}

async function readPart(index: number): Promise<readonly CityRow[]> {
  const url = `${import.meta.env.BASE_URL}cities/cities-part-${String(index).padStart(2, '0')}.json`;
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`City data could not be loaded (${response.status}).`);
  const text = await response.text();
  if (text.length > 256_000) throw new Error('City data batch is too large.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.partHashes[index]) throw new Error('City data does not match this app version.');
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length > CITY_PART_ROWS || !rows.every(validRow)) {
    throw new Error('City data batch is invalid.');
  }
  return rows;
}

const realParts: CityPartLoader = async () => ({
  version: manifest.version,
  rows: manifest.rows,
  parts: Array.from({ length: manifest.parts }, (_, index) => () => readPart(index)),
});
const importing = new WeakMap<SqlDatabase, Promise<void>>();

async function importAll(db: SqlDatabase, load: CityPartLoader): Promise<void> {
  const { version, parts, rows: expectedRows } = await load();
  const current = await db.query<{ value: string }>("SELECT value FROM dataset_meta WHERE key = 'cities_version'");
  if (current[0]?.value === version) return;
  await db.transaction([
    { sql: "DELETE FROM dataset_meta WHERE key = 'cities_version'" },
    { sql: 'DELETE FROM cities' },
  ]);
  let index = 0;
  for (const part of parts) {
    const rows = await part();
    if (rows.length > CITY_PART_ROWS || !rows.every(validRow)) throw new Error('City data batch is invalid.');
    await db.executeMany(
      'INSERT INTO cities (idx, n, s, c, cc, lat, lon, p, name_fold, search_fold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rows.map((row) => [index++, row.n, row.s ?? null, row.c, row.cc, row.lat, row.lon, row.p, foldPlaceText(row.n), citySearchText(row)]),
    );
  }
  if (expectedRows !== undefined && index !== expectedRows) throw new Error('City data is incomplete.');
  await db.transaction([
    { sql: "INSERT INTO cities_fts(cities_fts) VALUES ('rebuild')" },
    { sql: "INSERT INTO dataset_meta (key, value) VALUES ('cities_version', ?)", bind: [version] },
  ]);
}

export function ensureCitiesImported(db: SqlDatabase, load: CityPartLoader = realParts): Promise<void> {
  const pending = importing.get(db);
  if (pending) return pending;
  const work = importAll(db, load).finally(() => {
    if (importing.get(db) === work) importing.delete(db);
  });
  importing.set(db, work);
  return work;
}

/**
 * The first query token must appear in every accepted row, including tolerated
 * state qualifiers. FTS provides that superset, then the unchanged matcher
 * filters bounded pages. SQL orders exactly as the previous full-list scan did.
 */
export async function cityCandidates(db: SqlDatabase, query: string, offset = 0): Promise<IndexedCityRow[]> {
  const tokens = placeTokens(query);
  if (tokens.length === 0) return [];
  const first = tokens[0];
  // Rank by the city part, so "san jose, ca" puts the exact San Jose first.
  const norm = splitPlaceQuery(query).city || tokens.join(' ');
  const useFts = Array.from(first).length >= 3;
  const where = useFts
    ? 'idx IN (SELECT rowid FROM cities_fts WHERE cities_fts MATCH ?)'
    : 'instr(search_fold, ?) > 0';
  const candidateQuery = useFts ? `"${first.replaceAll('"', '""')}"` : first;
  const rows = await db.query<SqlCityRow & { idx: number }>(
    `SELECT idx, n, s, c, cc, lat, lon, p FROM cities WHERE ${where}
     ORDER BY CASE WHEN name_fold = ? THEN 3 WHEN substr(name_fold, 1, length(?)) = ? THEN 2 WHEN instr(name_fold, ?) > 0 THEN 1 ELSE 0 END DESC,
       p DESC, idx ASC LIMIT ? OFFSET ?`,
    [candidateQuery, norm, norm, norm, norm, CITY_SQL_CANDIDATES, offset],
  );
  return rows.map(({ idx, ...row }) => ({ index: idx, row: fromSql(row) }));
}

export async function cityRowAt(db: SqlDatabase, index: number): Promise<CityRow | undefined> {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  const row = (await db.query<SqlCityRow>('SELECT n, s, c, cc, lat, lon, p FROM cities WHERE idx = ?', [index]))[0];
  return row && fromSql(row);
}
