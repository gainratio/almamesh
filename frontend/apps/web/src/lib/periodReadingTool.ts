/**
 * `get_period_reading` and `get_period_detail` (spec 2026-10-13): the chat's
 * elaborate, citable period tools. Bound to the thread: a trip's period and
 * place, or today = [today, today] at the viewer's zone. They load through the
 * same paths as get_timing (the period-sky queue, or today's Life Atlas store)
 * and return what periodReading.ts builds. Failures the model must act on are
 * RETURNED with get_timing's typed reasons, never thrown.
 */
import type { PeriodReadingContext, SiderealChart } from '@almamesh/browser/types';
import {
  BEFORE_BIRTH_MESSAGE,
  BIRTH_YEAR_SKY_NOTE,
  endsBeforeBirthYear,
  PERIOD_DETAIL_TOOL_NAME,
  PERIOD_READING_TOOL_NAME,
  startsInOrBeforeBirthYear,
  type AgentJsonObject,
  type AgentTool,
  type AgentToolContext,
  type PeriodRange,
} from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';

import { currentDateTimeForZone, viewerTodayDay } from './chatAgentTools';
import { birthUtcYearOf, birthYearOf, type PeriodChartLoader } from './periodChart';
import {
  buildPeriodDetail,
  buildPeriodReading,
  DETAIL_SECTIONS,
  summarizePeriodDetail,
  summarizePeriodReading,
  type PeriodDetailToolResult,
  type PeriodReadingFailure,
  type PeriodReadingToolResult,
  type PeriodReadingUnavailable,
  type ReadingFrame,
} from './periodReading';
import { PeriodSkyTimeoutError } from './periodSky';
import { isCachedNatalLords, isCachedPeriodReading } from './periodSkyValidation';
import { formatPinLabel } from './timeTravelSheet';
import { DEVICE_DASHAS_ONLY_NOTE, PeriodSkyUnavailableError, TIMING_TOOL_TIMEOUT_MS } from './timingTool';
import { tripContext } from './tripContext';
import { birthPlaceOf } from './tripPlacePrefill';

export interface PeriodReadingToolsInput {
  /** A trip's pin (tripPin: an old trip carries the birth place's label and zone); undefined for today. */
  readonly pin: ChatThreadAsOf | undefined;
  /** The stored natal chart (the trip frame's dasha tree and natal summary). */
  readonly chart: SiderealChart;
  /** Read for the before-birth gates (birth year) and today's place label (current location). Never echoed. */
  readonly birth: ProcessedBirthData | undefined;
  readonly language: string;
  readonly viewerZone: () => string;
  /** Today's engine contexts merged onto the chart (chatToolset loadCurrentChart). */
  readonly loadCurrentChart: (context: AgentToolContext) => Promise<SiderealChart>;
  /** A period's engine contexts merged onto the chart (periodChart.ts). */
  readonly loadPeriodChart: PeriodChartLoader;
  /** devicePolicy().periodSkyComputeAllowed: a trip on a weak device gets no reading. */
  readonly periodSkyAllowed: boolean;
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

/** How far ahead a today thread may read a month at the current place. */
const MONTHS_AHEAD = 12;
const MONTH_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])$';
const MONTH_ARG = new RegExp(MONTH_PATTERN);

/** A today thread's arguments (a trip is bound to its own period and takes none). */
const TODAY_PROPERTIES = {
  granularity: {
    type: 'string', enum: ['day', 'month'],
    description: 'month (the default): a calendar month. day: today only, for "today" or "right now".',
  },
  month: {
    type: 'string', pattern: MONTH_PATTERN,
    description: 'YYYY-MM, with granularity month. Omit for the current month; next month is the month after it.',
  },
} as const;
const TODAY_ARGS = { type: 'object', properties: TODAY_PROPERTIES, additionalProperties: false } as const;

const BOUND_READING = [
  "Read this thread's Vedic period reading, computed on this device. It never makes a network request. No arguments:",
  "it is bound to this time-travel trip's period and place.",
].join(' ');

const TODAY_READING = [
  "Read the user's Vedic period reading for now, at their current place, computed on this device. It never makes a network request.",
  'Call it for any present-day or near-future period question ("this month", "next month", "the next few weeks", "lately"), including a follow-up, before you answer.',
  'Send granularity "month" (the default; the current month) and, for a later month, month "YYYY-MM" (e.g. next month).',
  'For "the next few weeks", read this month and the next one. granularity "day" is today only.',
].join(' ');

const READING_CONTENTS = [
  'Returns the period and place (name both), the running dashas (maha, antar, pratyantar; sookshma for a day) and the Yogini maha;',
  'the running lords with the houses they rule, functional nature, natal and transit placement;',
  'the slow-planet sky with Moon-based tags (e.g. sade_sati_phase_1, kantaka_shani); double-transit houses;',
  'and per-life-area themes with direction, strength, confidence, agreement per technique, cited factors and dated windows.',
  'Cite these facts by name. `trimmed` lists what was cut to stay compact; get_period_detail returns it.',
].join(' ');

