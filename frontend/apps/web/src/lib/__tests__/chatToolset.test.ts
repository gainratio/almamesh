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

  it('refuses periods before the local birth day', async () => {
    const result = await timingOf(toolset()).execute({ section: 'dashas', start: '1990-01-14' }, options());
    expect(result).toHaveProperty('error');
  });
});
