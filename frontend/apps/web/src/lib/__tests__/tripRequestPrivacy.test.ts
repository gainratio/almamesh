/**
 * Privacy contract for a chat turn, asserted on the ACTUAL request bodies the REAL
 * tool loop (runToolTurn, via runChatTurn) sends: a trip prefilled from the birth
 * place still sends only a place label and a zone. No coordinate, birth date or
 * birth time, no birth_location_details field and no birth-place marker reaches
 * the model, in the prompt or in a read_period result.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import type { ProviderConfig } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { runChatTurn } from '../chatTurn';
import { readPeriodArgs, stubCallFor, stubEndpoint } from '../../test/stubAnswer';
import { periodReadingFixture } from './periodReadingFixtures';
import { CHART } from './timingFixtures';

const DELHI = { city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata', timezone_offset_hours: 5.5, location_name: 'New Delhi, Delhi, India' };
const BIRTH = {
  birth_datetime_utc: '1990-01-15T06:30:00Z',
  birth_datetime_local: '1990-01-15T12:00:00',
  birth_location_details: DELHI,
} as unknown as ProcessedBirthData;
const NATAL = {
  ...CHART,
  lagna: { sign: 'scorpio', nakshatra: 'anuradha', nakshatra_pada: 1, sign_lord: 'mars', longitude: 215.25 },
} as unknown as SiderealChart;
const READING_CHART = { ...NATAL, period_reading: periodReadingFixture('delhi-2019-year') } as unknown as SiderealChart;
// The sheet's prefill: the birth place's label, zone and coordinates.
const PREFILLED = { label: 'Delhi, India', timezone: 'Asia/Kolkata', latitude: 28.6139, longitude: 77.209 };
const CONFIG: ProviderConfig = { engine: 'openai-http', model: 'm', privacyMode: 'cloud_premium', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' };
const NOW = new Date('2026-03-08T20:00:00.000Z');
const LEAKS = [/28\.61/, /77\.20/, /1990-01-15/, /06:30/, /12:00:00/, /"latitude"/, /birth_location/, /timezone_offset/, /location_name/, /birth_place/];
/** A birth-place MARKER in data the model reads (tool results, the thread lines); fixed instructions may name the concept. */
const MARKER = /birth(?! chart)/i;

function modelData(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role: string; content: string | null }>;
  const tools = messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '');
  const lines = (messages[0]?.content ?? '').split('\n').filter((line) => /^(NOW|THIS THREAD|PINNED PERIOD)/.test(line));
  return [...tools, ...lines].join('\n');
}

async function tripRequestBodies(asOf: ChatThreadAsOf | undefined, start = '2019-05'): Promise<string[]> {
  const { fetchImpl, bodies } = stubEndpoint([{ name: 'read_period', args: readPeriodArgs(start) }, (body) => stubCallFor(body, {})]);
  const turn = runChatTurn({
    config: CONFIG, chart: NATAL, chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }, profileKey: 'p1', birth: BIRTH,
    engine: null, question: 'How was work then?', mode: 'layman', language: 'en', history: [], retrievedContext: [], ...(asOf ? { asOf } : {}),
    signal: new AbortController().signal, now: NOW, labels: { deciding: 'd', answering: 'a', complete: 'c' }, onTravel: vi.fn(),
    seams: { fetchImpl, loadCurrentChart: async () => READING_CHART, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true, loadPeriodChart: async () => READING_CHART },
  });
  for await (const _snapshot of turn) {
    // drain
  }
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(modelData(body)).not.toMatch(MARKER);
  return bodies.map((body) => JSON.stringify(body));
}

describe('a trip turn sends only a place label and zone', () => {
  it('a trip prefilled from the birth place: no coordinates, birth date/time or birth-place fields in any request', async () => {
    const bodies = await tripRequestBodies({ start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: PREFILLED });
    // Contract reversed twice on 2026-10-13: the trip's place (here the prefilled birth place)
    // MUST reach the model as its label and zone (Harish: the AI must know where the trip is),
    // never with coordinates or a birth-place marker.
    expect(bodies[0]).toContain('when the user lived in Delhi, India (Asia/Kolkata)');
    expect(bodies[1]).toContain('\\"timezone\\":\\"Asia/Kolkata\\"');
    expect(bodies[1]).toContain('2019-05-01');
    for (const body of bodies) {
      for (const leak of LEAKS) expect(body).not.toMatch(leak);
    }
  });

  it('an old trip with no place: its fallback place is sent by label and zone, unmarked', async () => {
    const bodies = await tripRequestBodies({ start: '2019-05-01', end: '2019-05-31', granularity: 'month' });
    expect(bodies[0]).toContain('when the user lived in New Delhi, Delhi, India (Asia/Kolkata)');
    for (const body of bodies) {
      for (const leak of LEAKS) expect(body).not.toMatch(leak);
    }
  });
});

describe('a today turn (no trip) sends no birth data either', () => {
  it('every request body is free of birth date, time, place and coordinates, and the reading reaches the model', async () => {
    const bodies = await tripRequestBodies(undefined, '2026-03-08');
    for (const body of bodies) {
      for (const leak of LEAKS) expect(body).not.toMatch(leak);
    }
    // The reading reached the model: round two carries read_period's result.
    expect(bodies[1]).toContain('\\"dashas\\"');
    expect(bodies[1]).toContain('2026-03-08');
  });
});
