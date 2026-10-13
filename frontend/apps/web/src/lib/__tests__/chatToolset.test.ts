import type { SiderealChart } from '@almamesh/browser/types';
import { streamAgentChat, type AgentTool } from '@almamesh/llm';
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

/** Stands in for the period-reading tool (apps/web periodReadingTool.ts, its own agent's work). */
const READING_STUB: AgentTool = {
  name: 'get_period_reading', description: 'Read the period reading.', statusLabel: 'Reading the period',
  parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ ok: true }),
};
const READING_GROUNDING = {
  toolChoice: 'required', groundingTool: 'get_period_reading',
  requiredTools: ['get_period_reading'], groundingCalls: [{ name: 'get_period_reading', args: {} }],
};

function toolset(overrides: Partial<BuildChatToolsetInput> = {}) {
  return buildChatToolset({
    toolOverrides: [READING_STUB],
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

  it("today's get_timing asks the engine for the viewer's day", async () => {
    await timingOf(toolset()).execute({ section: 'transits' }, options());
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
  // Contract reversed 2026-10-13: a named month no longer pre-computes timing facts before the model runs;
  // it is a trip whose first round must call a tool, and the trip-bound get_timing reads that month.
  it('a named month makes the first round require a tool, pre-computes nothing, and its trip-bound get_timing with no dates reads that month', async () => {
    loadMock.mockResolvedValue({ transit_context: SKY_CHART.transit_context });
    const built = toolset({ chart: TIMING_CHART, periodSkyAllowed: true });
    const prepared = await built.prepare('What happened in September 2017?', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '2017-09-01', end: '2017-09-30' } });
    expect(prepared.clarification).toBeUndefined();
    expect(prepared.toolChoice).toBe('required');
    expect(prepared.groundingTool).toBe('get_period_reading');
    expect(loadMock).not.toHaveBeenCalled();
    expect(await timingOf(built).execute({ section: 'dashas' }, options()))
      .toMatchObject({ section: 'dashas', data: { maha: [{ lord: 'jupiter' }], antar: [{ lord: 'saturn' }] } });
    expect(await timingOf(built).execute({ section: 'transits' }, options()))
      .toMatchObject({ section: 'transits', shown: 'transits', period: { start: '2017-09-01', end: '2017-09-30' } });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loadMock.mock.calls[0])).toContain('2017-09-01');
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it.each([
    ['2017-09', '2017-09-01', '2017-09-30'],
    ['2017', '2017-01-01', '2017-12-31'],
    ['septiembre de 2017', '2017-09-01', '2017-09-30'],
    ['setembro de 2017', '2017-09-01', '2017-09-30'],
  // Contract reversed 2026-10-13: a literal period is a trip; nothing is pre-computed, the trip-bound tool reads it.
  ])('a supported literal period %s becomes a trip whose get_timing reads that period', async (question, start, end) => {
    const built = toolset({ chart: TIMING_CHART, periodSkyAllowed: false });
    const prepared = await built.prepare(question, options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start, end } });
    expect(prepared.clarification).toBeUndefined();
    expect(prepared.toolChoice).toBe('required');
    expect(prepared.pinned).toMatchObject({ start, end });
    expect(await timingOf(built).execute({ section: 'dashas' }, options())).toMatchObject({ period: { start, end }, section: 'dashas' });
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
      expect(prepared.toolChoice).toBe('auto');
      expect(prepared.clarification?.reason).toMatch(/_period$/);
      expect(prepared.clarification?.note).toContain('TIMING CLARIFICATION');
      expect(prepared.clarification?.note).toContain('Ask for one explicit month and year, a year, or an ISO date');
      expect(loadMock).not.toHaveBeenCalled();
      expect(ensureMock).not.toHaveBeenCalled();
    });

  // Contract reversed 2026-10-13: the before-birth refusal now comes from the trip's tool call, not a pre-run.
  it('a before-birth trip refuses through its get_timing call before any period engine call', async () => {
    const built = toolset({ chart: TIMING_CHART, periodSkyAllowed: true });
    const prepared = await built.prepare('1980', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '1980-01-01', end: '1980-12-31' } });
    expect(prepared.clarification).toBeUndefined();
    expect(prepared.toolChoice).toBe('required');
    expect(await timingOf(built).execute({ section: 'dashas' }, options())).toMatchObject({ error: expect.stringContaining('before') });
    expect(await timingOf(built).execute({ section: 'transits' }, options())).toMatchObject({ error: expect.stringContaining('before') });
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
    expect(prepared.clarification?.reason).toBe('ambiguous_period');
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

  // Contract reversed 2026-10-13 (period reading): a today question no longer pre-runs get_timing into the
  // prompt. Its first round must call get_period_reading, and prepare runs no engine and shows no status.
  it('a today question requires get_period_reading, pre-computes nothing, and labels the prompt "today"', async () => {
    const onStatus = vi.fn();
    const prepared = await toolset({ promptChart: TODAY_CHART }).prepare('What matters today?', { ...options(), onStatus });
    expect(prepared).toMatchObject(READING_GROUNDING);
    expect(prepared.asOf.basis).toBe('today');
    expect(prepared.chart.transit_context).toBeUndefined(); // stored transits never pose as today's
    expect(prepared.clarification).toBeUndefined();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it.each(['What are my transits today?', 'What is my current timing?', '¿Qué tránsitos tengo hoy?', 'Como estão meus trânsitos hoje?'])(
    'routes the today question %s to the period reading', async (question) => {
      expect(await toolset().prepare(question, options())).toMatchObject(READING_GROUNDING);
    });

  it('a natal question stays auto, with no required tool', async () => {
    const prepared = await toolset().prepare('Where is my natal Mars?', options());
    expect(prepared.toolChoice).toBe('auto');
    expect(prepared.requiredTools).toBeUndefined();
    expect(prepared.groundingCalls).toBeUndefined();
  });

  it('prepares a today question with no engine at all: the reading tool reports what it could not compute', async () => {
    const prepared = await toolset({ engine: null }).prepare('What matters today?', options());
    expect(prepared).toMatchObject(READING_GROUNDING);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('refuses a today question loudly when the period reading tool is missing', async () => {
    await expect(toolset({ toolOverrides: [] }).prepare('What matters today?', options()))
      .rejects.toThrow('The get_period_reading tool is unavailable.');
  });

  it('waits for a booting engine before the today load of get_timing', async () => {
    const engine = { engine: null, startBootstrap: vi.fn(), whenReady: vi.fn(async () => ({})) };
    await timingOf(toolset({ engine: engine as unknown as ChartEngineContextValue })).execute({ section: 'transits' }, options());
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
    await timingOf(built).execute({ section: 'transits' }, options());
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ chart: CHART }));
  });
});

