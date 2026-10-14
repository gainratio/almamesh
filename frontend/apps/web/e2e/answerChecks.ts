/**
 * The trip matrix's answer checks, shared by trip-acceptance.real.spec.ts and the renderer's
 * unit test (src/lib/__tests__/answerRender.checks.test.ts) so the two never drift. Moved verbatim
 * from the spec (2026-10-14); change a pattern here and both move together.
 */

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const DATED_WINDOW = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');
const CONFIDENCE = /\b(?:high|medium|moderate|low)(?:[- ]to[- ](?:high|medium|moderate|low))?[\s-]+confidence\b|\bconfidence\b[^.\n]{0,40}\b(?:high|medium|moderate|low)\b/i;
const LEVEL = /^(?:high|medium|moderate|low)(?:[- ]to[- ](?:high|medium|moderate|low))?$/i;

/**
 * A Markdown table with a Confidence column states a confidence level (matrix 2026-10-14: an
 * answer's "| Obstacles | Mixed | Strong | High |" row read as no confidence). The answer's text
 * comes with its whitespace collapsed, so rows are joined as "| a | b | | c | d |".
 */
function tableConfidence(answer: string): boolean {
  const chunks = answer.split(/\|\s+\|/);
  return chunks.some((chunk, index) => {
    const column = chunk.slice(chunk.indexOf('|') + 1).split('|').map((cell) => cell.trim()).findIndex((cell) => /^confidence$/i.test(cell));
    return column >= 0 && chunks.slice(index + 1).some((row) => LEVEL.test(row.split('|').map((cell) => cell.trim())[column] ?? ''));
  });
}

const GRAHA = '(?:sun|moon|mars|mercury|jupiter|venus|saturn|rahu|ketu)';
const HOUSE = '(?:\\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)';
/** "rules", and the plain-voice forms a layman answer uses for a lordship ("handles", "looks after"). */
const RULES = '(?:rul(?:es|ed|ing|er of|ership of|e over|e of)|governs?|handles?|looks after|oversees|is in charge of)';
/** A lordship: "Saturn, your 12th lord", "rules your 2nd and 11th houses", "Jupiter looks after your 2nd house", "Jupiter rules your money". */
const LORDSHIP = new RegExp([
  `\\b${HOUSE}(?:[- ]house)?[- ]lord\\b`,
  `\\blord of (?:your |the )?${HOUSE}\\b`,
  `\\b${RULES}\\b[^.\\n]{0,50}\\b(?:house|houses)?\\s*${HOUSE}\\b`,
  `\\b${GRAHA}(?:'s|’s)?\\b[^.\\n]{0,20}\\brul(?:es|ed|ing|er of|ership of|e over)\\b`,
].join('|'), 'i');

const ORDINAL_WORDS: Readonly<Record<string, string>> = {
  1: 'first|one', 2: 'second|two', 3: 'third|three', 4: 'fourth|four', 5: 'fifth|five', 6: 'sixth|six',
  7: 'seventh|seven', 8: 'eighth|eight', 9: 'ninth|nine', 10: 'tenth|ten', 11: 'eleventh|eleven', 12: 'twelfth|twelve',
};

/** A Moon-based tag as people write it: "Sade Sati", "Kantaka Shani", "7th from your Moon", "eighth-from-Moon" (jupiter_from_moon_8). */
function tagPattern(tag: string): RegExp {
  const words = tag.split('_');
  const house = words.find((word) => /^\d+(?:st|nd|rd|th)?$/.test(word))?.replace(/\D/g, '');
  if (words.includes('moon') && house) {
    const nth = `\\b(?:${house}(?:st|nd|rd|th)?|${ORDINAL_WORDS[house] ?? house})\\b`;
    return new RegExp(`${nth}[^.\\n]{0,40}\\bmoon\\b|\\bmoon\\b[^.\\n]{0,40}${nth}`, 'i');
  }
  return new RegExp(`\\b${words.slice(0, 2).filter((word) => !/^(?:phase|\d+)$/.test(word)).join('[\\s-]*')}`, 'i');
}

