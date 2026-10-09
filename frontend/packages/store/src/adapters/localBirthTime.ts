// Local civil birth time -> UTC instant, with DST gaps and overlaps made EXPLICIT.
//
// A wall-clock time in a zone with daylight saving can name zero instants (the
// spring-forward gap: 02:30 on the night clocks jump 02:00 -> 03:00) or two (the
// fall-back overlap: 01:30 happens once in summer time, once in standard time).
// `dayjs.tz` silently shifts the first forward an hour and picks the earlier of
// the second, so a birth chart could be computed for a time nobody entered. This
// module reports both cases and makes the caller decide. Offsets come from the
// platform's IANA database through dayjs's timezone plugin (Intl) — no hand-kept
// offset tables.

import dayjs from 'dayjs';
import tzPlugin from 'dayjs/plugin/timezone';
import utcPlugin from 'dayjs/plugin/utc';

dayjs.extend(utcPlugin);
dayjs.extend(tzPlugin);

/** Which occurrence of a wall-clock time that happened twice (DST fall-back). */
export type DstFold = 'earlier' | 'later';

/** One concrete instant for a local time. */
export interface ResolvedInstant {
  /** ISO-8601 UTC instant, e.g. `2024-11-03T08:30:00.000Z`. */
  readonly utc: string;
  /** The zone's UTC offset at that instant, in minutes (330 for IST). */
  readonly offsetMinutes: number;
}

export type LocalTimeResolution =
  | { readonly kind: 'unique'; readonly instant: ResolvedInstant }
  | { readonly kind: 'nonexistent' }
  | {
      readonly kind: 'ambiguous';
      readonly earlier: ResolvedInstant;
      readonly later: ResolvedInstant;
    };

/** A local time the caller must fix (nonexistent) or disambiguate (ambiguous). */
export class LocalTimeError extends Error {
  constructor(
    readonly kind: 'nonexistent' | 'ambiguous',
    message: string,
  ) {
    super(message);
    this.name = 'LocalTimeError';
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MINUTE_MS = 60_000;
// Real UTC offsets lie within -12h..+14h, so a probe a day either side of the
// wall time always lands on each side of any transition near it.
const PROBE_MS = 24 * 60 * MINUTE_MS;

/** The wall clock read as if it were UTC (epoch ms). Throws on bad input. */
function wallClockMs(date: string, time: string): number {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) {
    throw new RangeError(`invalid local date/time "${date}T${time}"`);
  }
  const [y, mo, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const ms = Date.UTC(y, mo - 1, day, Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  if (new Date(ms).getUTCDate() !== day) {
    throw new RangeError(`invalid calendar date "${date}"`);
  }
  return ms;
}

/** The zone's UTC offset (minutes) at an instant. Throws RangeError on a bad zone. */
function offsetAt(epochMs: number, timeZone: string): number {
  return dayjs.utc(epochMs).tz(timeZone).utcOffset();
}

function toInstant(epochMs: number, offsetMinutes: number): ResolvedInstant {
  return { utc: new Date(epochMs).toISOString(), offsetMinutes };
}

/** Every instant whose local wall clock in `timeZone` equals `date time`. */
export function resolveLocalTime(date: string, time: string, timeZone: string): LocalTimeResolution {
  const wall = wallClockMs(date, time);
  const offsets = new Set([offsetAt(wall - PROBE_MS, timeZone), offsetAt(wall + PROBE_MS, timeZone)]);
  const matches = [...offsets]
    .map((offset) => ({ epoch: wall - offset * MINUTE_MS, offset }))
    .filter(({ epoch, offset }) => offsetAt(epoch, timeZone) === offset)
    .sort((a, b) => a.epoch - b.epoch)
    .map(({ epoch, offset }) => toInstant(epoch, offset));
  const [first, second] = matches;
  if (!first) return { kind: 'nonexistent' };
  if (!second) return { kind: 'unique', instant: first };
  return { kind: 'ambiguous', earlier: first, later: second };
}

/**
 * The single instant for a local birth time. Fails closed: a time that never
 * happened throws, and a time that happened twice throws unless `fold` says
 * which occurrence the user meant. `fold` is ignored for an unambiguous time.
 */
export function localTimeToInstant(
  date: string,
  time: string,
  timeZone: string,
  fold?: DstFold,
): ResolvedInstant {
  const resolution = resolveLocalTime(date, time, timeZone);
  if (resolution.kind === 'unique') return resolution.instant;
  if (resolution.kind === 'nonexistent') {
    throw new LocalTimeError(
      'nonexistent',
      `${date} ${time} did not exist in ${timeZone}: the clocks skipped that hour for daylight saving`,
    );
  }
  if (!fold) {
    throw new LocalTimeError(
      'ambiguous',
      `${date} ${time} happened twice in ${timeZone} (clocks went back for daylight saving); choose which one`,
    );
  }
  return resolution[fold];
}

/**
 * Which occurrence a stored chart used, read back from its stored UTC instant.
 * Undefined when the time is not ambiguous, the instant matches neither, or the
 * stored clock/zone cannot be read.
 */
export function dstFoldFromStoredUtc(
  date: string,
  time: string,
  timeZone: string,
  storedUtc: string,
): DstFold | undefined {
  let resolution: LocalTimeResolution;
  try {
    resolution = resolveLocalTime(date, time, timeZone);
  } catch {
    return undefined; // an unreadable stored clock or zone has no fold to recover
  }
  if (resolution.kind !== 'ambiguous') return undefined;
  const stored = Date.parse(storedUtc);
  if (stored === Date.parse(resolution.earlier.utc)) return 'earlier';
  if (stored === Date.parse(resolution.later.utc)) return 'later';
  return undefined;
}

/**
 * The birthplace's IANA zone, or a thrown error naming the caller. Replaces the
 * old `zone || 'UTC'` fallbacks: a chart computed for a missing zone as if the
 * birth were in UTC is silently wrong by the full offset, so refuse instead.
 */
export function requireBirthTimeZone(zone: string | null | undefined, context: string): string {
  if (!zone) {
    throw new Error(`${context}: the birthplace timezone is missing; re-select the birthplace`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`${context}: "${zone}" is not a known IANA timezone`);
  }
  return zone;
}
