// The deterministic date guard. Prompt rules ask for month precision and
// engine-only months; this check does not trust them. After a timeline
// section is parsed, any sentence carrying a day-precision date, or a month
// (YYYY-MM or a month name with a year, en/es/pt) that is not in the months
// the engine put in that section's input, is removed. Removals are counted so
// a model that keeps inventing dates is visible.
//
// Month names are a fixed list, not built from Intl: ICU's short forms vary by
// browser. A name only counts as a date when a 4-digit year follows it, so
// ordinary words ("Mar", "set", "may") without a year are left alone.

import { dropSentences } from "./layman-jargon";

const DAY_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const YEAR_MONTH = /\b(\d{4})-(\d{2})\b/g;

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

// "<month>[.] [de ]<year>", case-insensitive; the name must start a word.
const NAMED_MONTH = new RegExp(
  `(?<!\\p{L})(${MONTH_NAMES})\\.?(?:\\s+de)?\\s+(\\d{4})\\b`,
  "giu",
);

// The start of a month range that shares the end month's year, as quarter
// titles print it: "Feb-Apr 2027", "fev.-abr. 2027". The start month is read
// with that year.
const RANGE_START = new RegExp(
  `(?<!\\p{L})(${MONTH_NAMES})\\.?\\s*[-–]\\s*(?:${MONTH_NAMES})\\.?(?:\\s+de)?\\s+(\\d{4})\\b`,
  "giu",
);

// The jargon guard's sentence splitter, except that the period of an
// abbreviated month followed by a year or a range dash ("dez. 2027",
// "Sept. de 2027", "fev.-abr.") does not end the sentence. Concatenating every
// piece still reproduces the input.
const ABBREVIATION_DOT = `(?<!\\p{L})(?:${MONTH_NAMES})\\.(?=\\s+(?:de\\s+)?\\d{4}\\b|\\s*[-–])`;
const SENTENCE_OR_BREAK = new RegExp(
  `(?:${ABBREVIATION_DOT}|[^.!?…\\n])+(?:[.!?…]+["'”’)\\]]*)?[ \\t]*|[.!?…]+[ \\t]*|\\n+`,
  "giu",
);

function namedMonths(sentence: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const [, name, year] of sentence.matchAll(pattern)) {
    const month = MONTH_NUMBER[name.toLowerCase()];
    if (month !== undefined) out.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return out;
}

function monthsMentioned(sentence: string): string[] {
  const numeric = [...sentence.matchAll(YEAR_MONTH)].map(([, year, month]) => `${year}-${month}`);
  return [...numeric, ...namedMonths(sentence, NAMED_MONTH), ...namedMonths(sentence, RANGE_START)];
}

function offends(sentence: string, allowed: ReadonlySet<string>): boolean {
  if (DAY_DATE.test(sentence)) return true;
  return monthsMentioned(sentence).some((month) => !allowed.has(month));
}

/**
 * Remove every sentence, in every string anywhere in `section`, that carries a
 * day-precision date or a month not in `allowedMonths`. Returns a new value of
 * the same shape (the input is not mutated) and the number of sentences removed.
 */
export function validateTimelineDates<T>(
  section: T,
  allowedMonths: ReadonlySet<string>,
): { section: T; removals: number } {
  let removals = 0;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = dropSentences(value, (sentence) => offends(sentence, allowedMonths), SENTENCE_OR_BREAK);
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
  for (const [, year, month] of JSON.stringify(value).matchAll(YEAR_MONTH)) months.add(`${year}-${month}`);
  return months;
}
