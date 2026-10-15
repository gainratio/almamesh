/**
 * One chat turn on the seam (chat tool layer redesign, Task 6): the REAL runToolTurn against a
 * scripted endpoint. A trip turn must read before it may answer; a today turn may answer at once;
 * the answer streams as rendered snapshots; a retried call is telemetry, never a transcript row.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import { estimateRequestTokens, type ProviderConfig } from '@almamesh/llm';
import { BUDGET_INSTRUCTION } from '@almamesh/llm/toolLoop';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCallRows, agentRoundRows, clearAgentRoundsForTest } from '../agentRoundTelemetry';
import { useAppStale } from '../appStale';
import { runChatTurn, type ChatToolCall, type ChatTurnInput } from '../chatTurn';
import { generalAnswer, periodAnswerFrom, readingsOf, readPeriodArgs, stubCallFor, stubEndpoint } from '../../test/stubAnswer';
import { periodReadingFixture } from './periodReadingFixtures';
import { CHART } from './timingFixtures';

const LOCAL: ProviderConfig = { engine: 'openai-http', model: 'm', privacyMode: 'local_only', baseUrl: 'http://localhost:11434/v1' };
const BIRTH = {
  birth_datetime_utc: '1990-01-15T12:00:00Z',
  birth_datetime_local: '1990-01-15T17:30:00',
  birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const NOW = new Date('2026-10-14T18:00:00.000Z');
const MAY_2019 = { start: '2019-05-01', end: '2019-05-31', granularity: 'month' as const, place: { label: 'Vadodara, India', timezone: 'Asia/Kolkata', latitude: 22.3072, longitude: 73.1812 } };
const READING_CHART = { ...CHART, period_reading: periodReadingFixture('delhi-2019-year') } as unknown as SiderealChart;

const endpoint = stubEndpoint;

const toolNames = (body: Record<string, unknown> | undefined) =>
  ((body?.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name);

function input(fetchImpl: typeof fetch, overrides: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return {
    config: LOCAL, chart: CHART, chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }, profileKey: 'p1', birth: BIRTH,
    engine: null, question: 'How was work?', mode: 'layman', language: 'en', history: [], retrievedContext: [],
    signal: new AbortController().signal, now: NOW, labels: { deciding: 'Thinking', answering: 'Answering', complete: 'Done' },
    onTravel: vi.fn(),
    seams: {
      fetchImpl, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true,
      loadPeriodChart: async () => READING_CHART, loadCurrentChart: async () => READING_CHART,
    },
    ...overrides,
  };
}

async function drain(turn: AsyncGenerator<string>): Promise<string[]> {
  const snapshots: string[] = [];
  for await (const snapshot of turn) snapshots.push(snapshot);
  return snapshots;
}

beforeEach(() => {
  clearAgentRoundsForTest();
  useAppStale.setState({ stale: false });
});

describe('runChatTurn: a trip turn reads first', () => {
  it('round 1 is required and offers no answer tool; the answer comes from the reading', async () => {
    const { fetchImpl, bodies } = endpoint([{ name: 'read_period', args: readPeriodArgs('2019-05') }, (body) => stubCallFor(body, {})]);
    const snapshots = await drain(runChatTurn(input(fetchImpl, { asOf: MAY_2019 })));
    expect(bodies[0]).toMatchObject({ tool_choice: 'required' });
    expect(toolNames(bodies[0])).toEqual(['read_period', 'travel']);
    expect(toolNames(bodies[1])).toContain('answer');
    expect(snapshots.at(-1)).toContain('May 2019');
  });

  it('a travel call does not unlock answer: it stays hidden until read_period completes', async () => {
    const { fetchImpl, bodies } = endpoint([
      { name: 'travel', args: { to: '2019-09', place: null } },
      { name: 'read_period', args: readPeriodArgs('2019-09') },
      (body) => stubCallFor(body, {}),
    ]);
    await drain(runChatTurn(input(fetchImpl, { asOf: MAY_2019, question: 'Take me to September 2019' })));
    // Contract reversed 2026-10-14: travel is offered once per turn, so after it only read_period remains.
    expect(toolNames(bodies[1])).toEqual(['read_period']);
    expect(toolNames(bodies[2])).toContain('answer');
    expect(toolNames(bodies[2])).not.toContain('travel');
  });

  it('a travel back to today unlocks answer: the reply only confirms the move, there is no period to read (dashboard.agentic, 2026-10-14)', async () => {
    const { fetchImpl, bodies } = endpoint([
      { name: 'travel', args: { to: 'today', place: null } },
      { name: 'answer', args: generalAnswer('Back to today.') },
    ]);
    const snapshots = await drain(runChatTurn(input(fetchImpl, { asOf: MAY_2019, question: 'Back to today, please.' })));
    expect(toolNames(bodies[1])).toEqual(['read_period', 'answer']);
    expect(snapshots.at(-1)).toBe('Back to today.');
    expect(bodies).toHaveLength(2);
  });

  // dashboard.agentic.real 2026-10-15 (GPT Luna): "outlook today?" in a September 2017 trip read
  // today, then called travel back to today and ended the trip. The turn's own message asks for no
  // move, so the call is refused with a typed note and nothing moves.
  it('a question about today in a trip: a travel call is refused, nothing moves, and the turn reads instead', async () => {
    const onTravel = vi.fn();
    const { fetchImpl, bodies } = endpoint([
      { name: 'travel', args: { to: 'today', place: null } },
      { name: 'read_period', args: readPeriodArgs('2019-05') },
      (body) => stubCallFor(body, {}),
    ]);
    await drain(runChatTurn(input(fetchImpl, { asOf: MAY_2019, question: 'outlook today?', onTravel })));
    expect(onTravel).not.toHaveBeenCalled();
    const travelResult = (bodies[1]?.messages as { role: string; content: unknown }[]).find((m) => m.role === 'tool');
    expect(JSON.stringify(travelResult?.content)).toContain('not_asked');
    // A refused travel is no read: the turn still reads before it may answer.
    expect(toolNames(bodies[1])).toEqual(['read_period']);
  });

  it('states today and the trip in the system prompt', async () => {
    const { fetchImpl, bodies } = endpoint([{ name: 'read_period', args: readPeriodArgs('2019-05') }, (body) => stubCallFor(body, {})]);
    await drain(runChatTurn(input(fetchImpl, { asOf: MAY_2019 })));
    const system = String((bodies[0]?.messages as { content: string }[])[0]?.content);
    expect(system).toContain('NOW: today is Wednesday 14 October 2026, America/Los_Angeles.');
    expect(system).toContain('THIS THREAD: a trip to May 2019, when the user lived in Vadodara, India (Asia/Kolkata).');
  });

  it('the read_period status line names the span it reads', async () => {
    const labels: (string | null)[] = [];
    const { fetchImpl } = endpoint([{ name: 'read_period', args: readPeriodArgs('2019-05') }, (body) => stubCallFor(body, {})]);
    await drain(runChatTurn(input(fetchImpl, { asOf: MAY_2019, onStatus: (label) => labels.push(label) })));
    expect(labels).toContain('Reading May 2019…');
    // The generic tool label never replaces the span: React renders only the last of two synchronous updates.
    expect(labels).not.toContain('Reading the period…');
  });

  it('the travel status line names where the trip goes, and never the generic label', async () => {
    const labels: (string | null)[] = [];
    const { fetchImpl } = endpoint([{ name: 'travel', args: { to: '2019-09', place: null } }, (body) => stubCallFor(body, {})]);
    await drain(runChatTurn(input(fetchImpl, { question: 'Take me to September 2019', onStatus: (label) => labels.push(label) })));
    expect(labels).toContain('Moving to September 2019…');
    expect(labels).not.toContain('Preparing time travel');
  });

  it('the span status lines speak the language the page gives them', async () => {
    const labels: (string | null)[] = [];
    const spoken = {
      deciding: 'Pensando', answering: 'Respondiendo', complete: 'Listo',
      reading: (period: string) => `Leyendo ${period}…`, moving: (period: string) => `Viajando a ${period}…`, returning: 'Volviendo a hoy…',
    };
    const turn = (script: Parameters<typeof endpoint>[0], asOf?: typeof MAY_2019) =>
      drain(runChatTurn(input(endpoint(script).fetchImpl, { ...(asOf ? { asOf } : {}), language: 'es', question: 'Llévame a septiembre de 2019', labels: spoken, onStatus: (label) => labels.push(label) })));
    await turn([{ name: 'read_period', args: readPeriodArgs('2019-05') }, (body) => stubCallFor(body, {})], MAY_2019);
    await turn([{ name: 'travel', args: { to: '2019-09', place: null } }, (body) => stubCallFor(body, {})]);
    // A trip turn reads before it may answer, even after travel (travel is not a read).
    await turn([{ name: 'travel', args: { to: 'today', place: null } }, { name: 'read_period', args: readPeriodArgs('2019-05') }, (body) => stubCallFor(body, {})], MAY_2019);
    expect(labels).toContain('Leyendo mayo de 2019…');
    expect(labels).toContain('Viajando a septiembre de 2019…');
    expect(labels).toContain('Volviendo a hoy…');
  });
});

describe('runChatTurn: a today turn', () => {
  it('round 1 is required with read_period, travel and answer; a general answer streams as snapshots', async () => {
    const { fetchImpl, bodies } = endpoint([{ name: 'answer', args: generalAnswer('Your Mars is strong.') }]);
    const snapshots = await drain(runChatTurn(input(fetchImpl)));
    expect(bodies[0]).toMatchObject({ tool_choice: 'required' });
    expect(toolNames(bodies[0])).toEqual(['read_period', 'travel', 'answer']);
    expect(snapshots.at(-1)).toBe('Your Mars is strong.');
  });
});

// Task 11 (2026-10-14): Settings' "Where do you live now?" is a today thread's place.
describe('runChatTurn: a today turn where the user lives now', () => {
  const NOVATO = { label: 'Novato, California, United States', timezone: 'America/Los_Angeles', latitude: 38.1074, longitude: -122.5697 };
  // A today thread reading January 2027 (the fixture month) at its default place.
  const THIS_MONTH = readPeriodArgs('2027-01');
  const JAN_2027 = { ...CHART, period_reading: periodReadingFixture('delhi-2027-01') } as unknown as SiderealChart;
  const todayInput = (fetchImpl: typeof fetch, overrides: Partial<ChatTurnInput> = {}): ChatTurnInput => {
    const base = input(fetchImpl, overrides);
    return { ...base, seams: { ...base.seams, loadPeriodChart: async () => JAN_2027, loadCurrentChart: async () => JAN_2027 } };
  };
  const systemOf = (body: Record<string, unknown> | undefined) => String((body?.messages as { content: string }[])[0]?.content);
  /** An answer citing the reading, but naming `place`. */
  const answerNaming = (place: string) => (body: Record<string, unknown>) => ({ name: 'answer', args: { ...periodAnswerFrom(readingsOf(body)), place } });

  it('the reading is at the current place (label and zone), the prompt says so, and the answer names the city', async () => {
    const rows: ChatToolCall[] = [];
    const { fetchImpl, bodies } = endpoint([{ name: 'read_period', args: THIS_MONTH }, (body) => stubCallFor(body, {})]);
    const snapshots = await drain(runChatTurn(todayInput(fetchImpl, { currentPlace: NOVATO, onToolCall: (row) => rows.push(row) })));
    expect(rows[0]?.result).toMatchObject({ place: { label: 'Novato, California, United States', timezone: 'America/Los_Angeles' }, cite: { place: 'Novato, California, United States' } });
    expect(systemOf(bodies[0])).toContain('THIS THREAD: today, where the user lives now: Novato, California, United States (America/Los_Angeles).');
    expect(snapshots.at(-1)).toContain('in Novato, California, United States');
  });

  it('the answer check requires the current place: an answer naming another city is sent back', async () => {
    const { fetchImpl } = endpoint([{ name: 'read_period', args: THIS_MONTH }, answerNaming('Delhi'), (body) => stubCallFor(body, {})]);
    const snapshots = await drain(runChatTurn(todayInput(fetchImpl, { currentPlace: NOVATO })));
    expect(agentCallRows().map((row) => [row.name, row.status])).toEqual([['read_period', 'complete'], ['answer', 'retried'], ['answer', 'complete']]);
    expect(snapshots.at(-1)).toContain('Novato');
  });

  it('unset: the reading has the zone only, the prompt names no place, and the answer names no city', async () => {
    const rows: ChatToolCall[] = [];
    const { fetchImpl, bodies } = endpoint([{ name: 'read_period', args: THIS_MONTH }, (body) => stubCallFor(body, {})]);
    const snapshots = await drain(runChatTurn(todayInput(fetchImpl, { onToolCall: (row) => rows.push(row) })));
    expect((rows[0]?.result as { place: unknown }).place).toEqual({ timezone: 'America/Los_Angeles' });
    expect(rows[0]?.result).toMatchObject({ cite: { place: null } });
    expect(systemOf(bodies[0])).not.toContain('THIS THREAD');
    expect(snapshots.at(-1)).not.toMatch(/ in [A-Z][a-z]+,/);
  });

  it('unset: an answer that names a city is sent back (the reading has no place)', async () => {
    const { fetchImpl } = endpoint([{ name: 'read_period', args: THIS_MONTH }, answerNaming('Novato'), (body) => stubCallFor(body, {})]);
    const snapshots = await drain(runChatTurn(todayInput(fetchImpl)));
    expect(agentCallRows().map((row) => [row.name, row.status])).toEqual([['read_period', 'complete'], ['answer', 'retried'], ['answer', 'complete']]);
    expect(snapshots.at(-1)).not.toContain('Novato');
  });

  it('never the birth record transit location: a chart with one still reads at the zone only', async () => {
    const rows: ChatToolCall[] = [];
    const birth = { ...BIRTH, transit_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata', location_name: 'New Delhi, Delhi, India' } } as unknown as ProcessedBirthData;
    const { fetchImpl } = endpoint([{ name: 'read_period', args: THIS_MONTH }, (body) => stubCallFor(body, {})]);
    await drain(runChatTurn(todayInput(fetchImpl, { birth, onToolCall: (row) => rows.push(row) })));
    expect((rows[0]?.result as { place: unknown }).place).toEqual({ timezone: 'America/Los_Angeles' });
  });
});

