/** Compact row shape used by the bundled reference data (keys minimised for size). */
export type CityRow = {
  n: string;
  /** State / province / region (GeoNames admin1 name), when GeoNames has one. */
  s?: string;
  c: string;
  cc: string;
  lat: number;
  lon: number;
  p: number;
};

/** Every place box shows at most this many suggestions: every Springfield that matters, no scroll. */
export const PLACE_SUGGESTION_LIMIT = 6;

/**
 * Fold diacritics and lower-case so "Sao Paulo" matches stored "São Paulo" and
 * "Zurich" matches "Zürich". NFD splits accented letters into base + combining
 * mark; stripping the marks leaves the plain ASCII base.
 */
export function foldPlaceText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Split (already-folded) text into non-empty word tokens. */
function splitWords(folded: string): string[] {
  return folded.split(/[\s,]+/).filter(Boolean);
}

/** Diacritic-fold then tokenize free text into words. */
export function placeTokens(text: string): string[] {
  return splitWords(foldPlaceText(text));
}

/**
 * Extra qualifier words the dataset's country name/code don't spell out
 * literally. Keyed by ISO 3166-1 alpha-2 code so a query like "San Francisco,
 * USA" or "London UK" resolves. "US"/"United States"/"United Kingdom"/"United
 * Arab Emirates" already fold out of the code + country name.
 */
const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  US: ['usa'],
  GB: ['uk'],
  AE: ['uae'],
};

/**
 * The postal abbreviations people type after a city ("Novato, CA", "Toronto,
 * ON", "Sydney NSW"), keyed by country, then by the folded admin1 name that
 * GeoNames (offline rows) and Open-Meteo (online rows) both use.
 */
const STATE_ABBREVIATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  US: {
    alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
    connecticut: 'ct', delaware: 'de', 'district of columbia': 'dc', 'washington, d.c.': 'dc', florida: 'fl',
    georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks',
    kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi',
    minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
    'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc',
    'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri',
    'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt',
    virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
  },
  CA: {
    alberta: 'ab', 'british columbia': 'bc', manitoba: 'mb', 'new brunswick': 'nb',
    'newfoundland and labrador': 'nl', 'northwest territories': 'nt', 'nova scotia': 'ns', nunavut: 'nu',
    ontario: 'on', 'prince edward island': 'pe', quebec: 'qc', saskatchewan: 'sk', yukon: 'yt',
  },
  AU: {
    'australian capital territory': 'act', 'new south wales': 'nsw', 'northern territory': 'nt',
    queensland: 'qld', 'south australia': 'sa', tasmania: 'tas', victoria: 'vic', 'western australia': 'wa',
  },
};

/** Where a place is: what a qualifier ("CA", "California", "USA") is checked against. */
export interface PlaceWhere {
  readonly state?: string;
  readonly country: string;
  readonly countryCode: string;
}

/** A qualifier phrase: a whole name ("costa rica"), a code ("cr") or an alias ("usa"). */
type Phrase = readonly string[];

function countryPhrases({ country, countryCode }: PlaceWhere): Phrase[] {
  const aliases = COUNTRY_ALIASES[countryCode] ?? [];
  return [placeTokens(country), [foldPlaceText(countryCode)], ...aliases.map((alias) => [alias])];
}

/** The state's name and postal abbreviation, then the country's phrases. */
function wherePhrases(where: PlaceWhere): Phrase[] {
  const { state, countryCode } = where;
  if (!state) return countryPhrases(where);
  const abbreviation = STATE_ABBREVIATIONS[countryCode]?.[foldPlaceText(state)];
  return [placeTokens(state), ...(abbreviation ? [[abbreviation]] : []), ...countryPhrases(where)];
}

function rowWhere(row: CityRow): PlaceWhere {
  return { state: row.s, country: row.c, countryCode: row.cc };
}

/** Shortest unfinished last word that may stand for a longer one ("cal" -> California). */
const MIN_PREFIX_QUALIFIER = 3;

/**
 * The tokens still being typed are the start of this phrase: "cal", or "costa
 * ri" once "costa" is whole. A lone short stub ("ca") must be a whole code.
 */
function startsPhrase(rest: readonly string[], phrase: Phrase): boolean {
  if (rest.length > phrase.length) return false;
  const last = rest.length - 1;
  return rest.every((token, i) => token === phrase[i]
    || (i === last && (i > 0 || token.length >= MIN_PREFIX_QUALIFIER) && phrase[i].startsWith(token)));
}