const DETAIL_DESCRIPTION = [
  'Drill into the same bound period reading. section: lord (key = a graha, e.g. "saturn"),',
  'segment (key = a segment start date, YYYY-MM-DD), bindus (key = a graha or "sav": the ashtakavarga row per sign),',
  'panchang (a single-day period only), dashas (every dasha span in the period). Returns facts plus cited factor strings.',
].join(' ');
const TODAY_DETAIL_NOTE = 'In a today thread, send the same granularity and month as the reading you are drilling into.';

const DETAIL_PROPERTIES = {
  section: { type: 'string', enum: DETAIL_SECTIONS },
  key: { type: 'string', maxLength: 16, description: 'A graha, "sav", or a segment start date (YYYY-MM-DD); per section.' },
} as const;

function detailParameters(today: boolean) {
  const properties = today ? { ...DETAIL_PROPERTIES, ...TODAY_PROPERTIES } : DETAIL_PROPERTIES;
  return { type: 'object', properties, required: ['section'], additionalProperties: false } as const;
}

/** What a today thread reads: today alone, or one calendar month at the current place. */
type TodayRequest =
  | { readonly granularity: 'day' }
  | { readonly granularity: 'month'; readonly month: string };

function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, index - 1 + by, 1));
  return shifted.toISOString().slice(0, 7);
}

