import { describe, expect, it } from 'vitest';

import {
  LocalTimeError,
  dstFoldFromStoredUtc,
  requireBirthTimeZone,
  localTimeToInstant,
  resolveLocalTime,
} from './localBirthTime';

describe('resolveLocalTime', () => {
  it('reports a spring-forward gap time as nonexistent (Los Angeles 02:30)', () => {
    expect(resolveLocalTime('2024-03-10', '02:30', 'America/Los_Angeles')).toEqual({
      kind: 'nonexistent',
    });
  });

  it('reports a fall-back overlap time as ambiguous with both instants (Los Angeles 01:30)', () => {
    expect(resolveLocalTime('2024-11-03', '01:30', 'America/Los_Angeles')).toEqual({
      kind: 'ambiguous',
      earlier: { utc: '2024-11-03T08:30:00.000Z', offsetMinutes: -420 },
      later: { utc: '2024-11-03T09:30:00.000Z', offsetMinutes: -480 },
    });
  });

  it('handles southern-hemisphere overlaps (Sydney 02:30 on the April fall-back)', () => {
    expect(resolveLocalTime('2024-04-07', '02:30', 'Australia/Sydney')).toEqual({
      kind: 'ambiguous',
      earlier: { utc: '2024-04-06T15:30:00.000Z', offsetMinutes: 660 },
      later: { utc: '2024-04-06T16:30:00.000Z', offsetMinutes: 600 },
    });
  });

  it('resolves an ordinary time just after local midnight to one instant (Sydney 00:30)', () => {
    expect(resolveLocalTime('2024-01-10', '00:30', 'Australia/Sydney')).toEqual({
      kind: 'unique',
      instant: { utc: '2024-01-09T13:30:00.000Z', offsetMinutes: 660 },
    });
  });

  it('resolves a zone with no DST (Kolkata) to one instant', () => {
    expect(resolveLocalTime('1988-08-08', '06:44', 'Asia/Kolkata')).toEqual({
      kind: 'unique',
      instant: { utc: '1988-08-08T01:14:00.000Z', offsetMinutes: 330 },
    });
  });

  it('rejects an unknown IANA zone instead of assuming UTC', () => {
    expect(() => resolveLocalTime('2024-01-10', '10:00', 'Mars/Olympus')).toThrow(RangeError);
  });

  it('rejects a malformed clock instead of guessing', () => {
    expect(() => resolveLocalTime('2024-01-10', '25:00', 'Asia/Kolkata')).toThrow(RangeError);
  });
});

describe('localTimeToInstant', () => {
  it('refuses a nonexistent time with a typed error', () => {
    const run = () => localTimeToInstant('2024-03-10', '02:30', 'America/Los_Angeles');
    expect(run).toThrow(LocalTimeError);
    expect(run).toThrow(/did not exist/);
  });

  it('refuses an ambiguous time when no choice was made', () => {
    expect(() => localTimeToInstant('2024-11-03', '01:30', 'America/Los_Angeles')).toThrow(
      /happened twice/,
    );
  });

  it('honours an explicit choice for an ambiguous time', () => {
    expect(localTimeToInstant('2024-11-03', '01:30', 'America/Los_Angeles', 'earlier').utc).toBe(
      '2024-11-03T08:30:00.000Z',
    );
    expect(localTimeToInstant('2024-11-03', '01:30', 'America/Los_Angeles', 'later').utc).toBe(
      '2024-11-03T09:30:00.000Z',
    );
  });

  it('ignores a stale choice when the time is not ambiguous', () => {
    expect(localTimeToInstant('2024-01-10', '00:30', 'Australia/Sydney', 'later').utc).toBe(
      '2024-01-09T13:30:00.000Z',
    );
  });
});

describe('dstFoldFromStoredUtc', () => {
  it('recovers which occurrence a stored chart used', () => {
    const args = ['2024-11-03', '01:30', 'America/Los_Angeles'] as const;
    expect(dstFoldFromStoredUtc(...args, '2024-11-03T08:30:00.000Z')).toBe('earlier');
    expect(dstFoldFromStoredUtc(...args, '2024-11-03T09:30:00Z')).toBe('later');
  });

  it('returns undefined for an unreadable stored clock or zone instead of throwing', () => {
    expect(dstFoldFromStoredUtc('', '', 'America/Los_Angeles', '2024-11-03T08:30:00Z')).toBeUndefined();
    expect(dstFoldFromStoredUtc('2024-11-03', '01:30', 'Mars/Olympus', '2024-11-03T08:30:00Z')).toBeUndefined();
  });

  it('returns undefined for an unambiguous time or an unmatched instant', () => {
    expect(
      dstFoldFromStoredUtc('2024-01-10', '00:30', 'Australia/Sydney', '2024-01-09T13:30:00Z'),
    ).toBeUndefined();
    expect(
      dstFoldFromStoredUtc('2024-11-03', '01:30', 'America/Los_Angeles', '2024-11-03T07:00:00Z'),
    ).toBeUndefined();
  });
});

describe('requireBirthTimeZone', () => {
  it('returns a valid IANA zone unchanged', () => {
    expect(requireBirthTimeZone('Australia/Sydney', 'test')).toBe('Australia/Sydney');
  });

  it.each([undefined, null, ''])('refuses a missing zone (%s) instead of assuming UTC', (zone) => {
    expect(() => requireBirthTimeZone(zone, 'birthMetaFromDetails')).toThrow(
      /birthMetaFromDetails: the birthplace timezone is missing/,
    );
  });

  it('refuses an unknown zone', () => {
    expect(() => requireBirthTimeZone('Mars/Olympus', 'x')).toThrow(/not a known IANA timezone/);
  });
});
