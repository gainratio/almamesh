/**
 * One chat turn on the seam (chat tool layer redesign, Task 6): the REAL runToolTurn against a
 * scripted endpoint. A trip turn must read before it may answer; a today turn may answer at once;
 * the answer streams as rendered snapshots; a retried call is telemetry, never a transcript row.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import type { ProviderConfig } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCallRows, agentRoundRows, clearAgentRoundsForTest } from '../agentRoundTelemetry';
import { useAppStale } from '../appStale';
import { runChatTurn, type ChatToolCall, type ChatTurnInput } from '../chatTurn';
import { generalAnswer, readPeriodArgs, stubCallFor, stubEndpoint } from '../../test/stubAnswer';
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
