import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { rangeCallMisses, textMisses, type RangeCall } from './answerChecks';
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
 *
 * Tool layer redesign (2026-10-14, Task 9): readings come from read_period rows. T3 must be read in
 * ONE read_period range call to 31 Dec 2019. trip-novato types "novato, ca" in the trip's Where?
 * box and picks "Novato, California" by its text; chat-springfield asks about Springfield in a
 * today thread and picks "Springfield, Illinois" in the chat's "Which Springfield?" picker.
 * TRIP_ACCEPTANCE_JOURNEYS (comma list of journey ids) runs a subset.
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
const JOURNEYS = process.env.TRIP_ACCEPTANCE_JOURNEYS?.split(',').map((id) => id.trim()).filter(Boolean);
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
  /** The reading's place; `answerLabel` (default `label`) is what the answer must name. */
  readonly place: { readonly label?: RegExp; readonly timezone: string; readonly answerLabel?: RegExp };
  /** The turn must read the period in exactly one read_period call over this range (T3). */
  readonly oneRangeCall?: RangeCall;
  /** The chat's "Which ...?" picker opens mid-turn; choose the option containing this text. */
  readonly pick?: string;
  /** The answer must name Sade Sati (2019 for a Capricorn Moon). */
  readonly sadeSati: boolean;
  /** The answer must name the obstacles theme, its factor and its 25 Sep Mars window. */
  readonly obstacles?: boolean;
}

interface Journey {
  readonly id: string;
  /** A trip's place query and title, or undefined for a today thread. `option` picks the Where? option by its text (else the first). */
  readonly trip?: { readonly where: string; readonly title: RegExp; readonly option?: string };
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
      oneRangeCall: { startBy: '2019-06-01', end: '2019-12-31' },
    },
  ];
}

function journeys(): Journey[] {
  const now = viewerMonth();
  const today = { timezone: VIEWER_ZONE };
  const vadodara = { label: /Vadodara/, timezone: 'Asia/Kolkata' };
  const singapore = { label: /Singapore/, timezone: 'Asia/Singapore' };
  const novato = { label: /Novato/, timezone: 'America/Los_Angeles' };
  const springfield = { label: /Springfield, Illinois/, timezone: 'America/Chicago', answerLabel: /Springfield/ };
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
    {
      id: 'trip-novato', trip: { where: 'novato, ca', option: 'Novato, California', title: /^⏳ May 2019 · Novato/ },
      questions: [{ id: 'N1', question: 'What did May 2019 look like for me?', periods: [monthPeriod('2019-05')], place: novato, sadeSati: true }],
    },
    {
      id: 'chat-springfield', questions: [{
        id: 'P1', question: 'What did May 2019 look like for me in Springfield?', periods: [monthPeriod('2019-05')],
        place: springfield, sadeSati: true, pick: 'Springfield, Illinois',
      }],
    },
  ].filter((journey) => !JOURNEYS || JOURNEYS.includes(journey.id));
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
  const options = page.locator('[data-testid^="time-travel-where-option-"]');
  const option = trip.option ? options.filter({ hasText: trip.option }).first() : page.getByTestId('time-travel-where-option-0');
  await option.click({ timeout: 60_000 });
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

interface TurnRow { readonly turn: number }
interface CallRow extends TurnRow { readonly name: string; readonly status: string; readonly validFirstTry: boolean; readonly retryReason?: string }

/** The app's own telemetry (agentRoundTelemetry.ts, hook builds): every round and call row recorded so far. */
async function telemetry(page: Page): Promise<{ readonly rounds: TurnRow[]; readonly calls: CallRow[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __almameshAgentRounds?: () => TurnRow[]; __almameshAgentCalls?: () => CallRow[] };
    return { rounds: [...(w.__almameshAgentRounds?.() ?? [])], calls: [...(w.__almameshAgentCalls?.() ?? [])] };
  });
}

/**
 * Per question (tool layer redesign 2026-10-14): model requests; every call and those valid on the first try
 * (the answer included); the same for tool calls only (read_period, travel); 1 when the first answer submission
 * was accepted; retries and error rows over every call; rejected answers; and why each retried call was rejected.
 */
interface TurnMetrics {
  readonly rounds: number;
  readonly calls: number;
  readonly validFirstTry: number;
  readonly toolCalls: number;
  readonly toolValidFirstTry: number;
  readonly answerValidFirstTry: number;
  readonly retries: number;
  readonly answerRetries: number;
  readonly errorRows: number;
  readonly retryReasons: string[];
}

function turnMetrics(after: { readonly rounds: TurnRow[]; readonly calls: CallRow[] }, lastTurnBefore: number): TurnMetrics {
  const calls = after.calls.filter((row) => row.turn > lastTurnBefore);
  const tools = calls.filter((row) => row.name !== 'answer');
  const answers = calls.filter((row) => row.name === 'answer');
  const retried = calls.filter((row) => row.status === 'retried');
  return {
    rounds: after.rounds.filter((row) => row.turn > lastTurnBefore).length,
    calls: calls.length,
    validFirstTry: calls.filter((row) => row.validFirstTry).length,
    toolCalls: tools.length,
    toolValidFirstTry: tools.filter((row) => row.validFirstTry).length,
    answerValidFirstTry: answers[0]?.status !== 'retried' && answers[0]?.validFirstTry === true ? 1 : 0,
    retries: retried.length,
    answerRetries: answers.filter((row) => row.status === 'retried').length,
    errorRows: calls.filter((row) => row.status === 'error').length,
    retryReasons: retried.map((row) => `${row.name}: ${row.retryReason ?? '(no reason recorded)'}`),
  };
}

