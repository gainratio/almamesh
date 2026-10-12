/** Runtime contract for recomputable transit JSON read from the derived cache. */
import type { TransitContext } from '@almamesh/browser/types';

const PHASES = new Set(['rising', 'peak', 'setting', 'none']);
const EVENT_KINDS = new Set(['sign_ingress', 'sade_sati_phase', 'return', 'dasha_change', 'station']);
const SEVERITIES = new Set(['supportive', 'neutral', 'challenging']);
const STATION_DIRECTIONS = new Set(['retrograde', 'direct']);
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function nullableString(value: unknown): boolean {
  return value === null || string(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function inRange(value: unknown, minimum: number, maximum: number, exclusiveMaximum = false): boolean {
  return finite(value) && value >= minimum && (exclusiveMaximum ? value < maximum : value <= maximum);
}

function integerInRange(value: unknown, minimum: number, maximum: number): boolean {
  return inRange(value, minimum, maximum) && Number.isInteger(value);
}

function member(value: unknown, values: ReadonlySet<string>): boolean {
  return string(value) && values.has(value);
}

/** Python emits ISO UTC datetimes, with optional microseconds or +00:00. */
function instant(value: unknown): boolean {
  if (!string(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = month === 2 && leap ? 29 : MONTH_DAYS[month - 1];
  // Date.parse normalizes impossible days (February 30); check the calendar too.
  return year >= 1 && maximumDay !== undefined && day >= 1 && day <= maximumDay
    && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
    && Number.isFinite(Date.parse(value));
}

function nullableInstant(value: unknown): boolean {
  return value === null || instant(value);
}

function arrayOf(value: unknown, accepts: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (!accepts(item)) return false;
  return true;
}

function placement(value: unknown): boolean {
  return record(value)
    && string(value.graha) && inRange(value.longitude, 0, 360, true)
    && string(value.sign) && inRange(value.sign_degrees, 0, 30, true)
    && string(value.nakshatra) && integerInRange(value.nakshatra_pada, 1, 4)
    && typeof value.is_retrograde === 'boolean'
    && integerInRange(value.house_from_lagna, 1, 12)
    && integerInRange(value.house_from_moon, 1, 12)
    && string(value.natal_sign_occupied);
}

function gochara(value: unknown): boolean {
  return record(value) && instant(value.instant) && finite(value.transit_ayanamsa)
    && record(value.placements) && Object.values(value.placements).every(placement);
}

function sadeSatiSegment(value: unknown): boolean {
  return record(value) && member(value.phase, PHASES) && string(value.saturn_sign)
    && instant(value.start) && instant(value.end);
}

function sadeSati(value: unknown): boolean {
  return record(value) && typeof value.is_active === 'boolean'
    && member(value.current_phase, PHASES) && string(value.natal_moon_sign)
    && arrayOf(value.cycle, sadeSatiSegment)
    && nullableInstant(value.cycle_start) && nullableInstant(value.cycle_end);
}

function slowHit(value: unknown): boolean {
  return record(value) && string(value.graha) && member(value.kind, EVENT_KINDS)
    && string(value.natal_point) && instant(value.exact) && member(value.severity, SEVERITIES);
}

function fusion(value: unknown): boolean {
  return record(value) && instant(value.instant) && string(value.maha_lord)
    && nullableString(value.antar_lord)
    && integerInRange(value.maha_lord_transit_house_from_moon, 1, 12)
    && integerInRange(value.maha_lord_transit_house_from_lagna, 1, 12)
    && arrayOf(value.reinforcing, string) && arrayOf(value.afflicting, string)
    && inRange(value.net_weight, -1, 1) && member(value.severity, SEVERITIES);
}

function timelineEvent(value: unknown): boolean {
  return record(value) && instant(value.date) && member(value.kind, EVENT_KINDS)
    && nullableString(value.graha) && nullableString(value.from_sign) && nullableString(value.to_sign)
    && nullableString(value.from_lord) && nullableString(value.to_lord)
    && (value.sade_sati_phase === null || member(value.sade_sati_phase, PHASES))
    && member(value.severity, SEVERITIES) && string(value.descriptor)
    && (value.station_direction === undefined || value.station_direction === null
      || member(value.station_direction, STATION_DIRECTIONS))
    && (value.station_sign === undefined || nullableString(value.station_sign));
}

function timeline(value: unknown): boolean {
  return record(value) && instant(value.window_start) && instant(value.window_end)
    && arrayOf(value.events, timelineEvent);
}

/** Keep names open as in the browser mirror; reject malformed nested UI inputs. */
export function isCachedTransitContext(value: unknown): value is TransitContext {
  return record(value) && instant(value.instant) && gochara(value.gochara)
    && sadeSati(value.sade_sati) && arrayOf(value.slow_hits, slowHit)
    && fusion(value.fusion) && timeline(value.timeline);
}
