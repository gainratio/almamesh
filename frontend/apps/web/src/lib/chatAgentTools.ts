import { devicePolicy } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  pinRelative,
  sanitizeChartForLlm,
  type AnalysisInstant,
  type AgentTool,
  type AgentToolContext,
  type PeriodRange,
} from '@almamesh/llm';

import { enumArgument } from './agentArgs';
import { viewerTimeZone } from './analysisInstant';
import { predictiveReferenceInstant } from './predictive';
import type { MoonWindowLoader } from './moonWindow';
import type { PlaceReader } from './timingPlaces';
import { createTimingTool, type PinnedTiming } from './timingTool';
import { parseExplicitTimingPeriod } from './timingQuestion';

export interface ZonedDateTime {
  readonly isoUtc: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly utcOffset: string;
  readonly timeZone: string;
}

function partsRecord(parts: readonly Intl.DateTimeFormatPart[]): Record<string, string> {
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function normalizeOffset(value: string | undefined): string {
  if (value === 'GMT' || value === 'UTC') return '+00:00';
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value ?? '');
  if (!match) throw new Error('The timezone offset could not be resolved.');
  return `${match[1]}${match[2].padStart(2, '0')}:${match[3] ?? '00'}`;
}

/** Format one caller-pinned instant without consulting the wall clock. */
export function currentDateTimeForZone(now: Date, timeZone: string): ZonedDateTime {
  if (Number.isNaN(now.valueOf())) throw new Error('A valid clock instant is required.');
  let values: Record<string, string>;
  try {
    values = partsRecord(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'longOffset',
      }).formatToParts(now),
    );
  } catch (error) {
    throw new Error(`Invalid timezone: ${timeZone}`, { cause: error });
  }
  return {
    isoUtc: now.toISOString(),
    localDate: `${values.year}-${values.month}-${values.day}`,
    localTime: `${values.hour}:${values.minute}:${values.second}`,
    utcOffset: normalizeOffset(values.timeZoneName),
    timeZone,
  };
}

export interface CreateChatAgentToolsInput {
  readonly chart: SiderealChart;
  /** A time-travel thread's pin (chatToolset.ts builds it from the thread's as_of). */
  readonly pinned?: PinnedTiming;
  /**
   * The chart's own analysis instant: `get_chart_facts` describes the chart as
   * of this instant. Only `get_timing` (today, or a dated period) uses the
   * tool context's `now`, labelled as "today".
   */
  readonly chartAsOf: AnalysisInstant;
  readonly chartTimeZone: string;
  /** Resolve exact-day engine facts; the caller owns cache/profile identity checks. */
  readonly loadCurrentChart?: (context: AgentToolContext) => Promise<SiderealChart>;
  /** The local birth year; periods that end before 1 January of it are refused. */
  readonly birthYear?: number;
  /** The birth instant's UTC year; the birth-year sky gate uses the later of the two. */
  readonly birthUtcYear?: number | undefined;
  /** Today's calendar day; defaults to the viewer's zone. */
  readonly todayDay?: (now: Date) => string;
  /** Engine facts for a period other than today (periodChart.ts). */
  readonly loadPeriodChart?: (period: PeriodRange, context: AgentToolContext) => Promise<SiderealChart>;
  /** Test seam. Default: this device's `devicePolicy().periodSkyComputeAllowed`. */
  readonly periodSkyAllowed?: boolean;
  /** The engine's Moon at a place for a short period (moonWindow.ts). */
  readonly loadMoonWindow?: MoonWindowLoader;
  /** Re-read a place_ref offline (geo/placeLookup.ts). */
  readonly placeFromRef?: PlaceReader;
}

/**
 * Today's calendar day in the viewer's (device) zone: the one "today" every
 * page reads, and the zone every "As of" on screen is printed in.
 */
export function viewerTodayDay(now: Date, timeZone: string = viewerTimeZone()): string {
  return predictiveReferenceInstant(now, timeZone).slice(0, 10);
}

const CURRENT_CONTEXT_PATTERN =
  /\b(?:today|now|currently|current|this\s+(?:week|month|year)|transits?|timing|hoy|ahora|actual(?:mente)?|esta\s+semana|este\s+(?:mes|ano)|transitos?|hoje|agora|atual(?:mente)?|esta\s+semana|este\s+(?:mes|ano)|transitos?)\b/i;