/**
 * Wait for the chat's place picker while the turn runs and choose the option containing `text`.
 * A miss when the turn ends without a picker, or the picker offers no such option.
 */
async function pickPlace(page: Page, text: string): Promise<string | undefined> {
  const picker = page.getByTestId('place-pick');
  const ended = expect(page.getByTestId('time-travel-button')).toBeEnabled({ timeout: TURN_TIMEOUT_MS }).then(() => 'ended' as const, () => 'ended' as const);
  const shown = picker.waitFor({ state: 'visible', timeout: TURN_TIMEOUT_MS }).then(() => 'shown' as const, () => 'ended' as const);
  if ((await Promise.race([shown, ended])) !== 'shown') return `no place picker for "${text}"`;
  const option = page.locator('[data-testid^="place-pick-option-"]').filter({ hasText: text }).first();
  try {
    await option.click({ timeout: 30_000 });
  } catch {
    const offered = await page.locator('[data-testid^="place-pick-option-"]').allTextContents();
    return `place picker offered no "${text}": ${offered.join(' | ').slice(0, 200)}`;
  }
  await expect(picker).toBeHidden({ timeout: 30_000 });
  return undefined;
}

async function ask(page: Page, question: string, pick?: string): Promise<{ readonly rows: ToolRow[]; readonly answer: string; readonly errorBubble: string | undefined; readonly pickMiss: string | undefined; readonly metrics: TurnMetrics }> {
  const before = await page.getByTestId('chat-tool-call').count();
  const seen = await telemetry(page);
  const lastTurnBefore = Math.max(0, ...seen.rounds.map((row) => row.turn), ...seen.calls.map((row) => row.turn));
  const answersBefore = await page.getByTestId('chat-message-assistant').count();
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send-button').click();
  // The ⏳ button is disabled only while an answer streams.
  await expect(page.getByTestId('time-travel-button')).toBeDisabled({ timeout: 30_000 });
  const pickMiss = pick ? await pickPlace(page, pick) : undefined;
  await expect(page.getByTestId('time-travel-button')).toBeEnabled({ timeout: TURN_TIMEOUT_MS });
  const answers = await page.getByTestId('chat-message-assistant').allTextContents();
  const bubbles = await page.getByTestId('chat-error-bubble').allTextContents();
  return {
    rows: await readRows(page, before),
    answer: answers.length > answersBefore ? (answers[answers.length - 1] ?? '') : '',
    errorBubble: bubbles[bubbles.length - 1],
    pickMiss,
    metrics: turnMetrics(await telemetry(page), lastTurnBefore),
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
  return rows.filter((row) => row.name === 'read_period' && row.status === 'complete')
    .map((row) => row.result as ReadingLike).filter((reading) => reading?.period !== undefined);
}

function matches(period: Period | undefined, expectation: Expectation): boolean {
  if (!period) return false;
  if (expectation.periods.some((p) => p.start === period.start && p.end === period.end)) return true;
  const within = expectation.within;
  return within !== undefined && period.start >= within.start && period.end <= within.end;
}

function checkAnswer(expectation: Expectation, answer: string, reading: ReadingLike | undefined): string[] {
  if (!reading) return ['no completed read_period for the period asked'];
  const lord = (spans: ReadonlyArray<{ lord?: string }> | undefined) => (spans ?? []).map((span) => span.lord).filter((name): name is string => Boolean(name));
  return textMisses(answer, {
    maha: lord(reading.dashas?.maha),
    antar: lord(reading.dashas?.antar),
    tags: (reading.sky ?? []).flatMap((row) => row.tags ?? []),
    sadeSati: expectation.sadeSati,
    placeLabel: expectation.place.answerLabel ?? expectation.place.label,
    obstacles: expectation.obstacles,
  });
}

function errorSummary(row: ToolRow): string | undefined {
  if (row.status !== 'error') return undefined;
  const result = row.result as { error?: unknown; reason?: unknown; message?: unknown; code?: unknown } | null;
  return String(result?.error ?? result?.reason ?? result?.message ?? result?.code ?? 'error').slice(0, 240);
}

/** Every miss for one question: rows, the period read, the place, the answer. */
function verdict(expectation: Expectation, rows: readonly ToolRow[], answer: string, errorBubble: string | undefined, pickMiss?: string): string[] {
  const misses: string[] = [];
  if (pickMiss) misses.push(pickMiss);
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
  if (expectation.oneRangeCall) misses.push(...rangeCallMisses(rows, expectation.oneRangeCall));
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
          const { rows, answer, errorBubble, pickMiss, metrics } = await ask(page, expectation.question, expectation.pick);
          const misses = verdict(expectation, rows, answer, errorBubble, pickMiss);
          const asked = readings(rows).find((reading) => matches(reading.period, expectation));
          log({
            at: new Date().toISOString(), model, run, journey: journey.id, question: expectation.id, text: expectation.question,
            pass: misses.length === 0, misses, seconds: Math.round((Date.now() - started) / 1000),
            ...metrics,
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
