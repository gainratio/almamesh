import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { SPLIT_DAY_NOW } from '../../test/viewerToday';

const ensureMock = vi.hoisted(() => vi.fn());
vi.mock('../currentPlanetaryContext', () => ({ ensureCurrentPlanetaryContext: ensureMock }));

const loadMock = vi.hoisted(() => vi.fn());
vi.mock('../periodSky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../periodSky')>();
  return { ...actual, periodSkyCache: () => ({ load: loadMock, keys: () => [] }) };
});

vi.mock('../chatAgentTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chatAgentTools')>();
  return { ...actual, createChatAgentTools: vi.fn(actual.createChatAgentTools) };
});

import { createChatAgentTools } from '../chatAgentTools';
import { buildChatToolset, type BuildChatToolsetInput } from '../chatToolset';
import { TIME_TRAVEL_TOOL_NAME } from '../timeTravelTool';
import { CHART as TIMING_CHART, SKY_CHART } from './timingFixtures';

const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [] } as unknown as SiderealChart;
const TODAY_CHART = { ...SKY_CHART, ayanamsa_value: 23.71 } as unknown as SiderealChart;
const BIRTH = {
  birth_datetime_utc: '1990-01-15T06:30:00Z',
  birth_datetime_local: '1990-01-15T12:00:00',
  birth_location_details: { city: 'Delhi', latitude: 28.61, longitude: 77.21, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;

function engineContext(): ChartEngineContextValue {
  return {
    engine: { computePredictive: vi.fn() },
    startBootstrap: vi.fn(),
    whenReady: vi.fn(),
  } as unknown as ChartEngineContextValue;
}

/** engineContext() whose engine (ready and booting alike) carries extra methods. */
function engineContextWith(overrides: Record<string, unknown>): ChartEngineContextValue {
  const engine = { computePredictive: vi.fn(), ...overrides };
  return { engine, startBootstrap: vi.fn(), whenReady: vi.fn(async () => engine) } as unknown as ChartEngineContextValue;
}

function toolset(overrides: Partial<BuildChatToolsetInput> = {}) {
  return buildChatToolset({
    chart: CHART,
    chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') },
    chartTimeZone: 'Asia/Kolkata',
    profileKey: 'p1',
    birth: BIRTH,
    engine: engineContext(),
    viewerZone: () => 'America/Los_Angeles',
    ...overrides,
  });
}

const options = () => ({ now: SPLIT_DAY_NOW, signal: new AbortController().signal });
const timingOf = (built: ReturnType<typeof toolset>) => built.tools.find((tool) => tool.name === 'get_timing')!;

describe('chat time travel registration', () => {
  it('only advertises a move when this turn has a recorder, and actually records both directions', async () => {
    expect(toolset().tools.map((tool) => tool.name)).not.toContain(TIME_TRAVEL_TOOL_NAME);
    const onTravel = vi.fn();
    const tool = toolset({ onTravel, language: 'en' }).tools.find((candidate) => candidate.name === TIME_TRAVEL_TOOL_NAME);
    expect(tool).toBeDefined();
    await tool!.execute({ action: 'travel', period: 'year', date: '2027' }, options());
    expect(onTravel).toHaveBeenLastCalledWith({ kind: 'travel', asOf: { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } });
    await tool!.execute({ action: 'back_to_today' }, options());
    expect(onTravel).toHaveBeenLastCalledWith({ kind: 'back_to_today' });
  });
});

beforeEach(() => {
  ensureMock.mockReset().mockResolvedValue(TODAY_CHART);
  loadMock.mockReset().mockResolvedValue({});
});

describe('buildChatToolset: one "today", the viewer zone', () => {
  it('get_timing with no dates reads today in the viewer zone, not the birth zone', async () => {
    const result = await timingOf(toolset()).execute({ section: 'dashas' }, options());
    expect(result).toMatchObject({ period: { start: '2026-03-08', basis: 'today' } }); // Kolkata is already 03-09
  });

  it("the router's today pre-run asks the engine for the viewer's day", async () => {
    await toolset().prepare('What are my transits today?', options());
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ chartTimeZone: 'America/Los_Angeles' }));
  });

  it('defaults to the device zone when no test seam is passed', async () => {
    const result = await timingOf(toolset({ viewerZone: undefined })).execute({ section: 'dashas' }, options());
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = new Intl.DateTimeFormat('en-CA', { timeZone: device }).format(SPLIT_DAY_NOW);
    expect(result).toMatchObject({ period: { start: expected } });
  });
});