describe('buildChatToolset: explicit-turn engine recovery', () => {
  function failedContext(reboot = vi.fn(async () => engineContext().engine!)) {
    return {
      ...engineContext(), engine: null, error: new Error('Out of bounds memory access'),
      reboot, whenReady: vi.fn(async () => { throw new Error('latched fatal'); }),
    } as unknown as ChartEngineContextValue;
  }

  it('does not reboot on construction or a natal-only question', async () => {
    const context = failedContext();
    const built = toolset({ engine: context });
    expect(context.reboot).not.toHaveBeenCalled();
    await built.prepare('Where is my Mars?', options());
    expect(context.reboot).not.toHaveBeenCalled();
  });

  // Contract reversed 2026-10-13 (period reading): a today question pre-computes nothing, so recovery starts on its first tool call.
  it('a new today question recovers on its first tool call, with the fresh engine', async () => {
    const fresh = engineContext().engine!;
    const context = failedContext(vi.fn(async () => fresh));
    const built = toolset({ engine: context });
    await built.prepare('What matters today?', options());
    expect(context.reboot).not.toHaveBeenCalled();
    await timingOf(built).execute({ section: 'transits' }, options());
    expect(context.reboot).toHaveBeenCalledTimes(1);
    expect(context.whenReady).not.toHaveBeenCalled();
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ runtime: fresh }));
  });

  // Contract reversed 2026-10-13: a historical question pre-computes nothing, so recovery starts on its first tool call.
  it('a new historical question recovers on its first trip tool call, before querying its deterministic sky', async () => {
    const fresh = engineContext().engine!;
    const context = failedContext(vi.fn(async () => fresh));
    loadMock.mockResolvedValue({ transit_context: SKY_CHART.transit_context });
    const built = toolset({ chart: TIMING_CHART, engine: context, periodSkyAllowed: true });
    await built.prepare('September 2017', options());
    expect(context.reboot).not.toHaveBeenCalled();
    const result = await timingOf(built).execute({ section: 'transits' }, options());
    expect(context.reboot).toHaveBeenCalledTimes(1);
    expect(context.whenReady).not.toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceInstant: '2017-09-01T00:00:00Z' }), fresh, expect.any(AbortSignal),
    );
    expect(result).toMatchObject({ shown: 'transits' });
  });

  it('concurrent today and period tools share one recovery for the turn', async () => {
    const fresh = engineContext().engine!;
    let finish!: (engine: NonNullable<ChartEngineContextValue['engine']>) => void;
    const context = failedContext(vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    const built = toolset({ engine: context, periodSkyAllowed: true });
    const today = timingOf(built).execute({ section: 'transits' }, options());
    const historical = timingOf(built).execute({ section: 'strength', start: '2017-09-01', end: '2017-09-30' }, options());
    const completed = Promise.allSettled([today, historical]);
    expect(context.reboot).toHaveBeenCalledTimes(1);
    expect(ensureMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
    finish(fresh);
    expect((await completed).every((result) => result.status === 'fulfilled')).toBe(true);
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ runtime: fresh }));
    expect(loadMock.mock.calls[0]?.[1]).toBe(fresh);
    expect(context.reboot).toHaveBeenCalledTimes(1);
  });

  it('a rejected recovery stays failed for this turn instead of repeatedly booting', async () => {
    const context = failedContext(vi.fn(async () => { throw new Error('fresh boot failed'); }));
    const built = toolset({ engine: context, periodSkyAllowed: true });
    await built.prepare('What matters today?', options());
    // The agent loop turns this refusal into a tool error the model reads; the turn does not reboot again.
    await expect(timingOf(built).execute({ section: 'transits' }, options())).rejects.toThrow('fresh boot failed');
    await timingOf(built).execute({ section: 'transits', start: '2017-09-01', end: '2017-09-30' }, options());
    expect(context.reboot).toHaveBeenCalledTimes(1);
    expect(ensureMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('a placed-day tool uses the same recovered engine for its Moon calculation', async () => {
    const mark = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
    const computeMoonWindow = vi.fn(async () => ({ at_place: { at_start: mark, at_end: mark }, event: null }));
    const fresh = engineContextWith({ computeMoonWindow }).engine!;
    const context = failedContext(vi.fn(async () => fresh));
    const built = toolset({ engine: context, periodSkyAllowed: true, placeFromRef: async () => ({
      summary: { place_ref: 'city:5', label: 'Lima, Peru', timezone: 'America/Lima' }, latitude: -12.04, longitude: -77.03,
    }) });
    const result = await timingOf(built).execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:5' }, options());
    expect(context.reboot).toHaveBeenCalledTimes(1);
    expect(loadMock.mock.calls[0]?.[1]).toBe(fresh);
    expect(computeMoonWindow).toHaveBeenCalledWith({ placeStartUtc: '2026-06-15T05:00:00.000Z', placeEndUtc: '2026-06-16T05:00:00.000Z' });
    expect(result).toMatchObject({ places: [{ moon: { at_start: mark } }] });
  });

  it('a later submitted question can recover after the previous turn failed', async () => {
    const fresh = engineContext().engine!;
    const reboot = vi.fn().mockRejectedValueOnce(new Error('temporary boot failure')).mockResolvedValueOnce(fresh);
    const context = failedContext(reboot);
    await expect(timingOf(toolset({ engine: context })).execute({ section: 'transits' }, options())).rejects.toThrow('temporary boot failure');
    await timingOf(toolset({ engine: context })).execute({ section: 'transits' }, options());
    expect(reboot).toHaveBeenCalledTimes(2);
    expect(ensureMock).toHaveBeenCalledTimes(1);
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
    const names = (allowed: boolean) => toolset({ periodSkyAllowed: allowed, toolOverrides: undefined }).tools.map((t) => t.name);
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

  // Contract reversed 2026-10-13: a trip no longer warms its period before the model runs; its first tool call loads it.
  it('warms nothing before the model runs; the first trip-bound get_timing call loads the pinned period', async () => {
    const pinned = toolset({ pinned: YEAR_2027, periodSkyAllowed: true });
    const prepared = await pinned.prepare("what was happening then?", options());
    expect(prepared.toolChoice).toBe('required');
    expect(loadMock).not.toHaveBeenCalled();
    await timingOf(pinned).execute({ section: 'transits' }, options());
    expect(ensureMock).not.toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loadMock.mock.calls[0])).toContain('2027-01-01');
  });

  // Contract reversed 2026-10-13: the model must ground itself (tool_choice required); the trip tools carry the dashas.
  it('the exact September 2017 question requires a tool first, and its trip tools ground the selected engine dashas', async () => {
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const built = toolset({ chart: TIMING_CHART, pinned: pin, periodSkyAllowed: false });
    const prepared = await built.prepare('this was a challenging time what do you think happened', options());
    expect(prepared.clarification).toBeUndefined();
    expect(prepared.toolChoice).toBe('required');
    expect(prepared.groundingTool).toBe('get_period_reading');
    const trip = await built.tools.find((tool) => tool.name === 'get_trip_context')!.execute({}, options());
    expect(trip).toMatchObject({ period: { start: '2017-09-01' }, dashas: { maha: [{ lord: 'jupiter' }], antar: [{ lord: 'saturn' }] } });
    const facts = JSON.stringify(await timingOf(built).execute({ section: 'dashas' }, options()));
    expect(facts).toContain('2017-09-01');
    expect(facts).toContain('jupiter');
    expect(facts).toContain('saturn');
    expect(loadMock).not.toHaveBeenCalled();
  });

  // Contract reversed 2026-10-13: nothing is pre-computed, so the bound now holds per tool result in the agent
  // loop: the dashas call survives and the oversized sky call gets its own result_too_large stub.
  it('bounds each trip tool result in the agent loop, preserving dashas and stubbing an oversized sky call', async () => {
    const period = { start: '2027-01-01', end: '2027-12-31', basis: 'period', days: 365 };
    vi.mocked(createChatAgentTools).mockReturnValueOnce([{
      name: 'get_timing', description: 'timing', parameters: { type: 'object', properties: { section: { type: 'string' } } },
      execute: vi.fn(async (args: { section: string }) => ({
        period, section: args.section, shown: args.section, notes: ['A full year was selected.'],
        data: args.section === 'dashas' ? { maha: [{ lord: 'saturn' }] } : { rows: 'x'.repeat(20_000) },
      })),
    } as never]);
    const built = toolset({ pinned: YEAR_2027 });
    const prepared = await built.prepare('What matters then?', options());
    expect(prepared.clarification).toBeUndefined();
    const requests: Array<{ tool_choice?: unknown; messages: Array<{ role: string; name?: string; content: string }> }> = [];
    const call = (id: string, section: string) => ({ id, type: 'function', function: { name: 'get_timing', arguments: JSON.stringify({ section }) } });
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) {
        return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call('d', 'dashas'), call('t', 'transits')] } }] });
      }
      // A failed (stubbed) call forces a final streamed answer.
      return new Response('data: {"choices":[{"delta":{"content":"Bounded."}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    let answer = '';
    for await (const token of streamAgentChat({
      config: { engine: 'openai-http', model: 'fixture', baseUrl: 'http://localhost:11434/v1', privacyMode: 'local_only' },
      messages: [{ role: 'user', content: 'What matters then?' }], tools: built.tools, now: SPLIT_DAY_NOW,
      firstRoundToolChoice: prepared.toolChoice, fetchImpl: fetchImpl as typeof fetch,
    })) answer += token;
    expect(answer).toBe('Bounded.');
    expect(requests[0]?.tool_choice).toBe('required');
    const results = requests[1]!.messages.filter((message) => message.role === 'tool');
    expect(results.map((message) => message.content).join('').length).toBeLessThanOrEqual(16_384);
    expect(JSON.parse(results[0]!.content)).toMatchObject({ ok: true, value: { period, data: { maha: [{ lord: 'saturn' }] } } });
    expect(JSON.parse(results[1]!.content)).toMatchObject({ ok: false, error: { code: 'result_too_large' } });
  });

  // Contract reversed 2026-10-13: the dasha and sky facts now come from the trip's tool calls, not a pre-run.
  it('the trip tools keep selected dasha facts when the period engine reports unavailable sky', async () => {
    loadMock.mockRejectedValue(new Error('engine down'));
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const built = toolset({ chart: TIMING_CHART, pinned: pin, periodSkyAllowed: true });
    expect((await built.prepare('What happened?', options())).clarification).toBeUndefined();
    expect(await timingOf(built).execute({ section: 'dashas' }, options()))
      .toMatchObject({ data: { maha: [{ lord: 'jupiter' }], antar: [{ lord: 'saturn' }] } });
    expect(await timingOf(built).execute({ section: 'transits' }, options()))
      .toMatchObject({ period: { start: pin.start, end: pin.end }, data: { available: false, reason: 'engine_unavailable' } });
  });

  it('outlook today reads real current context even in a persisted September pin', async () => {
    ensureMock.mockResolvedValue(TODAY_CHART);
    const pin = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
    const set = toolset({ pinned: pin, periodSkyAllowed: true });
    const now = new Date('2026-10-11T17:00:00Z');
    const prepared = await set.prepare('outlook today?', { ...options(), now });
    expect(prepared.asOf.basis).toBe('today');
    expect(prepared.pinned).toBeUndefined();
    expect(prepared).toMatchObject(READING_GROUNDING);
    expect(ensureMock).not.toHaveBeenCalled();
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
    expect(prepared).toMatchObject(READING_GROUNDING);
    expect(built.tools.map((tool) => tool.name)).not.toContain('get_trip_context');
    expect(loadMock).not.toHaveBeenCalled();
  });

  // Contract reversed 2026-10-13: the pin now also carries granularity, label and place; an old pin with no
  // place reads the birth place's sky under a generic label (source 'default').
  it('labels the prompt with the period and hands back the pin with its tense (viewer day), granularity, label and place', async () => {
    const prepared = await toolset({ pinned: YEAR_2050, periodSkyAllowed: true }).prepare('Will work get easier?', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '2050-01-01', end: '2050-12-31' } });
    expect(prepared.pinned).toEqual({
      start: '2050-01-01', end: '2050-12-31', relative: 'future', granularity: 'year', label: '2050',
      place: { label: 'Delhi', timezone: 'Asia/Kolkata' }, // an old trip reads the birth place, unmarked
    });
    expect(JSON.stringify(prepared.pinned)).not.toMatch(/birth.?place|28\.61|77\.21/i); // label + zone yes; coordinates or a marker no
  });

  // Contract reversed 2026-10-13: pinnedStatus was removed; no engine runs in a trip's prepare, so it shows no
  // status on any tier, and each trip tool carries its own status label for the agent loop.
  it('a trip prepare shows no status on a full or lite device; its tools carry their own labels', async () => {
    for (const periodSkyAllowed of [true, false]) {
      const onStatus = vi.fn();
      const built = toolset({ pinned: YEAR_2027, periodSkyAllowed });
      await built.prepare('q', { ...options(), onStatus });
      expect(onStatus).not.toHaveBeenCalled();
      expect(built.tools.find((tool) => tool.name === 'get_trip_context')?.statusLabel).toBe('Reading this trip');
    }
    expect(loadMock).not.toHaveBeenCalled();
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
    const pinned = toolset({ chart: TIMING_CHART, pinned: DAY_PIN, periodSkyAllowed: true, placeFromRef: vi.fn(async () => undefined), engine });
    const timing = pinned.tools.find((tool) => tool.name === 'get_timing')!;
    // Contract reversed 2026-10-13: a trip does not register get_current_datetime; its own context tools run instead.
    expect(pinned.tools.map((tool) => tool.name)).not.toContain('get_current_datetime');
    const trip = pinned.tools.find((tool) => tool.name === 'get_trip_context')!;
    const natal = pinned.tools.find((tool) => tool.name === 'get_natal_summary')!;
    const results = [
      await timing.execute({ section: 'transits' }, options()),
      await trip.execute({}, options()),
      await natal.execute({}, options()),
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
    const built = toolset({ chart: TIMING_CHART, pinned: today, periodSkyAllowed: true });
    const prepared = await built.prepare('q', options());
    // Contract reversed 2026-10-13: the pin also carries granularity, label and the (default) place.
    expect(prepared.pinned).toEqual({
      start: '2026-03-08', end: '2026-03-08', relative: 'contains_today', granularity: 'day', label: 'March 8, 2026',
      place: { label: 'Delhi', timezone: 'Asia/Kolkata' }, // an old trip reads the birth place, unmarked
    });
    const trip = await built.tools.find((tool) => tool.name === 'get_trip_context')!.execute({}, options());
    expect(trip).toMatchObject({ period: { tense: 'present' }, today: '2026-03-08' });
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

  // Contract reversed 2026-10-13: there is no pinned warm; an abort now stops the trip's get_timing call.
  it('stops the trip-bound get_timing call when the user aborts it', async () => {
    const controller = new AbortController();
    loadMock.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted mid-load');
    });
    const pinned = toolset({ pinned: YEAR_2027, periodSkyAllowed: true });
    await pinned.prepare('q', { now: SPLIT_DAY_NOW, signal: controller.signal });
    expect(loadMock).not.toHaveBeenCalled();
    await expect(timingOf(pinned).execute({ section: 'transits' }, { now: SPLIT_DAY_NOW, signal: controller.signal }))
      .rejects.toThrow();
  });

  it('leaves a failed (not aborted) warm to the model: prepare still resolves with the pin', async () => {
    loadMock.mockRejectedValue(new Error('engine down'));
    const prepared = await toolset({ pinned: YEAR_2050, periodSkyAllowed: true }).prepare('q', options());
    expect(prepared.pinned).toMatchObject({ start: '2050-01-01', relative: 'future' });
  });

  // Contract reversed 2026-10-13 (period reading): a trip grounds through get_period_reading and its own
  // get_natal_summary; get_timing is not required, so a missing timing tool does not stop it.
  it('prepares a pinned thread without the timing tool, grounding through the period reading and natal summary', async () => {
    vi.mocked(createChatAgentTools).mockReturnValueOnce([]);
    const built = toolset({ pinned: YEAR_2027, periodSkyAllowed: true });
    const prepared = await built.prepare('q', options());
    expect(prepared.groundingTool).toBe('get_period_reading');
    expect(prepared.requiredTools).toEqual(['get_period_reading', 'get_natal_summary']);
    expect(built.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['get_natal_summary', 'get_trip_context']));
  });

  it('refuses a trip loudly when the period reading tool is missing', async () => {
    await expect(toolset({ pinned: YEAR_2027, toolOverrides: [] }).prepare('q', options()))
      .rejects.toThrow('The get_period_reading tool is unavailable.');
  });

  it('an unpinned thread routes a today question to the period reading', async () => {
    const prepared = await toolset({ periodSkyAllowed: true }).prepare("what's happening today?", options());
    expect(prepared).toMatchObject(READING_GROUNDING);
    expect(ensureMock).not.toHaveBeenCalled();
    expect(prepared.pinned).toBeUndefined();
  });
});
