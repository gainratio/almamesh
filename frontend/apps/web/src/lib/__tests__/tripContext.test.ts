import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { describe, expect, it } from 'vitest';

import { UNKNOWN_PLACE_LABEL, natalSummary, tripContext, tripDashaLine, tripPin } from '../tripContext';
import { DASHAS } from './timingFixtures';

const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.2897, longitude: 103.8501 };
const SAN_FRANCISCO = { label: 'San Francisco', timezone: 'America/Los_Angeles', latitude: 37.7749, longitude: -122.4194 };
const JUNE_2019_SG = { start: '2019-06-01', end: '2019-06-30', granularity: 'month', place: SINGAPORE } as const;
const JAN_2027_SF = { start: '2027-01-01', end: '2027-01-31', granularity: 'month', place: SAN_FRANCISCO } as const;
const TODAY = '2026-10-13';
const BIRTH = {
  birth_datetime_utc: '1990-01-15T06:30:00Z',
  birth_datetime_local: '1990-01-15T12:00:00',
  birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;

const planet = (name: string, sign: string, house: number, nakshatra: string) => ({
  name, longitude: 123.4567, latitude: 1.2345, distance: 1.01, speed: 0.98, is_retrograde: name === 'saturn',
  sign, sign_degrees: 3.4567, sign_lord: 'mars', nakshatra, nakshatra_pada: 2, nakshatra_lord: 'ketu', house, dignity: 'neutral',
  houses_ruled: name === 'saturn' ? [3, 4] : [9], is_combust: name === 'saturn', is_yogakaraka: name === 'saturn',
});
const CHART = {
  snapshot: { birth_utc: '1990-01-15T06:30:00Z', reference_date: '2026-03-08T00:00:00Z', snapshot_id: 'a'.repeat(64) },
  ayanamsa_value: 23.7,
  lagna: { longitude: 215.25, sign: 'scorpio', sign_degrees: 5.25, sign_lord: 'mars', nakshatra: 'anuradha', nakshatra_pada: 1, nakshatra_lord: 'saturn' },
  planets: { moon: planet('moon', 'cancer', 9, 'pushya'), saturn: planet('saturn', 'capricorn', 3, 'shravana') },
  houses: {},
  yogas: [{ name: 'gaja_kesari', display_name: 'Gaja Kesari', category: 'auspicious', description: 'd', effects: 'e', planets_involved: ['jupiter', 'moon'] }],
  dashas: DASHAS,
} as unknown as SiderealChart;

describe('tripContext: one source for the tools, the brief and the context card', () => {
  it('a past Singapore trip carries natal, place, period and its dashas', () => {
    const trip = tripContext({ chart: CHART, asOf: JUNE_2019_SG, today: TODAY, birth: BIRTH, language: 'en' });
    expect(trip.period).toEqual({ start: '2019-06-01', end: '2019-06-30', granularity: 'month', tense: 'past', label: 'June 2019', short: 'Jun 2019' });
    expect(trip.place).toEqual({ label: 'Singapore', timezone: 'Asia/Singapore', source: 'trip', display: 'Singapore' });
    expect(trip.natal.lagna).toMatchObject({ sign: 'scorpio', nakshatra: 'anuradha' });
    expect(trip.natal.moon).toMatchObject({ sign: 'cancer', nakshatra: 'pushya' });
    expect(trip.dashas.maha.map((row) => row.lord)).toEqual(['jupiter']);
    expect(trip.dashas.antar.map((row) => row.lord)).toEqual(['saturn', 'mercury']);
    expect(tripDashaLine(trip)).toBe('Jupiter–Saturn → Jupiter–Mercury');
  });

  it('a future San Francisco trip is in the future tense at its own place', () => {
    const trip = tripContext({ chart: CHART, asOf: JAN_2027_SF, today: TODAY, birth: BIRTH, language: 'en' });
    expect(trip.period).toMatchObject({ tense: 'future', label: 'January 2027', granularity: 'month' });
    expect(trip.place).toMatchObject({ label: 'San Francisco', timezone: 'America/Los_Angeles', source: 'trip' });
  });

  it('a trip containing today is in the present tense', () => {
    const trip = tripContext({ chart: CHART, asOf: { start: '2026-01-01', end: '2026-12-31', granularity: 'year' }, today: TODAY, birth: BIRTH, language: 'en' });
    expect(trip.period.tense).toBe('present');
  });

  it('an old trip with no place falls back to the birth place (local card says so; no marker for the model)', () => {
    const old = { start: '2019-06-01', end: '2019-06-30', granularity: 'month' } as const;
    const trip = tripContext({ chart: CHART, asOf: old, today: TODAY, birth: BIRTH, language: 'en' });
    expect(trip.place).toEqual({ label: 'Delhi', timezone: 'Asia/Kolkata', source: 'birth_place', display: 'Delhi' });
    expect(tripPin(old, BIRTH).place).toEqual({ label: 'Delhi', timezone: 'Asia/Kolkata', latitude: 28.6139, longitude: 77.209 });
    expect(tripPin(JUNE_2019_SG, BIRTH)).toBe(JUNE_2019_SG);
  });
});

describe('the natal summary holds no raw birth data', () => {
  const RAW = [/1990-01-15/, /06:30/, /12:00:00/, /28\.61/, /77\.20/, /latitude/i, /longitude/i, /123\.45/, /3\.4567/, /5\.25/, /degree/i, /1\.2897|103\.85/, /snapshot/];

  it('natal summary: lagna, Moon, planets by sign and house, yogas; no dates, times, coordinates or degrees', () => {
    const summary = natalSummary(CHART);
    // Lordships, combustion and yogakaraka ride per planet (2026-10-13), so the model can say "Saturn, your 4th lord".
    expect(summary.planets).toContainEqual({
      name: 'saturn', sign: 'capricorn', house: 3, nakshatra: 'shravana', dignity: 'neutral', retrograde: true,
      houses_ruled: [3, 4], combust: true, yogakaraka: true,
    });
    expect(summary.planets).toContainEqual(expect.objectContaining({ name: 'moon', houses_ruled: [9], combust: false, yogakaraka: false }));
    expect(summary.yogas).toEqual([{ name: 'Gaja Kesari', category: 'auspicious', planets_involved: ['jupiter', 'moon'] }]);
    const text = JSON.stringify(summary);
    for (const pattern of RAW) expect(text).not.toMatch(pattern);
  });
});

describe('tripContext edges', () => {
  it('a chart with no dasha tree still has a trip, with no dasha rows', () => {
    const trip = tripContext({ chart: { ...CHART, dashas: undefined } as unknown as SiderealChart, asOf: JUNE_2019_SG, today: TODAY, birth: BIRTH, language: 'en' });
    expect(trip.dashas).toEqual({ maha: [], antar: [], notes: [] });
    expect(tripDashaLine(trip)).toBe('');
  });

  it('with maha rows but no antar rows the line names the maha lords', () => {
    const trip = tripContext({ chart: CHART, asOf: JUNE_2019_SG, today: TODAY, birth: BIRTH, language: 'en' });
    expect(tripDashaLine({ ...trip, dashas: { ...trip.dashas, antar: [] } })).toBe('Jupiter');
  });

  it('no Moon and no birth place: the summary has no Moon and the default place is in UTC', () => {
    const chart = { ...CHART, planets: {}, yogas: undefined } as unknown as SiderealChart;
    const old = { start: '2019-06-01', end: '2019-06-30', granularity: 'month' } as const;
    const trip = tripContext({ chart, asOf: old, today: TODAY, birth: undefined, language: 'en' });
    expect(trip.natal.moon).toBeNull();
    expect(trip.natal.yogas).toEqual([]);
    expect(trip.place).toEqual({ label: UNKNOWN_PLACE_LABEL, timezone: 'UTC', source: 'birth_place', display: '' });
    expect(tripPin(old, undefined)).toBe(old);
  });
});
