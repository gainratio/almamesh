/**
 * A city typed in chat is looked up on this device (the bundled list), and its
 * coordinates go to the engine only: every request body of a real chat turn
 * carries the place's label and zone, never a coordinate or a birth field.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import { hydrateLlmSettings, type ProviderConfig } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { runChatTurn, type ChatToolCall } from '../chatTurn';
import { installCityTestDatabase } from '../geo/__tests__/cityTestDb';
import { readPeriodArgs, stubCallFor, stubEndpoint } from '../../test/stubAnswer';
import { periodReadingFixture } from './periodReadingFixtures';
import { CHART } from './timingFixtures';

installCityTestDatabase();

const BIRTH = {
  birth_datetime_utc: '1990-01-15T06:30:00Z',
  birth_datetime_local: '1990-01-15T12:00:00',
  birth_location_details: { city: 'Delhi', latitude: 28.61, longitude: 77.21, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const DAY_CHART = { ...CHART, period_reading: periodReadingFixture('delhi-2019-09-15-day') } as unknown as SiderealChart;
const LOCAL: ProviderConfig = { engine: 'openai-http', model: 'm', privacyMode: 'local_only', baseUrl: 'http://localhost:11434/v1' };
const MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
const COORDINATE_LIKE = [/28\.6/, /77\.2/, /"latitude"/, /"longitude"/, /"lat"/, /"lon"/, /birth_location/, /location_name/];

function engineWith(computeMoonWindow: unknown): ChartEngineContextValue {
  const engine = { computePredictive: vi.fn(), computeMoonWindow };
  return { engine, startBootstrap: vi.fn(), whenReady: vi.fn(async () => engine) } as unknown as ChartEngineContextValue;
}

describe('a chat-typed city never leaves the device, and the birth place never does', () => {
  // A roomy window, so the context budget (8k for an unknown local model) does not close the turn before all three calls.
  beforeEach(() => hydrateLlmSettings(JSON.stringify({ chatContextTokens: 1_000_000 })));
  afterEach(() => hydrateLlmSettings(null));

  it('read_period (day, city, time), read_period (day, no place) and travel (city): no coordinate and no birth field in any request', async () => {
    const computeMoonWindow = vi.fn(async (_input: { event?: { latitude: number } }) => ({ at_place: { at_start: MARK, at_end: MARK }, event: { lagna_sign: 'leo', moon: MARK } }));
    const rows: ChatToolCall[] = [];
    const { fetchImpl, bodies } = stubEndpoint([
      { name: 'read_period', args: readPeriodArgs('2019-09-15', { place: 'Delhi', time: '15:00' }) },
      { name: 'read_period', args: readPeriodArgs('2019-09-16') },
      { name: 'travel', args: { to: '2019-09-15', place: 'Delhi' } },
      (body) => stubCallFor(body, {}),
    ]);
    const turn = runChatTurn({
      config: LOCAL, chart: CHART, chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }, profileKey: 'p1', birth: BIRTH,
      engine: engineWith(computeMoonWindow), question: 'Take me to 15 September 2019 in Delhi: how was 3 pm there?', mode: 'layman', language: 'en',
      history: [], retrievedContext: [], signal: new AbortController().signal, now: new Date('2026-03-08T20:00:00.000Z'),
      labels: { deciding: 'd', answering: 'a', complete: 'c' }, onTravel: vi.fn(), onToolCall: (row) => rows.push(row),
      seams: { fetchImpl, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true, loadPeriodChart: async () => DAY_CHART },
    });
    for await (const _snapshot of turn) {
      // drain
    }
    expect(rows.map((row) => [row.toolName, row.status])).toEqual([['read_period', 'complete'], ['read_period', 'complete'], ['travel', 'complete']]);
    expect(rows[0]?.result).toMatchObject({ place: { label: expect.stringContaining('Delhi'), timezone: 'Asia/Kolkata' } });
    expect(rows[1]?.result).toMatchObject({ status: 'needs_place' });
    expect(rows[2]?.result).toMatchObject({ status: 'queued', place_label: expect.stringContaining('Delhi') });
    for (const body of bodies) {
      for (const pattern of COORDINATE_LIKE) expect(JSON.stringify(body)).not.toMatch(pattern);
    }
    // The coordinates went to the engine, on the device.
    expect(computeMoonWindow.mock.calls[0]?.[0]?.event).toMatchObject({ latitude: expect.any(Number) });
  });
});

// Task 11 (2026-10-14): Settings' "Where do you live now?" is a today thread's place.
describe('where the user lives now never leaves the device by its coordinates', () => {
  const NOVATO = { label: 'Novato, California, United States', timezone: 'America/Los_Angeles', latitude: 38.1074, longitude: -122.5697 };
  const NOVATO_COORDINATES = [/38\.10/, /122\.56/, /"latitude"/, /"longitude"/];
  beforeEach(() => hydrateLlmSettings(JSON.stringify({ chatContextTokens: 1_000_000 })));
  afterEach(() => hydrateLlmSettings(null));

  it('a today thread reads a day at home (null place and "home"): label and zone to the model, coordinates to the engine only', async () => {
    const computeMoonWindow = vi.fn(async (_input: { placeStartUtc: string; event?: { latitude: number; longitude: number } }) => ({ at_place: { at_start: MARK, at_end: MARK }, event: { lagna_sign: 'leo', moon: MARK } }));
    const rows: ChatToolCall[] = [];
    const { fetchImpl, bodies } = stubEndpoint([
      { name: 'read_period', args: readPeriodArgs('2019-09-15') },
      { name: 'read_period', args: readPeriodArgs('2019-09-15', { place: 'home', time: '09:00' }) },
      (body) => stubCallFor(body, {}),
    ]);
    const turn = runChatTurn({
      config: LOCAL, chart: CHART, chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }, profileKey: 'p1', birth: BIRTH,
      engine: engineWith(computeMoonWindow), question: 'How was 15 September 2019 for me?', mode: 'layman', language: 'en', currentPlace: NOVATO,
      history: [], retrievedContext: [], signal: new AbortController().signal, now: new Date('2026-03-08T20:00:00.000Z'),
      labels: { deciding: 'd', answering: 'a', complete: 'c' }, onTravel: vi.fn(), onToolCall: (row) => rows.push(row),
      seams: { fetchImpl, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true, loadPeriodChart: async () => DAY_CHART },
    });
    let answer = '';
    for await (const snapshot of turn) answer = snapshot;
    expect(rows.map((row) => [row.toolName, row.status])).toEqual([['read_period', 'complete'], ['read_period', 'complete']]);
    for (const row of rows) expect(row.result).toMatchObject({ place: { label: NOVATO.label, timezone: 'America/Los_Angeles' }, place_moon: expect.any(Object) });
    expect(bodies[0]).toBeDefined();
    expect(String((bodies[0]?.messages as { content: string }[])[0]?.content)).toContain(`where the user lives now: ${NOVATO.label} (America/Los_Angeles)`);
    for (const body of bodies) {
      for (const pattern of [...NOVATO_COORDINATES, ...COORDINATE_LIKE]) expect(JSON.stringify(body)).not.toMatch(pattern);
    }
    expect(answer).toContain('Novato');
    // The Moon is read at home's local midnights (Pacific), and the coordinates went to the engine, on the device.
    expect(computeMoonWindow).toHaveBeenCalledTimes(2);
    expect(computeMoonWindow.mock.calls[0]?.[0]?.placeStartUtc).toBe('2019-09-15T07:00:00.000Z');
    expect(computeMoonWindow.mock.calls[1]?.[0]?.event).toMatchObject({ latitude: 38.1074, longitude: -122.5697 });
  });
});
