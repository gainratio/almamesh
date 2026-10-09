/**
 * resolve_place's offline engine (spec 2026-10-08 Part 2). Bundled list only:
 * never searchCities or the online geocoder. A place_ref is the row's index in
 * the bundled list ("city:<n>"): stateless, nothing stored (plan Ruling 4).
 * Coordinates stay in ResolvedPlace; the tool layer sends only `summary`.
 */
import {
  cityAtIndexOffline,
  foldPlaceText,
  searchCityRowsOffline,
  type CityMatch,
  type IndexedCityMatch,
} from './cityLookup';

export const PLACE_REF_PATTERN = '^city:\\d{1,6}$';
const PLACE_REF = new RegExp(PLACE_REF_PATTERN);
export const PLACE_CANDIDATE_LIMIT = 5;
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
}

export type PlaceLookup =
  | { readonly status: 'found'; readonly place: ResolvedPlace }
  | { readonly status: 'ambiguous'; readonly candidates: readonly ResolvedPlace[] }
  | { readonly status: 'not_found' };

function resolved(index: number, match: CityMatch): ResolvedPlace | undefined {
  if (!match.timezone) return undefined;
  const summary = { place_ref: `city:${index}`, label: match.displayName, timezone: match.timezone };
  return { summary, latitude: match.latitude, longitude: match.longitude };
}

function cityPart(query: string): string {
  return foldPlaceText(query.split(',')[0] ?? '').trim().replace(/\s+/g, ' ');
}

/** The single exact-name row, or the most populous one when it dominates the next (Ruling 5). */
function uniqueExact(rows: readonly IndexedCityMatch[], query: string): IndexedCityMatch | undefined {
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

export async function lookupPlaceOffline(query: string): Promise<PlaceLookup> {
  const rows = await searchCityRowsOffline(query, PLACE_CANDIDATE_LIMIT);
  const exact = uniqueExact(rows, query);
  const place = exact && resolved(exact.index, exact.match);
  if (place) return { status: 'found', place };
  const candidates = rows.flatMap(({ index, match }) => {
    const found = resolved(index, match);
    return found ? [{ place: found, state: match.state }] : [];
  });
  return candidates.length > 0 ? { status: 'ambiguous', candidates: uniqueLabels(candidates) } : { status: 'not_found' };
}

export async function placeFromRef(ref: string): Promise<ResolvedPlace | undefined> {
  if (!PLACE_REF.test(ref)) return undefined;
  const index = Number(ref.slice('city:'.length));
  const match = await cityAtIndexOffline(index);
  return match && resolved(index, match);
}
