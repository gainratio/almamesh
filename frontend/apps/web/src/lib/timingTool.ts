/**
 * `get_timing` (spec 2026-10-08, Part 1): the chat's ONE timing tool, for
 * today or any period. The model turns words into dates; this checks them,
 * picks dashas by date, and runs the engine for the period's sky. Errors the
 * model must act on are RETURNED (`{ error }`): a thrown error reaches the
 * model only as an opaque "could not complete safely".
 */
import type { SiderealChart } from '@almamesh/browser/types';
import {
  BEFORE_BIRTH_MESSAGE,
  BIRTH_YEAR_SKY_NOTE,
  COVERED_EVENTS,
  endsBeforeBirthYear,
  ISO_DAY_PATTERN,
  parsePeriodArgs,
  periodAnalysisInstant,
  periodEcho,
  periodLimits,
  restrictTransitsToPeriod,
  sanitizeChartForLlm,
  selectDashasForPeriod,
  startsInOrBeforeBirthYear,
  todayAnalysisInstant,
  type AgentJsonObject,
  type AgentTool,
  type AgentToolContext,
  type PeriodEcho,
  type PeriodRange,
  type SanitizedChart,
} from '@almamesh/llm';

import { PeriodSkyTimeoutError } from './periodSky';

export const TIMING_TOOL_NAME = 'get_timing';
/** One queued Life Atlas compute plus one period compute (spec, Performance). */
export const TIMING_TOOL_TIMEOUT_MS = 150_000;
const TIMING_SECTIONS = ['dashas', 'transits', 'domains', 'strength'] as const;
type TimingSection = (typeof TIMING_SECTIONS)[number];

export type PeriodSkyFailure = 'engine_unavailable' | 'timeout' | 'incomplete_birth_data';

export class PeriodSkyUnavailableError extends Error {
  constructor(readonly reason: PeriodSkyFailure) {
    super(`The period sky is unavailable: ${reason}`);
    this.name = 'PeriodSkyUnavailableError';
  }
}

export interface TimingToolInput {
  /** The stored natal chart: its dated dasha tree is read for every period. */
  readonly chart: SiderealChart;
  /**
   * The local birth year. Used only to refuse periods that end before 1 January
   * of it; never echoed. Never the day: a day-precision refusal is a birth-date oracle.
   */
  readonly birthYear: number | undefined;
  /**
   * The birth instant's UTC year, when it is later than the local year (a birth
   * late on 31 Dec west of UTC). The engine computes in UTC, so the birth-year sky
   * gate uses the later of the two. Never echoed.
   */
  readonly birthUtcYear?: number | undefined;
  /** Today's calendar day in the one "today" zone (the viewer's). */
  readonly todayDay: (now: Date) => string;
  /** Today's engine facts (the Life Atlas store path). */
  readonly loadCurrentChart?: (context: AgentToolContext) => Promise<SiderealChart>;
  /** A period's engine facts (periodChart.ts, through periodSky.ts). */
  readonly loadPeriodChart?: (period: PeriodRange, context: AgentToolContext) => Promise<SiderealChart>;
  /** `devicePolicy().periodSkyComputeAllowed`: false answers every period with dashas only. */
  readonly periodSkyAllowed: boolean;
}

/** Every successful call. `shown` differs from `section` when a limit gave dashas only. */
interface TimingResult {
  readonly period: PeriodEcho;
  readonly section: TimingSection;
  readonly shown: TimingSection;
  readonly notes: readonly string[];
  readonly data: unknown;
  readonly covered_events?: readonly string[];
  readonly measured_at?: 'start_of_period' | 'that_day';
}

/** A refusal the model must read and act on. */
interface TimingError {
  readonly error: string;
}

const DAY = { type: 'string', pattern: ISO_DAY_PATTERN } as const;

const DESCRIPTION = [
  'Read deterministic planetary timing on this device, for today or for any period. It never makes a network request.',
  'Omit start and end for today. For a period send YYYY-MM-DD dates, end inclusive:',
  '"12 March 2019" -> start=end=2019-03-12; "June 2026" -> start=2026-06-01, end=2026-06-30;',
  '"2019" -> start=2019-01-01, end=2019-12-31. For vague ranges ("summer 2019") pick a sensible range and say which.',
  'Every result carries `period`: name it in your answer, e.g. "I looked at 1–30 June 2026."',
  'Respect `notes`. Only the events in `covered_events` were checked; do not claim anything about other planets.',
].join(' ');

const UNAVAILABLE = { available: false } as const;

/** Why a weak device's period answer has no sky (devicePolicy, deviceTier.ts). */
export const DEVICE_DASHAS_ONLY_NOTE = 'This device answers dated questions with dashas only, to stay within memory.';

/** Returned, not thrown, so the model can retry with a valid section. */
const SECTION_ERROR = `section must be one of: ${TIMING_SECTIONS.join(', ')}`;

function sectionData(chart: SanitizedChart, section: TimingSection): unknown {
  if (section === 'dashas') return chart.dashas ?? UNAVAILABLE;
  return chart.predictive?.[section] ?? UNAVAILABLE;
}

async function todayTiming(
  input: TimingToolInput,
  section: TimingSection,
  context: AgentToolContext,
): Promise<TimingResult> {
  // Dashas need no engine run: the stored tree already carries every date.
  const source =
    section === 'dashas' || !input.loadCurrentChart ? input.chart : await input.loadCurrentChart(context);
  const chart = sanitizeChartForLlm(source, todayAnalysisInstant(context.now));
  const today = input.todayDay(context.now);
  return {
    period: periodEcho({ start: today, end: today }, 'today'),
    section,
    shown: section,
    notes: [],
    data: sectionData(chart, section),
  };
}

