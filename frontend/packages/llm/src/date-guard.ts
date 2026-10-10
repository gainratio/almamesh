// The deterministic date guard. Prompt rules ask for month precision and
// engine-only months; this check does not trust them. After a timeline
// section is parsed, any sentence carrying a day-precision date, or a month
// (YYYY-MM or a month name with a year, en/es/pt) that is not in the months
// the engine put in that section's input, is removed. Removals are counted so
// a model that keeps inventing dates is visible.
//
// Month names are a fixed list, not built from Intl: ICU's short forms vary by
// browser. A name only counts as a month when a 4-digit year follows it, so
// ordinary words ("Mar", "set", "may") without a year are left alone.
//
// Day precision is always removed, whatever the month: ISO dates and
// timestamps, "March 14, 2027", "14 de marzo de 2027", "1º de junho", a month
// then a day with no year ("October 12", "Oct 12"), a day then a 3-letter
// month ("12 Oct", "14 de out"), a cued numeric day ("on 12/14", "on 12-14",
// "On 14.03"), and the numeric forms the engine never emits ("03/2027",
// "2027.03", "3/14/2027"). Two engine months joined by a slash
// ("2026-10/2027-01") are months, not a day.
//
// Known limits (not read as dates): a decade ("the 2040s"), years in words,
// a month name with no year and no day ("in October"), fiscal years
// ("FY2031"), and a season span ("2027-28 season").
//
// A bare year (1900-2199: "in 2031", "Q3 2029", "mid-2029") is removed unless
// it is the year of a supplied month. YYYY-MM is read with any hyphen or dash
// and a one- or two-digit month ("2027–03", "2027-3").

import { dropSentences } from "./layman-jargon";

/** Exactly what the engine emits: read only from engine input slices. */
const ENGINE_MONTH = /\b(\d{4})-(\d{2})\b/g;

// ASCII hyphen-minus plus U+2010..U+2015 (hyphen, non-breaking hyphen, figure
// dash, en dash, em dash, horizontal bar).
const DASH = "[-\\u2010-\\u2015]";

/** A year-month in model prose, any dash, one- or two-digit month. */
const YEAR_MONTH = new RegExp(`(?<!\\d)(\\d{4})${DASH}(\\d{1,2})(?!\\d)`, "g");

const MONTH_NUMBER: Readonly<Record<string, number>> = {
  // en
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  // es
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, abr: 4, ago: 8, dic: 12,
  // pt
  janeiro: 1, fevereiro: 2, "março": 3, marco: 3, maio: 5, junho: 6, julho: 7,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  fev: 2, mai: 5, set: 9, out: 10, dez: 12,
};

// Longest first, so "sept" is tried before "sep" and "marzo" before "mar".
const MONTH_NAMES = Object.keys(MONTH_NUMBER)
  .sort((a, b) => b.length - a.length)
  .join("|");

// Names of 4+ letters ("March", "junio", "sept") are never ordinary words
// after a day number; 3-letter ones ("may", "set", "mar") need a year too.
const LONG_MONTH_NAMES = Object.keys(MONTH_NUMBER)
  .filter((name) => name.length >= 4)
  .sort((a, b) => b.length - a.length)
  .join("|");

// 3-letter names count before a day number only when written as a name
// ("Oct", "OCT"), so lowercase prose ("may 5 times", "set 3 goals") is left alone.
const SHORT_NAMES = Object.keys(MONTH_NUMBER)
  .filter((name) => name.length === 3)
  .join("|");
const CAPITALIZED_SHORT_NAMES = SHORT_NAMES.split("|")
  .flatMap((name) => [name[0].toUpperCase() + name.slice(1), name.toUpperCase()])
  .join("|");

// Between a month name and its year: "March 2027", "March, 2027",
// "marzo de/del 2027", "March of 2027", "março/2027".
const TO_YEAR = `(?:,?(?:\\s+(?:del?|of))?\\s+|\\s*/\\s*)`;
const MONTH = `(?<!\\p{L})(?:${MONTH_NAMES})\\.?`;

// "<month> <year>"; the name must start a word.
const NAMED_MONTH = new RegExp(`(?<!\\p{L})(${MONTH_NAMES})\\.?${TO_YEAR}(\\d{4})\\b`, "giu");

