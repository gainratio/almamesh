/**
 * City lookup for birthplace entry.
 *
 * `searchCities` is ONLINE-PRIMARY: it queries the Open-Meteo geocoding API
 * (see onlineGeocoder.ts) — a deliberate, owner-approved network egress.
 * The typed city string and ordinary HTTPS/request metadata leave the device.
 * When the network is unreachable (or the browser is offline) it FALLS BACK to
 * `searchCitiesOffline`,
 * which resolves a typed city to { latitude, longitude, timezone (IANA) }
 * entirely from bundled data — so birthplace search still works offline:
 *
 *   - city list: same-origin JSON batches imported into SQLite on OPFS,
 *     pre-baked from `all-the-cities` (GeoNames,
 *     population > 15k; see scripts/generate-cities.mjs). Only one batch is parsed
 *     at a time, and lookups retain bounded SQL result pages.
 *   - timezone: `tz-lookup` maps lat/lon -> IANA zone offline.
 *
 * The engine path (`toBirthInput`) fails closed without a valid IANA timezone,
 * so every search result carries one.
 */
import tzlookup from 'tz-lookup';
import { safeWarn } from '@almamesh/shared-types';

import { geocodeCitiesOnline } from './onlineGeocoder';
import { withDerivedDb, type SqlDatabase } from '../derivedDb';
import { cityCandidates, cityRowAt, ensureCitiesImported, CITY_SQL_CANDIDATES } from './citySql';
import { cityDisplayName, cityMatchRank, placeQualifiersMatch, placeTokens, splitPlaceQuery, type CityRow } from './cityMatch';
export { cityMatchRank, citySearchText, foldPlaceText, placeRegion, type CityRow } from './cityMatch';

/** A city match ready to feed the onboarding store / engine. */
export interface CityMatch {
  /** Human display string, e.g. "Chennai, Tamil Nadu, India". */
  displayName: string;
  /** City name, e.g. "Chennai". */
  city: string;
  /** State / province / region (admin1), when the geocoder provides it. */
  state?: string;
  /** Country display name, e.g. "India". */
  country: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "IN". */
  countryCode: string;
  latitude: number;
  longitude: number;
  /**
   * IANA timezone, e.g. "Asia/Kolkata". Absent only when no zone could be
   * resolved for the point; the engine path then refuses it (never 'UTC').
   */
  timezone?: string;
  /** Population — used for ranking and surfaced for disambiguation. */
  population: number;
}

/** Resolve the IANA timezone for a coordinate, offline. */
export function timezoneForCoordinates(latitude: number, longitude: number): string {
  return tzlookup(latitude, longitude);
}

function toMatch(row: CityRow): CityMatch {
  return {
    displayName: cityDisplayName(row),
    city: row.n,
    ...(row.s ? { state: row.s } : {}),
    country: row.c,
    countryCode: row.cc,
    latitude: row.lat,
    longitude: row.lon,
    timezone: timezoneForCoordinates(row.lat, row.lon),
    population: row.p,
  };
}

/**
 * Search the bundled city DB, diacritic-insensitively. A row matches when the
 * query is a substring of the (folded) city name, OR the query reads as
 * "<city> <state/country qualifiers>" where every qualifier names the row's
 * state or country ("Novato, CA" never returns Novator, Russia), OR every token
 * is a state/country qualifier. Ranks exact > prefix > substring name matches, then by
 * population, so the most likely birth city surfaces first.
 *
 * @param query - free text (city, optionally with state/country qualifiers);
 *   queries under 2 chars return [].
 * @param limit - maximum results to return (default 8).
 */
export async function searchCitiesOffline(query: string, limit = 8): Promise<CityMatch[]> {
  return (await searchCityRowsOffline(query, limit)).map(({ match }) => match);
}

export interface IndexedCityMatch {
  readonly index: number;
  readonly match: CityMatch;
}

/** Where an offline city lookup failed: the database session, the bundled import, or the query. */
export type CityLookupErrorCode = 'geo.city_session' | 'geo.city_import' | 'geo.city_query';

/**
 * An offline city lookup that failed, naming the step and keeping the
 * underlying error as `cause`, so diagnostics can say why (safeCauseWarn
 * prints the class/code chain, never the text). A cancellation (AbortError)
 * is never wrapped: callers still see the page-teardown signal as it is.
 */