describe('buildChatToolset: router', () => {
  it('grounds a named month before inference without requiring a model tool call', async () => {
    loadMock.mockResolvedValue({ transit_context: SKY_CHART.transit_context });
    const prepared = await toolset({ chart: TIMING_CHART, periodSkyAllowed: true })
      .prepare('What happened in September 2017?', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '2017-09-01', end: '2017-09-30' } });
    expect(prepared.timingFacts).toHaveLength(2);
    expect(prepared.timingFacts[0]?.result).toMatchObject({ section: 'dashas', data: { maha: [{ lord: 'jupiter' }], antar: [{ lord: 'saturn' }] } });
    expect(prepared.timingFacts[1]?.result).toMatchObject({ section: 'transits', shown: 'transits', period: { start: '2017-09-01', end: '2017-09-30' } });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loadMock.mock.calls[0])).toContain('2017-09-01');
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it.each([
    ['2017-09', '2017-09-01', '2017-09-30'],
    ['2017', '2017-01-01', '2017-12-31'],
    ['septiembre de 2017', '2017-09-01', '2017-09-30'],
    ['setembro de 2017', '2017-09-01', '2017-09-30'],
  ])('grounds the supported literal period %s', async (question, start, end) => {
    const prepared = await toolset({ chart: TIMING_CHART, periodSkyAllowed: false }).prepare(question, options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start, end } });
    expect(prepared.timingFacts[0]?.result).toMatchObject({ period: { start, end }, section: 'dashas' });
  });

  it('uses an explicitly requested period for this turn without changing the selected pin', async () => {
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const onTravel = vi.fn();
    const built = toolset({ chart: TIMING_CHART, pinned: pin, periodSkyAllowed: false, onTravel });
    const dated = await built.prepare('What changed in June 2019?', options());
    expect(dated.asOf).toMatchObject({ basis: 'period', period: { start: '2019-06-01', end: '2019-06-30' } });
    const followup = await built.prepare('What was happening then?', options());
    expect(followup.asOf).toMatchObject({ basis: 'period', period: { start: pin.start, end: pin.end } });
    expect(onTravel).not.toHaveBeenCalled();
    expect(pin).toEqual({ start: '2017-09-01', end: '2017-09-30', granularity: 'month' });
  });

  it.each(['June and September 2017', '2017 to 2019', 'summer 2017', '03/04/2017', '1899', '2053'])(
    'does not silently reuse the pin or invent a period for %s', async (question) => {
      const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
      const prepared = await toolset({ chart: TIMING_CHART, pinned: pin, periodSkyAllowed: true }).prepare(question, options());
      expect(prepared.pinned).toBeUndefined();
      expect(prepared.currentContextUnavailable).toBe(false);
      expect(prepared.timingFacts[0]?.result).toMatchObject({ status: 'needs_clarification', data: { available: false, reason: expect.stringMatching(/period/) } });
      expect(loadMock).not.toHaveBeenCalled();
      expect(ensureMock).not.toHaveBeenCalled();
    });

  it('uses the existing before-birth refusal before any period engine call', async () => {
    const prepared = await toolset({ chart: TIMING_CHART, periodSkyAllowed: true }).prepare('1980', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '1980-01-01', end: '1980-12-31' } });
    expect(prepared.timingFacts).toHaveLength(2);
    expect(prepared.timingFacts[0]?.result).toMatchObject({ error: expect.stringContaining('before') });
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('does not relabel an unrelated current predictive block as historical facts', async () => {
    const prepared = await toolset({ chart: TIMING_CHART, promptChart: TODAY_CHART, periodSkyAllowed: false })
      .prepare('September 2017', options());
    expect(prepared.chart.transit_context).toBeUndefined();
    expect(prepared.chart.strength_context).toBeUndefined();
    expect(prepared.chart.varga_context_full).toBeUndefined();
    expect(prepared.chart.domains_context).toBeUndefined();
    expect(prepared.chart.dashas).toEqual(TIMING_CHART.dashas);
    expect(TODAY_CHART.transit_context).toBeDefined();
  });

  it.each([
    'Compare June 2019 with today',
    'June 2019 and today',
    'Compare octubre de 2026 con hoy',
    'Compare outubro de 2026 com hoje',
    'Compare September 11, 2017 with today',
    'Compare 03/04/2017 with today',
    'Compare summer 2017 with today',
    'September 11, 2017 versus today',
    'Compara 11 septiembre de 2017 con hoy',
    'Compare verão de 2017 com hoje',
  ])('does not choose one period from a current-day comparison: %s', async (question) => {
    const prepared = await toolset({ pinned: { start: '2017-09-01', end: '2017-09-30', granularity: 'month' }, periodSkyAllowed: true })
      .prepare(question, { ...options(), now: new Date('2026-10-11T17:00:00Z') });
    expect(prepared.timingFacts[0]?.result).toMatchObject({ status: 'needs_clarification', data: { reason: 'ambiguous_period' } });
    expect(prepared.pinned).toBeUndefined();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('does not pre-run today for a dated question', async () => {
    const prepared = await toolset().prepare('transits in June 2019', options());
    expect(ensureMock).not.toHaveBeenCalled();
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '2019-06-01', end: '2019-06-30' } });
    expect(prepared.chart).toBe(CHART);
  });

  it('labels the prompt "today" and hands over today\'s chart after a today pre-run', async () => {
    const onStatus = vi.fn();
    const prepared = await toolset().prepare('What matters today?', { ...options(), onStatus });
    expect(prepared.asOf.basis).toBe('today');
    expect(prepared.chart).toBe(TODAY_CHART);
    expect(prepared.currentContextUnavailable).toBe(false);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('marks the context unavailable when the today pre-run fails', async () => {
    ensureMock.mockRejectedValue(new Error('engine down'));
    const prepared = await toolset().prepare('What matters today?', options());
    expect(prepared.currentContextUnavailable).toBe(true);
    expect(prepared.asOf.basis).toBe('chart');
  });

  it('marks the context unavailable when there is no engine at all', async () => {
    const prepared = await toolset({ engine: null }).prepare('What matters today?', options());
    expect(prepared.currentContextUnavailable).toBe(true);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('rethrows when the question was aborted mid pre-run', async () => {
    const controller = new AbortController();
    ensureMock.mockImplementation(async () => {
      controller.abort(new Error('stopped'));
      throw new Error('aborted');
    });
    await expect(
      toolset().prepare('What matters today?', { now: SPLIT_DAY_NOW, signal: controller.signal }),
    ).rejects.toThrow('aborted');
  });

  it('refuses a today question loudly when the timing tool is missing', async () => {
    vi.mocked(createChatAgentTools).mockReturnValueOnce([]);
    await expect(toolset().prepare('What matters today?', options())).rejects.toThrow('The timing tool is unavailable.');
  });

  it('shows a readable status when the timing tool carries no label of its own', async () => {
    const execute = vi.fn(async () => ({}));
    vi.mocked(createChatAgentTools).mockReturnValueOnce([{ name: 'get_timing', execute } as never]);
    const onStatus = vi.fn();
    await toolset().prepare('What matters today?', { ...options(), onStatus });
    expect(onStatus).toHaveBeenCalledWith("Working out today's sky");
    expect(execute).toHaveBeenCalledWith({ section: 'transits' }, expect.objectContaining({ now: SPLIT_DAY_NOW }));
  });

  it('waits for a booting engine before the today load', async () => {
    const engine = { engine: null, startBootstrap: vi.fn(), whenReady: vi.fn(async () => ({})) };
    await toolset({ engine: engine as unknown as ChartEngineContextValue }).prepare('What matters today?', options());
    expect(engine.startBootstrap).toHaveBeenCalledTimes(1);
    expect(engine.whenReady).toHaveBeenCalledTimes(1);
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });
});

describe('buildChatToolset: charts', () => {
  const PROMPT = { ...CHART, transit_context: { stored: true } } as unknown as SiderealChart;

  it('the prompt and natal facts read promptChart; engine loads merge onto the base chart', async () => {
    const built = toolset({ promptChart: PROMPT });
    expect((await built.prepare('Where is my Mars?', options())).chart).toBe(PROMPT);
    await built.prepare('What matters today?', options());
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ chart: CHART }));
  });
});