/** The obstacles theme in its classical words (friction with rules or authorities, legal or administrative matters, losses and expenses). */
const OBSTACLES_MEANING = /friction with (?:rules|authorit)|\blegal\b|\badministrative\b|\bloss(?:es)?\b|\bexpenses\b/i;
/** Its factor: "Saturn rules the 12th", "Saturn, your 12th lord", "Rahu in the 12th". */
const OBSTACLES_FACTOR = /\b(?:saturn|rahu)\b[^.\n]{0,60}\b(?:12th|twelfth)\b|\b(?:12th|twelfth)\b[^.\n]{0,40}\b(?:saturn|rahu)\b/i;
/** The 25 Sep 2019 Mars window. */
const SEP_25 = /\b25(?:th)?\s+sep|\bsep[a-z]*\.?\s+25(?:th)?\b|\b2019-09-25\b/i;

function obstaclesMisses(answer: string): string[] {
  const misses: string[] = [];
  if (!OBSTACLES_MEANING.test(answer)) misses.push('answer does not name the obstacles theme (rules/authorities, legal/administrative, losses)');
  if (!OBSTACLES_FACTOR.test(answer)) misses.push('answer names no obstacles factor (Saturn rules the 12th / Rahu in the 12th)');
  if (!SEP_25.test(answer)) misses.push('answer does not give the 25 Sep Mars window');
  return misses;
}

/** The facts one question's answer must name (from its reading and its expectation). */
interface AnswerFacts {
  readonly maha: readonly string[];
  readonly antar: readonly string[];
  readonly tags: readonly string[];
  readonly sadeSati: boolean;
  readonly placeLabel?: RegExp | undefined;
  readonly obstacles?: boolean | undefined;
}

/** Every miss in the answer text: the matrix's answer checks, without the tool rows. */
function textMisses(answer: string, facts: AnswerFacts): string[] {
  const misses: string[] = [];
  const names = (list: readonly string[]) => list.some((name) => new RegExp(`\\b${name}\\b`, 'i').test(answer));
  if (!names(facts.maha)) misses.push(`answer names no maha lord (${facts.maha.join('/')})`);
  if (!names(facts.antar)) misses.push(`answer names no antar lord (${facts.antar.join('/')})`);
  if (!LORDSHIP.test(answer)) misses.push('answer names no lordship ("Nth lord", "rules the Nth")');
  if (facts.sadeSati && !/sade[\s-]*sati/i.test(answer)) misses.push('answer does not name Sade Sati');
  if (facts.tags.length > 0 && !facts.tags.some((tag) => tagPattern(tag).test(answer))) misses.push(`answer names no Moon tag (${[...new Set(facts.tags)].join(', ')})`);
  if (!DATED_WINDOW.test(answer)) misses.push('answer gives no dated window');
  if (!CONFIDENCE.test(answer) && !tableConfidence(answer)) misses.push('answer gives no confidence level');
  if (facts.placeLabel && !facts.placeLabel.test(answer)) misses.push(`answer does not name the place ${facts.placeLabel}`);
  if (facts.obstacles) misses.push(...obstaclesMisses(answer));
  return misses;
}

/** A transcript tool row as the matrix reads it (name, status, the result the model got). */
interface RangeRow {
  readonly name: string;
  readonly status: string;
  readonly result: unknown;
}

/** The range one call must cover: it starts on or before `startBy` and ends on `end`. */
interface RangeCall {
  readonly startBy: string;
  readonly end: string;
}

const RANGE_CALL_MISS = 'T3 not read in one range call';

/**
 * T3 ("What about the rest of 2019?", chat tool layer redesign 2026-10-14): exactly one complete
 * read_period call in the turn, over a range that starts by `startBy` and ends on `end`. Month by
 * month reads, or a read that stops short, are a miss.
 */