export class CityLookupError extends Error {
  override readonly name = 'CityLookupError';
  constructor(readonly code: CityLookupErrorCode, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Offline city lookup failed.', { cause });
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function atStep<T>(step: CityLookupErrorCode, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CityLookupError || isCancellation(error)) throw error;
    throw new CityLookupError(step, error);
  }
}

/** One derived-database session with the bundled list imported; every failure names its step. */
function withCityDb<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T> {
  return atStep('geo.city_session', () => withDerivedDb(async (db) => {
    await atStep('geo.city_import', () => ensureCitiesImported(db));
    return work(db);
  }));
}

/** Search SQL in bounded pages; JS retains only one page and the requested matches. */
export async function searchCityRowsOffline(query: string, limit = 8): Promise<IndexedCityMatch[]> {
  if (query.trim().length < 2 || limit <= 0) return [];
  const tokens = placeTokens(query);
  if (tokens.length === 0) return [];
  return withCityDb(async (db) => {
    const results: IndexedCityMatch[] = [];
    for (let offset = 0; ; offset += CITY_SQL_CANDIDATES) {
      const candidates = await atStep('geo.city_query', () => cityCandidates(db, query, offset));
      // SQL uses the original rank/population/index order. Qualifier tolerance is
      // checked here; paging preserves answers even with >200 rejected candidates.
      for (const { index, row } of candidates) {
        if (cityMatchRank(row, tokens) < 0) continue;
        results.push({ index, match: toMatch(row) });
        if (results.length >= limit) return results;
      }
      if (candidates.length < CITY_SQL_CANDIDATES) return results;
    }
  });
}

/** One bundled reference row by its original list index. */
export async function cityAtIndexOffline(index: number): Promise<CityMatch | undefined> {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  return withCityDb(async (db) => {
    const row = await atStep('geo.city_query', () => cityRowAt(db, index));
    return row ? toMatch(row) : undefined;
  });
}

/** "novato california": several words and no comma, so a state may hide in it. */
function spacedQualifiers(query: string): boolean {
  return !query.includes(',') && placeTokens(query).length > 1;
}

/**
 * Birthplace search — ONLINE-PRIMARY with an OFFLINE FALLBACK.
 *
 * Tries the Open-Meteo geocoder first (richer data: real state/province names +
 * a ready IANA timezone). If the browser is offline, or the request fails for
 * any reason, it transparently falls back to the bundled offline list so search
 * keeps working with no network. Queries under 2 chars short-circuit to [].
 *
 * @param query - free text (city, optionally with state/country qualifiers).
 * @param limit - maximum results to return (default 8).
 * @param opts.language - UI language forwarded to the geocoder for localized
 *   place names (en/es/pt).
 * @param opts.signal - abort signal so a superseded keystroke cancels the
 *   in-flight geocode (prevents a slow older query overwriting newer results).
 */
export async function searchCities(
  query: string,
  limit = 8,
  opts: { language?: string; signal?: AbortSignal } = {},
): Promise<CityMatch[]> {
  if (query.trim().length < 2) return [];

  // Skip the network when the browser reports it is offline.
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (online) {
    try {
      const found = await geocodeCitiesOnline(query, {
        language: opts.language,
        limit,
        signal: opts.signal,
      });
      // Open-Meteo reads "Novato, CA" but not "novato california": a spaced
      // multi-word query it finds nothing for is read on the device instead.
      // A one-word miss stays authoritative (no stale offline resurfacing).
      if (found.length === 0 && spacedQualifiers(query)) return searchCitiesOffline(query, limit);
      const { qualifiers } = splitPlaceQuery(query);
      return found.filter((match) => placeQualifiersMatch(match, qualifiers));
    } catch (err) {
      // A CALLER abort (a newer keystroke superseded this query) must NOT waste
      // an offline search or resurface stale results — propagate so the caller
      // bails. (The geocoder's own 3.5s timeout aborts a DIFFERENT controller,
      // so opts.signal stays unset there and we still fall back below.)
      if (opts.signal?.aborted) throw err;
      // A genuine network/geocoder failure degrades gracefully to the bundled
      // list. Surface it in dev (this app is zero-egress, no telemetry) so a
      // systemic Open-Meteo outage isn't an invisible silent degradation.
      if (import.meta.env.DEV) {
        safeWarn('geo.online_lookup_failed', err);
      }
    }
  }
  return searchCitiesOffline(query, limit);
}
