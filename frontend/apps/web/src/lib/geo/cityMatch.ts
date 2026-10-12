/** Compact row shape used by the bundled reference data (keys minimised for size). */
export type CityRow = {
  n: string;
  c: string;
  cc: string;
  lat: number;
  lon: number;
  p: number;
};

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

/** Country name words + code + aliases — the searchable "where" of a row. */
function qualifierWords(row: CityRow): string[] {
  return [...placeTokens(row.c), foldPlaceText(row.cc), ...(COUNTRY_ALIASES[row.cc] ?? [])];
}

/**
 * Do the trailing (post-city) tokens read as location qualifiers? Each must
 * prefix-match a country word / code / alias — except a SINGLE trailing token
 * may go unverified: the dataset has no state/province field, so "San
 * Francisco, CA" and "San Francisco California" each strand one qualifier we
 * can't confirm. A non-trailing stray (e.g. a stranded city word like the
 * "francisco" left over when "san" alone anchored on "Sanford") rejects the row,
 * which keeps the tolerance from producing false positives.
 */
function qualifiersOk(remainder: readonly string[], qualWords: readonly string[]): boolean {
  let unverified = 0;
  for (let i = 0; i < remainder.length; i += 1) {
    if (qualWords.some((w) => w.startsWith(remainder[i]))) continue;
    unverified += 1;
    if (unverified > 1 || i !== remainder.length - 1) return false;
  }
  return true;
}

/**
 * Match a "<city> <qualifiers>" query: the leading tokens must form the city
 * name as a contiguous word-prefix phrase (anchored from the first token, so
 * "san francisco" can't scatter across "Santiago … Caballeros"), and the rest
 * must read as location qualifiers.
 */
function cityWithQualifiers(
  nameTokens: readonly string[],
  qualWords: readonly string[],
  tokens: readonly string[],
): boolean {
  if (tokens.length <= nameTokens.length) return false;
  for (let i = 0; i < nameTokens.length; i += 1) {
    if (!nameTokens[i].startsWith(tokens[i])) return false;
  }
  return qualifiersOk(tokens.slice(nameTokens.length), qualWords);
}

/** Rank: exact name > prefix > substring > qualifier-only, then by population. */
function nameScore(foldedName: string, normQuery: string): number {
  if (foldedName === normQuery) return 3;
  if (foldedName.startsWith(normQuery)) return 2;
  if (foldedName.includes(normQuery)) return 1;
  return 0;
}

/** Searchable reference text; coordinates never appear in it. */
export function citySearchText(row: CityRow): string {
  return [foldPlaceText(row.n), ...qualifierWords(row)].join(' ');
}

/** -1 means no match. Country/qualifier-only matches keep their original rank 0. */
export function cityMatchRank(row: CityRow, normQuery: string, tokens: readonly string[]): -1 | 0 | 1 | 2 | 3 {
  const name = foldPlaceText(row.n);
  const qualWords = qualifierWords(row);
  const matched = name.includes(normQuery)
    || cityWithQualifiers(splitWords(name), qualWords, tokens)
    || tokens.every((token) => qualWords.some((word) => word.startsWith(token)));
  return matched ? nameScore(name, normQuery) as 0 | 1 | 2 | 3 : -1;
}
