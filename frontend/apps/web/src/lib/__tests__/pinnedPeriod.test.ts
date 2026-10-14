import { describe, expect, it } from 'vitest';

import { asOfKey } from '../pinnedPeriod';

const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
const DAY = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

describe('pinnedPeriod', () => {
  it('keys a pin by its period and place, and an unpinned thread as today', () => {
    expect(asOfKey(undefined)).toBe('today');
    expect(asOfKey(YEAR)).not.toBe(asOfKey({ ...YEAR, start: '2028-01-01', end: '2028-12-31' }));
    expect(asOfKey(DAY)).not.toBe(asOfKey({ ...DAY, place: { ...BOGOTA, latitude: 4.6 } }));
    expect(asOfKey(DAY)).not.toBe(asOfKey({ ...DAY, place: { ...BOGOTA, longitude: -74 } }));
    expect(asOfKey(DAY)).not.toBe(asOfKey({ ...DAY, place: { ...BOGOTA, timezone: 'America/Lima' } }));
  });
});
