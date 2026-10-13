/** Literal calendar routing only; unsupported precision must never widen a period. */
import { EPHEMERIS_LAST_YEAR, parsePeriodArgs, type PeriodRange } from '@almamesh/llm';

export type ExplicitTimingPeriod =
  | { readonly kind: 'none' }
  | { readonly kind: 'period'; readonly period: PeriodRange }
  | { readonly kind: 'unresolved'; readonly reason: 'ambiguous_period' | 'unsupported_period' };

// Full names, then the en/es/pt short forms ("Sep", "Sept", "set.", "dez").
const MONTH_NAMES = [
  'january enero janeiro jan ene', 'february febrero fevereiro feb fev', 'march marzo março marco mar',
  'april abril apr abr', 'may mayo maio mai', 'june junio junho jun', 'july julio julho jul',
  'august agosto aug ago', 'september septiembre setiembre setembro sep sept set', 'october octubre outubro oct out',
  'november noviembre novembro nov', 'december diciembre dezembro dec dic dez',
] as const;
const MONTHS = new Map(MONTH_NAMES.flatMap((names, index) => names.split(' ').map((name) => [name, index + 1] as const)));
// A short form may carry a trailing dot ("Sep. 2019"); it belongs to the month token.
const MONTH_PATTERN = `(?:${[...MONTHS.keys()].join('|')})\\.?`;
/** Months that are also everyday words or names: they count only in calendar syntax. */
const WORD_MONTHS = new Set(['may', 'march', 'marco', 'mar', 'jan', 'set', 'out', 'ago', 'dez']);
const monthName = (token: string) => token.replace(/\.$/u, '');
const UNSUPPORTED: ExplicitTimingPeriod = { kind: 'unresolved', reason: 'unsupported_period' };
const AMBIGUOUS: ExplicitTimingPeriod = { kind: 'unresolved', reason: 'ambiguous_period' };
const NONE: ExplicitTimingPeriod = { kind: 'none' };
const VAGUE = /\b(?:early|late|mid|beginning|end|summer|winter|spring|autumn|fall|quarter|half|verano|invierno|primavera|otoño|verão|inverno|outono|trimestre|semestre|inicio|início|final)\b/u;
const RELATIVE = /\b(?:next|last|this|próximo|proximo|pasado|este|esse)\s+(?:day|week|month|year|summer|winter|spring|fall|autumn|mes|mês|ano|año|semana)\b/u;
const QUARTER = /\b(?:q[1-4]|h[12])\b/u;
const OPEN_RANGE = /\b(?:before|after|since|until|from|onwards?|antes|después|despues|depois|desde|hasta|até|ate)\b/u;
// Consume malformed suffixes too, so an unsupported ISO token cannot fall
// back to its year or a shorter valid prefix. Sentence punctuation stays out.
const ISO_TOKEN = /(?<![\p{L}\p{N}])\d{4}-[\p{L}\p{N}_-]*/gu;
const DOTTED_DATE = /(?<![\p{L}\p{N}])(?:\d{1,2}\.\d{1,2}\.\d{4}|\d{4}\.\d{1,2}(?:\.\d{1,2})?|\d{1,2}\.\d{4})(?![\p{L}\p{N}])/u;
const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\b/u;
const FRACTIONAL_ISO = /\d{4}-\d{2}(?:-\d{2})?\.\d/u;
const DAY_OR_WEEK = /\b(?:(?:first|second|third|fourth|fifth|last|primer|primera|primero|segundo|segunda|tercer|tercera|tercero|cuarto|cuarta|quinto|quinta|ultimo|ultima|primeiro|primeira|terceiro|terceira)\s+(?:days?|weeks?|dias?|semanas?)|(?:days?|weeks?|dias?|semanas?)\s+(?:\d+|of|in|de|del|do|da|en|em))\b/u;

function checked(start: string, end: string): ExplicitTimingPeriod {
  if (Number(start.slice(0, 4)) < 1900 || Number(end.slice(0, 4)) > EPHEMERIS_LAST_YEAR) return UNSUPPORTED;
  const parsed = parsePeriodArgs({ start, end });
  return parsed.kind === 'period' ? parsed : UNSUPPORTED;
}

