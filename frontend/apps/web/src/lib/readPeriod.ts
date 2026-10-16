/**
 * `read_period` (chat tool layer redesign 2026-10-14, audit §4.2): one typed
 * tool for any day, month, year or range up to 24 months, at a place named in
 * plain words. It replaces the router-bound period, detail, timing, place,
 * trip, natal and clock tools.
 *
 * One engine load per call: the span's sky and themes come from one period
 * compute (periodChart.ts), today's single day from today's chart. The place
 * frames the reading (label and zone); only a single day's Moon is read at
 * the place itself. Coordinates stay on this side: every result carries a
 * label and an IANA zone, never a latitude, a longitude or a birth field.
 */
import type { MoonEnds, MoonMark, MoonWindow } from '@almamesh/browser';
import type { PeriodReadingContext, SiderealChart, StrengthContext } from '@almamesh/browser/types';
import {
  BIRTH_YEAR_SKY_NOTE,
  endsBeforeBirthYear,
  EPHEMERIS_LAST_YEAR,
  startsInOrBeforeBirthYear,
} from '@almamesh/llm';
import { answerLanguage, datedEventLabel, moonTagLabel, type AnswerGrounding, type DatedEvent, type ThemeFact } from '@almamesh/llm/answer';
import { defineTool, z, type ToolContext, type ToolDef } from '@almamesh/llm/toolLoop';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { LocalTimeError } from '@almamesh/store';

import type { PlaceLookup, ResolvedPlace } from './geo/placeLookup';
import type { MoonWindowLoader } from './moonWindow';
import { birthUtcYearOf, birthYearOf, PeriodSkyUnavailableError, type PeriodChartLoader } from './periodChart';
import {
  buildPeriodDetail,
  buildPeriodReading,
  LAST_RESORT_NOTE,
  MAX_PERIOD_RESULT_BYTES,
  READ_PERIOD_TOOL_NAME,
  windowsOf,
  type PeriodReading,
  type PeriodReadingFailure,
  type PeriodReadingUnavailable,
  type ReadingFrame,
  type ReadingPeriod,
  type ReadingPlace,
} from './periodReading';
import { PeriodSkyTimeoutError } from './periodSky';
import { isCachedNatalLords, isCachedPeriodReading } from './periodSkyValidation';
import { askToPickPlace, NO_PLACE_PICKER } from './placePick';
import { predictiveReferenceInstant } from './predictive';
import { formatPinLabel } from './timeTravelSheet';

/** The picker's wait plus a cold engine: the longest any tool may run. */
export const READ_PERIOD_TIMEOUT_MS = 150_000;
export const READ_PERIOD_STATUS_LABEL = 'Reading the period…';
/** A range (more than one calendar month) carries month rows, so it gets more room than a day or a month (4096). */
export const MAX_RANGE_RESULT_BYTES = 6144;
/** How long the place picker waits for the person; then the model asks in words. */
export const PICK_TIMEOUT_MS = 60_000;
const MAX_SPAN_MONTHS = 24;
/** Under a week, a reading needs to know where the user was. */
const NEEDS_PLACE_DAYS = 7;
/** All of one call's Moon read; the period load before it has the rest of the tool's time. */
const MOON_DEADLINE_MS = 8_000;
const LAST_SKY_DAY = `${EPHEMERIS_LAST_YEAR}-12-31`;

const GRAHA_FOCI = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu'] as const;
const FOCI = [...GRAHA_FOCI, 'dashas', 'panchang'] as const;
type Graha = (typeof GRAHA_FOCI)[number];
export type ReadPeriodFocus = (typeof FOCI)[number];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface ReadPeriodArgs {
  readonly start: string;
  readonly end: string | null;
  readonly place: string | null;
  readonly time: string | null;
  readonly focus: ReadPeriodFocus | null;
}

const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const DATE_MESSAGE = 'must be YYYY, YYYY-MM or YYYY-MM-DD';

interface Span {
  readonly start: string;
  /** Inclusive. */
  readonly end: string;
}

