import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart, type SeedBirthSpec } from './interpretation.helpers';
import { waitForLifeAtlasAsOf } from './lifeAtlas.helpers';
import { gotoSettled } from './portableInvariants.helpers';
import { TRIP_ACCEPTANCE_MODELS } from './realModel';
import { test } from './webkitProfile';

/**
 * The trip/today acceptance matrix against LIVE OpenRouter models (2026-10-14). Harish's 09:22 PT
 * turn failed: a September question in a May 2019 trip read May, and two rows were errors. One run
 * per question on one model had passed before; this runs every question on every model
 * TRIP_ACCEPTANCE_RUNS times and fails a run on any miss.
 *
 * Per question it logs every tool call (name, args, status, an error summary) as one JSONL line in
 * TRIP_ACCEPTANCE_LOG; scripts/trip-acceptance-report.mjs prints the pass rate per question x model.
 *
 * The persona is synthetic (Mumbai, 17 Mar 1985 06:22 IST): Aquarius lagna, Capricorn Moon in
 * Shravana, like the profile under test, so 2019 is Sade Sati phase 1. Self-skips without
 * OPENROUTER_API_KEY.
 *
 * trip-obstacles (2026-10-14) asks the obstacles question on OBSTACLES_PERSONA, the engine's
 * SYNTHETIC_AQUARIUS (backend/tests/test_difficult_houses.py): Aquarius lagna ~28°53', Moon in
 * Capricorn Shravana pada 3, Mars and Rahu in the 12th. Its September 2019 reading has a strong
 * obstacles theme ("Saturn (maha) rules the 12th: losses and expenses") and a 25 Sep Mars window.
 */
const PERSONA: SeedBirthSpec = {
  name: 'Acceptance Native',
  datetimeUtc: '1985-03-17T00:52:00.000Z',
  latitude: 18.9667,
  longitude: 72.8333,
  referenceDate: '2026-10-14T00:00:00+00:00',
  chartId: 'trip-acceptance-1985',
  birthDatetimeLocal: '1985-03-17T06:22:00',
  timezone: 'Asia/Kolkata',
  city: 'Mumbai',
  state: 'Maharashtra',
  country: 'India',
  locationName: 'Mumbai, Maharashtra, India',
};

/** SYNTHETIC_AQUARIUS: not a real person (1971-09-30 11:40 UTC, 13.08 N 80.27 E, IST). */
const OBSTACLES_PERSONA: SeedBirthSpec = {
  name: 'Obstacles Native',
  datetimeUtc: '1971-09-30T11:40:00.000Z',
  latitude: 13.08,
  longitude: 80.27,
  referenceDate: '2026-10-14T00:00:00+00:00',
  chartId: 'trip-acceptance-obstacles-1971',
  birthDatetimeLocal: '1971-09-30T17:10:00',
  timezone: 'Asia/Kolkata',
  city: 'Chennai',
  state: 'Tamil Nadu',
  country: 'India',
  locationName: 'Chennai, Tamil Nadu, India',
};

const RUNS = Number(process.env.TRIP_ACCEPTANCE_RUNS ?? 3);
const MODELS = process.env.TRIP_ACCEPTANCE_MODEL_LIST?.split(',').filter(Boolean) ?? TRIP_ACCEPTANCE_MODELS;
const LOG = process.env.TRIP_ACCEPTANCE_LOG ?? 'test-results/trip-acceptance.jsonl';
const VIEWER_ZONE = 'America/Los_Angeles';
const TURN_TIMEOUT_MS = 420_000;

interface Period {
  readonly start: string;
  readonly end: string;
}

/** What one question must read: periods that count as "the month asked", and the place. */
interface Expectation {
  readonly id: string;
  readonly question: string;
  /** A reading counts when its period is one of these, or falls inside `within`. */
  readonly periods: readonly Period[];
  readonly within?: Period;
  readonly place: { readonly label?: RegExp; readonly timezone: string };
  /** The answer must name Sade Sati (2019 for a Capricorn Moon). */
  readonly sadeSati: boolean;
  /** The answer must name the obstacles theme, its factor and its 25 Sep Mars window. */
  readonly obstacles?: boolean;
}