function monthPeriod(year: string, month: number): ExplicitTimingPeriod {
  if (Number(year) < 1900 || Number(year) > EPHEMERIS_LAST_YEAR || month < 1 || month > 12) return UNSUPPORTED;
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(Number(year), month, 0)).toISOString().slice(0, 10);
  return checked(first, last);
}

/** May and March can be verbs; Marco can be a person. Require calendar syntax. */
function monthMention(match: RegExpMatchArray, text: string, total: number): boolean {
  const name = monthName(match[0]);
  if (!WORD_MONTHS.has(name)) return true;
  const before = text.slice(0, match.index);
  const after = text.slice((match.index ?? 0) + match[0].length);
  return /^\s*,?\s*(?:de\s+)?\d{4}(?!\d)/u.test(after)
    || /^\s+\d{1,2}(?:st|nd|rd|th)?(?:\D|$)/u.test(after)
    || /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:(?:de|of)\s+)?$/u.test(before)
    || /\b(?:in|during|by|around|for|en|em|de|para|desde)\s*$/u.test(before)
    || (name !== 'marco' && text.trim().replace(/[?.!]+$/u, '') === name)
    || (total > 1 && (/\b(?:and|or|y|o|ou|e)\s*$/u.test(before) || /^\s+(?:and|or|y|o|ou|e)\b/u.test(after)));
}

/**
 * Supported forms: one en/es/pt month (full or short, e.g. "Sep.") + year (optional "de"), YYYY-MM,
 * YYYY-MM-DD, or one four-digit year. Today remains the caller's decision.
 */
export function parseExplicitTimingPeriod(question: string): ExplicitTimingPeriod {
  const text = question.normalize('NFC').toLocaleLowerCase().replace(/[–—]/gu, '-');
  const allMonths = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${MONTH_PATTERN})(?![\\p{L}\\p{N}])`, 'gu'))];
  const months = allMonths.filter((match) => monthMention(match, text, allMonths.length));
  const years = [...text.matchAll(/(?<![\p{L}\p{N}])\d{4}(?![\p{L}\p{N}])/gu)];
  const numeric = [...text.matchAll(ISO_TOKEN)];
  const slash = /(?<![\p{L}\p{N}])\d+(?:\/\d+)+(?![\p{L}\p{N}])/u.test(text);
  const dotted = DOTTED_DATE.test(text);
  const hasDate = months.length > 0 || years.length > 0 || numeric.length > 0 || slash || dotted;

  if (months.length > 1 || years.length > 1 || numeric.length > 1 || (months.length > 0 && numeric.length > 0)) return AMBIGUOUS;
  const outsideNumeric = text.replace(ISO_TOKEN, '');
  if (hasDate && (/\b(?:between|entre)\b/u.test(text)
    || /\d\s*-\s*\d/u.test(outsideNumeric)
    || /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:to|through|until|a|al|até|ate|hasta)\s+\d{1,2}\b/u.test(text))) return AMBIGUOUS;
  if (slash || dotted || QUARTER.test(text)
    || (hasDate && (RELATIVE.test(text) || VAGUE.test(text) || OPEN_RANGE.test(text)
      || CLOCK.test(text) || FRACTIONAL_ISO.test(text)
      || DAY_OR_WEEK.test(text.normalize('NFD').replace(/\p{M}/gu, ''))))) return UNSUPPORTED;
  if (!hasDate) return NONE;

  if (numeric.length === 1) {
    const date = numeric[0]![0];
    if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return checked(date, date);
    if (/^\d{4}-\d{2}$/u.test(date)) return monthPeriod(date.slice(0, 4), Number(date.slice(5)));
    return UNSUPPORTED;
  }
  if (months.length === 1) {
    const month = months[0]!;
    const before = text.slice(0, month.index);
    const after = text.slice((month.index ?? 0) + month[0].length);
    const year = /^\s*,?\s*(?:de\s+)?(\d{4})(?![\p{L}\p{N}])/u.exec(after)?.[1];
    // An attached named day cannot quietly become its containing month.
    if (years.length !== 1 || !year || /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:(?:de|of)\s+)?$/u.test(before)) return UNSUPPORTED;
    return monthPeriod(year, MONTHS.get(monthName(month[0]))!);
  }
  if (years.length === 1) return checked(`${years[0]![0]}-01-01`, `${years[0]![0]}-12-31`);
  return UNSUPPORTED;
}