/** Lowercase with accents folded, the way the router has always matched. */
function foldQuestion(question: string): string {
  return question.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Conservative, multilingual routing for questions that require exact-day facts. */
export function requiresCurrentPlanetaryContext(question: string): boolean {
  return CURRENT_CONTEXT_PATTERN.test(foldQuestion(question));
}

/** Explicit calendar language must not silently fall back to today's sky. */
export function mentionsExplicitPeriod(question: string): boolean {
  return parseExplicitTimingPeriod(question).kind !== 'none';
}

/**
 * Pre-run today's sky for a current question or explicit today instruction.
 * Literal calendar periods and comparisons are prepared separately, so
 * "Transits in June 2019" never spends time computing the wrong sky.
 */
export function shouldPreRunToday(question: string): boolean {
  const explicit = parseExplicitTimingPeriod(question);
  if (explicit.kind === 'unresolved' && explicit.reason === 'ambiguous_period') return false;
  if (explicit.kind === 'period' && hasExplicitCurrentDay(question) && mentionsPeriodComparison(question)) return false;
  return requiresCurrentPlanetaryContext(question)
    && (hasExplicitCurrentDay(question) || explicit.kind === 'none');
}

/** A current-day instruction takes precedence over the saved historical pin. */
export function hasExplicitCurrentDay(question: string): boolean {
  return /\b(?:today|now|hoy|ahora|hoje|agora)\b/.test(foldQuestion(question));
}

/** An explicit comparison requires both periods, never a silently chosen one. */
export function mentionsPeriodComparison(question: string): boolean {
  return /\b(?:compar[a-z]*|versus|vs|differen[a-z]*|diferen[a-z]*)\b/.test(foldQuestion(question));
}

/** Build the fixed, read-only capability set for one already-loaded chart. */
export function createChatAgentTools(input: CreateChatAgentToolsInput): readonly AgentTool[] {
  const chartSections = ['overview', 'planets', 'houses', 'yogas', 'dashas'] as const;
  const timing = createTimingTool({
    chart: input.chart,
    birthYear: input.birthYear,
    birthUtcYear: input.birthUtcYear,
    todayDay: input.todayDay ?? viewerTodayDay,
    loadCurrentChart: input.loadCurrentChart,
    loadPeriodChart: input.loadPeriodChart,
    periodSkyAllowed: input.periodSkyAllowed ?? devicePolicy().periodSkyComputeAllowed,
    loadMoonWindow: input.loadMoonWindow,
    placeFromRef: input.placeFromRef,
    pinned: input.pinned,
  });

  return [
    {
      name: 'get_current_datetime',
      description:
        "Return the pinned current date and time in the birth place's time zone (scope chart) or UTC. Neither is the user's current zone: for today, get_period_reading's place.current has the user's local date and time.",
      statusLabel: 'Checking the current time',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['chart', 'utc'] },
        },
        required: ['scope'],
        additionalProperties: false,
      },
      execute: (args, context) => {
        const scope = enumArgument(args, 'scope', ['chart', 'utc']);
        const zone = scope === 'chart' ? input.chartTimeZone : 'UTC';
        const now = { scope, ...currentDateTimeForZone(context.now, zone) };
        if (!input.pinned) return now;
        // Plan Ruling 2: the viewer's day, the same "today" get_timing reads.
        const today = (input.todayDay ?? viewerTodayDay)(context.now);
        const { start, end } = input.pinned.period;
        return { ...now, pinned_period: { start, end }, relative: pinRelative(input.pinned.period, today) };
      },
    },
    {
      name: 'get_chart_facts',
      description:
        'Read one deterministic, identifier-free section of the active chart. Never computes or infers facts.',
      statusLabel: 'Reading chart facts',
      parameters: {
        type: 'object',
        properties: { section: { type: 'string', enum: chartSections } },
        required: ['section'],
        additionalProperties: false,
      },
      execute: (args, context) => {
        const section = enumArgument(args, 'section', chartSections);
        if (section === 'dashas' && (input.pinned || input.chartAsOf.basis === 'today')) {
          return Promise.resolve(timing.execute({ section }, context)).then((result) =>
            (result as { data?: unknown }).data ?? result);
        }
        const chart = sanitizeChartForLlm(input.chart, input.chartAsOf);
        switch (section) {
          case 'overview':
            return {
              ayanamsa_value: chart.ayanamsa_value,
              lagna: chart.lagna,
              navamsa: chart.navamsa,
            };
          case 'planets':
            return chart.planets;
          case 'houses':
            return chart.houses;
          case 'yogas':
            return chart.yogas;
          case 'dashas':
            return chart.dashas ?? { available: false };
          default:
            throw new Error('Unsupported chart section.');
        }
      },
    },
    timing,
  ];
}
