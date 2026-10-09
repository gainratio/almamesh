/**
 * The one shape check for a time-travel pin (plan Ruling 7). Migration uses it
 * to drop a malformed pin and keep the thread; portable import uses it to
 * refuse the backup and name the field.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { isCalendarDay } from '@almamesh/llm';

const AS_OF_KEYS = new Set(['start', 'end', 'granularity', 'place']);
const PLACE_KEYS = new Set(['label', 'timezone', 'latitude', 'longitude']);
const GRANULARITIES: readonly string[] = ['day', 'month', 'year'];
const FIRST_YEAR = 1900;
const LAST_YEAR = 2099;
const MAX_LABEL = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isZone(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function inRange(value: unknown, limit: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

function placeProblem(place: unknown): string | undefined {
  if (!isRecord(place) || !onlyKeys(place, PLACE_KEYS)) return 'as_of.place';
  const { label, timezone, latitude, longitude } = place;
  if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL) return 'as_of.place.label';
  if (!isZone(timezone)) return 'as_of.place.timezone';
  if (!inRange(latitude, 90)) return 'as_of.place.latitude';
  return inRange(longitude, 180) ? undefined : 'as_of.place.longitude';
}

/** The first day a valid start may hold: the 1st for a month, Jan 1 for a year. */
function startFits(start: string, granularity: string): boolean {
  if (granularity === 'month') return start.endsWith('-01');
  return granularity === 'year' ? start.endsWith('-01-01') : true;
}

/** The last day the granularity allows for this start (UTC calendar arithmetic only). */
function endFor(start: string, granularity: string): string {
  if (granularity === 'day') return start;
  const year = Number(start.slice(0, 4));
  if (granularity === 'year') return `${year}-12-31`;
  const month = Number(start.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function startYearInRange(start: string): boolean {
  const year = Number(start.slice(0, 4));
  return year >= FIRST_YEAR && year <= LAST_YEAR;
}

function periodProblem(value: Record<string, unknown>): string | undefined {
  const { start, end, granularity } = value;
  if (typeof start !== 'string' || !isCalendarDay(start) || !startYearInRange(start)) return 'as_of.start';
  if (typeof granularity !== 'string' || !GRANULARITIES.includes(granularity)) return 'as_of.granularity';
  if (!startFits(start, granularity)) return 'as_of.start';
  if (end !== endFor(start, granularity)) return 'as_of.end';
  return undefined;
}

export function chatAsOfProblem(value: unknown): string | undefined {
  if (!isRecord(value) || !onlyKeys(value, AS_OF_KEYS)) return 'as_of';
  const period = periodProblem(value);
  if (period) return period;
  const { granularity, place } = value;
  if (granularity === 'day') return place === undefined ? 'as_of.place' : placeProblem(place);
  return place === undefined ? undefined : 'as_of.place';
}

export function isChatThreadAsOf(value: unknown): value is ChatThreadAsOf {
  return chatAsOfProblem(value) === undefined;
}