describe('buildChatToolset: period sky', () => {
  // devicePolicy reads navigator.deviceMemory: 8 GB is the full tier, 4 GB lite.
  const setDeviceMemory = (gib: number) => Object.defineProperty(navigator, 'deviceMemory', { value: gib, configurable: true });
  beforeEach(() => setDeviceMemory(8));
  afterEach(() => Reflect.deleteProperty(navigator, 'deviceMemory'));

  it('a lite device (4 GB) computes dated transits through the bounded period cache', async () => {
    setDeviceMemory(4);
    await timingOf(toolset()).execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' }, options(),
    );
    expect(loadMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceInstant: '2019-06-01T00:00:00Z' }),
      expect.anything(), expect.any(AbortSignal),
    );
  });

  it('loads a period through the period-sky cache at the period start', async () => {
    await timingOf(toolset()).execute({ section: 'strength', start: '2019-06-01', end: '2019-06-30' }, options());
    expect(loadMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceInstant: '2019-06-01T00:00:00Z', profileKey: 'p1', utcOffsetMinutes: 330 }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('passes both the local and the UTC birth year to the timing tool (31 Dec PST birth)', () => {
    const edge = {
      ...BIRTH,
      birth_datetime_utc: '1991-01-01T04:00:00Z',
      birth_datetime_local: '1990-12-31T20:00:00',
    } as unknown as ProcessedBirthData;
    toolset({ birth: edge });
    expect(vi.mocked(createChatAgentTools)).toHaveBeenLastCalledWith(
      expect.objectContaining({ birthYear: 1990, birthUtcYear: 1991 }),
    );
  });

  // REVERSED CONTRACT (PR #298): the day before the local birth day used to be refused.
  // A day-precision refusal bisects the birth date, so only periods before the birth YEAR are.
  it('refuses only periods before the local birth year, not before the birth day', async () => {
    const dayBefore = await timingOf(toolset()).execute({ section: 'dashas', start: '1990-01-14' }, options());
    expect(dayBefore).not.toHaveProperty('error');
    const yearBefore = await timingOf(toolset()).execute({ section: 'dashas', start: '1989-12-31' }, options());
    expect(yearBefore).toHaveProperty('error');
  });
});