interface Journey {
  readonly id: string;
  /** A trip's place query and title, or undefined for a today thread. */
  readonly trip?: { readonly where: string; readonly title: RegExp };
  /** The chart under test; PERSONA unless the journey names another. */
  readonly persona?: SeedBirthSpec;
  readonly questions: readonly Expectation[];
}

interface ToolRow {
  readonly name: string;
  readonly status: string;
  readonly args: unknown;
  readonly result: unknown;
}

function monthPeriod(month: string): Period {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}

function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, index - 1 + by, 1)).toISOString().slice(0, 7);
}

/** This month in the viewer's zone (the app's one "today"). */
function viewerMonth(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: VIEWER_ZONE, year: 'numeric', month: '2-digit' }).format(new Date());
}

function tripQuestions(place: Expectation['place']): Expectation[] {
  return [
    { id: 'T1', question: 'What did September 2019 look like for me?', periods: [monthPeriod('2019-09')], place, sadeSati: true },
    { id: 'T2', question: 'How was May 2019 for me?', periods: [monthPeriod('2019-05')], place, sadeSati: true },
    {
      id: 'T3', question: 'What about the rest of 2019?', periods: [{ start: '2019-01-01', end: '2019-12-31' }],
      within: { start: '2019-06-01', end: '2019-12-31' }, place, sadeSati: true,
    },
  ];
}

function journeys(): Journey[] {
  const now = viewerMonth();
  const today = { timezone: VIEWER_ZONE };
  const vadodara = { label: /Vadodara/, timezone: 'Asia/Kolkata' };
  const singapore = { label: /Singapore/, timezone: 'Asia/Singapore' };
  return [
    { id: 'trip-vadodara', trip: { where: 'Vadodara', title: /^⏳ May 2019 · Vadodara/ }, questions: tripQuestions(vadodara) },
    {
      id: 'today', questions: [
        { id: 'D1', question: 'What does this month look like for me?', periods: [monthPeriod(now)], place: today, sadeSati: false },
        { id: 'D2', question: 'And next month?', periods: [monthPeriod(shiftMonth(now, 1))], place: today, sadeSati: false },
        {
          id: 'D3', question: 'What are the next 3 months like?', periods: [0, 1, 2, 3].map((by) => monthPeriod(shiftMonth(now, by))),
          place: today, sadeSati: false,
        },
      ],
    },
    { id: 'trip-singapore', trip: { where: 'Singapore', title: /^⏳ May 2019 · Singapore/ }, questions: tripQuestions(singapore).slice(0, 1).map((q) => ({ ...q, id: 'S1' })) },
    {
      id: 'trip-obstacles', persona: OBSTACLES_PERSONA, trip: { where: 'Vadodara', title: /^⏳ May 2019 · Vadodara/ },
      questions: tripQuestions(vadodara).slice(0, 1).map((q) => ({ ...q, id: 'O1', obstacles: true })),
    },
  ];
}

async function configureModel(page: Page, model: string, key: string): Promise<void> {
  const config = JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1', apiKey: key, model, chatModel: model, privacyMode: 'cloud_premium', engine: 'openai-http',
  });
  await page.addInitScript(([storageKey, cfg]) => window.localStorage.setItem(storageKey as string, cfg as string), [LLM_SETTINGS_KEY, config] as const);
}

async function travelToMay2019(page: Page, trip: NonNullable<Journey['trip']>): Promise<void> {
  await page.getByTestId('time-travel-button').click();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption('05');
  await page.getByTestId('time-travel-month-year').selectOption('2019');
  await page.getByTestId('time-travel-where-input').fill(trip.where);
  await page.getByTestId('time-travel-where-option-0').click({ timeout: 60_000 });
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('chat-thread-title')).toHaveText(trip.title);
}

