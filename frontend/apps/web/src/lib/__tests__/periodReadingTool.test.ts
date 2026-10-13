import type { SiderealChart } from '@almamesh/browser/types';
import { BEFORE_BIRTH_MESSAGE, buildChatMessages, compactToolContent, defaultToolSummary, estimateRequestTokens, PERIOD_DETAIL_TOOL_NAME, PERIOD_READING_TOOL_NAME, sanitizeChartForLlm, streamAgentChat, type AgentTool, type ProviderConfig } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { SPLIT_DAY_NOW } from '../../test/viewerToday';
import { buildPeriodReading, PERIOD_TOOL_SUMMARIZERS, periodDetailSummary, periodReadingSummary, type PeriodDetail, type PeriodReading } from '../periodReading';
import { PeriodSkyTimeoutError } from '../periodSky';
import { currentDateTimeForZone } from '../chatAgentTools';
import { createPeriodReadingTools, type PeriodReadingToolsInput } from '../periodReadingTool';
import { PeriodSkyUnavailableError } from '../timingTool';
import { DELHI_BIRTH_LEAKS, periodReadingFixture } from './periodReadingFixtures';
import { CHART } from './timingFixtures';

const BIRTH = {
  birth_datetime_utc: '1990-01-15T12:00:00Z',
  birth_datetime_local: '1990-01-15T17:30:00',
  birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.2897, longitude: 103.8501 };
const MAY_2019: ChatThreadAsOf = { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: SINGAPORE };
const STRENGTH = { sunrise_utc_iso: '1990-01-15T01:40:00Z', ashtakavarga: { bhinna: {}, sarva: { bindus: { aries: 28 }, total: 337 } }, shadbala: { planets: {} } };
const withReading = (name: Parameters<typeof periodReadingFixture>[0]) =>
  ({ ...CHART, period_reading: periodReadingFixture(name), strength_context: STRENGTH }) as unknown as SiderealChart;

function tools(overrides: Partial<PeriodReadingToolsInput> = {}) {
  const loadPeriodChart = vi.fn(async () => withReading('delhi-2019-05'));
  const loadCurrentChart = vi.fn(async () => withReading('delhi-2019-09-15-day'));
  const input: PeriodReadingToolsInput = {
    pin: MAY_2019, chart: CHART, birth: BIRTH, language: 'en', viewerZone: () => 'America/Los_Angeles',
    loadPeriodChart, loadCurrentChart, periodSkyAllowed: true, ...overrides,
  };
  const [reading, detail] = createPeriodReadingTools(input) as [AgentTool, AgentTool];
  return { reading, detail, loadPeriodChart, loadCurrentChart };
}
const context = () => ({ now: SPLIT_DAY_NOW, signal: new AbortController().signal });

