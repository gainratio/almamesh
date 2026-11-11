import type { VargaDetailResult } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfilesStore, useRectificationRecordsStore } from '@almamesh/store';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { createReadVargaTool, type ReadVargaResult } from '../vargaTool';
import { CHART } from './timingFixtures';

const CTX = { now: new Date('2026-11-11T18:00:00Z'), signal: new AbortController().signal };

const VARGA_CHART: SiderealChart = {
  ...CHART,
  lagna: { longitude: 215.4, sign: 'Scorpio', sign_lord: 'mars' } as SiderealChart['lagna'],
  planets: {
    jupiter: { longitude: 95.2, sign: 'Cancer', sign_lord: 'moon', is_combust: false },
    saturn: { longitude: 12.8, sign: 'Aries', sign_lord: 'mars', is_combust: false },
  } as unknown as SiderealChart['planets'],
};

const D60_ENGINE_RESULT: VargaDetailResult = {
  chart: 'D60',
  lagna_sign: 'Virgo',
  lagna_sign_lord: 'Mercury',
  lagna_vargottama: false,
  lagna_shashtiamsa: { number: 12, name: 'Deva', nature: 'saumya' },
  sensitivity: {
    nominal_window_minutes: 2,
    margin_prev_deg: 0.12,
    margin_next_deg: 0.38,
    approx_minutes_to_cusp: 0.48,
    high_time_sensitivity: true,
  },
  placements: {
    jupiter: {
      graha: 'jupiter',
      sign: 'Cancer',
      sign_lord: 'Moon',
      house: 11,
      dignity: 'exalted',
      is_combust: false,
      same_sign_as_d1: false,
      vargottama: true,
      shashtiamsa: { number: 19, name: 'Amrita', nature: 'saumya' },
    },
    saturn: {
      graha: 'saturn',
      sign: 'Aries',
      sign_lord: 'Mars',
      house: 8,
      dignity: 'debilitated',
      is_combust: false,
      same_sign_as_d1: false,
      vargottama: false,
      shashtiamsa: { number: 1, name: 'Ghora', nature: 'krura' },
    },
  },
};

beforeEach(() => {
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
  useRectificationRecordsStore.setState({ recordsByProfile: {} });
});

describe('read_varga tool', () => {
  it('computes D60 Shashtiamsa via Python engine with cusp sensitivity and unrectified prompt', async () => {
    const profileId = useProfilesStore.getState().createProfile('Asha');
    const computeVargaDetail = vi.fn(async () => D60_ENGINE_RESULT);
    const engine = {
      engine: { computeVargaDetail },
      error: null,
      startBootstrap: vi.fn(),
      whenReady: async () => ({ computeVargaDetail }),
    } as unknown as ChartEngineContextValue;

    const tool = createReadVargaTool({ chart: VARGA_CHART, engine, profileId });
    const result = (await tool.execute({ division: 'D60', focus_planets: null }, CTX)) as ReadVargaResult;

    expect(computeVargaDetail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      chart: 'D60',
      source: 'engine',
      lagna_sign: 'Virgo',
      lagna_sign_lord: 'Mercury',
      lagna_shashtiamsa: { number: 12, name: 'Deva', nature: 'saumya' },
      birth_time_rectified: false,
      rectify_available: true,
      sensitivity: {
        nominal_window_minutes: 2,
        approx_minutes_to_cusp: 0.48,
        high_time_sensitivity: true,
      },
    });
    expect(result.placements.jupiter?.shashtiamsa?.name).toBe('Amrita');
    expect(result.placements.saturn?.shashtiamsa?.nature).toBe('krura');
  });

  it('filters placements when focus_planets is specified', async () => {
    const computeVargaDetail = vi.fn(async () => D60_ENGINE_RESULT);
    const engine = {
      engine: { computeVargaDetail },
      error: null,
      startBootstrap: vi.fn(),
      whenReady: async () => ({ computeVargaDetail }),
    } as unknown as ChartEngineContextValue;

    const tool = createReadVargaTool({ chart: VARGA_CHART, engine, profileId: undefined });
    const result = (await tool.execute({ division: 'D60', focus_planets: ['jupiter'] }, CTX)) as ReadVargaResult;

    expect(Object.keys(result.placements)).toEqual(['jupiter']);
  });

  it('falls back gracefully to cached chart varga/navamsa when engine is unavailable', async () => {
    const tool = createReadVargaTool({ chart: VARGA_CHART, engine: null, profileId: undefined });
    const result = (await tool.execute({ division: 'D9', focus_planets: null }, CTX)) as ReadVargaResult;

    expect(result.source).toBe('cached_varga_context');
    expect(result.chart).toBe('D9');
    expect(result.lagna_sign).toBeTruthy();
    expect(result.sensitivity).toBeNull();
  });
});
