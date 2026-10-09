import { describe, expect, it, vi } from 'vitest';

import { PINNED_PLACE_REF, asOfKey, pinnedPlaceReader, pinnedTiming } from '../pinnedPeriod';

const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
const DAY = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

describe('pinnedPeriod', () => {
  it('maps a pin to the timing tool\'s period, with the reserved ref only for a placed Day pin', () => {
    expect(pinnedTiming(YEAR)).toEqual({ period: { start: '2027-01-01', end: '2027-12-31' } });
    expect(pinnedTiming(DAY)).toEqual({ period: { start: '2026-06-15', end: '2026-06-15' }, placeRef: PINNED_PLACE_REF });
  });

  it('the reserved ref can never be sent by the model (step C ref pattern)', () => {
    expect(new RegExp('^city:\\d{1,6}$').test(PINNED_PLACE_REF)).toBe(false);
  });

  it('resolves the reserved ref from the pin and every other ref from the city list', async () => {
    const base = vi.fn(async () => undefined);
    const read = pinnedPlaceReader(DAY, base);
    expect(await read(PINNED_PLACE_REF)).toEqual({
      summary: { place_ref: PINNED_PLACE_REF, label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
      latitude: 4.711,
      longitude: -74.0721,
    });
    await read('city:202');
    expect(base).toHaveBeenCalledWith('city:202');
    expect(pinnedPlaceReader(YEAR, base)).toBe(base);
  });

  it('keys a pin by its period and place, and an unpinned thread as today', () => {
    expect(asOfKey(undefined)).toBe('today');
    expect(asOfKey(YEAR)).not.toBe(asOfKey({ ...YEAR, start: '2028-01-01', end: '2028-12-31' }));
    expect(asOfKey(DAY)).not.toBe(asOfKey({ ...DAY, place: { ...BOGOTA, latitude: 4.6 } }));
  });
});