function monthRange(month: string): { readonly start: string; readonly end: string } {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** A today thread's arguments, read leniently: empty or partial means the current month. */
function todayRequest(args: AgentJsonObject, today: string): TodayRequest | { readonly error: string } {
  const { granularity, month } = args;
  if (granularity !== undefined && granularity !== 'day' && granularity !== 'month') return { error: 'granularity must be day or month' };
  if (granularity === 'day') return month === undefined ? { granularity } : { error: 'a day reading is today only: send granularity day with no month' };
  const current = today.slice(0, 7);
  if (month === undefined) return { granularity: 'month', month: current };
  const last = shiftMonth(current, MONTHS_AHEAD);
  if (typeof month !== 'string' || !MONTH_ARG.test(month) || month < current || month > last) {
    return { error: `month must be YYYY-MM from ${current} (this month) to ${last}. For an earlier period, use get_timing.` };
  }
  return { granularity: 'month', month };
}

/** Today's place label: the profile's current location, label only (never its coordinates); absent when unset. */
function currentPlaceLabel(birth: ProcessedBirthData | undefined): { readonly label?: string } {
  const label = birthPlaceOf(birth?.transit_location_details ?? undefined)?.label;
  return label ? { label } : {};
}

/** Today's place: the current place label (if set), the viewer zone and the user's own clock. */
function todayPlace(input: PeriodReadingToolsInput, now: Date): ReadingFrame['place'] {
  const timezone = input.viewerZone();
  const clock = currentDateTimeForZone(now, timezone);
  const current = { zone: `your current zone (${timezone})`, local_date: clock.localDate, local_time: clock.localTime.slice(0, 5) };
  return { ...currentPlaceLabel(input.birth), timezone, current };
}

function todayPeriod(request: TodayRequest, today: string, language: string): ReadingFrame['period'] {
  if (request.granularity === 'day') {
    const label = formatPinLabel({ start: today, granularity: 'day' }, language);
    return { start: today, end: today, granularity: 'day', label, tense: 'present' };
  }
  const { start, end } = monthRange(request.month);
  const tense = request.month === today.slice(0, 7) ? 'present' : 'future';
  return { start, end, granularity: 'month', label: formatPinLabel({ start, granularity: 'month' }, language), tense };
}

/** The period and place the tools are bound to, for this call's `now` (a today thread: its request). */
function frameOf(input: PeriodReadingToolsInput, now: Date, request: TodayRequest): ReadingFrame {
  const today = viewerTodayDay(now, input.viewerZone());
  if (!input.pin) return { period: todayPeriod(request, today, input.language), place: todayPlace(input, now) };
  const trip = tripContext({ chart: input.chart, asOf: input.pin, today, birth: input.birth, language: input.language });
  const { start, end, granularity, label, tense } = trip.period;
  return { period: { start, end, granularity, label, tense }, place: { label: trip.place.label, timezone: trip.place.timezone } };
}

/**
 * The request a call reads: a trip ignores arguments (it is bound); a today thread reads its
 * own. A device that cannot compute a period's sky reads today, never a month it cannot load.
 */
function requestOf(input: PeriodReadingToolsInput, args: AgentJsonObject, now: Date): TodayRequest | { readonly error: string } {
  if (input.pin) return { granularity: 'day' };
  const request = todayRequest(args, viewerTodayDay(now, input.viewerZone()));
  if ('error' in request || input.periodSkyAllowed) return request;
  return { granularity: 'day' };
}

function unavailable(frame: ReadingFrame, reason: PeriodReadingFailure, notes?: readonly string[]): PeriodReadingUnavailable {
  return { period: frame.period, place: frame.place, available: false, reason, ...(notes ? { notes } : {}) };
}

function failureReason(error: unknown): PeriodReadingFailure {
  if (error instanceof PeriodSkyUnavailableError) return error.reason;
  if (error instanceof PeriodSkyTimeoutError) return 'timeout';
  return 'engine_unavailable';
}

/** The later of the local and UTC birth years (the engine computes in UTC), as get_timing gates the sky. */
function skyGateYear(birth: ProcessedBirthData | undefined): number | undefined {
  const local = birthYearOf(birth);
  const utc = birthUtcYearOf(birth);
  return local === undefined ? utc : Math.max(local, utc ?? local);
}

/** A trip's gates, before any engine work. Today never needs them. */
function gate(input: PeriodReadingToolsInput, frame: ReadingFrame): PeriodReadingUnavailable | { readonly error: string } | undefined {
  if (!input.pin) return undefined;
  const period: PeriodRange = { start: frame.period.start, end: frame.period.end };
  if (endsBeforeBirthYear(period, birthYearOf(input.birth))) return { error: BEFORE_BIRTH_MESSAGE };
  if (startsInOrBeforeBirthYear(period, skyGateYear(input.birth))) return unavailable(frame, 'birth_year', [BIRTH_YEAR_SKY_NOTE]);
  if (!input.periodSkyAllowed) return unavailable(frame, 'device_limit', [DEVICE_DASHAS_ONLY_NOTE]);
  return undefined;
}

interface LoadedReading {
  readonly reading: PeriodReadingContext;
  readonly strength: SiderealChart['strength_context'];
}

type Loaded = LoadedReading | { readonly failure: PeriodReadingUnavailable | { readonly error: string } };

async function load(input: PeriodReadingToolsInput, frame: ReadingFrame, context: AgentToolContext): Promise<Loaded> {
  const refused = gate(input, frame);
  if (refused) return { failure: refused };
  try {
    // Today's day joins the Life Atlas's calculation; a trip or a month reads through the period queue.
    const chart = !input.pin && frame.period.granularity === 'day'
      ? await input.loadCurrentChart(context)
      : await input.loadPeriodChart({ start: frame.period.start, end: frame.period.end }, context);
    const reading = chart.period_reading;
    // An older engine (or a cache it wrote) has no reading: never synthesize one.
    if (!reading || !isCachedPeriodReading(reading) || !isCachedNatalLords(reading.natal_lords)) return { failure: unavailable(frame, 'reading_unavailable') };
    return { reading, strength: chart.strength_context };
  } catch (error) {
    // A cancelled turn is not a reading failure: let the agent see the cancellation.
    if (context.signal.aborted) throw error;
    return { failure: unavailable(frame, failureReason(error)) };
  }
}

async function readPeriod(input: PeriodReadingToolsInput, args: AgentJsonObject, context: AgentToolContext): Promise<PeriodReadingToolResult> {
  const request = requestOf(input, args, context.now);
  if ('error' in request) return request;
  const frame = frameOf(input, context.now, request);
  const loaded = await load(input, frame, context);
  if ('failure' in loaded) return loaded.failure;
  return buildPeriodReading(loaded.reading, frame);
}

async function readDetail(input: PeriodReadingToolsInput, args: AgentJsonObject, context: AgentToolContext): Promise<PeriodDetailToolResult> {
  const section = DETAIL_SECTIONS.find((value) => value === args.section);
  if (!section) return { error: `section must be one of: ${DETAIL_SECTIONS.join(', ')}` };
  if (args.key !== undefined && typeof args.key !== 'string') return { error: 'key must be a string' };
  const request = requestOf(input, args, context.now);
  if ('error' in request) return request;
  const frame = frameOf(input, context.now, request);
  const loaded = await load(input, frame, context);
  if ('failure' in loaded) return loaded.failure;
  return buildPeriodDetail({ reading: loaded.reading, strength: loaded.strength }, frame, section, args.key);
}

export function createPeriodReadingTools(input: PeriodReadingToolsInput): AgentTool[] {
  const today = !input.pin;
  return [
    {
      name: PERIOD_READING_TOOL_NAME,
      description: `${today ? TODAY_READING : BOUND_READING} ${READING_CONTENTS}`,
      statusLabel: 'Reading the period… (about 30 s)',
      timeoutMs: TIMING_TOOL_TIMEOUT_MS,
      parameters: today ? TODAY_ARGS : NO_ARGS,
      execute: (args, context) => readPeriod(input, args, context),
      summarize: summarizePeriodReading,
    },
    {
      name: PERIOD_DETAIL_TOOL_NAME,
      description: today ? `${DETAIL_DESCRIPTION} ${TODAY_DETAIL_NOTE}` : DETAIL_DESCRIPTION,
      statusLabel: 'Looking closer at the period',
      timeoutMs: TIMING_TOOL_TIMEOUT_MS,
      parameters: detailParameters(today),
      execute: (args, context) => readDetail(input, args, context),
      summarize: summarizePeriodDetail,
    },
  ];
}