function coveredFrom(tokens: readonly string[], from: number, phrases: readonly Phrase[]): boolean {
  if (from === tokens.length) return true;
  return phrases.some((phrase) => {
    const next = tokens.slice(from, from + phrase.length);
    if (next.length === phrase.length && next.every((token, i) => token === phrase[i])) {
      if (coveredFrom(tokens, from + phrase.length, phrases)) return true;
    }
    return startsPhrase(tokens.slice(from), phrase);
  });
}

/**
 * The qualifier tokens must read as whole state/country phrases, in any order:
 * "ca", "california usa", "costa rica". Only the phrase still being typed may
 * be cut short, by at least three letters. So "CA" is California or Canada,
 * never "Caraga", and "paulo" alone never names the state of São Paulo.
 */
function qualifiersOk(qualifiers: readonly string[], phrases: readonly Phrase[]): boolean {
  return coveredFrom(qualifiers, 0, phrases);
}

/** True when every qualifier ("ca", "illinois", "usa") names this place's state or country. */
export function placeQualifiersMatch(where: PlaceWhere, qualifiers: readonly string[]): boolean {
  return qualifiersOk(qualifiers, wherePhrases(where));
}

/** "Novato, CA" -> city "novato", qualifiers ["ca"]. Folded; no comma means no qualifiers. */
export function splitPlaceQuery(query: string): { city: string; qualifiers: string[] } {
  const [city = '', ...rest] = query.split(',');
  return { city: placeTokens(city).join(' '), qualifiers: placeTokens(rest.join(' ')) };
}

/**
 * "California, United States": the muted half of a suggestion. The state is
 * skipped when there is none, or when it only repeats the city ("Shanghai").
 */
export function placeRegion(city: string, state: string | undefined, country: string): string {
  // "Bogota D.C." and "Buenos Aires F.D." only restate the city too.
  const repeats = state !== undefined && foldPlaceText(state).startsWith(foldPlaceText(city));
  return [repeats ? undefined : state, country].filter(Boolean).join(', ');
}

/** "Novato, California, United States": one label for every place box and the chat. */
export function placeLabel(city: string, state: string | undefined, country: string): string {
  const region = placeRegion(city, state, country);
  return region ? `${city}, ${region}` : city;
}

export function cityDisplayName(row: CityRow): string {
  return placeLabel(row.n, row.s, row.c);
}

/**
 * Match a "<city words> <qualifiers>" query, trying each split point: the
 * leading tokens must be the city name's own first words, whole ("new york
 * usa" is New York City, never Newburgh), and every remaining token must name
 * the row's state or country. A qualifier that names neither ("Portland, ZZ")
 * rejects the row: it is never silently ignored. Returns the city part, or
 * undefined.
 */
function cityWithQualifiers(
  nameTokens: readonly string[],
  phrases: readonly Phrase[],
  tokens: readonly string[],
): string | undefined {
  const longest = Math.min(nameTokens.length, tokens.length - 1);
  for (let split = longest; split >= 1; split -= 1) {
    const cityTokens = tokens.slice(0, split);
    if (!cityTokens.every((token, i) => token === nameTokens[i])) continue;
    if (qualifiersOk(tokens.slice(split), phrases)) return cityTokens.join(' ');
  }
  return undefined;
}

/** Rank: exact name > prefix > substring > qualifier-only, then by population. */
function nameScore(foldedName: string, normQuery: string): 0 | 1 | 2 | 3 {
  if (foldedName === normQuery) return 3;
  if (foldedName.startsWith(normQuery)) return 2;
  if (foldedName.includes(normQuery)) return 1;
  return 0;
}

/** Searchable reference text; coordinates never appear in it. */
export function citySearchText(row: CityRow): string {
  return [foldPlaceText(row.n), ...wherePhrases(rowWhere(row)).flat()].join(' ');
}

/**
 * -1 means no match. A qualified match ("novato, ca") ranks by its city part,
 * so the exact Novato scores 3. A country-only query ("spain") keeps rank 0; a
 * state name alone never lists the whole state ("Sao Paulo" is the city).
 */
export function cityMatchRank(row: CityRow, tokens: readonly string[]): -1 | 0 | 1 | 2 | 3 {
  const name = foldPlaceText(row.n);
  const nameTokens = splitWords(name);
  const cityPart = cityWithQualifiers(nameTokens, wherePhrases(rowWhere(row)), tokens);
  if (cityPart !== undefined) return nameScore(name, cityPart);
  const normQuery = tokens.join(' ');
  if (name.includes(normQuery)) return nameScore(name, normQuery);
  return qualifiersOk(tokens, countryPhrases(rowWhere(row))) ? 0 : -1;
}
