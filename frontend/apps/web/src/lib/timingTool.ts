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
  MAX_SEGMENTS,
  NEEDS_PLACE_ERROR,
  needsPlace,
  normalizeTimingArgs,
  parseTimingArgs,
  PLACE_NEEDED_BELOW_DAYS,
  PLACE_REF_ARG_PATTERN,
  PLACE_REF_ERROR,
  periodAnalysisInstant,
  periodEcho,
  periodLimits,
  restrictTransitsToPeriod,
  sanitizeChartForLlm,
  selectDashasForPeriod,
  startsInOrBeforeBirthYear,
  TIME_OF_DAY_PATTERN,
  todayAnalysisInstant,
  type AgentJsonObject,
  type AgentTool,
  type AgentToolContext,
  type PeriodEcho,
  type PeriodRange,
  type SanitizedChart,
  type TimingArgs,
} from '@almamesh/llm';

import type { MoonWindowLoader } from './moonWindow';
import { PeriodSkyTimeoutError } from './periodSky';
import { hoistSharedStrengthNote, type DomainsPayload } from './timingDomains';
import {
  impossibleTime,
  labelPlaces,
  longPlaces,
  placedSpans,
  shortPlaces,
  type PlacedResult,
  type PlaceReader,
  type PlaceRequest,
} from './timingPlaces';

export { PLACE_DOES_NOT_CHANGE_NOTE, PLACE_MOON_ROWS_NOTE, PLACE_MOON_UNAVAILABLE_NOTE } from './timingPlaces';

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
  /** A time-travel thread's pin: no dates read it, and the pinned day uses its place. */
  readonly pinned?: PinnedTiming;
  /** The engine's Moon at a place for a short period (moonWindow.ts). Absent: no Moon-at-place rows. */
  readonly loadMoonWindow?: MoonWindowLoader;
  /** Re-read a place_ref offline (geo/placeLookup.ts placeFromRef). Absent: every place_ref is unknown. */
  readonly placeFromRef?: PlaceReader;
}