function lastDayOfMonth(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(year, index, 0)).getUTCDate()).padStart(2, '0')}`;
}

function firstDay(value: string): string {
  if (value.length === 4) return `${value}-01-01`;
  return value.length === 7 ? `${value}-01` : value;
}

function lastDay(value: string): string {
  if (value.length === 4) return `${value}-12-31`;
  return value.length === 7 ? lastDayOfMonth(value) : value;
}

function spanOf(args: Pick<ReadPeriodArgs, 'start' | 'end'>): Span {
  return { start: firstDay(args.start), end: lastDay(args.end ?? args.start) };
}

function isCalendarDate(value: string): boolean {
  if (value.length !== 10) return true;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Calendar months the span touches, both ends included. */
function monthCount(span: Span): number {
  const index = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));
  return index(span.end) - index(span.start) + 1;
}

const isSingleDay = (span: Span): boolean => span.start === span.end;

interface Problem {
  readonly path: keyof ReadPeriodArgs;
  readonly message: string;
}

function dateProblem(args: ReadPeriodArgs): Problem | undefined {
  const bad = (['start', 'end'] as const).find((key) => {
    const value = args[key];
    return value !== null && !isCalendarDate(value);
  });
  return bad ? { path: bad, message: `${String(args[bad])} is not a calendar day.` } : undefined;
}

function rangeProblem(args: ReadPeriodArgs, span: Span): Problem | undefined {
  if (span.end < span.start) return { path: 'end', message: `end (${String(args.end)}) is before start (${args.start}); send the earlier date as start.` };
  const months = monthCount(span);
  if (months > MAX_SPAN_MONTHS) return { path: 'end', message: `start to end is ${months} months; read at most ${MAX_SPAN_MONTHS} months, or ask which part matters most.` };
  if (span.end > LAST_SKY_DAY) return { path: 'end', message: `The sky is computed through ${EPHEMERIS_LAST_YEAR}; ask about a period that ends by ${LAST_SKY_DAY}.` };
  return undefined;
}

function dayOnlyProblem(args: ReadPeriodArgs, span: Span): Problem | undefined {
  if (isSingleDay(span)) return undefined;
  if (args.focus === 'panchang') return { path: 'focus', message: 'focus panchang needs a single day: send start as YYYY-MM-DD with end null, or another focus.' };
  return undefined;
}

/** The span rules, each worded as the fix the model should make (it sees this text on a retry). */
function spanProblem(args: ReadPeriodArgs): Problem | undefined {
  const date = dateProblem(args);
  if (date) return date;
  const span = spanOf(args);
  return rangeProblem(args, span) ?? dayOnlyProblem(args, span);
}

/** A bare year sent as a JSON number (`"end": 2017`, real runs 2026-10-15) is that year; any other number stays a number and is refused. */
const yearNumberAsText = (value: unknown): unknown =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 9999 ? String(value) : value;

const ARGS_SCHEMA: z.ZodType<ReadPeriodArgs> = z
  .object({
    start: z.preprocess(yearNumberAsText, z.string().regex(DATE, `start ${DATE_MESSAGE}`))
      .describe('First year, month or day: YYYY, YYYY-MM or YYYY-MM-DD.'),
    end: z.preprocess(yearNumberAsText, z.string().regex(DATE, `end ${DATE_MESSAGE}`).nullable())
      .describe('Last year, month or day, inclusive. null for a single year, month or day.'),
    place: z.string().min(2).max(80).nullable()
      .describe('A city as the user said it ("Pune", "Springfield"), or "trip" / "home". null = this thread\'s place.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (24-hour)').nullable()
      .describe('Local time HH:MM, only when start is a single day; else null.'),
    focus: z.enum(FOCI).nullable()
      .describe('null, or a close-up: a graha (its lordships, placements and ashtakavarga row), "dashas" (every dasha span in the period), or "panchang" (a single day only).'),
  })
  .strict()
  .superRefine((args, ctx) => {
    const problem = spanProblem(args);
    if (problem) ctx.addIssue({ code: 'custom', message: problem.message, path: [problem.path] });
  });

const DESCRIPTION = [
  'Read the Vedic reading for a span of time at one place, computed on this device (no network).',
  'Call it before you answer any question about a time: past, present or future.',
  'One call covers the whole span the user asked about (up to 24 months); never split a span into months.',
  'Returns the period and place (name both in your answer), the running dashas (maha, antar, pratyantar) and what each lord rules,',
  'the slow-planet sky with Moon-based tags (e.g. sade_sati_phase_1), life-area themes with direction, strength, confidence and dated windows,',
  'and for a range one row per month.',
  'The result\'s "cite" lists the facts your answer must state; copy them.',
  'Examples:',
  '"September 2019" -> {"start":"2019-09","end":null,"place":null,"time":null,"focus":null}.',
  '"the rest of 2019", asked in a May 2019 trip -> {"start":"2019-06","end":"2019-12","place":null,"time":null,"focus":null}.',
  '"the next 3 months", today 2026-10-14 -> {"start":"2026-10","end":"2027-01","place":null,"time":null,"focus":null}.',
  '"12 March 2019 at 3 pm in Pune" -> {"start":"2019-03-12","end":null,"place":"Pune","time":"15:00","focus":null}.',
  '"How was Saturn for me in 2019?" -> {"start":"2019","end":null,"place":null,"time":null,"focus":"saturn"}.',
].join(' ');

// ---------------------------------------------------------------------------
// The period frame
// ---------------------------------------------------------------------------

const onYearBounds = (span: Span) => span.start.endsWith('-01-01') && span.end.endsWith('-12-31');
const onMonthBounds = (span: Span) => span.start.endsWith('-01') && span.end === lastDayOfMonth(span.end.slice(0, 7));

function granularityOf(span: Span): ReadingPeriod['granularity'] {
  if (isSingleDay(span)) return 'day';
  return onYearBounds(span) && span.start.slice(0, 4) === span.end.slice(0, 4) ? 'year' : 'month';
}

const RANGE_FORMAT: Readonly<Record<ReadingPeriod['granularity'], Intl.DateTimeFormatOptions>> = {
  year: { year: 'numeric', timeZone: 'UTC' },
  month: { month: 'short', year: 'numeric', timeZone: 'UTC' },
  day: { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
};

/** "2019", "May 2019", "12 March 2019", or a range: "Jun – Dec 2019" (plain spaces, not ICU's thin ones). */
function labelOf(span: Span, language: string): string {
  const granularity = granularityOf(span);
  if (granularity !== 'month' || monthCount(span) === 1 && onMonthBounds(span)) return formatPinLabel({ start: span.start, granularity }, language);
  const precision = onYearBounds(span) ? 'year' : onMonthBounds(span) ? 'month' : 'day';
  const noon = (day: string) => new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat(language, RANGE_FORMAT[precision]).formatRange(noon(span.start), noon(span.end)).replace(/[\u2009\u202f]/g, ' ');
}

function tenseOf(span: Span, today: string): ReadingPeriod['tense'] {
  if (span.end < today) return 'past';
  return span.start > today ? 'future' : 'present';
}

/** "Jun – Dec 2019": the span one call reads, in the page's language. */
export function readPeriodSpanLabel(args: Pick<ReadPeriodArgs, 'start' | 'end'>, language: string): string {
  return labelOf(spanOf(args), language);
}

/** "Reading Jun – Dec 2019…": the English status line for one call. */
export function readPeriodStatusLabel(args: Pick<ReadPeriodArgs, 'start' | 'end'>, language: string): string {
  return `Reading ${readPeriodSpanLabel(args, language)}…`;
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface ChatPlace {
  readonly label: string;
  readonly timezone: string;
}

/** A place on the device side. Coordinates (a looked-up city, a trip pin) go to the Moon loader only. */
export interface DevicePlace extends ChatPlace {
  readonly latitude?: number;
  readonly longitude?: number;
}

export type PickPlace = typeof askToPickPlace;

export interface PlaceResolverInput {
  /** The trip's place; undefined in a today thread. */
  readonly threadPlace: DevicePlace | undefined;
  /** Where the person lives now (Settings); undefined when none is set. Coordinates go to the Moon loader only. */
  readonly homePlace: DevicePlace | undefined;
  readonly lookup?: (text: string) => Promise<PlaceLookup>;
  readonly pick?: PickPlace;
}

export interface PlaceAsk {
  readonly status: 'place_not_chosen' | 'place_not_found';
  readonly candidates?: readonly string[];
  readonly ask: string;
}

export type PlaceOutcome =
  | { readonly kind: 'place'; readonly place: DevicePlace }
  | { readonly kind: 'none' }
  | { readonly kind: 'ask'; readonly result: PlaceAsk };

const PLACE_NOT_FOUND: PlaceAsk = { status: 'place_not_found', ask: 'Ask for the nearest larger city.' };

/** The offline lookup, loaded on first use so the tz/geo data stays out of the eager chunk. */
const lazyLookup = (text: string): Promise<PlaceLookup> => import('./geo/placeLookup').then((geo) => geo.lookupPlaceOffline(text));

const known = (place: DevicePlace | undefined): PlaceOutcome => (place ? { kind: 'place', place } : { kind: 'none' });

function placed(place: ResolvedPlace): PlaceOutcome {
  const { label, timezone } = place.summary;
  return { kind: 'place', place: { label, timezone, latitude: place.latitude, longitude: place.longitude } };
}

/**
 * The pick, or undefined once {@link PICK_TIMEOUT_MS} passes: a person who never picks gets the
 * neutral ask, not the tool's own timeout. A timer (not AbortSignal.timeout) so the deadline is
 * one clock with the rest of the turn, and the race also answers a picker that ignores its signal.
 */
async function pickWithin(pick: PickPlace, text: string, candidates: readonly ResolvedPlace[], signal: AbortSignal): ReturnType<PickPlace> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), PICK_TIMEOUT_MS);
  const expired = new Promise<undefined>((resolve) => deadline.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
  try {
    return await Promise.race([pick(text, candidates, AbortSignal.any([signal, deadline.signal])), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function settlePick(text: string, candidates: readonly ResolvedPlace[], pick: PickPlace, signal: AbortSignal): Promise<PlaceOutcome> {
  const picked = await pickWithin(pick, text, candidates, signal);
  signal.throwIfAborted();
  if (picked && picked !== NO_PLACE_PICKER) return placed(picked);
  const labels = candidates.map((candidate) => candidate.summary.label);
  return { kind: 'ask', result: { status: 'place_not_chosen', candidates: labels, ask: 'Ask the user which one they meant.' } };
}

/**
 * The place a call names: null or "trip" is this thread's place (the trip's, else home), "home" the
 * profile's current place, anything else a city looked up offline. Several matches open the picker.
 */
export async function resolveChatPlace(text: string | null, input: PlaceResolverInput, signal: AbortSignal): Promise<PlaceOutcome> {
  const query = text?.trim() ?? '';
  const keyword = query.toLowerCase();
  if (text === null || keyword === 'trip') return known(input.threadPlace ?? input.homePlace);
  if (keyword === 'home') return known(input.homePlace);
  const found = await (input.lookup ?? lazyLookup)(query);
  signal.throwIfAborted();
  if (found.status === 'found') return placed(found.place);
  if (found.status === 'not_found') return { kind: 'ask', result: PLACE_NOT_FOUND };
  return settlePick(query, found.candidates, input.pick ?? askToPickPlace, signal);
}

/** Label and zone only, copied by name: coordinates never ride along. */
function readingPlace(where: PlaceOutcome, viewerZone: string): ReadingPlace {
  if (where.kind !== 'place') return { timezone: viewerZone };
  const { label, timezone } = where.place;
  return label ? { label, timezone } : { timezone };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface MonthTheme {
  readonly domain: string;
  readonly direction: PeriodReadingContext['themes'][number]['direction'];
  readonly confidence: PeriodReadingContext['themes'][number]['confidence'];
}

/** One compact row per calendar month of a range. */
export interface MonthRow {
  readonly month: string;
  /** On the first row, and wherever it differs from the row before (null: no maha that month). */
  readonly maha?: string | null;
  readonly antar?: string | null;
  /** Only when a dated window falls that month: the theme with the most of them (its direction and confidence are the span's). */
  readonly top_theme?: MonthTheme;
  readonly window_count?: number;
}

type Facts = Readonly<Record<string, unknown>>;

export interface CloseUp {
  readonly focus: ReadPeriodFocus;
  readonly lord?: Facts;
  readonly bindus?: Facts | null;
  readonly dashas?: Facts;
  readonly panchang?: Facts;
  readonly factors: readonly string[];
}

export interface PlaceEvent {
  readonly local_time: string;
  readonly lagna_sign: string;
  readonly moon: MoonMark;
}

/** A Moon tag as the answer copies it (`tag`) and as a person reads it (`says`). */
export interface CiteMoon {
  readonly tag: string;
  readonly says: string;
}

/**
 * What the answer must state, already phrased, from the reading's own facts (never the birth
 * data, never coordinates): the model copies these lines into the answer's keys.
 */
export interface ReadingCite {
  readonly period: string;
  /** The place label, or null when the reading has none (the answer's place is then null). */
  readonly place: string | null;
  /** One line per running lord: "Jupiter, rules your 2nd and 11th houses". */
  readonly maha: readonly string[];
  readonly antar: readonly string[];
  /** The pratyantar lords running in the period, phrased like maha and antar ([] when none). */
  readonly pratyantar: readonly string[];
  readonly moon: readonly CiteMoon[];
  /** At most {@link MAX_CITE_WINDOWS} dated facts inside the period, by date. */
  readonly windows: readonly DatedFact[];
  /** Each theme's direction and confidence by domain: the answer's theme for that area states both. */
  readonly themes: Readonly<Record<string, ThemeFact>>;
}

export interface ReadPeriodReading extends PeriodReading {
  /** On every successful read; cut by no trim. */
  readonly cite?: ReadingCite;
  readonly months?: readonly MonthRow[];
  readonly close_up?: CloseUp;
  /** A single day at a place: the Moon at that place's local midnights. */
  readonly place_moon?: MoonEnds;
  readonly event?: PlaceEvent;
  readonly notes?: readonly string[];
}

export interface ReadPeriodAsk {
  readonly status: 'outside_range' | 'needs_place' | PlaceAsk['status'];
  readonly candidates?: readonly string[];
  readonly ask: string;
}

export type ReadPeriodResult = ReadPeriodReading | ReadPeriodAsk | PeriodReadingUnavailable;

/** Shared with travel (travelTool.ts): a day with no place at all. */
export const NEEDS_PLACE: ReadPeriodAsk = { status: 'needs_place', ask: 'Ask where the user was that day.' };
/** Shared with travel: a period before birth. Names no part of the birth date, not even the year. */
export const OUTSIDE_RANGE: ReadPeriodAsk = { status: 'outside_range', ask: 'This is before the chart begins; ask about a later period.' };
const DEVICE_LIMIT_NOTE = 'This device answers dated questions with dashas only, to stay within memory.';
const MOON_UNAVAILABLE_NOTE = "Couldn't read the Moon at that place on this device; the rest of the answer stands.";
/** A time on a span longer than a day means nothing there: the read goes ahead without it. */
const TIME_IGNORED_NOTE = 'time ignored: the span is longer than a day';

export function isReadPeriodReading(value: unknown): value is ReadPeriodReading {
  return typeof value === 'object' && value !== null && 'period' in value && 'dashas' in value;
}

// ---------------------------------------------------------------------------
// Gates and the engine load
// ---------------------------------------------------------------------------

/** The later of the local and UTC birth years (the engine computes in UTC). Never sent. */
function skyGateYear(birth: ProcessedBirthData | undefined): number | undefined {
  const local = birthYearOf(birth);
  const utc = birthUtcYearOf(birth);
  return local === undefined ? utc : Math.max(local, utc ?? local);
}

/** Before birth, judged by the birth YEAR (a day-precision refusal is a birth-date oracle); the ask names neither. */
function outsideRange(birth: ProcessedBirthData | undefined, span: Span): ReadPeriodAsk | undefined {
  return endsBeforeBirthYear(span, birthYearOf(birth)) ? OUTSIDE_RANGE : undefined;
}

function unavailable(frame: ReadingFrame, reason: PeriodReadingFailure, notes?: readonly string[]): PeriodReadingUnavailable {
  return { period: frame.period, place: frame.place, available: false, reason, ...(notes ? { notes } : {}) };
}

function failureReason(error: unknown): PeriodReadingFailure {
  if (error instanceof PeriodSkyUnavailableError) return error.reason;
  if (error instanceof PeriodSkyTimeoutError) return 'timeout';
  return 'engine_unavailable';
}

export interface ReadPeriodInput extends PlaceResolverInput {
  /** Read for the birth-year gates only. Never echoed. */
  readonly birth: ProcessedBirthData | undefined;
  readonly chart: SiderealChart;
  readonly language: string;
  readonly viewerZone: () => string;
  /** One engine load for the span (periodChart.ts). */
  readonly loadPeriodChart: PeriodChartLoader;
  /** Today's chart, for a single day that is today. */
  readonly loadCurrentChart: (context: ToolContext) => Promise<SiderealChart>;
  /** A single day's Moon at a place (moonWindow.ts); absent: no Moon rows. */
  readonly loadMoonWindow?: MoonWindowLoader;
  /** devicePolicy().periodSkyComputeAllowed (default true): false reads only today's single day. */
  readonly periodSkyAllowed?: boolean;
}

interface Loaded {
  readonly source: PeriodReadingContext;
  readonly strength: StrengthContext | null | undefined;
}

function gate(input: ReadPeriodInput, frame: ReadingFrame, today: boolean): PeriodReadingUnavailable | undefined {
  if (startsInOrBeforeBirthYear(frame.period, skyGateYear(input.birth))) return unavailable(frame, 'birth_year', [BIRTH_YEAR_SKY_NOTE]);
  if (input.periodSkyAllowed === false && !today) return unavailable(frame, 'device_limit', [DEVICE_LIMIT_NOTE]);
  return undefined;
}

async function load(input: ReadPeriodInput, frame: ReadingFrame, today: boolean, context: ToolContext): Promise<Loaded | PeriodReadingUnavailable> {
  const refused = gate(input, frame, today);
  if (refused) return refused;
  try {
    const { start, end } = frame.period;
    const chart = today ? await input.loadCurrentChart(context) : await input.loadPeriodChart({ start, end }, context);
    const source = chart.period_reading;
    // An older engine (or a cache it wrote) has no reading: never synthesize one.
    if (!source || !isCachedPeriodReading(source) || !isCachedNatalLords(source.natal_lords)) return unavailable(frame, 'reading_unavailable');
    return { source, strength: chart.strength_context };
  } catch (error) {
    // A cancelled turn is not a reading failure: let the loop see the cancellation.
    if (context.signal.aborted) throw error;
    return unavailable(frame, failureReason(error));
  }
}

// ---------------------------------------------------------------------------
// Month rows, close-ups, the Moon at a place
// ---------------------------------------------------------------------------

function monthsOf(period: Span): Span[] {
  const months: Span[] = [];
  for (let month = period.start.slice(0, 7); month <= period.end.slice(0, 7); month = nextMonth(month)) {
    const start = `${month}-01` < period.start ? period.start : `${month}-01`;
    const end = lastDayOfMonth(month) > period.end ? period.end : lastDayOfMonth(month);
    months.push({ start, end });
  }
  return months;
}

function nextMonth(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, index, 1)).toISOString().slice(0, 7);
}

function lordAt(source: PeriodReadingContext, level: 'maha' | 'antar', day: string): string | null {
  const span = source.dasha_spans.find((item) => item.level === level && item.start.slice(0, 10) <= day && day < item.end.slice(0, 10));
  return span?.lord ?? null;
}

function topTheme(source: PeriodReadingContext, month: Span): MonthTheme | undefined {
  let best: { readonly theme: PeriodReadingContext['themes'][number]; readonly count: number } | undefined;
  for (const theme of source.themes) {
    const count = windowsOf([theme], month).length;
    if (count > (best?.count ?? 0)) best = { theme, count };
  }
  return best ? { domain: best.theme.domain, direction: best.theme.direction, confidence: best.theme.confidence } : undefined;
}

interface MonthLords {
  readonly maha: string | null;
  readonly antar: string | null;
}

function changedLords(previous: MonthLords | undefined, lords: MonthLords): Partial<MonthLords> {
  if (!previous) return lords;
  return { ...(lords.maha !== previous.maha ? { maha: lords.maha } : {}), ...(lords.antar !== previous.antar ? { antar: lords.antar } : {}) };
}

function monthActivity(source: PeriodReadingContext, month: Span): Pick<MonthRow, 'top_theme' | 'window_count'> {
  const count = windowsOf(source.themes, month).length;
  const top = count > 0 ? topTheme(source, month) : undefined;
  return top ? { top_theme: top, window_count: count } : {};
}

function monthRows(source: PeriodReadingContext, period: Span): MonthRow[] {
  let previous: MonthLords | undefined;
  return monthsOf(period).map((month) => {
    const lords = { maha: lordAt(source, 'maha', month.start), antar: lordAt(source, 'antar', month.start) };
    const row = { month: month.start.slice(0, 7), ...changedLords(previous, lords), ...monthActivity(source, month) };
    previous = lords;
    return row;
  });
}

function detailFacts(loaded: Loaded, frame: ReadingFrame, section: string, key?: string): { facts: Facts; factors: readonly string[] } | null {
  const detail = buildPeriodDetail({ reading: loaded.source, strength: loaded.strength }, frame, section, key);
  return 'error' in detail ? null : { facts: detail.facts, factors: detail.factors };
}

const isGraha = (focus: ReadPeriodFocus): focus is Graha => GRAHA_FOCI.some((graha) => graha === focus);

function closeUpOf(loaded: Loaded, frame: ReadingFrame, focus: ReadPeriodFocus): CloseUp | undefined {
  if (isGraha(focus)) {
    const lord = detailFacts(loaded, frame, 'lord', focus);
    const bindus = detailFacts(loaded, frame, 'bindus', focus);
    return lord ? { focus, lord: lord.facts, bindus: bindus?.facts ?? null, factors: lord.factors } : undefined;
  }
  const detail = detailFacts(loaded, frame, focus);
  return detail ? { focus, [focus]: detail.facts, factors: detail.factors } : undefined;
}

/** `work` under the turn's signal and the Moon's own deadline. */
async function withMoonDeadline<T>(context: ToolContext, work: (bounded: ToolContext) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(MOON_DEADLINE_MS)]);
  const stopped = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return Promise.race([work({ ...context, signal }), stopped]);
}

interface MoonPart {
  readonly place_moon?: MoonEnds;
  readonly event?: PlaceEvent;
  readonly notes?: readonly string[];
}

const moonMark = (mark: MoonMark): MoonMark => ({ sign: mark.sign, nakshatra: mark.nakshatra, tithi: mark.tithi, paksha: mark.paksha });

function moonPart(window: MoonWindow, time: string | null): MoonPart {
  const place_moon = { at_start: moonMark(window.at_place.at_start), at_end: moonMark(window.at_place.at_end) };
  if (!time || !window.event) return { place_moon };
  return { place_moon, event: { local_time: time, lagna_sign: window.event.lagna_sign, moon: moonMark(window.event.moon) } };
}

/** A single day at a place with coordinates: the Moon there, and at the time if one was sent. */
async function readMoon(input: ReadPeriodInput, where: PlaceOutcome, span: Span, time: string | null, context: ToolContext): Promise<MoonPart> {
  const place = where.kind === 'place' ? where.place : undefined;
  const { latitude, longitude } = place ?? {};
  if (!isSingleDay(span) || !place || latitude === undefined || longitude === undefined || !input.loadMoonWindow) return {};
  const load = input.loadMoonWindow;
  const request = { start: span.start, end: span.end, zone: place.timezone, place: { latitude, longitude }, ...(time ? { time } : {}) };
  try {
    return moonPart(await withMoonDeadline(context, (bounded) => load(request, bounded)), time);
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { notes: [error instanceof LocalTimeError ? error.message : MOON_UNAVAILABLE_NOTE] };
  }
}

// ---------------------------------------------------------------------------
// Composing the result under the budget
// ---------------------------------------------------------------------------

interface Extras extends MoonPart {
  readonly months?: readonly MonthRow[];
  readonly close_up?: CloseUp;
}

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

interface ExtrasLevel {
  readonly extras: Extras;
  readonly trimmed: readonly string[];
}

/**
 * The extras, fullest first: the close-up loses its factors, then goes. Month rows are already
 * compact and always stay: they outrank the reading's extra sky spans, which its own trims cut first.
 */
function extrasLevels(extras: Extras): readonly [ExtrasLevel, ...ExtrasLevel[]] {
  const { close_up: closeUp, ...rest } = extras;
  if (!closeUp) return [{ extras, trimmed: [] }];
  return [
    { extras, trimmed: [] },
    { extras: { ...rest, close_up: { ...closeUp, factors: [] } }, trimmed: ['close-up factors'] },
    { extras: rest, trimmed: ['close-up'] },
  ];
}

function withExtras(reading: PeriodReading, level: ExtrasLevel): ReadPeriodReading {
  const trimmed = [...(reading.trimmed ?? []), ...level.trimmed];
  return { ...reading, ...level.extras, ...(trimmed.length > 0 ? { trimmed } : {}) };
}

/** periodReading.ts's last resort: the windows, segments and most theme detail are gone, the sky is coarse. */
const isBare = (reading: PeriodReading): boolean => reading.trimmed?.includes(LAST_RESORT_NOTE) ?? false;

interface Fitted {
  readonly reading: PeriodReading;
  readonly result: ReadPeriodReading;
}

/** `"cite":` and its comma, with slack for a second-pass cite a few bytes longer than the first. */
const CITE_KEY_BYTES = 32;

/**
 * The reading gets what the extras (month rows, close-up, Moon), their trimmed notes and the cite
 * leave. The cite is sized on a first fit and the reading refitted without its bytes: trimming
 * only drops facts, so the refitted reading's cite is no larger. The cite's dated windows come from
 * the untrimmed reading: a budget cut may drop the segment events, never the dates the answer
 * must give (November 2026 once lost its only dates that way, matrix 2026-10-14).
 */
function fitLevel(loaded: Loaded, frame: ReadingFrame, level: ExtrasLevel, limit: number, range: boolean, language: string): Fitted {
  const room = limit - jsonBytes(level.extras) - jsonBytes(level.trimmed) - 16;
  const fit = (budgetBytes: number) => buildPeriodReading(loaded.source, frame, { budgetBytes, windowOrder: range ? 'severity' : 'date' });
  const windows = citeWindows(withExtras(fit(Number.POSITIVE_INFINITY), level), language);
  const cite = (fitted: ReadPeriodReading) => ({ ...readingCite(fitted, language), windows });
  const reserve = jsonBytes(cite(withExtras(fit(room), level))) + CITE_KEY_BYTES;
  const reading = fit(room - reserve);
  const result = withExtras(reading, level);
  return { reading, result: { cite: cite(result), ...result } };
}

/**
 * The fullest extras that fit beside a reading the budget did not cut to its last resort. When
 * every level cuts it that far, the fullest level that fits; when none fits, the leanest (no close-up).
 */
function compose(loaded: Loaded, frame: ReadingFrame, extras: Extras, language: string): ReadPeriodReading {
  const range = extras.months !== undefined;
  const limit = range ? MAX_RANGE_RESULT_BYTES : MAX_PERIOD_RESULT_BYTES;
  const levels = extrasLevels(extras);
  let fallback: ReadPeriodReading | undefined;
  for (const level of levels) {
    const { reading, result } = fitLevel(loaded, frame, level, limit, range, language);
    if (jsonBytes(result) >= limit) continue;
    if (!isBare(reading)) return result;
    fallback ??= result;
  }
  return fallback ?? fitLevel(loaded, frame, levels.at(-1) ?? levels[0], limit, range, language).result;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

function frameOf(input: ReadPeriodInput, span: Span, where: PlaceOutcome, today: string): ReadingFrame {
  const viewerZone = input.viewerZone();
  return {
    period: { ...span, granularity: granularityOf(span), label: labelOf(span, input.language), tense: tenseOf(span, today) },
    place: readingPlace(where, viewerZone),
  };
}

const daysIn = (span: Span): number => (Date.parse(`${span.end}T00:00:00Z`) - Date.parse(`${span.start}T00:00:00Z`)) / 86_400_000 + 1;

async function readPeriod(input: ReadPeriodInput, args: ReadPeriodArgs, context: ToolContext): Promise<ReadPeriodResult> {
  const span = spanOf(args);
  const outside = outsideRange(input.birth, span);
  if (outside) return outside;
  const where = await resolveChatPlace(args.place, input, context.signal);
  if (where.kind === 'ask') return where.result;
  if (where.kind === 'none' && daysIn(span) < NEEDS_PLACE_DAYS) return NEEDS_PLACE;
  const todayDay = predictiveReferenceInstant(context.now, input.viewerZone()).slice(0, 10);
  const frame = frameOf(input, span, where, todayDay);
  const loaded = await load(input, frame, isSingleDay(span) && span.start === todayDay, context);
  if ('available' in loaded) return loaded;
  const moon = await readMoon(input, where, span, args.time, context);
  const ignoredTime = args.time !== null && !isSingleDay(span) ? [TIME_IGNORED_NOTE] : [];
  const notes = [...(moon.notes ?? []), ...ignoredTime];
  const closeUp = args.focus ? closeUpOf(loaded, frame, args.focus) : undefined;
  const months = monthCount(span) > 1 ? monthRows(loaded.source, span) : undefined;
  const extras = { ...moon, ...(notes.length > 0 ? { notes } : {}), ...(months ? { months } : {}), ...(closeUp ? { close_up: closeUp } : {}) };
  return compose(loaded, frame, extras, input.language);
}

const cacheKey = (args: ReadPeriodArgs): string => JSON.stringify([args.start, args.end, args.place, args.time, args.focus]);

/**
 * One tool per turn: an identical call returns the same result object (no pointer to an
 * earlier call). That includes the asks: a cached place_not_chosen, needs_place or
 * outside_range is answered again from the cache, never re-asked (the picker does not reopen)
 * within the same turn. A failed or unavailable read is not kept, so a later call reads again.
 */
export function createReadPeriodTool(input: ReadPeriodInput): ToolDef<ReadPeriodArgs> {
  const cache = new Map<string, Promise<ReadPeriodResult>>();
  return defineTool({
    name: READ_PERIOD_TOOL_NAME,
    description: DESCRIPTION,
    input: ARGS_SCHEMA,
    timeoutMs: READ_PERIOD_TIMEOUT_MS,
    statusLabel: READ_PERIOD_STATUS_LABEL,
    reads: true,
    execute: (args, context) => {
      const key = cacheKey(args);
      const hit = cache.get(key);
      if (hit) return hit;
      const pending = readPeriod(input, args, context);
      cache.set(key, pending);
      pending.then((result) => ('available' in result ? cache.delete(key) : undefined), () => cache.delete(key));
      return pending;
    },
  });
}

type DatedFact = AnswerGrounding['readings'][number]['windows'][number];

const titled = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * An engine descriptor as a dated event: "transit.jupiter.ingress.cancer" is Jupiter entering
 * Cancer, "saturn.station.direct" Saturn stationing direct. Any other descriptor stays as written.
 */
function descriptorEvent(descriptor: string): DatedEvent {
  const [, graha = '', kind = '', what = ''] = /(?:^|\.)([a-z]+)\.(ingress|station)\.([a-z]+)$/.exec(descriptor) ?? [];
  if (kind === 'ingress') return { kind: 'ingress', graha, sign: what };
  if (kind === 'station') return { kind: 'station', graha, motion: what };
  return { kind: 'other', text: descriptor };
}

/** Dasha spans that begin inside the period (a clipped span starts on the period's first day). */
function dashaChanges(dashas: ReadPeriodReading['dashas'], start: string): { date: string; event: DatedEvent }[] {
  return (['maha', 'antar', 'pratyantar'] as const).flatMap((level) =>
    dashas[level].filter((span) => span.start > start).map((span) => ({ date: span.start, event: { kind: 'dasha' as const, level, lord: span.lord } })),
  );
}

/**
 * Every dated fact inside the period, by date, one label per day (the first by kind): theme
 * windows, segment events (sign changes, stations), dasha changes and the sandhi. Each label is
 * in the chat language (the answer fills windows from these; the cite lists them).
 */
function datedFacts(result: ReadPeriodReading, language: string): DatedFact[] {
  const { start, end } = result.period;
  const { sandhi } = result.dashas;
  const events: { date: string; event: DatedEvent }[] = [
    ...result.windows.map((window) => ({ date: window.date, event: descriptorEvent(window.descriptor) })),
    ...result.segments.flatMap((segment) => segment.events.map((event) => ({ date: event.slice(0, 10), event: descriptorEvent(event.slice(11).trim()) }))),
    ...dashaChanges(result.dashas, start),
    ...(sandhi ? [{ date: sandhi.date, event: { kind: 'sandhi' as const, level: sandhi.level } }] : []),
  ];
  const spoken = answerLanguage(language);
  const byDay = new Map<string, DatedFact>();
  for (const { date, event } of events) {
    if (date >= start && date <= end && !byDay.has(date)) byDay.set(date, { date, what: datedEventLabel(event, spoken) });
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** At most this many dated facts in a cite: enough to choose from, small enough to ride in every result. */
export const MAX_CITE_WINDOWS = 6;

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Readonly<Record<number, string>>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const listed = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`);

