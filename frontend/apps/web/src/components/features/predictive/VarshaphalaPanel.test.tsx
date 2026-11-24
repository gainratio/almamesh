import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { SiderealChart, VarshaphalaContext } from '@almamesh/browser/types';
import type { StoredChart } from '@almamesh/store';
import '../../../i18n/config';
import {
  ChartEngineContext,
  type ChartEngineContextValue,
} from '../../../providers/chartEngineContext';
import { VarshaphalaPanel } from './VarshaphalaPanel';

const MOCK_VARSHA_CHART = {
  ayanamsa_value: 24.22,
  lagna: {
    longitude: 125.0,
    sign: 'Leo',
    sign_degrees: 5.0,
    nakshatra: 'Magha',
    nakshatra_pada: 2,
    nakshatra_lord: 'ketu',
    sign_lord: 'sun',
  },
  planets: {
    sun: {
      name: 'sun',
      longitude: 30.5,
      sign: 'Taurus',
      sign_degrees: 0.5,
      nakshatra: 'Krittika',
      nakshatra_pada: 2,
      nakshatra_lord: 'sun',
      sign_lord: 'venus',
      house: 10,
      is_retrograde: false,
      speed: 0.96,
      latitude: 0,
      distance: 1,
      dignity: 'neutral',
      is_combust: false,
      combustion_separation_deg: null,
      houses_ruled: [1],
      is_yogakaraka: false,
      is_exalted: false,
      is_debilitated: false,
      is_own_sign: false,
    },
  },
  houses: Object.fromEntries(
    [
      'Leo',
      'Virgo',
      'Libra',
      'Scorpio',
      'Sagittarius',
      'Capricorn',
      'Aquarius',
      'Pisces',
      'Aries',
      'Taurus',
      'Gemini',
      'Cancer',
    ].map((sign, index) => [
      String(index + 1),
      { house_number: index + 1, sign, longitude: ((index + 4) % 12) * 30, sign_lord: 'sun' },
    ]),
  ),
  dashas: {
    current_maha_dasha: 'sun',
    balance_at_birth_years: 10,
    maha_dashas: [],
  },
  yogas: [],
} as unknown as SiderealChart;

const MOCK_VARSHAPHALA: VarshaphalaContext = {
  target_year: 2026,
  completed_years: 36,
  solar_return_utc: '2026-05-15T14:22:00Z',
  next_solar_return_utc: '2027-05-15T20:30:00Z',
  ayanamsa_type: 'LAHIRI',
  ayanamsa_value: 24.22,
  natal_sun_longitude: 30.5,
  return_sun_longitude: 30.5,
  is_day_chart: true,
  varsha_chart: MOCK_VARSHA_CHART,
  muntha: {
    sign: 'Virgo',
    sign_lord: 'mercury',
    house_from_varsha_lagna: 2,
    natal_lagna_sign: 'Virgo',
    completed_years: 36,
  },
  varshesha: 'sun',
  varshesha_candidates: [
    {
      graha: 'sun',
      roles: ['varsha_lagna_lord'],
      panchavargiya_total: 14.5,
      aspects_varsha_lagna: true,
    },
  ],
  panchavargiya_bala: {
    sun: {
      kshetra: 15,
      uchcha: 16,
      hadda: 11.25,
      drekkana: 10,
      navamsa: 5.75,
      total: 14.5,
      dignity_band: 'strong',
    },
  },
  mudda_dasha: [
    {
      lord: 'sun',
      start_utc: '2026-05-15T14:22:00Z',
      end_utc: '2026-06-02T14:22:00Z',
      duration_days: 18.26,
      is_current: true,
    },
  ],
  tajaka_yogas: [
    {
      name: 'Ithasala',
      kind: 'applying',
      faster_planet: 'moon',
      slower_planet: 'sun',
      aspect_type: 'trine',
      orb_degrees: 1.4,
      deep_orb: false,
    },
  ],
};

const STORED_CHART = {
  chart_id: 'test-chart',
  birth_data: {
    birth_datetime_utc: '1990-05-15T06:30:00Z',
    birth_location_details: {
      latitude: 28.6139,
      longitude: 77.209,
      timezone: 'Asia/Kolkata',
    },
  },
} as unknown as StoredChart;

describe('VarshaphalaPanel', () => {
  it('renders solar return summary, Muntha, Varshesha, Mudda Dasha, and Tajaka Yogas', async () => {
    const computeVarshaphala = vi.fn().mockResolvedValue(MOCK_VARSHAPHALA);
    const contextValue = {
      engine: { computeVarshaphala },
      stage: { kind: 'ready' },
      meta: null,
      error: null,
      startBootstrap: vi.fn(),
      whenReady: vi.fn(),
      reboot: vi.fn(),
    } as unknown as ChartEngineContextValue;

    render(
      <ChartEngineContext.Provider value={contextValue}>
        <VarshaphalaPanel storedChart={STORED_CHART} referenceInstant="2026-06-01T00:00:00Z" />
      </ChartEngineContext.Provider>,
    );

    await waitFor(() => expect(computeVarshaphala).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('varshaphala-return-card')).toBeTruthy();
    expect(screen.getByTestId('varshaphala-muntha-card')).toBeTruthy();
    expect(screen.getByTestId('varshaphala-varshesha-card')).toBeTruthy();
    expect(screen.getByTestId('varshaphala-mudda-table')).toBeTruthy();
    expect(screen.getByTestId('varshaphala-yogas-card').textContent).toContain('Ithasala');
  });
});