// The start of a month range that shares the end month's year, as quarter
// titles print it: "Feb-Apr 2027", "fev.-abr. 2027", "Feb/Mar 2027". The start
// month is read with that year.
const RANGE_START = new RegExp(
  `(?<!\\p{L})(${MONTH_NAMES})\\.?\\s*(?:${DASH}|/)\\s*${MONTH}${TO_YEAR}(\\d{4})\\b`,
  "giu",
);

const DAY_SUFFIX = `(?:st|nd|rd|th|º|°)?`;
// A day number after a month name, year or not: "October 12", "marzo 14",
// "março de 14", "March 14th".
const THEN_DAY = `\\.?(?:\\s+de)?\\s+\\d{1,2}${DAY_SUFFIX}(?![\\d\\p{L}])`;
const DAY_PRECISION: readonly RegExp[] = [
  // ISO date or timestamp, any dash: 2027-03-14, 2027‑03‑14, 2027-03-14T00:00.
  new RegExp(`(?<!\\d)\\d{4}${DASH}\\d{1,2}${DASH}\\d{1,2}(?!\\d)`),
  // Month, day, year: "March 14, 2027", "Mar. 14th 2027".
  new RegExp(`${MONTH}\\s+\\d{1,2}${DAY_SUFFIX},?\\s+\\d{4}\\b`, "iu"),
  // Long month name then a day, no year: "October 12", "marzo 14", "MARCH 3".
  new RegExp(`(?<!\\p{L})(?:${LONG_MONTH_NAMES})${THEN_DAY}`, "iu"),
  // Capitalized 3-letter name then a day, no year: "Oct 12", "Oct. 12", "Set 3".
  new RegExp(`(?<!\\p{L})(?:${CAPITALIZED_SHORT_NAMES})${THEN_DAY}`, "u"),
  // Day before a long month name, year optional: "14 March", "1º de junho".
  new RegExp(`(?<![\\d\\p{L}])\\d{1,2}${DAY_SUFFIX}(?:\\s+(?:de|of))?\\s+(?:${LONG_MONTH_NAMES})(?!\\p{L})`, "iu"),
  // Day before any month name with a year: "3 de jun. de 2027".
  new RegExp(`(?<![\\d\\p{L}])\\d{1,2}${DAY_SUFFIX}(?:\\s+(?:de|of))?\\s+${MONTH}${TO_YEAR}\\d{4}\\b`, "iu"),
  // Day before a 3-letter name, no year: "12 Oct", "3rd of Dec" written as a
  // name, or any case after "de" ("14 de out"), so "3 set tries" is left alone.
  new RegExp(`(?<![\\d\\p{L}])\\d{1,2}${DAY_SUFFIX}(?:\\s+(?:de|of))?\\s+(?:${CAPITALIZED_SHORT_NAMES})(?!\\p{L})`, "u"),
  new RegExp(`(?<![\\d\\p{L}])\\d{1,2}${DAY_SUFFIX}\\s+de\\s+(?:${SHORT_NAMES})(?!\\p{L})`, "iu"),
  // Numeric: 3/14/2027, 14.03.2027, 03/2027, 2027/03, 2027.03. The month of a
  // YYYY-MM is not a day ("2026-10/2027-01" is two engine months).
  new RegExp(
    `(?<![\\d/.])(?<!\\d{4}${DASH})(?:\\d{1,2}[/.]\\d{1,2}[/.]\\d{4}|\\d{1,2}[/.]\\d{4}|\\d{4}[/.]\\d{1,2})(?!\\d)`,
  ),
];

// The jargon guard's sentence splitter, except that two kinds of period do not
// end a sentence: an abbreviated month's, when a number, connector or range
// mark follows ("dez. 2027", "Mar. 14", "fev.-abr."), and one between digits
// ("14.03.2027"). Concatenating every piece still reproduces the input.
const ABBREVIATION_DOT = `(?<!\\p{L})(?:${MONTH_NAMES})\\.(?=\\s*[-–/,]|\\s+(?:(?:del?|of)\\s+)?\\d)`;
const SENTENCE_OR_BREAK = new RegExp(
  `(?:${ABBREVIATION_DOT}|(?<=\\d)\\.(?=\\d)|[^.!?…\\n])+(?:[.!?…]+["'”’)\\]]*)?[ \\t]*|[.!?…]+[ \\t]*|\\n+`,
  "giu",
);