function failureReason(error: unknown): PeriodSkyFailure {
  if (error instanceof PeriodSkyUnavailableError) return error.reason;
  if (error instanceof PeriodSkyTimeoutError) return 'timeout';
  return 'engine_unavailable';
}

type SkySection = Exclude<TimingSection, 'dashas'>;

function skyResult(
  sky: SiderealChart,
  section: SkySection,
  period: PeriodRange,
  echo: PeriodEcho,
): TimingResult {
  const base = { period: echo, section, shown: section };
  const multiDay = echo.days > 1;
  const asOf = periodAnalysisInstant(period.start, period.end);
  if (section !== 'transits') {
    const measuredAt = multiDay ? 'start_of_period' : 'that_day';
    return { ...base, notes: [], measured_at: measuredAt, data: sectionData(sanitizeChartForLlm(sky, asOf), section) };
  }
  if (!sky.transit_context) return { ...base, notes: [], data: UNAVAILABLE };
  const restricted = restrictTransitsToPeriod(sky.transit_context, period, multiDay);
  const chart = sanitizeChartForLlm({ ...sky, transit_context: restricted.context }, asOf);
  return { ...base, notes: restricted.notes, covered_events: COVERED_EVENTS, data: sectionData(chart, section) };
}

async function skyTiming(
  input: TimingToolInput,
  section: SkySection,
  period: PeriodRange,
  echo: PeriodEcho,
  context: AgentToolContext,
): Promise<TimingResult> {
  let sky: SiderealChart;
  try {
    if (!input.loadPeriodChart) throw new PeriodSkyUnavailableError('engine_unavailable');
    sky = await input.loadPeriodChart(period, context);
  } catch (error) {
    // A cancelled turn is not a sky failure: let the agent see the cancellation.
    if (context.signal.aborted) throw error;
    const data = { available: false, reason: failureReason(error) };
    return { period: echo, section, shown: section, notes: [], data };
  }
  return skyResult(sky, section, period, echo);
}

function dashasTiming(
  input: TimingToolInput,
  section: TimingSection,
  period: PeriodRange,
  echo: PeriodEcho,
  limitNotes: readonly string[],
): TimingResult {
  const dashas = input.chart.dashas ? selectDashasForPeriod(input.chart.dashas, period, input.birthYear) : undefined;
  return {
    period: echo,
    section,
    shown: 'dashas',
    notes: [...limitNotes, ...(dashas?.notes ?? [])],
    data: dashas ?? UNAVAILABLE,
  };
}

/** The later of the local and UTC birth years: the sky gate must cover the UTC birth instant too. */
function skyGateYear(input: TimingToolInput): number | undefined {
  if (input.birthYear === undefined) return input.birthUtcYear;
  return Math.max(input.birthYear, input.birthUtcYear ?? input.birthYear);
}

/** Why this period gets dashas only (its notes), or undefined when the engine runs. */
function dashasOnlyNotes(
  input: TimingToolInput,
  section: TimingSection,
  period: PeriodRange,
): readonly string[] | undefined {
  if (section === 'dashas') return [];
  // The engine computes against the real birth instant, so a birth-year sky flips at birth.
  if (startsInOrBeforeBirthYear(period, skyGateYear(input))) return [BIRTH_YEAR_SKY_NOTE];
  const limits = periodLimits(period);
  if (limits.dashasOnly) return limits.notes;
  if (!input.periodSkyAllowed) return [DEVICE_DASHAS_ONLY_NOTE];
  return undefined;
}

async function periodTiming(
  input: TimingToolInput,
  section: TimingSection,
  period: PeriodRange,
  context: AgentToolContext,
): Promise<TimingResult | TimingError> {
  if (endsBeforeBirthYear(period, input.birthYear)) return { error: BEFORE_BIRTH_MESSAGE };
  const echo = periodEcho(period, 'period');
  const notes = dashasOnlyNotes(input, section, period);
  if (notes || section === 'dashas') return dashasTiming(input, section, period, echo, notes ?? []);
  return skyTiming(input, section, period, echo, context);
}

const SKY_STATUS_LABEL = 'Working out the sky… (about 30 s)';
/** Shown when a period call will not run the engine. A fixed phrase: no dates, no reasons. */
export const DASHAS_STATUS_LABEL = 'Reading dasha periods';

/** The status line for one call: no sky wording when the engine will not run. */
function statusLabelFor(input: TimingToolInput, args: AgentJsonObject): string | undefined {
  const section = TIMING_SECTIONS.find((value) => value === args.section);
  const parsed = parsePeriodArgs(args);
  if (!section || parsed.kind !== 'period') return undefined;
  if (endsBeforeBirthYear(parsed.period, input.birthYear)) return DASHAS_STATUS_LABEL;
  return dashasOnlyNotes(input, section, parsed.period) ? DASHAS_STATUS_LABEL : undefined;
}

export function createTimingTool(input: TimingToolInput): AgentTool {
  return {
    name: TIMING_TOOL_NAME,
    description: DESCRIPTION,
    statusLabel: SKY_STATUS_LABEL,
    statusLabelFor: (args: AgentJsonObject) => statusLabelFor(input, args),
    timeoutMs: TIMING_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: { section: { type: 'string', enum: TIMING_SECTIONS }, start: DAY, end: DAY },
      required: ['section'],
      additionalProperties: false,
    },
    execute: async (args: AgentJsonObject, context: AgentToolContext) => {
      const section = TIMING_SECTIONS.find((value) => value === args.section);
      if (!section) return { error: SECTION_ERROR };
      const parsed = parsePeriodArgs(args);
      if (parsed.kind === 'invalid') return { error: parsed.error };
      if (parsed.kind === 'today') return todayTiming(input, section, context);
      return periodTiming(input, section, parsed.period, context);
    },
  };
}