describe('buildChatToolset: places', () => {
  const MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
  const LIMA = { summary: { place_ref: 'city:5', label: 'Lima, Peru', timezone: 'America/Lima' }, latitude: -12.04, longitude: -77.03 };

  it('registers resolve_place only where the device computes the sky', () => {
    const names = (allowed: boolean) => toolset({ periodSkyAllowed: allowed }).tools.map((t) => t.name);
    expect(names(true)).toEqual(['get_current_datetime', 'get_chart_facts', 'get_timing', 'resolve_place']);
    expect(names(false)).toEqual(['get_current_datetime', 'get_chart_facts', 'get_timing']);
  });

  it('follows devicePolicy when no seam is passed: full and lite tiers get resolve_place', () => {
    const names = (gib: number) => {
      Object.defineProperty(navigator, 'deviceMemory', { value: gib, configurable: true });
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
      try {
        return toolset().tools.map((t) => t.name);
      } finally {
        Reflect.deleteProperty(navigator, 'deviceMemory');
        Reflect.deleteProperty(navigator, 'hardwareConcurrency');
      }
    };
    expect(names(8)).toContain('resolve_place');
    expect(names(4)).toContain('resolve_place');
  });

  it('the explicit disabled-compute seam gets no place reader or Moon loader', () => {
    toolset({ periodSkyAllowed: false });
    const lite = vi.mocked(createChatAgentTools).mock.lastCall?.[0];
    expect(lite).toMatchObject({ periodSkyAllowed: false });
    expect(lite?.placeFromRef).toBeUndefined();
    expect(lite?.loadMoonWindow).toBeUndefined();
    toolset({ periodSkyAllowed: true });
    const full = vi.mocked(createChatAgentTools).mock.lastCall?.[0];
    expect(full?.placeFromRef).toBeTypeOf('function');
    expect(full?.loadMoonWindow).toBeTypeOf('function');
  });

  it('the explicit disabled-compute seam never looks up a segmented place', async () => {
    const placeFromRef = vi.fn(async () => LIMA);
    const segments = [{ start: '2026-06-01', end: '2026-06-15', place_ref: 'city:5' }, { start: '2026-06-16', end: '2026-06-30', place_ref: 'city:5' }];
    const result = await timingOf(toolset({ periodSkyAllowed: false, placeFromRef })).execute({ section: 'dashas', segments }, options());
    expect(result).toMatchObject({ shown: 'dashas' });
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('the explicit disabled-compute seam answers a day with dashas only', async () => {
    const result = await timingOf(toolset({ periodSkyAllowed: false })).execute({ section: 'transits', start: '2026-06-15' }, options());
    expect(result).toMatchObject({ shown: 'dashas' });
  });

  it('a day with no place asks, and never falls back to the viewer or birth zone', async () => {
    const computeMoonWindow = vi.fn();
    const set = toolset({ engine: engineContextWith({ computeMoonWindow }), periodSkyAllowed: true });
    expect(await timingOf(set).execute({ section: 'transits', start: '2026-06-15' }, options())).toEqual({ error: 'needs_place' });
    expect(computeMoonWindow).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('the place path reads only the ref it was given, never the birth place', async () => {
    const placeFromRef = vi.fn(async () => undefined);
    const set = toolset({ placeFromRef, periodSkyAllowed: true });
    const result = await timingOf(set).execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:1' }, options());
    expect(placeFromRef.mock.calls).toEqual([['city:1']]);
    expect(result).toEqual({ error: 'unknown place_ref: call resolve_place first' });
  });

  it("a placed day reads the Moon on this device's engine at the place, and echoes no coordinates", async () => {
    const computeMoonWindow = vi.fn(async () => ({ at_place: { at_start: MARK, at_end: MARK }, event: null }));
    const set = toolset({ engine: engineContextWith({ computeMoonWindow }), placeFromRef: vi.fn(async () => LIMA), periodSkyAllowed: true });
    const result = await timingOf(set).execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:5' }, options());
    expect(computeMoonWindow).toHaveBeenCalledWith({ placeStartUtc: '2026-06-15T05:00:00.000Z', placeEndUtc: '2026-06-16T05:00:00.000Z' });
    expect(result).toMatchObject({ places: [{ label: 'Lima, Peru', timezone: 'America/Lima', moon: { at_start: MARK } }] });
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|12\.04|77\.03|Delhi|28\.61|77\.21|Kolkata/);
  });
});

describe('a pinned thread', () => {
  const YEAR_2050 = { start: '2050-01-01', end: '2050-12-31', granularity: 'year' } as const;
  const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
  const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
  const DAY_PIN = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;

  beforeEach(() => {
    loadMock.mockReset();
    ensureMock.mockReset();
    loadMock.mockResolvedValue(CHART);
  });

  it('warms the pinned period before the model runs for contextual questions', async () => {
    const pinned = toolset({ pinned: YEAR_2027, periodSkyAllowed: true });
    await pinned.prepare("what was happening then?", options());
    expect(ensureMock).not.toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loadMock.mock.calls[0])).toContain('2027-01-01');
  });

  it('grounds the exact September 2017 question in selected engine dashas even if the model uses no tool', async () => {
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const prepared = await toolset({ chart: TIMING_CHART, pinned: pin, periodSkyAllowed: false })
      .prepare('this was a challenging time what do you think happened', options());
    const facts = JSON.stringify(prepared.timingFacts);
    expect(facts).toContain('2017-09-01');
    expect(facts).toContain('jupiter');
    expect(facts).toContain('saturn');
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('bounds grounding including wrappers, preserving dashas and an explicit period-labelled sky overflow', async () => {
    const period = { start: '2027-01-01', end: '2027-12-31', basis: 'period', days: 365 };
    vi.mocked(createChatAgentTools).mockReturnValueOnce([{ name: 'get_timing', execute: vi.fn(async (args) => ({
      period, section: args.section, shown: args.section, notes: ['A full year was selected.'],
      data: args.section === 'dashas' ? { maha: [{ lord: 'saturn' }] } : { rows: 'x'.repeat(20_000) },
    })) } as never]);
    const prepared = await toolset({ pinned: YEAR_2027 }).prepare('What matters then?', options());
    expect(JSON.stringify(prepared.timingFacts).length).toBeLessThanOrEqual(16_384);
    expect(prepared.timingFacts[0]?.result).toMatchObject({ data: { maha: [{ lord: 'saturn' }] } });
    expect(prepared.timingFacts[1]?.result).toMatchObject({ period,
      notes: expect.arrayContaining(['A full year was selected.', expect.stringContaining('too large')]),
      data: { available: false, reason: 'result_too_large' },
    });
  });

  it('keeps selected dasha facts when the period engine reports unavailable sky', async () => {
    loadMock.mockRejectedValue(new Error('engine down'));
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const prepared = await toolset({ chart: TIMING_CHART, pinned: pin, periodSkyAllowed: true }).prepare('What happened?', options());
    expect(prepared.timingFacts[0]?.result).toMatchObject({ data: { maha: [{ lord: 'jupiter' }], antar: [{ lord: 'saturn' }] } });
    expect(prepared.timingFacts[1]?.result).toMatchObject({ period: { start: pin.start, end: pin.end }, data: { available: false, reason: 'engine_unavailable' } });
  });

  it('outlook today reads real current context even in a persisted September pin', async () => {
    ensureMock.mockResolvedValue(TODAY_CHART);
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const set = toolset({ pinned: pin, periodSkyAllowed: true });
    const now = new Date('2026-10-11T17:00:00Z');
    const prepared = await set.prepare('outlook today?', { ...options(), now });
    expect(prepared.asOf.basis).toBe('today');
    expect(prepared.pinned).toBeUndefined();
    expect(prepared.currentContextUnavailable).toBe(false);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(loadMock).not.toHaveBeenCalled();
    const read = await timingOf(set).execute({ section: 'dashas' }, { ...options(), now });
    expect(read).toMatchObject({ period: { start: '2026-10-11', end: '2026-10-11', basis: 'today' } });
  });

  it.each([
    'What are my transits today, October 11?',
    'Mis tránsitos hoy, 11 octubre',
    'Meus trânsitos hoje, 11 outubro',
  ])('an explicit today question with a calendar label ignores the historical pin for this turn: %s', async (question) => {
    ensureMock.mockResolvedValue(TODAY_CHART);
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const built = toolset({ pinned: pin, periodSkyAllowed: true });
    const prepared = await built.prepare(question, { ...options(), now: new Date('2026-10-11T17:00:00Z') });
    expect(prepared.asOf.basis).toBe('today');
    expect(prepared.pinned).toBeUndefined();
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('labels the prompt with the period and hands back the pin with its tense (viewer day)', async () => {
    const prepared = await toolset({ pinned: YEAR_2050, periodSkyAllowed: true }).prepare('Will work get easier?', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '2050-01-01', end: '2050-12-31' } });
    expect(prepared.pinned).toEqual({ start: '2050-01-01', end: '2050-12-31', relative: 'future' });
    expect(prepared.currentContextUnavailable).toBe(false);
  });

  it('shows the page\'s localized status only when the engine will run', async () => {
    const full = vi.fn();
    await toolset({ pinned: YEAR_2027, periodSkyAllowed: true }).prepare('q', {
      ...options(), onStatus: full, pinnedStatus: 'Working out the sky for 2027… (about 30 s)',
    });
    expect(full).toHaveBeenCalledWith('Working out the sky for 2027… (about 30 s)');
    const lite = vi.fn();
    await toolset({ pinned: YEAR_2027, periodSkyAllowed: false }).prepare('q', {
      ...options(), onStatus: lite, pinnedStatus: 'Working out the sky for 2027… (about 30 s)',
    });
    expect(lite).toHaveBeenCalledWith('Reading dasha periods');
  });

  it('the explicit disabled-compute seam answers a Day pin with dashas only', async () => {
    const placeFromRef = vi.fn();
    const pinned = toolset({ pinned: DAY_PIN, periodSkyAllowed: false, placeFromRef });
    await pinned.prepare('q', options());
    const timing = pinned.tools.find((tool) => tool.name === 'get_timing')!;
    const result = (await timing.execute({ section: 'transits' }, options())) as { shown: string };
    expect(result.shown).toBe('dashas');
    expect(loadMock).not.toHaveBeenCalled();
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('a full device reads a Day pin at its place and sends no coordinate anywhere', async () => {
    // The Moon read fails fast here, so the 8 s Moon deadline never runs in a unit test.
    const engine = engineContextWith({ computeMoonWindow: vi.fn(async () => Promise.reject(new Error('no moon in tests'))) });
    const pinned = toolset({ pinned: DAY_PIN, periodSkyAllowed: true, placeFromRef: vi.fn(async () => undefined), engine });
    const timing = pinned.tools.find((tool) => tool.name === 'get_timing')!;
    const datetime = pinned.tools.find((tool) => tool.name === 'get_current_datetime')!;
    const results = [
      await timing.execute({ section: 'transits' }, options()),
      await datetime.execute({ scope: 'utc' }, options()),
      await pinned.prepare('q', options()),
    ];
    const text = JSON.stringify(results);
    expect(text).toContain('Bogotá, Colombia');
    expect(text).not.toMatch(/4\.711|74\.07|"latitude"|"longitude"/);
  });

  it('the real pinned place reader gives get_timing the label and zone, and no coordinate in its result', async () => {
    const engine = engineContextWith({ computeMoonWindow: vi.fn(async () => Promise.reject(new Error('no moon in tests'))) });
    const pinned = toolset({ pinned: DAY_PIN, periodSkyAllowed: true, placeFromRef: vi.fn(async () => undefined), engine });
    const result = (await timingOf(pinned).execute({ section: 'transits' }, options())) as { places?: unknown };
    expect(result.places).toEqual([{ start: '2026-06-15', end: '2026-06-15', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }]);
    expect(JSON.stringify(result)).not.toMatch(/4\.711|74\.07|latitude|longitude/i);
  });

  it('tells the pin\'s tense in the viewer zone, not the birth zone', async () => {
    // SPLIT_DAY_NOW is 2026-03-08 in Los Angeles (viewer) and already 03-09 in Kolkata (birth).
    const today = { start: '2026-03-08', end: '2026-03-08', granularity: 'day' } as const;
    const prepared = await toolset({ pinned: today, periodSkyAllowed: true }).prepare('q', options());
    expect(prepared.pinned).toEqual({ start: '2026-03-08', end: '2026-03-08', relative: 'contains_today' });
  });

  it('hands a lite device no place reader at all, whatever the pin', async () => {
    const spy = vi.mocked(createChatAgentTools);
    spy.mockClear();
    toolset({ pinned: DAY_PIN, periodSkyAllowed: false });
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('placeFromRef');
    spy.mockClear();
    toolset({ pinned: DAY_PIN, periodSkyAllowed: true });
    expect(spy.mock.calls[0]?.[0]).toHaveProperty('placeFromRef');
  });

  it('stops the pinned warm when the user aborts it', async () => {
    const controller = new AbortController();
    loadMock.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted mid-warm');
    });
    const pinned = toolset({ pinned: YEAR_2027, periodSkyAllowed: true });
    await expect(pinned.prepare('q', { now: SPLIT_DAY_NOW, signal: controller.signal })).rejects.toThrow();
  });

  it('leaves a failed (not aborted) warm to the model: prepare still resolves with the pin', async () => {
    loadMock.mockRejectedValue(new Error('engine down'));
    const prepared = await toolset({ pinned: YEAR_2050, periodSkyAllowed: true }).prepare('q', options());
    expect(prepared.pinned).toMatchObject({ start: '2050-01-01', relative: 'future' });
    expect(prepared.currentContextUnavailable).toBe(false);
  });

  it('refuses to prepare a pinned thread that has no timing tool', async () => {
    vi.mocked(createChatAgentTools).mockReturnValueOnce([]);
    await expect(toolset({ pinned: YEAR_2027, periodSkyAllowed: true }).prepare('q', options())).rejects.toThrow('timing tool is unavailable');
  });

  it('an unpinned thread keeps the step A router (today pre-run for a today question)', async () => {
    ensureMock.mockResolvedValue(TODAY_CHART);
    const prepared = await toolset({ periodSkyAllowed: true }).prepare("what's happening today?", options());
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(prepared.pinned).toBeUndefined();
  });
});