describe('runChatTurn: tool calls', () => {
  it('a retried call and the answer call make no transcript row; telemetry keeps both', async () => {
    const rows: ChatToolCall[] = [];
    const { fetchImpl } = endpoint([
      { name: 'read_period', args: readPeriodArgs('May 2019') },
      { name: 'read_period', args: readPeriodArgs('2019-05') },
      (body) => stubCallFor(body, {}),
    ]);
    await drain(runChatTurn(input(fetchImpl, { onToolCall: (row) => rows.push(row) })));
    expect(rows.map((row) => [row.toolName, row.status])).toEqual([['read_period', 'complete']]);
    expect(agentCallRows().map((row) => [row.name, row.status, row.validFirstTry])).toEqual([
      ['read_period', 'retried', false], ['read_period', 'complete', false], ['answer', 'complete', true],
    ]);
    expect(agentRoundRows().map((row) => row.phase)).toEqual(['decision', 'decision', 'final']);
  });
});

describe('runChatTurn: a tool that throws', () => {
  it('a stale chunk inside a tool raises the update notice; the row is an error', async () => {
    const rows: ChatToolCall[] = [];
    const stale = new TypeError('Failed to fetch dynamically imported module: /assets/placeLookup-a1.js');
    const { fetchImpl } = endpoint([{ name: 'read_period', args: readPeriodArgs('2019-05', { place: 'Pune' }) }, { name: 'answer', args: generalAnswer('Sorry.') }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const turn = input(fetchImpl, { onToolCall: (row) => rows.push(row) });
    await drain(runChatTurn({ ...turn, seams: { ...turn.seams, lookup: async () => { throw stale; } } }));
    expect(useAppStale.getState().stale).toBe(true);
    expect(rows.map((row) => row.status)).toEqual(['error']);
  });
});

describe('runChatTurn: a cancelled turn', () => {
  it('a tool cut off by the user\'s cancel is not logged as a tool failure', async () => {
    const controller = new AbortController();
    const { fetchImpl } = endpoint([{ name: 'read_period', args: readPeriodArgs('2019-05', { place: 'Pune' }) }, { name: 'answer', args: generalAnswer('Sorry.') }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const turn = input(fetchImpl, { signal: controller.signal });
    const lookup = async () => {
      controller.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    };
    await drain(runChatTurn({ ...turn, seams: { ...turn.seams, lookup } })).catch(() => undefined);
    expect(controller.signal.aborted).toBe(true);
    expect(warn.mock.calls.flat().map(String).some((text) => text.includes('chat.tool_failed'))).toBe(false);
  });
});

describe('runChatTurn: the context budget follows the model window', () => {
  const CATALOG = { data: [
    { id: 'mock/ctx-8k', context_length: 8_192 }, { id: 'mock/ctx-9k', context_length: 10_240 }, { id: 'mock/ctx-1m', context_length: 1_000_000 },
  ] };
  const routerConfig = (model: string): ProviderConfig =>
    ({ engine: 'openai-http', model, privacyMode: 'cloud_premium', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' });
  /** The models catalog for a GET; the scripted chat endpoint for everything else. */
  const withCatalog = (chat: typeof fetch): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('/models') ? Response.json(CATALOG) : chat(url, init)) as typeof fetch;
  const readWhileOffered = (start: string) => (body: Record<string, unknown>) =>
    toolNames(body).includes('read_period') ? { name: 'read_period', args: readPeriodArgs(start) } : stubCallFor(body, {});
  const script = [readWhileOffered('2019-05'), readWhileOffered('2019-06'), readWhileOffered('2019-07'), (body: Record<string, unknown>) => stubCallFor(body, {})];
  const tokens = (body: Record<string, unknown>) => estimateRequestTokens(body.messages as unknown[], (body.tools ?? []) as unknown[]);
  const messages = (body: Record<string, unknown> | undefined) => (body?.messages ?? []) as { role: string; content: string }[];
  const toolContents = (body: Record<string, unknown> | undefined) => messages(body).filter((m) => m.role === 'tool').map((m) => m.content);
  const compactedIn = (bodies: readonly Record<string, unknown>[]) => bodies.flatMap(toolContents).filter((content) => content.includes('"compacted":true'));
  const turnOn = async (model: string) => {
    const { fetchImpl, bodies } = endpoint(script);
    const snapshots = await drain(runChatTurn(input(withCatalog(fetchImpl), { config: routerConfig(model), asOf: MAY_2019 })));
    return { bodies, snapshots };
  };

  it('an 8k model: the read that fills the budget closes the turn; the answer is forced with the reading whole', async () => {
    const { bodies, snapshots } = await turnOn('mock/ctx-8k');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.tool_choice).toEqual({ type: 'function', function: { name: 'answer' } });
    expect(toolNames(bodies[1])).toEqual(['answer']);
    expect(messages(bodies[1]).some((m) => m.role === 'system' && m.content === BUDGET_INSTRUCTION)).toBe(true);
    expect(compactedIn(bodies)).toEqual([]);
    for (const body of bodies) expect(tokens(body)).toBeLessThanOrEqual(4_096);
    expect(snapshots.at(-1)).toContain('May 2019');
  });

  // 10_240 (was 9_984, 9_472, 9_216): 2026-10-15 the reflection rule (no tool narration, no guessed
  // experience) and the newest-message TOOLS line add ~150 tokens to every request. Before that, Task 10d's answer-key descriptions add ~55 tokens to
  // every request and compact readings carry labelled windows; the final review's stricter check
  // adds each theme's direction and the pratyantar lords to the grounding and the cite (~120
  // tokens a reading). Each tipped the old window into a forced answer on the 4th request. The
  // scenario is unchanged.
  it('a 9k model: an older reading goes to its grounding facts, the newest stays whole, and the turn keeps reading', async () => {
    const { bodies, snapshots } = await turnOn('mock/ctx-9k');
    expect(bodies).toHaveLength(4);
    const compacted = compactedIn(bodies);
    expect(compacted.length).toBeGreaterThan(0);
    expect(JSON.parse(compacted[0]!)).toMatchObject({ compacted: true, period: { start: expect.any(String) }, maha: expect.any(Array), antar: expect.any(Array), tags: expect.any(Array) });
    expect(bodies.every((body) => body.tool_choice === 'required')).toBe(true);
    for (const body of bodies) expect(tokens(body)).toBeLessThanOrEqual(5_120);
    expect(snapshots.at(-1)).toContain('May 2019');
    expect(agentRoundRows().some((row) => row.compacted > 0 && row.budget === 5_120)).toBe(true);
  });

  it('a 1M model keeps every reading whole and reads all three', async () => {
    const { bodies } = await turnOn('mock/ctx-1m');
    expect(bodies).toHaveLength(4);
    expect(compactedIn(bodies)).toEqual([]);
    expect(Math.max(...bodies.map(tokens))).toBeGreaterThan(4_096);
  });
});