/** Open every row from `from` on and read the exact args and result the model got. */
async function readRows(page: Page, from: number): Promise<ToolRow[]> {
  const rows = page.getByTestId('chat-tool-call');
  const count = await rows.count();
  const read: ToolRow[] = [];
  for (let index = from; index < count; index += 1) {
    const row = rows.nth(index);
    await row.getByTestId('chat-tool-call-summary').click();
    const parse = async (testId: string) => JSON.parse((await row.getByTestId(testId).textContent()) || 'null') as unknown;
    read.push({
      name: (await row.getAttribute('data-tool-name')) ?? '',
      status: (await row.getAttribute('data-status')) ?? '',
      args: await parse('chat-tool-call-args'),
      result: await parse('chat-tool-call-result'),
    });
  }
  return read;
}

async function ask(page: Page, question: string): Promise<{ readonly rows: ToolRow[]; readonly answer: string; readonly errorBubble: string | undefined }> {
  const before = await page.getByTestId('chat-tool-call').count();
  const answersBefore = await page.getByTestId('chat-message-assistant').count();
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send-button').click();
  // The ⏳ button is disabled only while an answer streams.
  await expect(page.getByTestId('time-travel-button')).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByTestId('time-travel-button')).toBeEnabled({ timeout: TURN_TIMEOUT_MS });
  const answers = await page.getByTestId('chat-message-assistant').allTextContents();
  const bubbles = await page.getByTestId('chat-error-bubble').allTextContents();
  return {
    rows: await readRows(page, before),
    answer: answers.length > answersBefore ? (answers[answers.length - 1] ?? '') : '',
    errorBubble: bubbles[bubbles.length - 1],
  };
}

interface ReadingLike {
  readonly period?: Period;
  readonly place?: { readonly label?: string; readonly timezone?: string };
  readonly dashas?: { readonly maha?: ReadonlyArray<{ lord?: string }>; readonly antar?: ReadonlyArray<{ lord?: string }> };
  readonly sky?: ReadonlyArray<{ readonly tags?: readonly string[] }>;
}

/** Completed readings. A repeated identical call gets a pointer to the first result (no period): not a reading. */
function readings(rows: readonly ToolRow[]): ReadingLike[] {
  return rows.filter((row) => row.name === 'get_period_reading' && row.status === 'complete')
    .map((row) => row.result as ReadingLike).filter((reading) => reading?.period !== undefined);
}

function matches(period: Period | undefined, expectation: Expectation): boolean {
  if (!period) return false;
  if (expectation.periods.some((p) => p.start === period.start && p.end === period.end)) return true;
  const within = expectation.within;
  return within !== undefined && period.start >= within.start && period.end <= within.end;
}

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

function checkAnswer(expectation: Expectation, answer: string, reading: ReadingLike | undefined): string[] {
  const misses: string[] = [];
  if (!reading) return ['no completed get_period_reading for the period asked'];
  const lord = (spans: ReadonlyArray<{ lord?: string }> | undefined) => (spans ?? []).map((span) => span.lord).filter((name): name is string => Boolean(name));
  const mahas = lord(reading.dashas?.maha);
  const antars = lord(reading.dashas?.antar);
  const names = (list: string[]) => list.some((name) => new RegExp(`\\b${name}\\b`, 'i').test(answer));
  if (!names(mahas)) misses.push(`answer names no maha lord (${mahas.join('/')})`);
  if (!names(antars)) misses.push(`answer names no antar lord (${antars.join('/')})`);
  if (!LORDSHIP.test(answer)) misses.push('answer names no lordship ("Nth lord", "rules the Nth")');
  const tags = (reading.sky ?? []).flatMap((row) => row.tags ?? []);
  if (expectation.sadeSati && !/sade[\s-]*sati/i.test(answer)) misses.push('answer does not name Sade Sati');
  if (tags.length > 0 && !tags.some((tag) => tagPattern(tag).test(answer))) misses.push(`answer names no Moon tag (${[...new Set(tags)].join(', ')})`);
  if (!DATED_WINDOW.test(answer)) misses.push('answer gives no dated window');
  if (!CONFIDENCE.test(answer) && !tableConfidence(answer)) misses.push('answer gives no confidence level');
  if (expectation.place.label && !expectation.place.label.test(answer)) misses.push(`answer does not name the place ${expectation.place.label}`);
  if (expectation.obstacles) misses.push(...obstaclesMisses(answer));
  return misses;
}

