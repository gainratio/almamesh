import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { SPLIT_DAY_NOW } from '../../test/viewerToday';

const ensureMock = vi.hoisted(() => vi.fn());
vi.mock('../currentPlanetaryContext', () => ({ ensureCurrentPlanetaryContext: ensureMock }));

const loadMock = vi.hoisted(() => vi.fn());
vi.mock('../periodSky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../periodSky')>();
  return { ...actual, periodSkyCache: () => ({ load: loadMock, keys: () => [] }) };
});

import { buildChatToolset, type BuildChatToolsetInput } from '../chatToolset';

const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [] } as unknown as SiderealChart;
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
const MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
const COORDINATE_LIKE = [/28\.6/, /77\.2/, /"latitude"/, /"longitude"/, /"lat"/, /"lon"/, /birth_location/, /location_name/];

beforeEach(() => {
  ensureMock.mockReset().mockResolvedValue(CHART);
  loadMock.mockReset().mockResolvedValue({});
});

describe('a chat-typed city never leaves the device, and the birth place never does', () => {
  it('resolve_place + get_timing (day, place, time) carry no coordinate and no birth field', async () => {
    const computeMoonWindow = vi.fn(async (_input: { event?: { latitude: number } }) => ({ at_place: { at_start: MARK, at_end: MARK }, event: { lagna_sign: 'leo', moon: MARK } }));
    const set = toolset({ engine: engineContextWith({ computeMoonWindow }), periodSkyAllowed: true });
    const resolve = set.tools.find((t) => t.name === 'resolve_place');
    const timing = set.tools.find((t) => t.name === 'get_timing');
    const found = (await resolve?.execute({ query: 'Delhi' }, options())) as { status: string; place: { place_ref: string } };
    expect(found.status).toBe('found');
    const day = await timing?.execute({ section: 'transits', start: '2026-06-15', place_ref: found.place.place_ref, time: '15:00' }, options());
    const asked = await timing?.execute({ section: 'transits', start: '2026-06-16' }, options());
    const wire = [found, day, asked].map((value) => JSON.stringify({ ok: true, value })).join('\n');
    for (const pattern of COORDINATE_LIKE) expect(wire).not.toMatch(pattern);
    expect(asked).toEqual({ error: 'needs_place' });
    expect(computeMoonWindow.mock.calls[0]?.[0]?.event).toMatchObject({ latitude: expect.any(Number) });
  });
});
