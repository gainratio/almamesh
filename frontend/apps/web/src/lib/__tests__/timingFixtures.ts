import type { SiderealChart, TransitContext } from '@almamesh/browser/types';

/** Shared get_timing fixtures (timingTool.test.ts, timingTool.places.test.ts). */
const BIRTH = '1990-01-15T12:00:00Z';
export const DASHAS = {
  maha_dasha_sequence: [
    {
      lord: 'rahu', start_date: BIRTH, end_date: '2007-06-01T00:00:00Z', duration_years: 17.4,
      antar_sequence: [{ lord: 'rahu', start_date: BIRTH, end_date: '1992-06-01T00:00:00Z', duration_years: 2.4 }],
    },
    {
      lord: 'jupiter', start_date: '2007-06-01T00:00:00Z', end_date: '2023-06-01T00:00:00Z', duration_years: 16,
      antar_sequence: [
        { lord: 'saturn', start_date: '2017-01-01T00:00:00Z', end_date: '2019-06-15T00:00:00Z', duration_years: 2.5 },
        { lord: 'mercury', start_date: '2019-06-15T00:00:00Z', end_date: '2021-09-01T00:00:00Z', duration_years: 2.2 },
      ],
    },
  ],
  current_maha: null,
  current_antar: null,
  current_pratyantar: null,
};
export const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [], dashas: DASHAS } as unknown as SiderealChart;

const placement = (graha: string) => ({
  graha, longitude: 0, sign: 'aries', sign_degrees: 0, nakshatra: 'ashwini', nakshatra_pada: 1,
  is_retrograde: false, house_from_lagna: 1, house_from_moon: 1, natal_sign_occupied: 'aries',
});
const event = (date: string, graha: string) => ({
  date, kind: 'sign_ingress', graha, from_sign: 'scorpio', to_sign: 'sagittarius', from_lord: null,
  to_lord: null, sade_sati_phase: null, severity: 'supportive', descriptor: `${graha} changes sign`,
});
export const TRANSITS = {
  instant: '2019-06-01T00:00:00Z',
  gochara: {
    instant: '2019-06-01T00:00:00Z', transit_ayanamsa: 24.1,
    placements: { moon: placement('moon'), saturn: placement('saturn'), jupiter: placement('jupiter') },
  },
  sade_sati: { is_active: false, current_phase: 'none', natal_moon_sign: 'aries', cycle: [], cycle_start: null, cycle_end: null },
  slow_hits: [],
  fusion: {
    instant: '2019-06-01T00:00:00Z', maha_lord: 'jupiter', antar_lord: 'saturn',
    maha_lord_transit_house_from_moon: 9, maha_lord_transit_house_from_lagna: 9,
    reinforcing: [], afflicting: [], net_weight: 0, severity: 'neutral',
  },
  timeline: {
    window_start: '2019-06-01T00:00:00Z', window_end: '2020-06-01T00:00:00Z',
    events: [event('2019-06-10T00:00:00Z', 'jupiter'), event('2019-09-01T00:00:00Z', 'saturn')],
  },
} as unknown as TransitContext;
export const SKY_CHART = { ...CHART, transit_context: TRANSITS } as SiderealChart;
