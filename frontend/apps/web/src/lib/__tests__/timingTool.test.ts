import type { SiderealChart, TransitContext } from '@almamesh/browser/types';
import { BEFORE_BIRTH_MESSAGE, OVER_TWO_YEARS_NOTE, PAST_EPHEMERIS_NOTE } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import { PeriodSkyTimeoutError } from '../periodSky';
import { PeriodSkyUnavailableError, TIMING_TOOL_TIMEOUT_MS, createTimingTool } from '../timingTool';

const BIRTH = '1990-01-15T12:00:00Z';
const DASHAS = {
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
const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [], dashas: DASHAS } as unknown as SiderealChart;

const placement = (graha: string) => ({
  graha, longitude: 0, sign: 'aries', sign_degrees: 0, nakshatra: 'ashwini', nakshatra_pada: 1,
  is_retrograde: false, house_from_lagna: 1, house_from_moon: 1, natal_sign_occupied: 'aries',
});
const event = (date: string, graha: string) => ({
  date, kind: 'sign_ingress', graha, from_sign: 'scorpio', to_sign: 'sagittarius', from_lord: null,
  to_lord: null, sade_sati_phase: null, severity: 'supportive', descriptor: `${graha} changes sign`,
});
const TRANSITS = {
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
const SKY_CHART = { ...CHART, transit_context: TRANSITS } as SiderealChart;

const NOW = new Date('2026-03-08T09:30:00.000Z');
const context = () => ({ now: NOW, signal: new AbortController().signal });

function tool(overrides: Partial<Parameters<typeof createTimingTool>[0]> = {}) {
  return createTimingTool({
    chart: CHART,
    birthDay: '1990-01-15',
    todayDay: () => '2026-03-08',
    loadPeriodChart: vi.fn(async () => SKY_CHART),
    ...overrides,
  });
}

describe('get_timing contract', () => {
  it('is named get_timing, takes optional start/end days, and waits up to 150 s', () => {
    const timing = tool();
    expect(timing.name).toBe('get_timing');
    expect(TIMING_TOOL_TIMEOUT_MS).toBe(150_000);
    expect(timing.timeoutMs).toBe(150_000);
    expect(timing.parameters).toMatchObject({
      properties: {
        section: { enum: ['dashas', 'transits', 'domains', 'strength'] },
        start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      required: ['section'],
    });
  });
});

describe('get_timing with no dates', () => {
  it("means today, labelled 'today', and never loads a period sky", async () => {
    const loadPeriodChart = vi.fn();
    const result = await tool({ loadPeriodChart }).execute({ section: 'dashas' }, context());
    expect(result).toMatchObject({
      period: { start: '2026-03-08', end: '2026-03-08', days: 1, basis: 'today' },
      section: 'dashas',
    });
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it("reads today's sky through the current-chart loader for engine sections", async () => {
    const loadCurrentChart = vi.fn(async () => SKY_CHART);
    const result = await tool({ loadCurrentChart }).execute({ section: 'transits' }, context());
    expect(loadCurrentChart).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ period: { basis: 'today' }, shown: 'transits' });
  });
});

describe('get_timing with dates', () => {
  it('echoes the resolved period on every result', async () => {
    const result = await tool().execute({ section: 'dashas', start: '2019-06-01', end: '2019-06-30' }, context());
    expect(result).toMatchObject({ period: { start: '2019-06-01', end: '2019-06-30', days: 30, basis: 'period' } });
  });

  it('picks dashas by date without an engine run', async () => {
    const loadPeriodChart = vi.fn();
    const result = (await tool({ loadPeriodChart }).execute(
      { section: 'dashas', start: '2019-06-01', end: '2019-06-30' },
      context(),
    )) as { data: { antar: Array<{ lord: string }> } };
    expect(result.data.antar.map((row) => row.lord)).toEqual(['saturn', 'mercury']);
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it.each([
    [{ start: '2026-02-30' }, 'start must be a date like 2026-06-01'],
    [{ start: '2026-06-30', end: '2026-06-01' }, 'end is before start'],
    [{ end: '2026-06-30' }, 'start is required when end is given'],
  ])('returns (never throws) a readable error for %j', async (dates, error) => {
    await expect(tool().execute({ section: 'transits', ...dates }, context())).resolves.toEqual({ error });
  });

  it('refuses a period before birth without revealing the birth date', async () => {
    const result = await tool().execute({ section: 'dashas', start: '1989-06-01', end: '1990-06-30' }, context());
    expect(result).toEqual({ error: BEFORE_BIRTH_MESSAGE });
    expect(JSON.stringify(result)).not.toMatch(/1990-01|1990/);
  });

  it('a span over two years gives dashas only, with a note, and no engine run', async () => {
    const loadPeriodChart = vi.fn();
    const result = await tool({ loadPeriodChart }).execute(
      { section: 'transits', start: '2019-01-01', end: '2021-02-01' },
      context(),
    );
    expect(result).toMatchObject({ shown: 'dashas' });
    // The cap note comes first; dasha-selection notes (pratyantar) may follow.
    expect((result as { notes: string[] }).notes[0]).toBe(OVER_TWO_YEARS_NOTE);
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('a day after 2052 gives dashas only', async () => {
    const result = await tool().execute({ section: 'transits', start: '2053-01-05' }, context());
    expect(result).toMatchObject({ shown: 'dashas' });
    expect((result as { notes: string[] }).notes[0]).toBe(PAST_EPHEMERIS_NOTE);
  });

  it('a month of transits drops fast planets and events outside the month', async () => {
    const result = (await tool().execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      context(),
    )) as { data: { gochara: Array<{ graha: string }>; timeline: Array<{ month: string }> }; covered_events: string[] };
    expect(result.data.gochara.map((row) => row.graha).sort()).toEqual(['jupiter', 'saturn']);
    expect(result.data.timeline.map((row) => row.month)).toEqual(['2019-06']);
    expect(result.covered_events).not.toContain('mars_ingress');
  });

  it('a single day keeps the Moon', async () => {
    const result = (await tool().execute({ section: 'transits', start: '2019-06-10' }, context())) as {
      data: { gochara: Array<{ graha: string }> };
    };
    expect(result.data.gochara.map((row) => row.graha)).toContain('moon');
  });

  it.each([
    [new PeriodSkyUnavailableError('engine_unavailable'), 'engine_unavailable'],
    [new PeriodSkyUnavailableError('incomplete_birth_data'), 'incomplete_birth_data'],
    [new PeriodSkyTimeoutError(), 'timeout'],
    [new Error('worker crashed'), 'engine_unavailable'],
  ])('tells the model why the sky is missing (%s)', async (error, reason) => {
    const loadPeriodChart = vi.fn(async () => {
      throw error;
    });
    const result = await tool({ loadPeriodChart }).execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      context(),
    );
    expect(result).toMatchObject({ data: { available: false, reason } });
  });

  it('rethrows when the turn itself was cancelled', async () => {
    const controller = new AbortController();
    const loadPeriodChart = vi.fn(async () => {
      controller.abort(new DOMException('cancelled', 'AbortError'));
      throw new Error('aborted');
    });
    await expect(
      tool({ loadPeriodChart }).execute(
        { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
        { now: NOW, signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});

describe('get_timing on real engine output (born 2019-11-09)', () => {
  const real = (golden as unknown as Record<string, SiderealChart>)['2019-11-09T17:45:00+00:00']!;
  const realTool = () => tool({ chart: real, birthDay: '2019-11-09' });

  it('a dashas period inside the first maha never shows the birth month', async () => {
    const result = await realTool().execute({ section: 'dashas', start: '2020-06-01', end: '2020-06-30' }, context());
    expect(result).toMatchObject({ data: { maha: [{ start_month: 'birth' }] } });
    expect(JSON.stringify(result)).not.toContain('2019-11');
  });

  it('every dasha boundary in a period result is YYYY-MM or "birth"', async () => {
    const result = (await realTool().execute(
      { section: 'dashas', start: '2021-01-01', end: '2021-12-31' },
      context(),
    )) as { data: { maha: Array<Record<string, string>>; antar: Array<Record<string, string>> } };
    const rows = [...result.data.maha, ...result.data.antar];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.start_month).toMatch(/^(\d{4}-\d{2}|birth)$/);
      expect(row.end_month).toMatch(/^(\d{4}-\d{2}|birth)$/);
    }
  });
});