/** Every successful call. `shown` differs from `section` when a limit gave dashas only. */
interface TimingResult extends PlacedResult {
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
const PLACE_REF = { type: 'string', pattern: PLACE_REF_ARG_PATTERN } as const;
const SEGMENT = {
  type: 'object',
  properties: { start: DAY, end: DAY, place_ref: PLACE_REF },
  required: ['start', 'end'],
  additionalProperties: false,
} as const;

const DESCRIPTION = [
  'Read deterministic planetary timing on this device, for today or for any period. It never makes a network request.',
  'Omit start and end for today. For a period send YYYY-MM-DD dates, end inclusive:',
  '"12 March 2019" -> start=end=2019-03-12; "June 2026" -> start=2026-06-01, end=2026-06-30;',
  '"2019" -> start=2019-01-01, end=2019-12-31. For vague ranges ("summer 2019"), ask the user to clarify the start and end dates before calling this tool; never choose dates for them.',
  'Every result carries `period`: name it in your answer, e.g. "I looked at 1–30 June 2026."',
  'Respect `notes`. `covered_events` lists the sky events this result checked;',
  'for the slow-planet sky, the running lords and their lordships, and dated windows, use get_period_reading.',
].join(' ');

/** Full tier only: lite/minimal answer every period with dashas, so they never hear of places. */
const PLACE_DESCRIPTION = [
  'A sky reading (transits, domains, strength) for less than 7 days (a day, a few days, or a time of day) needs a place:',
  'send place_ref from resolve_place, or segments that each carry one. Never assume a place.',
  'If the user already named a place for that day in this conversation, call resolve_place first, then call this with its place_ref.',
  'Otherwise the result is { error: "needs_place" }: ask once, "Where were you (or will you be) that day?"',
  "A week or longer never needs a place: don't resolve places for it, and say plainly that place doesn't change the reading.",
  'Dashas never need a place. For a time of day send start, place_ref and time (HH:MM, 24-hour).',
  `For a few days in different places send segments (up to ${MAX_SEGMENTS}); one turn can resolve at most 2 places.`,
].join(' ');

const BASE_PROPERTIES = {
  section: { type: 'string', enum: TIMING_SECTIONS },
  start: { ...DAY, description: 'First day, YYYY-MM-DD. Omit for today, or in a trip for the trip period.' },
  end: { ...DAY, description: 'Last day, inclusive. Use with start; never together with segments.' },
} as const;
const PLACE_PROPERTIES = {
  place_ref: { ...PLACE_REF, description: 'From resolve_place, for a single day. Omit in a trip: its place is bound.' },
  time: { type: 'string', pattern: TIME_OF_DAY_PATTERN, description: 'HH:MM, 24-hour, only with a single day.' },
  segments: { type: 'array', minItems: 1, maxItems: MAX_SEGMENTS, items: SEGMENT, description: 'Several places in a few days, instead of start/end (never with them).' },
} as const;

/** A trip's own description line: no dates or place are needed for the trip period. */
const TRIP_DESCRIPTION = "In a time-travel trip, call with only {section} for the trip's own period: its dates and place are already bound. Send dates only to compare another period.";

const UNAVAILABLE = { available: false } as const;

/** Why a weak device's period answer has no sky (devicePolicy, deviceTier.ts). */
export const DEVICE_DASHAS_ONLY_NOTE = 'This device answers dated questions with dashas only, to stay within memory.';

/** Returned, not thrown, so the model can retry with a valid section. */
const SECTION_ERROR = `section must be one of: ${TIMING_SECTIONS.join(', ')}`;

function sectionData(chart: SanitizedChart, section: TimingSection): unknown {
  if (section === 'dashas') return chart.dashas ?? UNAVAILABLE;
  return chart.predictive?.[section] ?? UNAVAILABLE;
}

/** A section's data plus any note lifted out of it (the life areas' shared strength note). */
function sectionPayload(chart: SanitizedChart, section: TimingSection): DomainsPayload {
  const data = sectionData(chart, section);
  return section === 'domains' ? hoistSharedStrengthNote(data) : { data, notes: [] };
}

async function todayTiming(
  input: TimingToolInput,
  section: TimingSection,
  context: AgentToolContext,
): Promise<TimingResult> {
  // Dashas need no engine run: the stored tree already carries every date.
  const today = input.todayDay(context.now);
  if (section === 'dashas') {
    const period = { start: today, end: today };
    return dashasTiming(input, section, period, periodEcho(period, 'today'), []);
  }
  const source =
    !input.loadCurrentChart ? input.chart : await input.loadCurrentChart(context);
  const chart = sanitizeChartForLlm(source, todayAnalysisInstant(context.now));
  const { data, notes } = sectionPayload(chart, section);
  return { period: periodEcho({ start: today, end: today }, 'today'), section, shown: section, notes: [...notes], data };
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
    const { data, notes } = sectionPayload(sanitizeChartForLlm(sky, asOf), section);
    return { ...base, notes: [...notes], measured_at: measuredAt, data };
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

/** One dated call: its period plus the place arguments (parseTimingArgs). */
interface PeriodRequest extends PlaceRequest {
  readonly period: PeriodRange;
}

/** A dashas-only answer (a limit applied), or undefined when the call goes on to the place step. */
function limitedTiming(
  input: TimingToolInput,
  section: TimingSection,
  period: PeriodRange,
  echo: PeriodEcho,
): TimingResult | undefined {
  const notes = dashasOnlyNotes(input, section, period);
  if (notes && section !== 'dashas') return dashasTiming(input, section, period, echo, notes);
  // Dashas ignore places under a week, and on a weak device always: no lookup, no Moon read.
  const placesIgnored = !input.periodSkyAllowed || echo.days < PLACE_NEEDED_BELOW_DAYS;
  if (section === 'dashas' && placesIgnored) return dashasTiming(input, section, period, echo, []);
  return undefined;
}

/** The place step: every ref read and every time checked before any engine work. */
async function placedTiming(
  input: TimingToolInput,
  section: TimingSection,
  request: PeriodRequest,
  echo: PeriodEcho,
  context: AgentToolContext,
): Promise<TimingResult | TimingError> {
  const spans = await placedSpans(input.placeFromRef, request.period, request);
  if (spans === 'unknown') return { error: PLACE_REF_ERROR };
  const timeError = impossibleTime(spans, request.time);
  if (timeError) return { error: timeError };
  if (section === 'dashas') return longPlaces(dashasTiming(input, section, request.period, echo, []), spans, request);
  const sky = await skyTiming(input, section, request.period, echo, context);
  if (echo.days >= PLACE_NEEDED_BELOW_DAYS) return longPlaces(sky, spans, request);
  if (section !== 'transits') return labelPlaces(sky, spans);
  return shortPlaces(input.loadMoonWindow, sky, spans, request.time, context);
}

async function periodTiming(
  input: TimingToolInput,
  section: TimingSection,
  request: PeriodRequest,
  context: AgentToolContext,
): Promise<TimingResult | TimingError> {
  const { period } = request;
  if (endsBeforeBirthYear(period, input.birthYear)) return { error: BEFORE_BIRTH_MESSAGE };
  const echo = periodEcho(period, 'period');
  const limited = limitedTiming(input, section, period, echo);
  if (limited) return limited;
  if (section !== 'dashas' && needsPlace(period, request)) return { error: NEEDS_PLACE_ERROR };
  return placedTiming(input, section, request, echo, context);
}

const SKY_STATUS_LABEL = 'Working out the sky… (about 30 s)';
/** Shown when a period call will not run the engine. A fixed phrase: no dates, no reasons. */
export const DASHAS_STATUS_LABEL = 'Reading dasha periods';
/** Shown when the call will come back asking where the user was: no engine runs. */
export const NEEDS_PLACE_STATUS_LABEL = 'Checking where you were';

/** The status line for one call: no sky wording when the engine will not run. */
function statusLabelFor(input: TimingToolInput, args: AgentJsonObject): string | undefined {
  const section = TIMING_SECTIONS.find((value) => value === args.section);
  const parsed = withPin(input.pinned, parseTimingArgs(bindToTrip(input.pinned, normalizeTimingArgs(args).args).args));
  if (!section || parsed.kind !== 'period') return undefined;
  if (endsBeforeBirthYear(parsed.period, input.birthYear)) return DASHAS_STATUS_LABEL;
  if (dashasOnlyNotes(input, section, parsed.period)) return DASHAS_STATUS_LABEL;
  return needsPlace(parsed.period, parsed) ? NEEDS_PLACE_STATUS_LABEL : undefined;
}

/** A pinned thread's period (spec Part 3) and, for a Day pin, the reserved ref of its place. */
export interface PinnedTiming {
  readonly period: PeriodRange;
  readonly placeRef?: string;
}

function samePeriod(a: PeriodRange, b: PeriodRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Plan Ruling 3 and 9: in a pinned thread no dates mean the pin, and the pinned day keeps its place. */
export function withPin(pinned: PinnedTiming | undefined, parsed: TimingArgs): TimingArgs {
  if (!pinned || parsed.kind === 'invalid') return parsed;
  const place = pinned.placeRef ? { placeRef: pinned.placeRef } : {};
  if (parsed.kind === 'today') return { kind: 'period', period: pinned.period, ...place };
  const unplaced = !parsed.placeRef && !parsed.segments;
  return unplaced && samePeriod(parsed.period, pinned.period) ? { ...parsed, ...place } : parsed;
}

/** Said when a trip's own place replaced the place arguments the model sent for the trip's period. */
export const TRIP_PLACE_USED_NOTE = "This trip's place was used: in a time-travel trip, call get_timing with only a section for the trip's own period.";

/** Appended to every get_timing error in a trip: exactly how to retry. */
export function tripRetryHint(section: string): string {
  return ` Retry: call get_timing with only {"section": "${section}"}; this trip's dates and place are already bound.`;
}

type RawArgs = Readonly<Record<string, unknown>>;

type RawSegments = ReadonlyArray<{ readonly start?: unknown; readonly end?: unknown; readonly place_ref?: unknown }>;

/** True when every set of dates the call names (start/end, the segments' span) is the trip's own period. */
function namesOnlyTripPeriod(args: RawArgs, period: PeriodRange): boolean {
  const segments = Array.isArray(args.segments) ? (args.segments as RawSegments) : undefined;
  const datesOk = args.start === undefined || (args.start === period.start && (args.end ?? args.start) === period.end);
  const segmentsOk = !segments || (segments[0]?.start === period.start && segments[segments.length - 1]?.end === period.end);
  return datesOk && segmentsOk;
}

/** The reserved pin ref is never the model's to send: such a call is left for the parser to refuse. */
function sendsReservedRef(args: RawArgs): boolean {
  const segments = Array.isArray(args.segments) ? (args.segments as RawSegments) : [];
  return args.place_ref === 'pinned' || segments.some((segment) => segment?.place_ref === 'pinned');
}

/**
 * In a trip, a call for the trip's own period reads the trip's place: place
 * arguments the model invented for it (it only ever saw the place's label)
 * are dropped, with a note. A call for another period keeps its own places.
 */
function bindToTrip(pinned: PinnedTiming | undefined, args: RawArgs): { readonly args: RawArgs; readonly notes: readonly string[] } {
  if (!pinned?.placeRef || (args.place_ref === undefined && args.segments === undefined)) return { args, notes: [] };
  if (sendsReservedRef(args) || !namesOnlyTripPeriod(args, pinned.period)) return { args, notes: [] };
  const { place_ref: _place, segments: _segments, ...rest } = args;
  return { args: rest, notes: [TRIP_PLACE_USED_NOTE] };
}

function withNotes(result: TimingResult | TimingError, notes: readonly string[]): TimingResult | TimingError {
  if (notes.length === 0 || 'error' in result) return result;
  return { ...result, notes: [...result.notes, ...notes] };
}

export function createTimingTool(input: TimingToolInput): AgentTool {
  return {
    name: TIMING_TOOL_NAME,
    description: [DESCRIPTION, ...(input.periodSkyAllowed ? [PLACE_DESCRIPTION] : []), ...(input.pinned ? [TRIP_DESCRIPTION] : [])].join(' '),
    statusLabel: SKY_STATUS_LABEL,
    statusLabelFor: (args: AgentJsonObject) => statusLabelFor(input, args),
    timeoutMs: TIMING_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: input.periodSkyAllowed ? { ...BASE_PROPERTIES, ...PLACE_PROPERTIES } : BASE_PROPERTIES,
      required: ['section'],
      additionalProperties: false,
    },
    execute: async (args: AgentJsonObject, context: AgentToolContext) => {
      const section = TIMING_SECTIONS.find((value) => value === args.section);
      if (!section) return { error: SECTION_ERROR };
      const normalized = normalizeTimingArgs(args);
      const bound = bindToTrip(input.pinned, normalized.args);
      const notes = [...normalized.notes, ...bound.notes];
      const hint = input.pinned ? tripRetryHint(section) : '';
      const parsed = withPin(input.pinned, parseTimingArgs(bound.args));
      if (parsed.kind === 'invalid') return { error: `${parsed.error}${hint}` };
      const result = parsed.kind === 'today'
        ? await todayTiming(input, section, context)
        : await periodTiming(input, section, parsed, context);
      if ('error' in result && hint && result.error !== BEFORE_BIRTH_MESSAGE && result.error !== NEEDS_PLACE_ERROR) {
        return { error: `${result.error}${hint}` };
      }
      return withNotes(result, notes);
    },
  };
}