function errorSummary(row: ToolRow): string | undefined {
  if (row.status !== 'error') return undefined;
  const result = row.result as { error?: unknown; reason?: unknown; message?: unknown; code?: unknown } | null;
  return String(result?.error ?? result?.reason ?? result?.message ?? result?.code ?? 'error').slice(0, 240);
}

/** Every miss for one question: rows, the period read, the place, the answer. */
function verdict(expectation: Expectation, rows: readonly ToolRow[], answer: string, errorBubble: string | undefined): string[] {
  const misses: string[] = [];
  if (errorBubble) misses.push(`error bubble: ${errorBubble.slice(0, 200)}`);
  if (!answer.trim()) misses.push('no answer');
  for (const row of rows) if (row.status === 'error') misses.push(`error row ${row.name}: ${errorSummary(row)}`);
  const read = readings(rows);
  const asked = read.find((reading) => matches(reading.period, expectation));
  if (!asked) misses.push(`no reading of the period asked; read ${read.map((r) => `${r.period?.start}..${r.period?.end}`).join(', ') || 'none'}`);
  for (const reading of read) {
    if (reading.place?.timezone !== expectation.place.timezone) misses.push(`reading place zone ${reading.place?.timezone}, expected ${expectation.place.timezone}`);
    if (expectation.place.label && !expectation.place.label.test(reading.place?.label ?? '')) misses.push(`reading place ${reading.place?.label}`);
  }
  if (/shanghai/i.test(JSON.stringify(rows)) || /shanghai/i.test(answer)) misses.push('Shanghai appears');
  return [...misses, ...checkAnswer(expectation, answer, asked)];
}

function log(line: Record<string, unknown>): void {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${JSON.stringify(line)}\n`);
}

for (const model of MODELS) {
  for (let run = 1; run <= RUNS; run += 1) {
    for (const journey of journeys()) {
      test(`[real] ${model} run ${run}: ${journey.id}`, async ({ page }, testInfo) => {
        const key = process.env.OPENROUTER_API_KEY;
        test.skip(!key, 'OPENROUTER_API_KEY not set');
        test.skip(testInfo.project.name !== 'chromium', 'Chromium only.');
        await configureModel(page, model, key ?? '');
        await bootEngine(page);
        await seedChart(page, { birth: journey.persona ?? PERSONA });
        await gotoSettled(page, '/dashboard');
        await waitForLifeAtlasAsOf(page);
        await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
        if (journey.trip) await travelToMay2019(page, journey.trip);
        const failures: string[] = [];
        for (const expectation of journey.questions) {
          const started = Date.now();
          const { rows, answer, errorBubble } = await ask(page, expectation.question);
          const misses = verdict(expectation, rows, answer, errorBubble);
          const asked = readings(rows).find((reading) => matches(reading.period, expectation));
          log({
            at: new Date().toISOString(), model, run, journey: journey.id, question: expectation.id, text: expectation.question,
            pass: misses.length === 0, misses, seconds: Math.round((Date.now() - started) / 1000),
            tools: rows.map((row) => ({ name: row.name, args: row.args, status: row.status, error: errorSummary(row),
              period: (row.result as ReadingLike | null)?.period, place: (row.result as ReadingLike | null)?.place })),
            // The facts the answer was checked against, so a log can be re-scored offline.
            reading: asked ? {
              period: asked.period, place: asked.place, maha: asked.dashas?.maha?.map((span) => span.lord),
              antar: asked.dashas?.antar?.map((span) => span.lord), tags: [...new Set((asked.sky ?? []).flatMap((row) => row.tags ?? []))],
            } : null,
            answer: answer.replace(/\s+/g, ' ').trim().slice(0, 6000),
          });
          failures.push(...misses.map((miss) => `${expectation.id}: ${miss}`));
        }
        expect(failures, failures.join('\n')).toEqual([]);
      });
    }
  }
}
