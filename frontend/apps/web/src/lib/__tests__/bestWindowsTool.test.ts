import type { SiderealChart } from '@almamesh/browser/types';
import { describe, expect, it, vi } from 'vitest';

import { createFindBestWindowsTool } from '../bestWindowsTool';
import { periodReadingFixture } from './periodReadingFixtures';
import { CHART } from './timingFixtures';

const CTX = { now: new Date('2026-11-11T18:00:00Z'), signal: new AbortController().signal };

const LOADED_CHART = {
  ...CHART,
  period_reading: periodReadingFixture('delhi-2027-01'),
  strength_context: {
    sunrise_utc_iso: '1990-01-15T01:44:00Z',
    ashtakavarga: {
      sarva: {
        bindus: { Aries: 29, Taurus: 33, Gemini: 27, Cancer: 31 },
        total: 337,
      },
    },
  },
  domains_context: {
    forecasts: {
      career: {
        domain: 'career',
        strength_summary: { tier: 'strong', score: 78 },
        current_emphasis: 'active',
        houses: [{ house: 10, sign: 'Capricorn', lord: 'Saturn' }],
        karakas: [{ graha: 'Saturn', role: 'karma' }],
        varga: { chart: 'D10', lagna_sign: 'Leo' },
        upcoming_windows: [
          {
            date: '2027-01-18',
            end_date: '2027-02-12',
            kind: 'supportive',
            summary: 'Jupiter trines 10th lord',
          },
          {
            date: '2028-09-01',
            end_date: '2028-09-20',
            kind: 'supportive',
            summary: 'Outside 6-month horizon',
          },
        ],
      },
    },
  },
} as unknown as SiderealChart;

describe('find_best_windows tool', () => {
  it('loads predictive window [today, +months], filters upcoming windows, and never leaks birth sunrise_utc_iso', async () => {
    const loadPeriodChart = vi.fn(async () => LOADED_CHART);
    const tool = createFindBestWindowsTool({
      chart: CHART,
      viewerZone: () => 'America/Los_Angeles',
      loadPeriodChart,
    });

    const result = await tool.execute({ domain: 'career', months: 6 }, CTX);

    expect(loadPeriodChart).toHaveBeenCalledWith(
      { start: '2026-11-11', end: '2027-05-11' },
      CTX,
    );
    expect(result).toMatchObject({
      domain: 'career',
      horizon_months: 6,
      window: { start: '2026-11-11', end: '2027-05-11' },
      sarva_total: 337,
      sarva_bindus: { Aries: 29, Taurus: 33, Gemini: 27, Cancer: 31 },
    });
    const ok = result as { upcoming_windows: { date: string }[] };
    expect(ok.upcoming_windows.map((w) => w.date)).toEqual(['2027-01-18']);
    expect(JSON.stringify(result)).not.toContain('1990-01-15');
    expect(JSON.stringify(result)).not.toContain('sunrise_utc_iso');
  });

  it('returns available=false cleanly when the period loader fails', async () => {
    const tool = createFindBestWindowsTool({
      chart: CHART,
      viewerZone: () => 'America/Los_Angeles',
      loadPeriodChart: async () => {
        throw new Error('worker offline');
      },
    });

    const result = await tool.execute({ domain: 'finances', months: null }, CTX);
    expect(result).toEqual({ domain: 'finances', available: false, reason: 'engine_unavailable' });
  });
});
