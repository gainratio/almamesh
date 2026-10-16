import { describe, expect, it } from 'vitest';

import type { ChatThreadAsOf, LocationDetails } from '@almamesh/shared-types';
import { birthPlaceOf, prefillTripPlace, type TripPin } from '../tripPlacePrefill';

const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.29, longitude: 103.85 };
const SF = { label: 'San Francisco, United States', timezone: 'America/Los_Angeles', latitude: 37.77, longitude: -122.42 };
const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
const CHENNAI: LocationDetails = { city: 'Chennai', state: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27, timezone: 'Asia/Kolkata', location_name: 'Chennai, Tamil Nadu, India' };
const BIRTH = { label: 'Chennai, Tamil Nadu, India', timezone: 'Asia/Kolkata', latitude: 13.08, longitude: 80.27 };

const pin = (start: string, end: string, place: ChatThreadAsOf['place'], updated_at = '2026-10-01T00:00:00Z'): TripPin => ({
  as_of: { start, end, granularity: 'month', ...(place ? { place } : {}) },
  updated_at,
});

describe('prefillTripPlace', () => {
  it('picks the place of the pin whose range is nearest the new date', () => {
    const pins = [pin('2019-05-01', '2019-05-31', SINGAPORE), pin('2027-01-01', '2027-01-31', SF)];
    expect(prefillTripPlace({ start: '2019-08-01', end: '2019-08-31' }, pins)).toEqual(SINGAPORE);
    expect(prefillTripPlace({ start: '2026-06-01', end: '2026-06-30' }, pins)).toEqual(SF);
  });

  it('treats a pin that overlaps the new range as nearest (distance zero)', () => {
    const pins = [pin('2018-12-01', '2018-12-31', SF), pin('2019-01-01', '2019-12-31', SINGAPORE)];
    expect(prefillTripPlace({ start: '2019-06-15', end: '2019-06-15' }, pins)).toEqual(SINGAPORE);
  });

  it('breaks a distance tie with the most recently updated pin', () => {
    const pins = [pin('2019-05-01', '2019-05-31', SINGAPORE, '2026-01-01T00:00:00Z'), pin('2019-05-01', '2019-05-31', BOGOTA, '2026-09-01T00:00:00Z')];
    expect(prefillTripPlace({ start: '2019-05-01', end: '2019-05-31' }, pins)).toEqual(BOGOTA);
    expect(prefillTripPlace({ start: '2019-05-01', end: '2019-05-31' }, [...pins].reverse())).toEqual(BOGOTA);
  });

  it('ranks a pin with no update time below a dated one at the same distance', () => {
    const undated: TripPin = { as_of: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: SINGAPORE } };
    expect(prefillTripPlace({ start: '2019-05-01', end: '2019-05-31' }, [undated, pin('2019-05-01', '2019-05-31', SF)])).toEqual(SF);
  });

  it('ignores threads with no pin or a pin with no place', () => {
    const pins: TripPin[] = [{ updated_at: '2026-10-01T00:00:00Z' }, pin('2019-05-01', '2019-05-31', undefined)];
    expect(prefillTripPlace({ start: '2019-05-01', end: '2019-05-31' }, pins)).toBeUndefined();
  });

  // Contract reversed 2026-10-13: the birth place is a suggestion the user confirms, never a silent prefill.
  it('with no earlier trip there is nothing to prefill', () => {
    expect(prefillTripPlace({ start: '2019-05-01', end: '2019-05-31' }, [])).toBeUndefined();
    expect(prefillTripPlace(undefined, [pin('2019-05-01', '2019-05-31', SINGAPORE)])).toBeUndefined();
  });
});

describe('birthPlaceOf', () => {
  it('turns the chart birth location into a trip place (label, timezone, coordinates)', () => {
    expect(birthPlaceOf(CHENNAI)).toEqual(BIRTH);
  });

  it('builds the label from city, state and country when there is no location name', () => {
    expect(birthPlaceOf({ ...CHENNAI, location_name: '' })?.label).toBe('Chennai, Tamil Nadu, India');
    expect(birthPlaceOf({ ...CHENNAI, location_name: undefined, state: null, country: 'India' })?.label).toBe('Chennai, India');
  });

  it('refuses a birth location the store would refuse as a pin place', () => {
    expect(birthPlaceOf(undefined)).toBeUndefined();
    expect(birthPlaceOf({ ...CHENNAI, timezone: 'Not/AZone' })).toBeUndefined();
    expect(birthPlaceOf({ ...CHENNAI, latitude: 91 })).toBeUndefined();
    expect(birthPlaceOf({ ...CHENNAI, longitude: Number.NaN })).toBeUndefined();
    expect(birthPlaceOf({ ...CHENNAI, location_name: ' ', city: '', state: null, country: null })).toBeUndefined();
    expect(birthPlaceOf({ ...CHENNAI, location_name: 'x'.repeat(121) })).toBeUndefined();
  });
});