describe('get_period_reading', () => {
  it('registers the two tools by their shared names, with no arguments for the reading', () => {
    const { reading, detail } = tools();
    expect([reading.name, detail.name]).toEqual([PERIOD_READING_TOOL_NAME, PERIOD_DETAIL_TOOL_NAME]);
    expect([PERIOD_READING_TOOL_NAME, PERIOD_DETAIL_TOOL_NAME]).toEqual(['get_period_reading', 'get_period_detail']);
    expect(reading.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(reading.timeoutMs).toBe(150_000);
  });

  it('a trip: loads the pin period through the period loader and binds the trip place', async () => {
    const { reading, loadPeriodChart } = tools();
    const result = await reading.execute({}, context()) as PeriodReading;
    expect(loadPeriodChart).toHaveBeenCalledWith({ start: '2019-05-01', end: '2019-05-31' }, expect.anything());
    expect(result.period).toEqual({ start: '2019-05-01', end: '2019-05-31', granularity: 'month', label: 'May 2019', tense: 'past' });
    expect(result.place).toEqual({ label: 'Singapore', timezone: 'Asia/Singapore' });
    expect(result).toEqual(buildPeriodReading(periodReadingFixture('delhi-2019-05'), { period: result.period, place: result.place }));
  });

  it('today: [today, today] at the viewer zone, through the today loader', async () => {
    const { reading, loadCurrentChart, loadPeriodChart } = tools({ pin: undefined });
    const result = await reading.execute({}, context()) as PeriodReading;
    expect(loadCurrentChart).toHaveBeenCalledTimes(1);
    expect(loadPeriodChart).not.toHaveBeenCalled();
    expect(result.period).toMatchObject({ granularity: 'day', tense: 'present' });
    expect(result.period.start).toBe(result.period.end);
    const local = currentDateTimeForZone(SPLIT_DAY_NOW, 'America/Los_Angeles');
    // Contract reversed (2026-10-13): today used to send `label: null`, and the model told the
    // user "the tool hasn't supplied a city name". With no known current place, no label key at all.
    expect(result.place).toEqual({
      timezone: 'America/Los_Angeles',
      current: { zone: 'your current zone (America/Los_Angeles)', local_date: result.period.start, local_time: local.localTime.slice(0, 5) },
    });
    expect(result.place).not.toHaveProperty('label');
    expect(local.localDate).toBe(result.period.start);
  });

  it("today: names the profile's current place by label only, never its coordinates or the birth place", async () => {
    const lisbon = { city: 'Lisbon', country: 'Portugal', latitude: 38.7223, longitude: -9.1393, timezone: 'Europe/Lisbon' };
    const { reading } = tools({ pin: undefined, birth: { ...BIRTH, transit_location_details: lisbon } });
    const result = await reading.execute({}, context()) as PeriodReading;
    expect(result.place).toMatchObject({ label: 'Lisbon, Portugal', timezone: 'America/Los_Angeles' });
    const sent = JSON.stringify(result);
    for (const leak of ['38.72', '-9.13', 'Delhi', '28.61', '77.20', '1990-01-15', '17:30']) expect(sent).not.toContain(leak);
  });

  it('today: an unusable current place (no label) sends no label, not an empty one', async () => {
    const blank = { city: ' ', latitude: 38.7223, longitude: -9.1393, timezone: 'Europe/Lisbon' };
    const { reading } = tools({ pin: undefined, birth: { ...BIRTH, transit_location_details: blank } });
    const result = await reading.execute({}, context()) as PeriodReading;
    expect(result.place).not.toHaveProperty('label');
  });

  it('a trip carries no current local time: its place is where the user was, not where they are', async () => {
    const { reading } = tools();
    const result = await reading.execute({}, context()) as PeriodReading;
    expect(result.place).not.toHaveProperty('current');
  });

  it.each([
    [new PeriodSkyUnavailableError('incomplete_birth_data'), 'incomplete_birth_data'],
    [new PeriodSkyUnavailableError('engine_unavailable'), 'engine_unavailable'],
    [new PeriodSkyTimeoutError(), 'timeout'],
    [new Error('worker died'), 'engine_unavailable'],
  ])('a failed load returns a typed reason (%s)', async (error, reason) => {
    const { reading } = tools({ loadPeriodChart: vi.fn(async () => { throw error; }) });
    await expect(reading.execute({}, context())).resolves.toMatchObject({
      period: { start: '2019-05-01' }, place: { label: 'Singapore' }, available: false, reason,
    });
  });

  it('a cancelled turn is not a reading failure', async () => {
    const controller = new AbortController();
    const abort = new DOMException('cancelled', 'AbortError');
    const { reading } = tools({ loadPeriodChart: vi.fn(async () => { controller.abort(abort); throw abort; }) });
    await expect(reading.execute({}, { now: SPLIT_DAY_NOW, signal: controller.signal })).rejects.toBe(abort);
  });

  it('contexts from an engine (or cache) without the reading say so: reading_unavailable', async () => {
    for (const chart of [CHART, { ...CHART, period_reading: { window: {} } }]) {
      const { reading } = tools({ loadPeriodChart: vi.fn(async () => chart as SiderealChart) });
      await expect(reading.execute({}, context())).resolves.toMatchObject({ available: false, reason: 'reading_unavailable' });
    }
  });

  it('applies the same period gates as get_timing: before birth, the birth year, a dashas-only device', async () => {
    const before = tools({ pin: { start: '1985-01-01', end: '1985-12-31', granularity: 'year', place: SINGAPORE } });
    await expect(before.reading.execute({}, context())).resolves.toEqual({ error: BEFORE_BIRTH_MESSAGE });
    const birthYear = tools({ pin: { start: '1990-01-01', end: '1990-12-31', granularity: 'year', place: SINGAPORE } });
    await expect(birthYear.reading.execute({}, context())).resolves.toMatchObject({ available: false, reason: 'birth_year' });
    expect(birthYear.loadPeriodChart).not.toHaveBeenCalled();
    const weak = tools({ periodSkyAllowed: false });
    await expect(weak.reading.execute({}, context())).resolves.toMatchObject({ available: false, reason: 'device_limit' });
    expect(weak.loadPeriodChart).not.toHaveBeenCalled();
  });

  it('carries no birth date, time or coordinates', async () => {
    const { reading } = tools();
    const text = JSON.stringify(await reading.execute({}, context()));
    for (const leak of DELHI_BIRTH_LEAKS) expect(text).not.toContain(leak);
  });
});

describe('get_period_detail', () => {
  it('digests one section of the same bound period', async () => {
    const { detail, loadPeriodChart } = tools();
    await expect(detail.execute({ section: 'lord', key: 'venus' }, context())).resolves.toMatchObject({
      section: 'lord', key: 'venus', period: { label: 'May 2019' }, facts: { lord: 'venus', rules: [5, 12] },
    });
    await expect(detail.execute({ section: 'bindus', key: 'sav' }, context())).resolves.toMatchObject({ facts: { total: 337 } });
    expect(loadPeriodChart).toHaveBeenCalledTimes(2);
  });

  it('returns a refusal the model can act on for bad arguments, before any engine work', async () => {
    const { detail, loadPeriodChart } = tools();
    await expect(detail.execute({ section: 'houses' }, context())).resolves.toEqual({ error: 'section must be one of: lord, segment, bindus, panchang, dashas' });
    await expect(detail.execute({ section: 'lord', key: 7 }, context())).resolves.toEqual({ error: 'key must be a string' });
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('shares the reading failure reasons', async () => {
    const { detail } = tools({ loadPeriodChart: vi.fn(async () => { throw new PeriodSkyTimeoutError(); }) });
    await expect(detail.execute({ section: 'dashas' }, context())).resolves.toMatchObject({ available: false, reason: 'timeout' });
  });
});

describe('the agent loop carries the reading as well-formed JSON', () => {
  it('the Year 2019 reading survives the agent sanitize step and parses back to itself', async () => {
    const { reading } = tools({
      pin: { start: '2019-01-01', end: '2019-12-31', granularity: 'year', place: SINGAPORE },
      loadPeriodChart: vi.fn(async () => withReading('delhi-2019-year')),
    });
    const config: ProviderConfig = { engine: 'openai-http', model: 'm', privacyMode: 'cloud_premium', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' };
    const messages = buildChatMessages(sanitizeChartForLlm(CHART, { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }), 'How was 2019?', 'layman', [], [], undefined, 'en');
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'r1', type: 'function', function: { name: PERIOD_READING_TOOL_NAME, arguments: '{}' } },
        ] } }] });
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    for await (const _token of streamAgentChat({ config, messages, tools: [reading], now: SPLIT_DAY_NOW, fetchImpl: fetchImpl as typeof fetch })) {
      // drain
    }
    const sent = (JSON.parse(bodies[1]!) as { messages: Array<{ role: string; content: string | null }> }).messages.find((m) => m.role === 'tool');
    const envelope = JSON.parse(sent?.content ?? '') as { ok: boolean; value: PeriodReading };
    expect(envelope.ok).toBe(true);
    expect(envelope.value).toEqual(await reading.execute({}, context()));
    expect(new TextEncoder().encode(JSON.stringify(envelope.value)).length).toBeLessThan(4096);
    for (const leak of DELHI_BIRTH_LEAKS) expect(sent?.content).not.toContain(leak);
  });
});

