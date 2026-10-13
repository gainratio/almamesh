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
  startsInOrBeforeBirthYear,
  type AgentJsonObject,
  type AgentTool,
  type AgentToolContext,
  type PeriodRange,
} from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';

import { viewerTodayDay } from './chatAgentTools';
import { birthUtcYearOf, birthYearOf, type PeriodChartLoader } from './periodChart';
import {
  buildPeriodDetail,
  buildPeriodReading,
  DETAIL_SECTIONS,
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

export const PERIOD_READING_TOOL_NAME = 'get_period_reading';
export const PERIOD_DETAIL_TOOL_NAME = 'get_period_detail';

export interface PeriodReadingToolsInput {
  /** A trip's pin (tripPin: an old trip carries the birth place's label and zone); undefined for today. */
  readonly pin: ChatThreadAsOf | undefined;
  /** The stored natal chart (the trip frame's dasha tree and natal summary). */
  readonly chart: SiderealChart;
  /** Only its birth year is read, for the before-birth gates. Never echoed. */
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

const READING_DESCRIPTION = [
  "Read this thread's Vedic period reading, computed on this device. It never makes a network request. No arguments:",
  "it is bound to this thread's period and place (a time-travel trip's, or today's).",
  'Returns the running dashas (maha, antar, pratyantar; sookshma for a day) and the Yogini maha;',
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

const DETAIL_PARAMETERS = {
  type: 'object',
  properties: {
    section: { type: 'string', enum: DETAIL_SECTIONS },
    key: { type: 'string', maxLength: 16, description: 'A graha, "sav", or a segment start date (YYYY-MM-DD); per section.' },
  },
  required: ['section'],
  additionalProperties: false,
} as const;

/** The period and place the tools are bound to, for this call's `now`. */
function frameOf(input: PeriodReadingToolsInput, now: Date): ReadingFrame {
  const today = viewerTodayDay(now, input.viewerZone());
  if (!input.pin) {
    const label = formatPinLabel({ start: today, granularity: 'day' }, input.language);
    return { period: { start: today, end: today, granularity: 'day', label, tense: 'present' }, place: { label: null, timezone: input.viewerZone() } };
  }
  const trip = tripContext({ chart: input.chart, asOf: input.pin, today, birth: input.birth, language: input.language });
  const { start, end, granularity, label, tense } = trip.period;
  return { period: { start, end, granularity, label, tense }, place: { label: trip.place.label, timezone: trip.place.timezone } };
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
    const chart = input.pin
      ? await input.loadPeriodChart({ start: frame.period.start, end: frame.period.end }, context)
      : await input.loadCurrentChart(context);
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

async function readPeriod(input: PeriodReadingToolsInput, context: AgentToolContext): Promise<PeriodReadingToolResult> {
  const frame = frameOf(input, context.now);
  const loaded = await load(input, frame, context);
  if ('failure' in loaded) return loaded.failure;
  return buildPeriodReading(loaded.reading, frame);
}

async function readDetail(input: PeriodReadingToolsInput, args: AgentJsonObject, context: AgentToolContext): Promise<PeriodDetailToolResult> {
  const section = DETAIL_SECTIONS.find((value) => value === args.section);
  if (!section) return { error: `section must be one of: ${DETAIL_SECTIONS.join(', ')}` };
  if (args.key !== undefined && typeof args.key !== 'string') return { error: 'key must be a string' };
  const frame = frameOf(input, context.now);
  const loaded = await load(input, frame, context);
  if ('failure' in loaded) return loaded.failure;
  return buildPeriodDetail({ reading: loaded.reading, strength: loaded.strength }, frame, section, args.key);
}

export function createPeriodReadingTools(input: PeriodReadingToolsInput): AgentTool[] {
  return [
    {
      name: PERIOD_READING_TOOL_NAME,
      description: READING_DESCRIPTION,
      statusLabel: 'Reading the period… (about 30 s)',
      timeoutMs: TIMING_TOOL_TIMEOUT_MS,
      parameters: NO_ARGS,
      execute: (_args, context) => readPeriod(input, context),
    },
    {
      name: PERIOD_DETAIL_TOOL_NAME,
      description: DETAIL_DESCRIPTION,
      statusLabel: 'Looking closer at the period',
      timeoutMs: TIMING_TOOL_TIMEOUT_MS,
      parameters: DETAIL_PARAMETERS,
      execute: (args, context) => readDetail(input, args, context),
    },
  ];
}
