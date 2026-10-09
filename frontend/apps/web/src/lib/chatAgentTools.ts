import type { SiderealChart } from '@almamesh/browser/types';
import {
  sanitizeChartForLlm,
  type AnalysisInstant,
  type AgentTool,
  type AgentToolContext,
  type PeriodRange,
} from '@almamesh/llm';

import { enumArgument } from './agentArgs';
import { viewerTimeZone } from './analysisInstant';
import { predictiveReferenceInstant } from './predictive';
import { createTimingTool } from './timingTool';

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
  /**
   * The chart's own analysis instant: `get_chart_facts` describes the chart as
   * of this instant. Only `get_timing` (today, or a dated period) uses the
   * tool context's `now`, labelled as "today".
   */
  readonly chartAsOf: AnalysisInstant;
  readonly chartTimeZone: string;
  /** Resolve exact-day engine facts; the caller owns cache/profile identity checks. */
  readonly loadCurrentChart?: (context: AgentToolContext) => Promise<SiderealChart>;
  /** The local birth day (YYYY-MM-DD); periods before it are refused. */
  readonly birthDay?: string;
  /** Today's calendar day; defaults to the viewer's zone. */
  readonly todayDay?: (now: Date) => string;
  /** Engine facts for a period other than today (periodChart.ts). */
  readonly loadPeriodChart?: (period: PeriodRange, context: AgentToolContext) => Promise<SiderealChart>;
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

/** Conservative, multilingual routing for questions that require exact-day facts. */
export function requiresCurrentPlanetaryContext(question: string): boolean {
  const normalized = question.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return CURRENT_CONTEXT_PATTERN.test(normalized);
}

/** Build the fixed, read-only capability set for one already-loaded chart. */
export function createChatAgentTools(input: CreateChatAgentToolsInput): readonly AgentTool[] {
  const chartSections = ['overview', 'planets', 'houses', 'yogas', 'dashas'] as const;

  return [
    {
      name: 'get_current_datetime',
      description:
        'Return the pinned current date and time for the chart timezone or UTC.',
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
        return { scope, ...currentDateTimeForZone(context.now, zone) };
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
      execute: (args) => {
        const section = enumArgument(args, 'section', chartSections);
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
    createTimingTool({
      chart: input.chart,
      birthDay: input.birthDay,
      todayDay: input.todayDay ?? viewerTodayDay,
      loadCurrentChart: input.loadCurrentChart,
      loadPeriodChart: input.loadPeriodChart,
    }),
  ];
}