describe('a consumed reading compacts to its own summary, not the generic default', () => {
  const config: ProviderConfig = { engine: 'openai-http', model: 'm', privacyMode: 'cloud_premium', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' };
  const decision = (id: string, name: string, args: Record<string, unknown>) => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] } }] });

  it('both tools carry the period summarizers, and the shared map names exactly them', () => {
    const { reading, detail } = tools();
    expect(reading.summarize).toBe(PERIOD_TOOL_SUMMARIZERS[PERIOD_READING_TOOL_NAME]);
    expect(detail.summarize).toBe(PERIOD_TOOL_SUMMARIZERS[PERIOD_DETAIL_TOOL_NAME]);
    expect(Object.keys(PERIOD_TOOL_SUMMARIZERS).sort()).toEqual([PERIOD_DETAIL_TOOL_NAME, PERIOD_READING_TOOL_NAME]);
  });

  /** One reading round, one detail round, then the answer; returns each request body. */
  async function readingThenDetail(contextTokens: number): Promise<string[]> {
    const { reading, detail } = tools();
    const messages = buildChatMessages(sanitizeChartForLlm(CHART, { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }), 'How was May 2019?', 'layman', [], [], undefined, 'en');
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) return decision('r1', PERIOD_READING_TOOL_NAME, {});
      if (bodies.length === 2) return decision('d1', PERIOD_DETAIL_TOOL_NAME, { section: 'dashas' });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    for await (const _token of streamAgentChat({ config, messages, tools: [reading, detail], now: SPLIT_DAY_NOW, fetchImpl: fetchImpl as typeof fetch, contextTokens })) {
      // drain
    }
    return bodies;
  }
  type WireBody = { messages: Array<{ role: string; tool_call_id?: string; content: string | null }>; tools?: unknown[] };

  it('a large context window answers from the full reading, never its compact note', async () => {
    const third = (JSON.parse((await readingThenDetail(1_000_000))[2]!) as WireBody).messages;
    const readingMessage = third.find((m) => m.role === 'tool' && m.tool_call_id === 'r1')?.content ?? '';
    expect(JSON.parse(readingMessage)).toMatchObject({ ok: true, value: { period: { label: 'May 2019' } } });
  });

  it('under budget pressure the round after the reading carries periodReadingSummary as the compact facts', async () => {
    const { reading } = tools();
    // A budget one token short of the full third request: the oldest result (the reading) must go compact.
    const roomy = JSON.parse((await readingThenDetail(1_000_000))[2]!) as WireBody;
    const bodies = await readingThenDetail(2 * (estimateRequestTokens(roomy.messages, roomy.tools ?? []) - 1));
    const third = (JSON.parse(bodies[2]!) as WireBody).messages;
    const compact = third.find((m) => m.role === 'tool' && m.tool_call_id === 'r1')?.content;
    const full = await reading.execute({}, context()) as PeriodReading;
    const own = periodReadingSummary(full);
    expect(own.factors.length).toBeGreaterThan(0);
    expect(compact).toBe(compactToolContent(own));
    expect(compact).not.toBe(compactToolContent(defaultToolSummary(full)));
    // The newest round (the detail) still rides in full.
    const detailMessage = third.find((m) => m.role === 'tool' && m.tool_call_id === 'd1')?.content ?? '';
    expect(JSON.parse(detailMessage)).toMatchObject({ ok: true, value: { section: 'dashas' } });
  });

  it('a detail result summarizes through periodDetailSummary', async () => {
    const { detail } = tools();
    const result = await detail.execute({ section: 'dashas' }, context()) as PeriodDetail;
    expect(detail.summarize?.(result)).toEqual(periodDetailSummary(result));
  });
});
