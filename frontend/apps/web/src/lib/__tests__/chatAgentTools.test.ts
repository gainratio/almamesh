import { describe, expect, it, vi } from 'vitest';

import {
  createChatAgentTools,
  currentDateTimeForZone,
  mentionsExplicitPeriod,
  requiresCurrentPlanetaryContext,
  shouldPreRunToday,
  viewerTodayDay,
} from '../chatAgentTools';
import type { SiderealChart } from '@almamesh/browser/types';

describe('currentDateTimeForZone', () => {
  const now = new Date('2026-03-08T09:30:00.000Z');

  it('formats the caller-pinned instant in an IANA timezone across DST', () => {
    expect(currentDateTimeForZone(now, 'America/Los_Angeles')).toEqual({
      isoUtc: '2026-03-08T09:30:00.000Z',
      localDate: '2026-03-08',
      localTime: '01:30:00',
      utcOffset: '-08:00',
      timeZone: 'America/Los_Angeles',
    });
  });

  it('handles a non-DST half-hour timezone deterministically', () => {
    expect(currentDateTimeForZone(now, 'Asia/Kolkata')).toMatchObject({
      localDate: '2026-03-08',
      localTime: '15:00:00',
      utcOffset: '+05:30',
      timeZone: 'Asia/Kolkata',
    });
  });

  it('fails closed for an invalid timezone', () => {
    expect(() => currentDateTimeForZone(now, 'not/a-zone')).toThrow(/timezone/i);
  });
});

describe('viewerTodayDay', () => {
  const now = new Date('2026-03-08T05:30:00.000Z');

  it("is today's calendar day in the given zone", () => {
    expect(viewerTodayDay(now, 'America/Los_Angeles')).toBe('2026-03-07');
    expect(viewerTodayDay(now, 'Asia/Kolkata')).toBe('2026-03-08');
  });

  it("defaults to the viewer's (device) zone", () => {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(viewerTodayDay(now)).toBe(viewerTodayDay(now, device));
  });
});

