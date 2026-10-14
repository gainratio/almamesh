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

export type { AnswerFacts, RangeCall, RangeRow };
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
  RANGE_CALL_MISS,
  RULES,
  SEP_25,
  obstaclesMisses,
  rangeCallMisses,
  tableConfidence,
  tagPattern,
  textMisses,
};
