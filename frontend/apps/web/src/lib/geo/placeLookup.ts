/**
 * The chat's offline place lookup for read_period and travel (spec 2026-10-08 Part 2). Bundled list only:
 * never searchCities or the online geocoder. A place_ref names the row's index in
 * the bundled list ("city:<n>"): stateless, nothing stored (plan Ruling 4).
 * Coordinates stay in ResolvedPlace; the tool layer sends only `summary`.
 */
import {
  foldPlaceText,
  isCancellation,
  placeRegion,
  searchCityRowsOffline,
  type CityMatch,
  type IndexedCityMatch,
} from './cityLookup';
import { PLACE_SUGGESTION_LIMIT } from './cityMatch';

export const PLACE_CANDIDATE_LIMIT = 5;
export { PLACE_SUGGESTION_LIMIT };
export const DOMINANT_POPULATION_RATIO = 10;

export interface PlaceSummary {
  readonly place_ref: string;
  readonly label: string;
  readonly timezone: string;
}

export interface ResolvedPlace {
  readonly summary: PlaceSummary;
  readonly latitude: number;
  readonly longitude: number;
  /** "California, United States": the muted half of a suggestion. Never sent to the model. */
  readonly region?: string;
}

export type PlaceLookup =
  | { readonly status: 'found'; readonly place: ResolvedPlace }
  | { readonly status: 'ambiguous'; readonly candidates: readonly ResolvedPlace[] }
  | { readonly status: 'not_found' };

function resolved(index: number, match: CityMatch): ResolvedPlace | undefined {
  if (!match.timezone) return undefined;
  const summary = { place_ref: `city:${index}`, label: match.displayName, timezone: match.timezone };
  const region = placeRegion(match.city, match.state, match.country);
  return { summary, latitude: match.latitude, longitude: match.longitude, ...(region ? { region } : {}) };
}

function cityPart(query: string): string {
  return foldPlaceText(query.split(',')[0] ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * The only row (its qualifiers already settled it: "springfield illinois"), the
 * single exact-name row, or the most populous one when it dominates the next (Ruling 5).
 */
function uniqueExact(rows: readonly IndexedCityMatch[], query: string): IndexedCityMatch | undefined {
  if (rows.length === 1) return rows[0];
  const city = cityPart(query);
  const exact = rows.filter(({ match }) => foldPlaceText(match.city) === city);
  const [first, second] = [...exact].sort((a, b) => b.match.population - a.match.population);
  if (!first) return undefined;
  if (!second || first.match.population >= DOMINANT_POPULATION_RATIO * second.match.population) return first;
  return undefined;
}

interface Candidate {
  readonly place: ResolvedPlace;
  readonly state?: string;
}

function withLabel(candidate: Candidate, label: string): Candidate {
  return { ...candidate, place: { ...candidate.place, summary: { ...candidate.place.summary, label } } };
}

function labelOf(candidate: Candidate): string {
  return candidate.place.summary.label;
}

/** Rows are population-ranked, so a label's n-th repeat is its population rank. */
function numberRepeats(candidates: readonly Candidate[]): Candidate[] {
  const total = new Map<string, number>();
  for (const c of candidates) total.set(labelOf(c), (total.get(labelOf(c)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return candidates.map((c) => {
    const label = labelOf(c);
    if ((total.get(label) ?? 0) < 2) return c;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return withLabel(c, `${label} (${n})`);
  });
}

function qualify(candidates: readonly Candidate[]): Candidate[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(labelOf(c), (counts.get(labelOf(c)) ?? 0) + 1);
  return candidates.map((c) => {
    if ((counts.get(labelOf(c)) ?? 0) < 2) return c;
    return withLabel(c, `${labelOf(c)}, ${c.state ?? c.place.summary.timezone}`);
  });
}

/** Ruling P12: labels unique by admin1, else zone, else " (n)". Never coordinates. */
function uniqueLabels(candidates: readonly Candidate[]): ResolvedPlace[] {
  return numberRepeats(qualify(candidates)).map((c) => c.place);
}

/**
 * The chat cannot retry: a failed tool ends its tool round, and the identical
 * call is refused as a duplicate. The first lookup in a tab may run the cold
 * 25-batch import, so one transient failure (a batch fetch, the SQL Worker)
 * would cost the whole request. The import restarts cleanly in a fresh
 * session (its version marker is written last), so try exactly once more.
 * A cancellation is final.
 */
export const PLACE_LOOKUP_ATTEMPTS = 2;

async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= PLACE_LOOKUP_ATTEMPTS || isCancellation(error)) throw error;
    }
  }
}

function candidatesOf(rows: readonly IndexedCityMatch[]): ResolvedPlace[] {
  return uniqueLabels(rows.flatMap(({ index, match }) => {
    const found = resolved(index, match);
    return found ? [{ place: found, state: match.state }] : [];
  }));
}

/** For the chat tool: one place when the name settles it (exact, or dominant), else the candidates. */
export async function lookupPlaceOffline(query: string): Promise<PlaceLookup> {
  const rows = await withRetry(() => searchCityRowsOffline(query, PLACE_CANDIDATE_LIMIT));
  const exact = uniqueExact(rows, query);
  const place = exact && resolved(exact.index, exact.match);
  if (place) return { status: 'found', place };
  const candidates = candidatesOf(rows);
  return candidates.length > 0 ? { status: 'ambiguous', candidates } : { status: 'not_found' };
}

/** For the place boxes: every match, most populous first, so a person can always pick their own. */
export async function listPlacesOffline(query: string): Promise<ResolvedPlace[]> {
  return candidatesOf(await withRetry(() => searchCityRowsOffline(query, PLACE_SUGGESTION_LIMIT)));
}
