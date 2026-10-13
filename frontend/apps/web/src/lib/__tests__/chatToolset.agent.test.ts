import { describe, expect, it, vi } from 'vitest';
import { streamAgentChat, type AgentStatusEvent } from '@almamesh/llm';

import { buildChatToolset } from '../chatToolset';
import { installCityTestDatabase } from '../geo/__tests__/cityTestDb';
import { CHART } from './timingFixtures';

installCityTestDatabase();

const now = new Date('2026-10-11T17:00:00Z');
const pinned = { start: '2017-09-01', end: '2017-09-30', granularity: 'month' } as const;
const place = { summary: { place_ref: 'city:42', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.711, longitude: -74.0721 };

// Contract reversed 2026-10-13: get_current_datetime and get_chart_facts are today-thread tools; a trip
// (pinned thread) no longer registers them, so they run in a today thread and the trip runs its own tools.
const TODAY = 'today';
const TRIP = 'trip';

describe('actual chat capabilities through the provider tool protocol', () => {
  it.each([
    ['get_current_datetime', TODAY, { scope: 'utc' }, '2026-10-11T17:00:00.000Z'],
    ['get_chart_facts', TODAY, { section: 'dashas' }, 'jupiter'], // today-relative: the 2017 antar is no longer selected
    ['get_natal_summary', TRIP, {}, 'lagna'],
    ['get_trip_context', TRIP, {}, 'September 2017'],
    ['get_timing', TRIP, { section: 'dashas' }, '2017-09-01'],
    ['resolve_place', TRIP, { query: 'Bogotá' }, 'America/Bogota'],
    ['time_travel', TRIP, { action: 'travel', period: 'day', date: '2017-09-15', place_ref: 'city:42' }, 'queued'],
    ['time_travel', TRIP, { action: 'back_to_today' }, 'back_to_today'],
  ])('executes %s (%s thread) and sends its safe result back, beyond merely advertising it', async (name, thread, args, expected) => {
    const record = vi.fn();
    const toolset = buildChatToolset({ chart: CHART, chartAsOf: { basis: 'chart', instant: now },
      chartTimeZone: 'UTC', profileKey: 'fixture', birth: undefined, engine: null,
      viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true,
      ...(thread === TRIP ? { pinned } : {}), placeFromRef: async () => place, onTravel: record,
    });
    const statuses: AgentStatusEvent[] = [];
    const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; name?: string; content: string }> }> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'actual-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: 'Grounded fixture answer.' } }] });
    });
    let answer = '';
    for await (const token of streamAgentChat({
      config: { engine: 'openai-http', model: 'fixture', baseUrl: 'http://localhost:11434/v1', privacyMode: 'local_only' },
      messages: [{ role: 'user', content: 'Use the selected local capability.' }], tools: toolset.tools,
      now, onStatus: (status) => statuses.push(status), fetchImpl: fetchImpl as typeof fetch,
    })) answer += token;
    expect(answer).toBe('Grounded fixture answer.');
    expect(requests[0]?.tools?.map((tool) => tool.function.name)).toContain(name);
    expect(statuses).toContainEqual(expect.objectContaining({ phase: 'using_tool', toolName: name }));
    const result = requests[1]?.messages.find((message) => message.role === 'tool');
    expect(result?.name).toBe(name);
    expect(result?.content).toContain(expected);
    expect(result?.content).not.toMatch(/tool_timeout|tool_failed|latitude|longitude|4\.711|74\.0721/);
    expect(record).toHaveBeenCalledTimes(name === 'time_travel' ? 1 : 0);
  });

  it('a trip does not register the today-only get_current_datetime or get_chart_facts', () => {
    const names = (trip: boolean) => buildChatToolset({ chart: CHART, chartAsOf: { basis: 'chart', instant: now },
      chartTimeZone: 'UTC', profileKey: 'fixture', birth: undefined, engine: null,
      viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true, ...(trip ? { pinned } : {}),
    }).tools.map((tool) => tool.name);
    expect(names(true)).toEqual(['get_natal_summary', 'get_trip_context', 'get_timing', 'resolve_place']);
    expect(names(false)).toEqual(expect.arrayContaining(['get_current_datetime', 'get_chart_facts']));
  });
});
