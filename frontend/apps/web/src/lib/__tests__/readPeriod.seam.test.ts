// The real read_period tool through the tool loop with the arguments deepseek-v4-pro really sends:
// the STRING "null" for every unused nullable key. It must validate on the first try.
import type { MoonWindow } from '@almamesh/browser';
import type { ProviderConfig } from '@almamesh/llm';
import { runToolTurn, z, type ToolCallEvent, type ToolDef } from '@almamesh/llm/toolLoop';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { stubEndpoint } from '../../test/stubAnswer';
import { createReadPeriodTool, type ReadPeriodInput } from '../readPeriod';
import { periodReadingFixture } from './periodReadingFixtures';
import { CHART } from './timingFixtures';

const CONFIG: ProviderConfig = { engine: 'openai-http', model: 'deepseek/deepseek-v4-pro', privacyMode: 'local_only', baseUrl: 'http://localhost:11434/v1' };
const NOW = new Date('2026-10-14T18:00:00.000Z');
const BIRTH = {
  birth_datetime_utc: '1990-01-15T12:00:00Z',
  birth_datetime_local: '1990-01-15T17:30:00',
  birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const TRIP = { label: 'Vadodara, India', timezone: 'Asia/Kolkata', latitude: 22.3072, longitude: 73.1812 };
const MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
const READING = { ...CHART, period_reading: periodReadingFixture('delhi-2019-year') } as never;

function tool(): ToolDef<unknown> {
  const input: ReadPeriodInput = {
    birth: BIRTH, chart: CHART, language: 'en', viewerZone: () => 'America/Los_Angeles',
    threadPlace: TRIP, homePlace: { label: 'Novato, California', timezone: 'America/Los_Angeles' },
    loadPeriodChart: vi.fn(async () => READING), loadCurrentChart: vi.fn(async () => READING),
    loadMoonWindow: vi.fn(async (): Promise<MoonWindow> => ({ at_place: { at_start: MARK, at_end: MARK }, event: { lagna_sign: 'leo', moon: MARK } })),
    lookup: vi.fn(async () => ({ status: 'not_found' as const })), pick: vi.fn(async () => undefined),
  };
  return createReadPeriodTool(input) as unknown as ToolDef<unknown>;
}

async function run(readArgs: Record<string, unknown>): Promise<ToolCallEvent[]> {
  const toolCalls: ToolCallEvent[] = [];
  const { fetchImpl } = stubEndpoint([
    { name: 'read_period', args: readArgs },
    { name: 'answer', args: { headline: 'done' } },
    { name: 'answer', args: { headline: 'done' } },
  ]);
  const stream = runToolTurn({
    config: CONFIG,
    messages: [{ role: 'user', content: 'How was September 2019?' }],
    tools: [tool()],
    answer: { schema: z.object({ headline: z.string() }), render: (p) => String(p.headline ?? '') },
    readFirst: false,
    now: NOW,
    fetchImpl,
    onToolCall: (e) => toolCalls.push(e),
  });
  for await (const snapshot of stream) void snapshot;
  return toolCalls;
}

describe('read_period through the tool loop: the string "null" for unused nullable keys', () => {
  it("deepseek's exact arguments validate on the first try, with no retry", async () => {
    const events = await run({ start: '2019-09', end: 'null', place: 'Vadodara', time: 'null', focus: 'null' });
    const read = events.find((e) => e.toolName === 'read_period');
    expect(read).toMatchObject({ validFirstTry: true });
    expect(events.some((e) => e.status === 'retried')).toBe(false);
  });

  it('an empty or blank string for an unused nullable key is null too, on the first try', async () => {
    const events = await run({ start: '2019-09', end: '', place: 'Vadodara', time: ' ', focus: '' });
    expect(events.find((e) => e.toolName === 'read_period')).toMatchObject({ validFirstTry: true });
    expect(events.some((e) => e.status === 'retried')).toBe(false);
  });

  it('an empty string for a required key is still a retry', async () => {
    const events = await run({ start: '', end: null, place: 'Vadodara', time: null, focus: null });
    expect(events.find((e) => e.toolName === 'read_period')).toMatchObject({ status: 'retried', validFirstTry: false });
  });

  it('a genuinely wrong end still retries', async () => {
    const events = await run({ start: '2019-09', end: 'Sept', place: 'null', time: 'null', focus: 'null' });
    expect(events.find((e) => e.toolName === 'read_period')).toMatchObject({ status: 'retried', validFirstTry: false });
  });
});