describe('createChatAgentTools', () => {
  const chart = {
    ayanamsa_value: 24,
    lagna: { sign: 'aries', longitude: 10 },
    planets: [],
    houses: [],
    yogas: [],
  } as unknown as SiderealChart;
  const chartAsOf = { basis: 'chart' as const, instant: new Date('2025-01-01T12:00:00.000Z') };

  it('exposes exactly the three bounded read-only capabilities', () => {
    const tools = createChatAgentTools({
      chart,
      chartAsOf,
      chartTimeZone: 'Asia/Kolkata',
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_current_datetime',
      'get_chart_facts',
      'get_timing',
    ]);
  });

  it.each([
    [8, true],
    [4, false],
  ])('with no seam, a %i GB device follows devicePolicy (period sky computed: %s)', async (gib, computed) => {
    Object.defineProperty(navigator, 'deviceMemory', { value: gib, configurable: true });
    try {
      const loadPeriodChart = vi.fn(async () => chart);
      const [, , timing] = createChatAgentTools({ chart, chartAsOf, chartTimeZone: 'UTC', loadPeriodChart });
      const context = { now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal };
      const result = await timing.execute({ section: 'transits', start: '2019-06-01', end: '2019-06-30' }, context);
      expect(loadPeriodChart).toHaveBeenCalledTimes(computed ? 1 : 0);
      expect(result).toMatchObject({ shown: computed ? 'transits' : 'dashas' });
    } finally {
      Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });

  it('hands get_timing the birth day, today, and the period loader', async () => {
    const loadPeriodChart = vi.fn(async () => chart);
    const [, , timing] = createChatAgentTools({
      chart,
      chartAsOf,
      chartTimeZone: 'UTC',
      birthYear: 1990,
      todayDay: () => '2026-03-08',
      loadPeriodChart,
      periodSkyAllowed: true,
    });
    const context = { now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal };
    await expect(timing.execute({ section: 'dashas', start: '1989-01-01' }, context)).resolves.toEqual({
      error: expect.stringMatching(/before the birth date/),
    });
    await expect(timing.execute({ section: 'dashas' }, context)).resolves.toMatchObject({
      period: { start: '2026-03-08', basis: 'today' },
    });
    // INVERTED (time travel step C): a single day of strength with no place used to load the
    // period sky; under a week it now needs a place and the loader is not called.
    await expect(timing.execute({ section: 'strength', start: '2019-06-01' }, context)).resolves.toEqual({
      error: 'needs_place',
    });
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  // Placed sibling of the inverted call: the place reader and Moon loader reach get_timing.
  it('hands get_timing the place reader and the Moon loader, and loads the placed day', async () => {
    const loadPeriodChart = vi.fn(async () => chart);
    const mark = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
    const loadMoonWindow = vi.fn(async () => ({ at_place: { at_start: mark, at_end: mark }, event: null }));
    const place = { summary: { place_ref: 'city:5', label: 'Lima, Peru', timezone: 'America/Lima' }, latitude: -12, longitude: -77 };
    const placeFromRef = vi.fn(async () => place);
    const [, , timing] = createChatAgentTools({
      chart,
      chartAsOf,
      chartTimeZone: 'UTC',
      birthYear: 1990,
      todayDay: () => '2026-03-08',
      loadPeriodChart,
      periodSkyAllowed: true,
      loadMoonWindow,
      placeFromRef,
    });
    const context = { now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal };
    // The Moon at a place rides on transits. INVERTED (northstar #306 item 1): a placed
    // strength day used to read the Moon too; it now carries the label and zone only.
    const result = await timing.execute({ section: 'transits', start: '2019-06-01', place_ref: 'city:5' }, context);
    expect(loadPeriodChart).toHaveBeenCalledWith({ start: '2019-06-01', end: '2019-06-01' }, context);
    expect(placeFromRef).toHaveBeenCalledWith('city:5');
    expect(loadMoonWindow).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ places: [{ label: 'Lima, Peru', timezone: 'America/Lima', moon: { at_start: mark } }] });
    const strength = await timing.execute({ section: 'strength', start: '2019-06-01', place_ref: 'city:5' }, context);
    expect(loadMoonWindow).toHaveBeenCalledOnce();
    expect((strength as { places: unknown[] }).places).toEqual([
      { start: '2019-06-01', end: '2019-06-01', label: 'Lima, Peru', timezone: 'America/Lima' },
    ]);
  });

  it('uses the turn-pinned clock and chart timezone without wall-clock reads', async () => {
    const [timeTool] = createChatAgentTools({
      chart,
      chartAsOf,
      chartTimeZone: 'Asia/Kolkata',
    });
    await expect(
      Promise.resolve(
        timeTool.execute(
          { scope: 'chart' },
          { now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal },
        ),
      ),
    ).resolves.toMatchObject({
      scope: 'chart',
      localTime: '15:00:00',
      timeZone: 'Asia/Kolkata',
    });
  });

  it('exposes only chart and UTC time scopes and rejects device context', () => {
    const [timeTool] = createChatAgentTools({ chart, chartAsOf, chartTimeZone: 'Asia/Kolkata' });

    expect(timeTool.parameters).toMatchObject({
      properties: {
        scope: { enum: ['chart', 'utc'] },
      },
    });
    expect(() =>
      timeTool.execute(
        { scope: 'device' },
        { now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal },
      ),
    ).toThrow(/scope must be one of: chart, utc/);
  });

  it('returns only sanitizer-allowlisted chart data', async () => {
    const chartWithPii = { ...chart, name: 'Private Name', city: 'Secret City' } as SiderealChart;
    const tools = createChatAgentTools({ chart: chartWithPii, chartAsOf, chartTimeZone: 'UTC' });
    const overview = await tools[1].execute(
      { section: 'overview' },
      { now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal },
    );
    expect(JSON.stringify(overview)).not.toContain('Private Name');
    expect(JSON.stringify(overview)).not.toContain('Secret City');
  });

  it('calculates current timing on demand from the pinned turn clock', async () => {
    const currentChart = {
      ...chart,
      strength_context: {
        ashtakavarga: { sarva: { total: 337 } },
        shadbala: { planets: {} },
      },
    } as unknown as SiderealChart;
    const loadCurrentChart = vi.fn(async () => currentChart);
    const tools = createChatAgentTools({
      chart,
      chartAsOf,
      chartTimeZone: 'Asia/Kolkata',
      loadCurrentChart,
    });

    await expect(
      tools[2].execute(
        { section: 'strength' },
        { now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ period: { basis: 'today' }, data: { sav_total: 337 } });
    expect(loadCurrentChart).toHaveBeenCalledWith({
      now: new Date('2026-03-08T09:30:00.000Z'),
      signal: expect.any(AbortSignal),
    });
    expect(tools[2].timeoutMs).toBe(150_000);
  });
});

describe('requiresCurrentPlanetaryContext', () => {
  it.each([
    'What should I pay attention to today?',
    'What are my current transits?',
    'How does this week look?',
    '¿Qué importa hoy?',
    'Como estão meus trânsitos agora?',
  ])('routes relative-time question through deterministic current context: %s', (question) => {
    expect(requiresCurrentPlanetaryContext(question)).toBe(true);
  });

  it.each([
    'Where is my natal Mars?',
    'Explain my ascendant.',
    'What does this yoga mean?',
  ])('does not force current computation for natal-only question: %s', (question) => {
    expect(requiresCurrentPlanetaryContext(question)).toBe(false);
  });

  it("describes the chart as of its own instant, and only the timing tool as of today", async () => {
    const golden = (await import('../../../../../../backend/tests/fixtures/chart_golden_de421.json'))
      .default as unknown as Record<string, SiderealChart>;
    const real = golden['1988-08-08T01:14:00+00:00']!;
    const tools = createChatAgentTools({
      chart: real,
      chartAsOf: { basis: 'chart', instant: new Date(real.snapshot!.reference_date) },
      chartTimeZone: 'UTC',
      loadCurrentChart: async () => real,
    });
    const context = { now: new Date('2030-06-01T12:00:00.000Z'), signal: new AbortController().signal };

    const facts = (await tools[1].execute({ section: 'dashas' }, context)) as {
      maha_dasha_sequence: Array<{ lord: string; status?: string }>;
    };
    const timing = ((await tools[2].execute({ section: 'dashas' }, context)) as { data: typeof facts }).data;

    const current = (rows: typeof facts.maha_dasha_sequence) =>
      rows.filter((row) => row.status?.startsWith('current')).map((row) => row.lord);
    expect(current(facts.maha_dasha_sequence)).toEqual(['jupiter']);
    expect(current(timing.maha_dasha_sequence)).toEqual(['saturn']);
  });
});

describe('mentionsExplicitPeriod', () => {
  it.each([
    'What happened in June 2019?',
    'transits in June 2019',
    'How was 2019 for me?',
    'What about 15 June?',
    'what may happen in May?',
    'Tell me about May 2027',
    '3 May was a big day',
    '¿Cómo fue marzo de 2020?',
    '¿Qué pasó en julio?',
    'Como foi março para mim?',
    'E em setembro?',
    'What happened in March?',
    'Desde marco de 2020',
    'Tudo mudou desde marco',
    // NFD "março" (c + combining cedilla), as some keyboards and pastes send it.
    'Como foi março para mim?'.normalize('NFD'),
  ])('sees an explicit period in: %s', (question) => {
    expect(mentionsExplicitPeriod(question)).toBe(true);
  });

  it.each([
    'What may happen today?',
    'What are my current transits?',
    'Ask Marco about this week',
    'How should I march forward this month?',
    'Where is my natal Mars?',
    'Explain my ascendant.',
  ])('sees no explicit period in: %s', (question) => {
    expect(mentionsExplicitPeriod(question)).toBe(false);
  });
});

describe('shouldPreRunToday', () => {
  it('pre-runs today only for "today" questions with no explicit period', () => {
    expect(shouldPreRunToday('What are my current transits?')).toBe(true);
    expect(shouldPreRunToday('What may happen today?')).toBe(true);
    expect(shouldPreRunToday('transits in June 2019')).toBe(false);
    expect(shouldPreRunToday('Where is my natal Mars?')).toBe(false);
  });
});
