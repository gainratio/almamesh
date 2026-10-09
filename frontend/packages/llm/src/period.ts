// Time travel (spec 2026-10-08): the rules the app enforces on the dates the
// model sends to the timing tool. Pure calendar checks on YYYY-MM-DD strings;
// no astrology lives here.
import type { PeriodRange } from "./sanitize";

export const ISO_DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const ISO_DAY = new RegExp(ISO_DAY_PATTERN);
const MS_PER_DAY = 86_400_000;

/** The last day the on-device ephemeris covers (DE421 ends 2053; slow_hits.py `_EPHEMERIS_MAX`). */
const EPHEMERIS_LAST_DAY = "2052-12-31";
/** Longer spans get dashas only. */
const MAX_TRANSIT_SPAN_YEARS = 2;
/** The engine's month for its timeline window (`_DAYS_PER_MONTH`, backend/src/almamesh/transits/timeline.py). */
export const ENGINE_DAYS_PER_MONTH = 30.4375;
/** The engine's longest timeline window (`_MAX_WINDOW_MONTHS`, backend/src/almamesh/predictive.py). */
export const LONG_PERIOD_WINDOW_MONTHS = 24;

export const BEFORE_BIRTH_MESSAGE =
  "This period starts before the birth date. Ask about a period after it.";
export const BIRTH_YEAR_SKY_NOTE =
  "Planet timing for the year of birth isn't available; showing periods only.";
export const OVER_TWO_YEARS_NOTE =
  "Over 2 years: showing dashas only. Ask about a shorter span for transits.";
export const PAST_EPHEMERIS_NOTE =
  "After 2052: showing dashas only. The on-device ephemeris ends in 2052.";

export type PeriodArgs =
  | { readonly kind: "today" }
  | { readonly kind: "period"; readonly period: PeriodRange }
  | { readonly kind: "invalid"; readonly error: string };

export interface PeriodEcho {
  readonly start: string;
  readonly end: string;
  readonly days: number;
  readonly basis: "today" | "period";
}

export interface PeriodLimits {
  readonly dashasOnly: boolean;
  readonly notes: readonly string[];
}

/** True for a real calendar day: Date.parse rolls 2026-02-30 to March, so round-trip it. */
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function dayArgument(value: unknown, key: "start" | "end"): string | { readonly error: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isCalendarDay(value)) {
    return { error: `${key} must be a date like 2026-06-01` };
  }
  return value;
}

/** Read the tool's optional start/end. Omitted start and end mean today. */
export function parsePeriodArgs(args: { readonly start?: unknown; readonly end?: unknown }): PeriodArgs {
  const start = dayArgument(args.start, "start");
  const end = dayArgument(args.end, "end");
  if (typeof start === "object") return { kind: "invalid", error: start.error };
  if (typeof end === "object") return { kind: "invalid", error: end.error };
  if (start === undefined) {
    return end === undefined
      ? { kind: "today" }
      : { kind: "invalid", error: "start is required when end is given" };
  }
  const last = end ?? start;
  if (last < start) return { kind: "invalid", error: "end is before start" };
  return { kind: "period", period: { start, end: last } };
}

export function periodEcho(period: PeriodRange, basis: PeriodEcho["basis"]): PeriodEcho {
  const span = Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`);
  return { start: period.start, end: period.end, days: Math.round(span / MS_PER_DAY) + 1, basis };
}

/**
 * True when the whole period ends before 1 January of the birth year. Year
 * precision on purpose: a refusal is itself an answer, so a day-precision
 * boundary would let repeated calls bisect the birth month and day. The year
 * is already revealed by month-precision dasha boundaries; nothing finer is.
 */
export function endsBeforeBirthYear(period: PeriodRange, birthYear: number | undefined): boolean {
  if (birthYear === undefined) return false;
  return period.end < yearDay(birthYear, "01-01");
}

/**
 * True when the period starts on or before 31 December of the birth year. The
 * engine computes a period sky against the real birth instant, so its running
 * dasha lords flip at birth; a birth-year sky would be a birth-day oracle.
 */
export function startsInOrBeforeBirthYear(period: PeriodRange, birthYear: number | undefined): boolean {
  if (birthYear === undefined) return false;
  return period.start <= yearDay(birthYear, "12-31");
}

/** "YYYY-MM-DD" for a month-day in the given year. */
export function yearDay(year: number, monthDay: "01-01" | "12-31"): string {
  return `${String(year).padStart(4, "0")}-${monthDay}`;
}

/** The same month and day N years later, as a string bound (02-29 stays a valid upper bound). */
function yearsLater(day: string, years: number): string {
  return `${String(Number(day.slice(0, 4)) + years).padStart(4, "0")}${day.slice(4)}`;
}

export function periodLimits(period: PeriodRange): PeriodLimits {
  if (period.end > EPHEMERIS_LAST_DAY) return { dashasOnly: true, notes: [PAST_EPHEMERIS_NOTE] };
  if (period.end >= yearsLater(period.start, MAX_TRANSIT_SPAN_YEARS)) {
    return { dashasOnly: true, notes: [OVER_TWO_YEARS_NOTE] };
  }
  return { dashasOnly: false, notes: [] };
}

/**
 * True when an engine window of `windowMonths`, starting at the period's first
 * day, ends before the END of the period's last day (instants, not days: a
 * leap calendar year's 12 months stop at 06:00 UTC on 31 December). Calendar
 * arithmetic only.
 */
export function windowEndsBeforePeriodEnd(period: PeriodRange, windowMonths: number): boolean {
  const start = Date.parse(`${period.start}T00:00:00Z`);
  return instantEndsBeforePeriodEnd(start + windowMonths * ENGINE_DAYS_PER_MONTH * MS_PER_DAY, period);
}

/** True when the instant (epoch ms) falls before the END of the period's last day. One rule for every window check. */
export function instantEndsBeforePeriodEnd(instantMs: number, period: PeriodRange): boolean {
  return instantMs < Date.parse(`${period.end}T00:00:00Z`) + MS_PER_DAY;
}

/**
 * 24 when the engine's default 12-month window ends before the period does;
 * otherwise undefined (send no window, so 12-month store and memo keys stay as
 * they were).
 */
export function periodWindowMonths(period: PeriodRange): typeof LONG_PERIOD_WINDOW_MONTHS | undefined {
  return windowEndsBeforePeriodEnd(period, 12) ? LONG_PERIOD_WINDOW_MONTHS : undefined;
}
