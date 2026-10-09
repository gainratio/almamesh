/**
 * Online city geocoding via Open-Meteo's free, keyless, CORS-enabled Geocoding
 * API (https://open-meteo.com/en/docs/geocoding-api).
 *
 * This is a DELIBERATE, owner-approved network egress recorded in the README's
 * network/data-flow inventory. The typed city string and ordinary HTTPS request
 * metadata leave the device — never the birth date/time or the computed chart.
 * The offline `cities.min.json` list remains as
 * a fallback (see `searchCities` in cityLookup.ts) so search still works offline.
 *
 * Open-Meteo returns richer data than the offline list — real `admin1` (state /
 * province) names and a ready IANA `timezone` — so a selected city needs no
 * on-device tz-lookup (we keep one only as a defensive fallback).
 */
import tzlookup from 'tz-lookup';

import type { CityMatch } from './cityLookup';

const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';

/**
 * Cap a stalled geocode so the typeahead can't hang: on timeout we abort the
 * request, which rejects `fetch` and lets `searchCities` fall back to the
 * offline list. Chosen to be snappy for a keystroke-driven search.
 */
const DEFAULT_TIMEOUT_MS = 3500;

/** The subset of the Open-Meteo geocoding result we consume. */
interface OpenMeteoPlace {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  timezone?: string;
  population?: number;
  feature_code?: string;
}

/**
 * Resolve an IANA zone from coordinates. Undefined when tz-lookup cannot place
 * the point: a made-up 'UTC' would silently compute the chart in the wrong
 * zone, while undefined is refused downstream (requireBirthTimeZone).
 */
function fallbackTimezone(latitude: number, longitude: number): string | undefined {
  try {
    return tzlookup(latitude, longitude);
  } catch {
    return undefined;
  }
}

function toMatch(place: OpenMeteoPlace): CityMatch {
  const displayName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  return {
    displayName,
    city: place.name,
    state: place.admin1,
    country: place.country ?? '',
    countryCode: place.country_code ?? '',
    latitude: place.latitude,
    longitude: place.longitude,
    // Open-Meteo returns a proper IANA zone; fall back to on-device lookup only
    // if it is somehow absent (the engine fails closed without a valid zone).
    timezone: place.timezone ?? fallbackTimezone(place.latitude, place.longitude),
    population: place.population ?? 0,
  };
}

/**
 * Geocode a birthplace query online. Returns [] for queries under 2 chars (no
 * request). THROWS on a failed/unreachable request so the caller can fall back
 * to the offline list. Results are limited to populated places (feature codes
 * `PPL*`) so countries/regions don't pollute the birthplace picker.
 */
export async function geocodeCitiesOnline(
  query: string,
  opts: { language?: string; limit?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CityMatch[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const params = new URLSearchParams({
    name: trimmed,
    count: String(opts.limit ?? 8),
    language: opts.language ?? 'en',
    format: 'json',
  });

  // Bound the request with an internal timeout (and forward any external
  // abort), so a stalled network aborts and the caller can fall back offline.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      // Don't leak the app's Origin/Referer to the third-party geocoder. The
      // URL contains only the typed city name and benign query parameters;
      // ordinary HTTPS/request metadata remains visible to the provider.
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      throw new Error(`Open-Meteo geocoding failed: ${response.status}`);
    }

    const data = (await response.json()) as { results?: OpenMeteoPlace[] };
    const results = data.results ?? [];
    return results
      .filter(
        (place) =>
          // Drop malformed rows: the engine path fails closed without finite
          // coordinates, and a place with no usable name is unpickable.
          Boolean(place.name) &&
          Number.isFinite(place.latitude) &&
          Number.isFinite(place.longitude) &&
          // Populated places only (PPL*); tolerate a missing feature_code.
          (!place.feature_code || place.feature_code.startsWith('PPL')),
      )
      .map(toMatch);
  } finally {
    clearTimeout(timer);
  }
}
