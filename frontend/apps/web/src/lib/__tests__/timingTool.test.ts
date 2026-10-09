import type { SiderealChart } from '@almamesh/browser/types';
import {
  BEFORE_BIRTH_MESSAGE,
  BIRTH_YEAR_ROWS_NOTE,
  BIRTH_YEAR_SKY_NOTE,
  NEEDS_PLACE_ERROR,
  OVER_TWO_YEARS_NOTE, PAST_EPHEMERIS_NOTE, placementsAsOfNote } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import golden from '../../../../../../backend/tests/fixtures/chart_golden_de421.json';
import { PeriodSkyTimeoutError } from '../periodSky';
import {
  DASHAS_STATUS_LABEL,
  DEVICE_DASHAS_ONLY_NOTE,
  NEEDS_PLACE_STATUS_LABEL,
  PeriodSkyUnavailableError,
  TIMING_TOOL_TIMEOUT_MS,
  createTimingTool,
} from '../timingTool';
import { CHART, DASHAS, SKY_CHART, TRANSITS } from './timingFixtures';

const NOW = new Date('2026-03-08T09:30:00.000Z');
const context = () => ({ now: NOW, signal: new AbortController().signal });
/** Step C: a sky reading under a week needs a place; these siblings send one. */
const PLACED = { place_ref: 'city:202' } as const;
const BOGOTA = {
  summary: { place_ref: 'city:202', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
  latitude: 4.711,
  longitude: -74.0721,
};

function tool(overrides: Partial<Parameters<typeof createTimingTool>[0]> = {}) {
  return createTimingTool({
    chart: CHART,
    birthYear: 1990,
    todayDay: () => '2026-03-08',
    loadPeriodChart: vi.fn(async () => SKY_CHART),
    periodSkyAllowed: true,
    placeFromRef: vi.fn(async (ref: string) => (ref === BOGOTA.summary.place_ref ? BOGOTA : undefined)),
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

  // REVERSED CONTRACT (PR #298): this period used to be refused because it starts
  // before the birth DAY. A day-precision refusal is a 1-bit oracle on the birth
  // date, so the refusal boundary is now 1 January of the birth year.
  it('answers a period that starts before the birth day but ends in the birth year', async () => {
    const result = await tool().execute({ section: 'dashas', start: '1989-06-01', end: '1990-06-30' }, context());
    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({ shown: 'dashas', data: { maha: [{ start_month: 'birth' }] } });
    expect(JSON.stringify(result)).not.toMatch(/1990-01/);
  });

  it('refuses only a period that ends before 1 January of the birth year', async () => {
    const refused = await tool().execute({ section: 'dashas', start: '1989-01-01', end: '1989-12-31' }, context());
    expect(refused).toEqual({ error: BEFORE_BIRTH_MESSAGE });
    const answered = await tool().execute({ section: 'transits', start: '1990-01-01', end: '1990-01-14' }, context());
    expect(answered).not.toHaveProperty('error');
    // Round 2: answered, but a birth-year sky is withheld (dashas only, constant note).
    expect(answered).toMatchObject({ shown: 'dashas', period: { start: '1990-01-01', end: '1990-01-14' } });
    expect((answered as { notes: string[] }).notes).toEqual([
      BIRTH_YEAR_SKY_NOTE,
      BIRTH_YEAR_ROWS_NOTE,
      'Pratyantar dashas are only available for the current antar.',
    ]);
  });

  it.each(['transits', 'domains', 'strength'])(
    'withholds the %s sky for a period starting in the birth year: dashas only, one constant note, no engine run',
    async (section) => {
      const loadPeriodChart = vi.fn(async () => SKY_CHART);
      const result = (await tool({ loadPeriodChart }).execute(
        { section, start: '1990-12-31', end: '1991-01-05' },
        context(),
      )) as { shown: string; notes: string[] };
      expect(loadPeriodChart).not.toHaveBeenCalled();
      expect(result.shown).toBe('dashas');
      expect(result.notes[0]).toBe(BIRTH_YEAR_SKY_NOTE);
      expect(BIRTH_YEAR_SKY_NOTE).toBe("Planet timing for the year of birth isn't available; showing periods only.");
      // INVERTED (time travel step C): a single day of sky with no place used to be computed;
      // under a week it now needs a place, and the engine does not run.
      const nextYear = await tool({ loadPeriodChart }).execute({ section, start: '1991-01-01' }, context());
      expect(nextYear).toEqual({ error: NEEDS_PLACE_ERROR });
      expect(loadPeriodChart).not.toHaveBeenCalled();
      // Placed sibling: the year after birth still computes the sky.
      const placed = await tool({ loadPeriodChart }).execute({ section, start: '1991-01-01', ...PLACED }, context());
      expect(placed).toMatchObject({ shown: section });
      expect(loadPeriodChart).toHaveBeenCalledOnce();
    },
  );

  it('does not promise a sky computation for a birth-year period (the engine never runs)', () => {
    const timing = tool();
    // What the agent shows: the per-call label, else the tool's label.
    const shown = (args: Record<string, string>) => timing.statusLabelFor?.(args) ?? timing.statusLabel;
    expect(shown({ section: 'transits', start: '1990-06-01' })).toBe(DASHAS_STATUS_LABEL);
    expect(DASHAS_STATUS_LABEL).toBe('Reading dasha periods');
    // INVERTED (time travel step C): a single day with no place is refused at once, so the
    // label no longer promises a 30 s sky. Placed sibling: with a place it still does.
    expect(shown({ section: 'domains', start: '1991-06-01' })).toBe(NEEDS_PLACE_STATUS_LABEL);
    expect(shown({ section: 'domains', start: '1991-06-01', ...PLACED })).toBe('Working out the sky… (about 30 s)');
    expect(shown({ section: 'transits' })).toBe('Working out the sky… (about 30 s)');
    // A refused (before the birth year) call runs no engine either.
    expect(shown({ section: 'transits', start: '1985-01-01' })).toBe(DASHAS_STATUS_LABEL);
  });

  it('withholds the sky until the later of the local and UTC birth years', async () => {
    // Born 1990-12-31 20:00 PST = 1991-01-01T04:00Z: 1991-01-01 is still before the birth instant.
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const pstEdge = tool({ birthYear: 1990, birthUtcYear: 1991, loadPeriodChart });
    const result = await pstEdge.execute({ section: 'transits', start: '1991-01-01' }, context());
    expect(loadPeriodChart).not.toHaveBeenCalled();
    expect(result).toMatchObject({ shown: 'dashas' });
    expect((result as { notes: string[] }).notes[0]).toBe(BIRTH_YEAR_SKY_NOTE);
    expect(pstEdge.statusLabelFor?.({ section: 'transits', start: '1991-01-01' })).toBe(DASHAS_STATUS_LABEL);
    // INVERTED (time travel step C): 1992-01-01 with no place now needs a place, no engine run.
    await expect(pstEdge.execute({ section: 'transits', start: '1992-01-01' }, context())).resolves.toEqual({
      error: NEEDS_PLACE_ERROR,
    });
    expect(loadPeriodChart).not.toHaveBeenCalled();
    // Placed sibling: the year after the UTC birth year computes the sky.
    await pstEdge.execute({ section: 'transits', start: '1992-01-01', ...PLACED }, context());
    expect(loadPeriodChart).toHaveBeenCalledOnce();
  });

  it('gates the sky on the UTC birth year alone when the local year is unknown', async () => {
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const utcOnly = tool({ birthYear: undefined, birthUtcYear: 1991, loadPeriodChart });
    await expect(utcOnly.execute({ section: 'strength', start: '1991-06-01' }, context())).resolves.toMatchObject({
      shown: 'dashas',
    });
    expect(loadPeriodChart).not.toHaveBeenCalled();
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
    )) as {
      data: { gochara: Array<{ graha: string }>; timeline: Array<{ month: string }> };
      covered_events: string[];
      notes: string[];
    };
    expect(result.data.gochara.map((row) => row.graha).sort()).toEqual(['jupiter', 'saturn']);
    // Placements hold at the first day only; the model must not stretch them over the month.
    expect(result.notes[0]).toBe(placementsAsOfNote('2019-06-01'));
    expect(result.data.timeline.map((row) => row.month)).toEqual(['2019-06']);
    expect(result.covered_events).toEqual([
      'jupiter_ingress',
      'saturn_ingress',
      'mars_ingress',
      'rahu_ingress',
      'ketu_ingress',
      'jupiter_station',
      'saturn_station',
      'mars_station',
      'dasha_change',
      'sade_sati_phase',
    ]);
  });

  // INVERTED (time travel step C): a single day of transits with no place used to answer
  // with the Moon; it now needs a place first.
  it('a single day with no place needs a place', async () => {
    const result = await tool().execute({ section: 'transits', start: '2019-06-10' }, context());
    expect(result).toEqual({ error: NEEDS_PLACE_ERROR });
  });

  // Placed sibling of the inverted test: the original intent, the Moon kept for one day.
  it('a single day at a place keeps the Moon', async () => {
    const result = (await tool().execute({ section: 'transits', start: '2019-06-10', ...PLACED }, context())) as {
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

  it('names the engine unavailable when no period loader was wired', async () => {
    const result = await tool({ loadPeriodChart: undefined }).execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      context(),
    );
    expect(result).toMatchObject({ data: { available: false, reason: 'engine_unavailable' } });
  });

  it('says transits are unavailable when the period sky has no transit context', async () => {
    const result = await tool({ loadPeriodChart: vi.fn(async () => CHART) }).execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      context(),
    );
    expect(result).toMatchObject({ shown: 'transits', notes: [], data: { available: false } });
    expect((result as { data: unknown }).data).toEqual({ available: false });
  });

  it('a device that may not compute period skies answers with dashas only, and says why', async () => {
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const result = (await tool({ loadPeriodChart, periodSkyAllowed: false }).execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      context(),
    )) as { section: string; shown: string; notes: string[]; data: unknown };
    expect(loadPeriodChart).not.toHaveBeenCalled();
    expect(result.section).toBe('transits');
    expect(result.shown).toBe('dashas');
    expect(result.notes[0]).toBe('This device answers dated questions with dashas only, to stay within memory.');
    expect(result.notes[0]).toBe(DEVICE_DASHAS_ONLY_NOTE);
    expect(result.data).toMatchObject({ maha: expect.any(Array) });
  });

  it('a dashas-only device still answers today from the Life Atlas sky', async () => {
    const loadCurrentChart = vi.fn(async () => SKY_CHART);
    const result = await tool({ loadCurrentChart, periodSkyAllowed: false }).execute({ section: 'transits' }, context());
    expect(loadCurrentChart).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ period: { basis: 'today' }, shown: 'transits', notes: [] });
  });

  it('says dashas are unavailable when the stored chart has none', async () => {
    const noDashas = { ...CHART, dashas: undefined } as unknown as SiderealChart;
    const result = await tool({ chart: noDashas }).execute(
      { section: 'dashas', start: '2019-06-01', end: '2019-06-30' },
      context(),
    );
    expect(result).toMatchObject({ shown: 'dashas', notes: [] });
    expect((result as { data: unknown }).data).toEqual({ available: false });
  });

  it('returns (never throws) a readable error for an unknown section', async () => {
    await expect(tool().execute({ section: 'vargas' }, context())).resolves.toEqual({
      error: 'section must be one of: dashas, transits, domains, strength',
    });
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
  const realTool = () => tool({ chart: real, birthYear: 2019 });

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

describe('get_timing is not a birth-day oracle', () => {
  // A chart whose dasha tree starts at the hidden birth instant; every later boundary is fixed.
  function chartBornOn(birthDay: string, birth = `${birthDay}T12:00:00Z`): SiderealChart {
    const dashas = {
      ...DASHAS,
      maha_dasha_sequence: [
        {
          lord: 'rahu', start_date: birth, end_date: '2007-06-01T00:00:00Z', duration_years: 17,
          antar_sequence: [
            { lord: 'rahu', start_date: birth, end_date: '1992-06-01T00:00:00Z', duration_years: 2 },
            { lord: 'jupiter', start_date: '1992-06-01T00:00:00Z', end_date: '2007-06-01T00:00:00Z', duration_years: 15 },
          ],
        },
        ...DASHAS.maha_dasha_sequence.slice(1),
      ],
    };
    return { ...CHART, dashas } as unknown as SiderealChart;
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const probes: Array<{ start: string; end: string }> = [
    ...[1989, 1990, 1991].flatMap((year) =>
      Array.from({ length: 12 }, (_, i) => ({
        start: `${year}-${pad(i + 1)}-01`,
        end: `${year}-${pad(i + 1)}-${pad(lastDay(year, i + 1))}`,
      })),
    ),
    ...Array.from({ length: 31 }, (_, i) => ({ start: `1990-03-${pad(i + 1)}`, end: `1990-03-${pad(i + 1)}` })),
  ];

  /**
   * A faithful fake of the period engine: like the real one it computes against the
   * birth instant, so the running maha lord is "sun" for a day before birth and
   * "rahu" after it, in transits (fusion), domains and strength alike.
   */
  function skyBornOn(chart: SiderealChart, birthDay: string) {
    return vi.fn(async (period: { start: string }) => {
      const lord = period.start < birthDay ? 'sun' : 'rahu';
      const forecast = {
        domain: 'career',
        strength_summary: {
          band: 'steady', key_graha: lord, key_graha_rupas: 6, key_graha_meets_minimum: true, sav_bindus: 28, note: '',
        },
        current_emphasis: {
          active_dasha_significator: lord, dasha_levels: ['maha'], matched_dasha_lords: [lord],
          under_sade_sati: false, transit_severity: 'neutral',
        },
        upcoming_windows: [],
      };
      const strength = {
        ashtakavarga: { sarva: { total: 337 } },
        shadbala: { planets: { [lord]: { planet: lord, total_rupas: 6, required_rupas: 5, meets_minimum: true } } },
      };
      return {
        ...chart,
        transit_context: { ...TRANSITS, fusion: { ...TRANSITS.fusion, maha_lord: lord, antar_lord: lord } },
        domains_context: { forecasts: { career: forecast } },
        strength_context: strength,
      } as unknown as SiderealChart;
    });
  }

  async function transcript(birthDay: string): Promise<unknown[]> {
    const chart = chartBornOn(birthDay);
    const timing = tool({
      chart,
      birthYear: Number(birthDay.slice(0, 4)),
      loadPeriodChart: skyBornOn(chart, birthDay),
    });
    const answers: unknown[] = [];
    for (const section of ['dashas', 'transits', 'domains', 'strength'] as const) {
      for (const period of probes) answers.push(await timing.execute({ section, ...period }, context()));
    }
    return answers;
  }

  it('answers every section, every month of 1989-1991 and every day of March 1990 identically for two birth days in 1990', async () => {
    const march = await transcript('1990-03-17');
    const november = await transcript('1990-11-02');
    expect(march).toHaveLength(probes.length * 4);
    expect(march).toEqual(november);
    // Sanity: the year is still the boundary, so 1989 is refused and 1990 is not.
    expect(march[0]).toEqual({ error: BEFORE_BIRTH_MESSAGE });
    expect(march[12]).not.toHaveProperty('error');
  });

  it('a birth late on 31 Dec (local) reads June of that year like a mid-year birth', async () => {
    // 1990-12-31 20:00 PST is 1991-01-01T04:00Z: the local year (1990) must win.
    const june = { section: 'dashas', start: '1990-06-01', end: '1990-06-30' };
    const pstEdge = await tool({ chart: chartBornOn('1990-12-31', '1991-01-01T04:00:00Z'), birthYear: 1990 }).execute(june, context());
    const midYear = await tool({ chart: chartBornOn('1990-06-15'), birthYear: 1990 }).execute(june, context());
    expect(pstEdge).toMatchObject({ data: { maha: [{ start_month: 'birth' }] } });
    expect(pstEdge).toEqual(midYear);
  });
});
