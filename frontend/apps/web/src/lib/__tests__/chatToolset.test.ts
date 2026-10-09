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

const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [] } as unknown as SiderealChart;
const TODAY_CHART = { ...CHART, ayanamsa_value: 23.71 } as unknown as SiderealChart;
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
  it('does not pre-run today for a dated question', async () => {
    const prepared = await toolset().prepare('transits in June 2019', options());
    expect(ensureMock).not.toHaveBeenCalled();
    expect(prepared.asOf.basis).toBe('chart');
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

  it('a lite device (4 GB) answers a dated question with dashas only and never computes the sky', async () => {
    setDeviceMemory(4);
    const result = await timingOf(toolset()).execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      options(),
    );
    expect(loadMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      shown: 'dashas',
      notes: expect.arrayContaining(['This device answers dated questions with dashas only, to stay within memory.']),
    });
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

  it('follows devicePolicy when no seam is passed: full tier gets resolve_place, lite does not', () => {
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
    expect(names(4)).not.toContain('resolve_place');
  });

  it('a lite device gets no place reader and no Moon loader at all', () => {
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

  it('a lite device never looks a place up, even for dashas over a month with segments', async () => {
    const placeFromRef = vi.fn(async () => LIMA);
    const segments = [{ start: '2026-06-01', end: '2026-06-15', place_ref: 'city:5' }, { start: '2026-06-16', end: '2026-06-30', place_ref: 'city:5' }];
    const result = await timingOf(toolset({ periodSkyAllowed: false, placeFromRef })).execute({ section: 'dashas', segments }, options());
    expect(result).toMatchObject({ shown: 'dashas' });
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('a lite device never asks where: a day of transits is dashas only', async () => {
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
  const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
  const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
  const DAY_PIN = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;

  beforeEach(() => {
    loadMock.mockReset();
    ensureMock.mockReset();
    loadMock.mockResolvedValue(CHART);
  });

  it('warms the pinned period before the model runs, and never today, whatever the question', async () => {
    const pinned = toolset({ pinned: YEAR_2027, periodSkyAllowed: true });
    await pinned.prepare("what's happening today?", options());
    expect(ensureMock).not.toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loadMock.mock.calls[0])).toContain('2027-01-01');
  });

  it('labels the prompt with the period and hands back the pin with its tense (viewer day)', async () => {
    const prepared = await toolset({ pinned: YEAR_2027, periodSkyAllowed: true }).prepare('Will work get easier?', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '2027-01-01', end: '2027-12-31' } });
    expect(prepared.pinned).toEqual({ start: '2027-01-01', end: '2027-12-31', relative: 'future' });
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

  it('a lite device answers a Day pin with dashas only and reads no place', async () => {
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

  it('an unpinned thread keeps the step A router (today pre-run for a today question)', async () => {
    ensureMock.mockResolvedValue(TODAY_CHART);
    const prepared = await toolset({ periodSkyAllowed: true }).prepare("what's happening today?", options());
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(prepared.pinned).toBeUndefined();
  });
});