// A date cue before a bare "d/d": "on 12/14", "by 3/14", "el 14/3", "a partir
// de 1/7". Without a cue "d/d" is a fraction or a score ("1/2 cup", "10/10"),
// which no shape test can tell from a date, so the cue is required.
const CUED_DAY_MONTH =
  /(?<!\p{L})(?:on|by|from|until|till|before|after|el|em|desde|hasta|até|a partir de|antes de|después de|depois de)\s+(?:the\s+|o\s+|dia\s+)?(\d{1,2})\/(\d{1,2})(?![\d/])/giu;

function isDayMonthPair(a: number, b: number): boolean {
  return a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
}

// The same with "-" or "." ("on 12-14", "On 14.03"), only after an "on"-type
// cue and with a two-digit second number, so "by 3-4 weeks" and "on 3.5
// stars" are left alone.
const CUED_DASH_DAY_MONTH =
  /(?<!\p{L})(?:on|el|em|dia)\s+(?:the\s+|o\s+|dia\s+)?(\d{1,2})[-.](\d{2})(?!\d|[-./]\d)/giu;

function hasCuedDayMonth(sentence: string): boolean {
  return [...sentence.matchAll(CUED_DAY_MONTH), ...sentence.matchAll(CUED_DASH_DAY_MONTH)].some(([, a, b]) =>
    isDayMonthPair(Number(a), Number(b)),
  );
}

// A standalone year 1900-2199, not glued to a digit, letter or currency mark
// and not a digit group ("2,050"): "in 2031", "Q3 2029", "mid-2029".
const BARE_YEAR = /(?<![\d\p{L}$€£]|\d[,.])((?:19|20|21)\d\d)(?![\d\p{L}])/gu;

function isMonthNumber(month: number): boolean {
  return month >= 1 && month <= 12;
}

function yearMonthsIn(sentence: string): string[] {
  return [...sentence.matchAll(YEAR_MONTH)]
    .filter(([, , month]) => isMonthNumber(Number(month)))
    .map(([, year, month]) => `${year}-${month.padStart(2, "0")}`);
}

/** Years outside every YYYY-MM in the sentence, which the month rule reads instead. */
function bareYears(sentence: string): string[] {
  const rest = sentence.replace(YEAR_MONTH, (match, _year: string, month: string) =>
    isMonthNumber(Number(month)) ? " " : match,
  );
  return [...rest.matchAll(BARE_YEAR)].map(([, year]) => year);
}

function namedMonths(sentence: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const [, name, year] of sentence.matchAll(pattern)) {
    const month = MONTH_NUMBER[name.toLowerCase()];
    if (month !== undefined) out.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return out;
}

function monthsMentioned(sentence: string): string[] {
  return [...yearMonthsIn(sentence), ...namedMonths(sentence, NAMED_MONTH), ...namedMonths(sentence, RANGE_START)];
}

/** The months a section may name, and the years those months fall in. */
interface AllowedDates {
  readonly months: ReadonlySet<string>;
  readonly years: ReadonlySet<string>;
}

function hasDayPrecision(sentence: string): boolean {
  return DAY_PRECISION.some((pattern) => pattern.test(sentence)) || hasCuedDayMonth(sentence);
}

function offends(sentence: string, allowed: AllowedDates): boolean {
  if (hasDayPrecision(sentence)) return true;
  if (monthsMentioned(sentence).some((month) => !allowed.months.has(month))) return true;
  return bareYears(sentence).some((year) => !allowed.years.has(year));
}

/**
 * Remove every sentence, in every string anywhere in `section`, that carries a
 * day-precision date, a month not in `allowedMonths`, or a bare year that is
 * not the year of an allowed month. Returns a new value of
 * the same shape (the input is not mutated) and the number of sentences removed.
 */
export function validateTimelineDates<T>(
  section: T,
  allowedMonths: ReadonlySet<string>,
): { section: T; removals: number } {
  let removals = 0;
  const allowed: AllowedDates = {
    months: allowedMonths,
    years: new Set([...allowedMonths].map((month) => month.slice(0, 4))),
  };
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = dropSentences(value, (sentence) => offends(sentence, allowed), SENTENCE_OR_BREAK);
      removals += result.dropped;
      return result.text;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    }
    return value;
  };
  // The one cast: `visit` rebuilds the same shape with only string values changed.
  const guarded = visit(section) as T;
  return { section: guarded, removals };
}

/** Every `YYYY-MM` that appears anywhere in an engine input slice. */
export function monthsIn(value: unknown): ReadonlySet<string> {
  const months = new Set<string>();
  for (const [, year, month] of JSON.stringify(value).matchAll(ENGINE_MONTH)) months.add(`${year}-${month}`);
  return months;
}
