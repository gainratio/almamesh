/**
 * buildWireInput — the rectification engine input uses the SAME explicit
 * local-time resolution as the chart: a repeated DST hour uses the occurrence
 * the stored chart used, and a missing zone is refused instead of read as UTC.
 */
import { describe, expect, it } from 'vitest';

import { buildWireInput } from './useRectification';

const LA_BIRTH = {
  date: '2024-11-03',
  effectiveTime: '01:30',
  latitude: 34.05,
  longitude: -118.24,
  tz: 'America/Los_Angeles',
};

describe('buildWireInput time handling', () => {
  it('uses the chosen occurrence of a repeated DST hour', () => {
    const wire = buildWireInput({ ...LA_BIRTH, dstFold: 'later' }, [], 'cusp');
    expect(wire.datetimeUtc).toBe('2024-11-03T09:30:00.000Z');
    expect(wire.utcOffsetMinutes).toBe(-480);
  });

  it('refuses a missing timezone instead of computing in UTC', () => {
    expect(() => buildWireInput({ ...LA_BIRTH, tz: '' }, [], 'cusp')).toThrow(/timezone is missing/);
  });
});
