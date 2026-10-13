/**
 * Privacy contract for a trip turn, asserted on the ACTUAL request bodies the
 * agent loop sends: a trip prefilled from the birth place still sends only a
 * place label and a zone. No coordinate, birth date or birth time, no
 * birth_location_details field and no birth-place marker reaches the model.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import { buildChatMessages, sanitizeChartForLlm, streamAgentChat, type ProviderConfig } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { SPLIT_DAY_NOW } from '../../test/viewerToday';

const loadMock = vi.hoisted(() => vi.fn());
vi.mock('../periodSky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../periodSky')>();
  return { ...actual, periodSkyCache: () => ({ load: loadMock, keys: () => [] }) };
});

import { buildChatToolset } from '../chatToolset';
import { CHART, SKY_CHART } from './timingFixtures';

const DELHI = { city: 'Delhi', state: 'Delhi', country: 'India', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata', timezone_offset_hours: 5.5, location_name: 'New Delhi, Delhi, India' };
const BIRTH = {
  birth_datetime_utc: '1990-01-15T06:30:00Z',
  birth_datetime_local: '1990-01-15T12:00:00',
  birth_location_details: DELHI,
} as unknown as ProcessedBirthData;
const NATAL = {
  ...CHART,
  lagna: { sign: 'scorpio', nakshatra: 'anuradha', nakshatra_pada: 1, sign_lord: 'mars', longitude: 215.25 },
  planets: { moon: { name: 'moon', sign: 'cancer', house: 9, nakshatra: 'pushya', nakshatra_pada: 2, sign_lord: 'moon', dignity: 'own', is_retrograde: false, longitude: 100.5, latitude: 4.9, houses_ruled: [2], is_yogakaraka: false } },
} as unknown as SiderealChart;
// The sheet's prefill: the birth place's label, zone and coordinates.
const PREFILLED = { label: 'Delhi, India', timezone: 'Asia/Kolkata', latitude: 28.6139, longitude: 77.209 };
const CONFIG: ProviderConfig = { engine: 'openai-http', model: 'm', privacyMode: 'cloud_premium', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' };
const LEAKS = [/28\.61/, /77\.20/, /1990-01-15/, /06:30/, /12:00:00/, /"latitude"/, /birth_location/, /timezone_offset/, /location_name/, /birth_place/];
/** A birth-place MARKER in data the model reads (tool results, the trip brief) — the fixed privacy instructions may name the concept. */
const MARKER = /birth/i;

function tripData(body: string): string {
  const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: string | null }> }).messages;
  const tools = messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '');
  const brief = (messages[0]?.content ?? '').split('\n').filter((line) => /^(TIME-TRAVEL TRIP|PINNED PERIOD|Before interpreting)/.test(line));
  return [...tools, ...brief].join('\n');
}

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

beforeEach(() => loadMock.mockReset().mockResolvedValue({ transit_context: SKY_CHART.transit_context }));

async function tripRequestBodies(asOf: Parameters<typeof buildChatToolset>[0]['pinned']): Promise<string[]> {
  const toolset = buildChatToolset({
    chart: NATAL, chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }, chartTimeZone: 'Asia/Kolkata',
    profileKey: 'p1', birth: BIRTH, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true, language: 'en',
    engine: { engine: { computePredictive: vi.fn() }, startBootstrap: vi.fn(), whenReady: vi.fn() } as unknown as ChartEngineContextValue,
    pinned: asOf,
  });
  const options = { now: SPLIT_DAY_NOW, signal: new AbortController().signal };
  const prepared = await toolset.prepare('How was work then?', options);
  const messages = buildChatMessages(sanitizeChartForLlm(prepared.chart, prepared.asOf), 'How was work then?', 'layman', [], [],
    undefined, 'en', undefined, undefined, undefined, true, prepared.pinned);
  const bodies: string[] = [];
  let round = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    round += 1;
    if (round === 1) {
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        call('a', 'get_natal_summary'), call('b', 'get_trip_context'), call('c', 'get_timing', { section: 'transits' }), call('d', 'get_timing', { section: 'dashas' }),
      ] } }] });
    }
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Work was steady.' } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  });
  for await (const _token of streamAgentChat({ config: CONFIG, messages, tools: toolset.tools, now: SPLIT_DAY_NOW,
    firstRoundToolChoice: prepared.toolChoice, groundingToolName: prepared.groundingTool, fetchImpl: fetchImpl as typeof fetch })) {
    // drain
  }
  return bodies;
}

describe('a trip turn sends only a place label and zone', () => {
  it('a trip prefilled from the birth place: no coordinates, birth date/time or birth-place fields in any request', async () => {
    const bodies = await tripRequestBodies({ start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: PREFILLED });
    expect(bodies).toHaveLength(2);
    // Contract reversed twice on 2026-10-13: the trip's place (here the prefilled birth place)
    // MUST reach the model as its label and zone (Harish: the AI must know where the trip is),
    // never with coordinates or a birth-place marker.
    expect(bodies[0]).toContain('when the user lived in Delhi, India (Asia/Kolkata)');
    expect(bodies[1]).toContain('\\"timezone\\":\\"Asia/Kolkata\\"');
    expect(bodies[1]).toContain('2019-05-01');
    for (const body of bodies) {
      for (const leak of LEAKS) expect(body).not.toMatch(leak);
      expect(tripData(body)).not.toMatch(MARKER);
    }
  });

  it('an old trip with no place: its fallback place is sent by label and zone, unmarked', async () => {
    const bodies = await tripRequestBodies({ start: '2019-05-01', end: '2019-05-31', granularity: 'month' });
    expect(bodies[0]).toContain('when the user lived in New Delhi, Delhi, India (Asia/Kolkata)');
    for (const body of bodies) {
      for (const leak of LEAKS) expect(body).not.toMatch(leak);
      expect(tripData(body)).not.toMatch(MARKER);
    }
  });
});
