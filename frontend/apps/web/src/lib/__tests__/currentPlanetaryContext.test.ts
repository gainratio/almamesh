import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { usePredictiveStore } from '@almamesh/store';
import { buildEnsurePredictiveInput, predictiveReferenceInstant } from '../predictive';
import {
  ensureCurrentPlanetaryContext,
  planetaryReferenceInstantForZone,
} from '../currentPlanetaryContext';

const chart = {
  ayanamsa_value: 24,
  lagna: { sign: 'aries', longitude: 10 },
  planets: [],
  houses: [],
  yogas: [],
} as unknown as SiderealChart;

const birth = {
  birth_datetime_utc: '1990-01-01T12:00:00.000Z',
  birth_location_details: {
    latitude: 12.97,
    longitude: 77.59,
    timezone: 'Asia/Kolkata',
  },
} as unknown as ProcessedBirthData;

const rawContexts = {
  transit_context: {
    instant: '2026-03-08T00:00:00Z',
    gochara: { instant: '2026-03-08T00:00:00Z', transit_ayanamsa: 24.2, placements: {} },
    sade_sati: {
      is_active: false,
      current_phase: 'none',
      natal_moon_sign: 'Cancer',
      cycle: [],
      cycle_start: null,
      cycle_end: null,
    },
    slow_hits: [],
    fusion: {
      instant: '2026-03-08T00:00:00Z',
      maha_lord: 'saturn',
      antar_lord: null,
      maha_lord_transit_house_from_moon: 3,
      maha_lord_transit_house_from_lagna: 5,
      reinforcing: [],
      afflicting: [],
      net_weight: 0,
      severity: 'neutral',
    },
    timeline: {
      window_start: '2026-03-08T00:00:00Z',
      window_end: '2027-03-08T00:00:00Z',
      events: [],
    },
  },
  varga_context_full: { charts: {}, vargottama: [], shadvarga_own_sign: [], vimshopaka: [] },
  strength_context: {
    sunrise_utc_iso: '1990-01-01T01:42:00+00:00',
    ashtakavarga: { bhinna: {}, sarva: { bindus: {}, total: 337 } },
    shadbala: { planets: {} },
  },
  domains_context: { instant: '2026-03-08T00:00:00Z', forecasts: {} },
} as never;

describe('ensureCurrentPlanetaryContext', () => {
  beforeEach(() => usePredictiveStore.getState().reset());

  it('pins today to UTC midnight, composes exact-profile engine output, and caches repeats', async () => {
    const computePredictive = vi.fn(async (input) => {
      expect(input.referenceInstant).toBe('2026-03-08T00:00:00Z');
      return rawContexts;
    });
    const input = {
      chart,
      profileKey: 'profile-1',
      birth,
      chartTimeZone: 'UTC',
      now: new Date('2026-03-08T23:59:00.000Z'),
      runtime: { computePredictive },
      signal: new AbortController().signal,
    };

    await expect(ensureCurrentPlanetaryContext(input)).resolves.toMatchObject({
      transit_context: { instant: '2026-03-08T00:00:00Z' },
    });
    await ensureCurrentPlanetaryContext(input);
    expect(computePredictive).toHaveBeenCalledTimes(1);
  });

  it('fails closed when exact birth inputs are unavailable', async () => {
    await expect(
      ensureCurrentPlanetaryContext({
        chart,
        profileKey: 'profile-1',
        birth: undefined,
        chartTimeZone: 'UTC',
        now: new Date('2026-03-08T23:59:00.000Z'),
        runtime: { computePredictive: vi.fn() },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/birth data/i);
  });

  it('joins an identical calculation already running for the dashboard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      computePredictive: vi.fn(async () => {
        await gate;
        return rawContexts;
      }),
    };
    const now = new Date('2026-03-08T12:00:00.000Z');
    const storeInput = buildEnsurePredictiveInput(
      'profile-1',
      birth,
      predictiveReferenceInstant(now),
    );
    if (!storeInput) throw new Error('test setup requires birth data');
    const dashboardCompute = usePredictiveStore.getState().ensurePredictive(runtime, storeInput);
    expect(usePredictiveStore.getState().status).toBe('loading');

    const chatCompute = ensureCurrentPlanetaryContext({
      chart,
      profileKey: 'profile-1',
      birth,
      chartTimeZone: 'UTC',
      now,
      runtime,
      signal: new AbortController().signal,
    });
    release();

    await expect(chatCompute).resolves.toMatchObject({
      transit_context: { instant: '2026-03-08T00:00:00Z' },
    });
    await dashboardCompute;
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });
});

describe('planetaryReferenceInstantForZone', () => {
  it('pins the chart-local calendar day across the UTC boundary', () => {
    const now = new Date('2026-03-08T20:00:00.000Z');
    expect(planetaryReferenceInstantForZone(now, 'Asia/Kolkata')).toBe(
      '2026-03-09T00:00:00Z',
    );
    expect(planetaryReferenceInstantForZone(now, 'America/Los_Angeles')).toBe(
      '2026-03-08T00:00:00Z',
    );
  });
});
