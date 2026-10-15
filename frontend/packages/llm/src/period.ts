// Time travel (spec 2026-10-08): the rules the app enforces on the dates the
// model sends to the timing tool. Pure calendar checks on YYYY-MM-DD strings;
// no astrology lives here.
import type { PeriodRange } from "./sanitize";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * The last year the engine computes. Mirrors backend `EPHEMERIS_LAST_INSTANT`
 * (transits/positions.py, 2053-01-01 exclusive); DE421 itself ends 2053-10-09.
 * The only TS copy: the Time travel sheet derives its last year from this.
 */
export const EPHEMERIS_LAST_YEAR = 2052;
/** The engine's month for its timeline window (`_DAYS_PER_MONTH`, backend/src/almamesh/transits/timeline.py). */
export const ENGINE_DAYS_PER_MONTH = 30.4375;
/** The engine's longest timeline window (`_MAX_WINDOW_MONTHS`, backend/src/almamesh/predictive.py). */
export const LONG_PERIOD_WINDOW_MONTHS = 24;

export const BIRTH_YEAR_SKY_NOTE =
  "Planet timing for the year of birth isn't available; showing periods only.";

/** True for a real calendar day: Date.parse rolls 2026-02-30 to March, so round-trip it. */
export function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
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

/**
 * True when an engine window of `windowMonths`, starting at the period's first
 * day, ends before the END of the period's last day (instants, not days: a
 * leap calendar year's 12 months stop at 06:00 UTC on 31 December). Calendar
 * arithmetic only.
 */
function windowEndsBeforePeriodEnd(period: PeriodRange, windowMonths: number): boolean {
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
