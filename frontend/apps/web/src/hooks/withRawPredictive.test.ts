// Spec 062 (LLM delta 1): composing the persisted RAW engine predictive
// contexts onto the natal chart before any LLM prompt is built.
//
// `withRawPredictive` must be strictly additive and FAIL-OPEN: not-ready,
// absent (pre-v2 persisted blob), or wrong-profile contexts leave the chart
// untouched — LLM features degrade gracefully to natal-only, NEVER an error.
// All fixtures are synthetic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PredictiveContexts, SiderealChart } from '@almamesh/browser/types';
import {
  predictiveRequestKey,
  useChartLibraryStore,
  usePredictiveStore,
  useProfilesStore,
  type StoredChart,
} from '@almamesh/store';

import { withRawPredictive } from './useStreamingInterpretation';

const CHART = {
  ayanamsa_value: 24.1,
  lagna: { sign: 'aries' },
  planets: {},
  houses: {},
  yogas: [],
} as unknown as SiderealChart;

const RAW = {
  transit_context: { instant: '2026-06-09T12:00:00Z' },
  varga_context_full: { charts: {} },
  strength_context: { ashtakavarga: { sarva: { total: 337 } } },
  domains_context: { forecasts: {} },
} as unknown as PredictiveContexts;

const CURRENT_BIRTH = {
  birth_datetime_utc: '1990-03-30T06:45:00Z',
  birth_location_details: { latitude: 12.97, longitude: 77.59, timezone: 'Asia/Kolkata' },
};

function currentRequestKey(profileKey: string): string {
  return predictiveRequestKey({
    profileKey,
    datetimeUtc: CURRENT_BIRTH.birth_datetime_utc,
    latitude: CURRENT_BIRTH.birth_location_details.latitude,
    longitude: CURRENT_BIRTH.birth_location_details.longitude,
    referenceInstant: '2026-06-09T00:00:00Z',
    utcOffsetMinutes: 330,
  });
}

function seedProfiles(activeProfileId: string | null): void {
  useProfilesStore.setState({ activeProfileId });
}

describe('withRawPredictive (Spec 062 delta 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:00Z'));
    usePredictiveStore.getState().reset();
    useChartLibraryStore.setState({
      charts: {
        'chart-1': {
          chart_id: 'chart-1',
          profile_id: 'profile-1',
          is_primary: true,
          birth_data: CURRENT_BIRTH,
          sidereal_chart: CHART,
        } as StoredChart,
      },
      hydrated: true,
    });
    seedProfiles(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('composes the raw contexts onto the chart when ready for the active profile', () => {
    seedProfiles('profile-1');
    usePredictiveStore.setState({
      status: 'ready',
      rawContexts: RAW,
      profileKey: 'profile-1',
      requestKey: currentRequestKey('profile-1'),
    });

    const composed = withRawPredictive(CHART, 'chart-1');
    expect(composed.transit_context).toBe(RAW.transit_context);
    expect(composed.strength_context).toBe(RAW.strength_context);
    expect(composed.varga_context_full).toBe(RAW.varga_context_full);
    expect(composed.domains_context).toBe(RAW.domains_context);
    // Natal fields untouched; the input chart is never mutated.
    expect(composed.lagna).toBe(CHART.lagna);
    expect(CHART.transit_context).toBeUndefined();
  });

  it('uses the stored chart profile when no profile is active', () => {
    usePredictiveStore.setState({
      status: 'ready',
      rawContexts: RAW,
      profileKey: 'profile-1',
      requestKey: currentRequestKey('profile-1'),
    });
    expect(withRawPredictive(CHART, 'chart-1').transit_context).toBe(RAW.transit_context);
  });

  it('returns the chart untouched when contexts are not ready', () => {
    seedProfiles('profile-1');
    usePredictiveStore.setState({ status: 'loading', rawContexts: RAW, profileKey: 'profile-1' });
    expect(withRawPredictive(CHART, 'chart-1')).toBe(CHART);
  });

  it('returns the chart untouched when the raw slice is absent (v1 persisted blob)', () => {
    seedProfiles('profile-1');
    usePredictiveStore.setState({ status: 'ready', rawContexts: undefined, profileKey: 'profile-1' });
    expect(withRawPredictive(CHART, 'chart-1')).toBe(CHART);
  });

  it("never composes another profile's contexts onto this chart", () => {
    seedProfiles('profile-2');
    usePredictiveStore.setState({
      status: 'ready',
      rawContexts: RAW,
      profileKey: 'profile-2',
      requestKey: currentRequestKey('profile-2'),
    });
    expect(withRawPredictive(CHART, 'chart-1')).toBe(CHART);
  });

  it('uses the requested chart profile even if the active profile switches mid-request', () => {
    seedProfiles('profile-2');
    usePredictiveStore.setState({
      status: 'ready',
      rawContexts: RAW,
      profileKey: 'profile-1',
      requestKey: currentRequestKey('profile-1'),
    });

    expect(withRawPredictive(CHART, 'chart-1').transit_context).toBe(RAW.transit_context);
  });

  it('never composes raw contexts produced for a pre-rectification birth instant', () => {
    seedProfiles('profile-1');
    useChartLibraryStore.setState({
      charts: {
        'chart-1': {
          chart_id: 'chart-1',
          profile_id: 'profile-1',
          is_primary: true,
          birth_data: CURRENT_BIRTH,
          sidereal_chart: CHART,
        } as StoredChart,
      },
      hydrated: true,
    });
    usePredictiveStore.setState({
      status: 'ready',
      rawContexts: RAW,
      profileKey: 'profile-1',
      requestKey: predictiveRequestKey({
        profileKey: 'profile-1',
        datetimeUtc: '1990-03-30T06:30:00Z',
        latitude: 12.97,
        longitude: 77.59,
        referenceInstant: '2026-06-09T00:00:00Z',
        utcOffsetMinutes: 330,
      }),
    });

    expect(withRawPredictive(CHART, 'chart-1')).toBe(CHART);
  });
});
