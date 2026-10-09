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

export const BEFORE_BIRTH_MESSAGE =
  "This period starts before the birth date. Ask about a period after it.";
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

export function startsBeforeBirth(period: PeriodRange, birthDay: string | undefined): boolean {
  return birthDay !== undefined && period.start < birthDay;
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