function rangeCallMisses(rows: readonly RangeRow[], range: RangeCall): string[] {
  const reads = rows.filter((row) => row.name === 'read_period' && row.status === 'complete');
  const period = (reads[0]?.result as { readonly period?: { readonly start?: unknown; readonly end?: unknown } } | null | undefined)?.period;
  const start = typeof period?.start === 'string' ? period.start : undefined;
  const one = reads.length === 1 && start !== undefined && start <= range.startBy && period?.end === range.end;
  return one ? [] : [RANGE_CALL_MISS];
}

/**
 * A span one call must cover (D3 "What are the next 3 months like?"): a start from `from` up to
 * `latestStart`, an end by `to`, and at least `minMonths` consecutive calendar months.
 */
interface SpanCall {
  readonly from: string;
  readonly latestStart: string;
  readonly to: string;
  readonly minMonths: number;
}

const SPAN_CALL_MISS = 'D3 not read in one call over 3+ consecutive months';

/** Months since year 0 of a YYYY-MM-DD day, so two days' months can be subtracted. */
const monthNumber = (day: string): number => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;

/** The period is one D3 reading: it starts in the allowed months, ends in time, and spans the months asked. */
function spanFits(period: { readonly start: string; readonly end: string }, span: SpanCall): boolean {
  const { start, end } = period;
  return start >= span.from && start <= span.latestStart && end <= span.to && monthNumber(end) - monthNumber(start) + 1 >= span.minMonths;
}

/**
 * D3 (controller ruling, Task 10d): exactly one complete read_period, over a span that fits
 * `span`. A CONTRACT CHANGE from "any single month 0..3": stricter, now that read_period reads
 * ranges. Month by month reads, or one month, are a miss; the miss says what was read.
 */
function spanCallMisses(rows: readonly RangeRow[], span: SpanCall): string[] {
  const reads = rows.filter((row) => row.name === 'read_period' && row.status === 'complete');
  const periods = reads.map((row) => (row.result as { readonly period?: { readonly start?: unknown; readonly end?: unknown } } | null | undefined)?.period);
  const read = periods.flatMap((period) => (typeof period?.start === 'string' && typeof period.end === 'string' ? [{ start: period.start, end: period.end }] : []));
  const only = reads.length === 1 ? read[0] : undefined;
  if (only && spanFits(only, span)) return [];
  return [read.length > 0 ? `${SPAN_CALL_MISS}; read ${read.map((period) => `${period.start}..${period.end}`).join(', ')}` : SPAN_CALL_MISS];
}

/** A transcript tool row with the arguments the model sent. */
interface CallRow {
  readonly name: string;
  readonly status: string;
  readonly args: unknown;
}

const PLACE_CALL_MISS = 'no complete read_period named the place';
const TRAVEL_ROW_MISS = 'a travel row in a place question';

/**
 * P1 ("…in Springfield?" in a today thread): a complete read_period whose `place` argument names
 * the place (the call that opened the picker), and no travel row (the question is not a trip).
 */
function placeCallMisses(rows: readonly CallRow[], place: RegExp): string[] {
  const placeOf = (row: CallRow): unknown => (row.args as { readonly place?: unknown } | null | undefined)?.place;
  const named = rows.some((row) => row.name === 'read_period' && row.status === 'complete' && typeof placeOf(row) === 'string' && place.test(placeOf(row) as string));
  return [...(named ? [] : [`${PLACE_CALL_MISS} ${place}`]), ...(rows.some((row) => row.name === 'travel') ? [TRAVEL_ROW_MISS] : [])];
}

export type { AnswerFacts, CallRow, RangeCall, RangeRow, SpanCall };
export {
  CONFIDENCE,
  DATED_WINDOW,
  GRAHA,
  HOUSE,
  LEVEL,
  LORDSHIP,
  MONTH,
  OBSTACLES_FACTOR,
  OBSTACLES_MEANING,
  ORDINAL_WORDS,
  PLACE_CALL_MISS,
  RANGE_CALL_MISS,
  RULES,
  SEP_25,
  SPAN_CALL_MISS,
  TRAVEL_ROW_MISS,
  obstaclesMisses,
  placeCallMisses,
  rangeCallMisses,
  spanCallMisses,
  spanFits,
  tableConfidence,
  tagPattern,
  textMisses,
};