/** "Jupiter, rules your 2nd and 11th houses"; "Rahu, rules no house"; just "Ketu" when the reading gives no lordship. */
function lordLine(lord: string, rules: readonly number[] | undefined): string {
  if (rules === undefined) return titled(lord);
  if (rules.length === 0) return `${titled(lord)}, rules no house`;
  const houses = [...rules].sort((a, b) => a - b).map(ordinal);
  return `${titled(lord)}, rules your ${listed(houses)} ${houses.length > 1 ? 'houses' : 'house'}`;
}

function citeLords(result: ReadPeriodReading, level: 'maha' | 'antar' | 'pratyantar'): string[] {
  const lords = [...new Set(result.dashas[level].map((span) => span.lord))];
  return lords.map((lord) => lordLine(lord, result.lords.find((item) => item.lord === lord)?.rules));
}

/** The theme windows first (a range has already ranked them by severity), then other dated facts; listed by date. */
function citeWindows(result: ReadPeriodReading, language: string): DatedFact[] {
  const themed = new Set(result.windows.map((window) => window.date));
  const facts = datedFacts(result, language);
  const chosen = [...facts.filter((fact) => themed.has(fact.date)), ...facts.filter((fact) => !themed.has(fact.date))].slice(0, MAX_CITE_WINDOWS);
  return chosen.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const uniqueLords = (spans: readonly { readonly lord: string }[]): string[] => [...new Set(spans.map((span) => span.lord))];

/** Each theme's direction and confidence by domain (the first theme of a domain). */
function themeFacts(result: ReadPeriodReading): Record<string, ThemeFact> {
  const facts: Record<string, ThemeFact> = {};
  for (const theme of result.themes) facts[theme.domain] ??= { direction: theme.direction, confidence: theme.confidence };
  return facts;
}

/**
 * The facts the answer must state, phrased from this reading only (the same facts the answer check
 * accepts). The Moon lines and dated windows are in the chat language; lords stay as the check names them.
 */
export function readingCite(result: ReadPeriodReading, language: string): ReadingCite {
  const tags = [...new Set(result.sky.flatMap((span) => span.tags))];
  return {
    period: result.period.label,
    place: result.place.label ?? null,
    maha: citeLords(result, 'maha'),
    antar: citeLords(result, 'antar'),
    pratyantar: citeLords(result, 'pratyantar'),
    moon: tags.map((tag) => ({ tag, says: moonTagLabel(tag, answerLanguage(language)) })),
    windows: citeWindows(result, language),
    themes: themeFacts(result),
  };
}

/**
 * The cite's dated facts (from the untrimmed reading, so a budget cut cannot take them away) plus
 * the reading's other dated facts, by date. On a day both name, the cite's label wins.
 */
function groundedWindows(result: ReadPeriodReading, language: string): DatedFact[] {
  const { start, end } = result.period;
  const cited = (result.cite?.windows ?? []).filter((fact) => fact.date >= start && fact.date <= end);
  const seen = new Set(cited.map((fact) => fact.date));
  const facts = datedFacts(result, language).filter((fact) => !seen.has(fact.date));
  return [...cited, ...facts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** A reading projected flat for the answer check (answer.ts): what the answer may cite, dated facts in the chat language. */
export function readPeriodGrounding(result: ReadPeriodReading, language: string): AnswerGrounding['readings'][number] {
  const unique = (items: readonly string[]) => [...new Set(items)];
  const { start, end, label } = result.period;
  return {
    period: { start, end, label },
    place: { label: result.place.label ?? '' },
    maha: uniqueLords(result.dashas.maha),
    antar: uniqueLords(result.dashas.antar),
    pratyantar: uniqueLords(result.dashas.pratyantar),
    rules: Object.fromEntries(result.lords.flatMap((lord) => (lord.rules ? [[lord.lord, [...lord.rules]]] : []))),
    tags: unique(result.sky.flatMap((span) => span.tags)),
    windows: groundedWindows(result, language),
    themes: themeFacts(result),
  };
}
