import type { ChartEngine, PredictiveContexts } from '@almamesh/browser';
import type { PredictiveCallOptions, PredictiveInput, SiderealChart } from '@almamesh/browser/types';
import { streamAgentChat, type AgentTool, type ProviderConfig } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real memo the runtime wraps every booted engine in (runtime.ts). Not a
// package export: imported by path so this test exercises the real pool bound.
import { EngineMemo, memoizeChartEngine } from '../../../../../packages/browser/src/pyodide/engineMemo';
import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { birthYearOf, createPeriodChartLoader } from '../periodChart';
import { createPeriodSkyCache } from '../periodSky';
import { PeriodSkyUnavailableError, createTimingTool } from '../timingTool';

const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [] } as unknown as SiderealChart;
const SKY = { transit_context: { instant: 'x' } } as unknown as PredictiveContexts;
const BIRTH = {
  birth_datetime_utc: '1990-01-15T12:00:00.000Z',
  birth_datetime_local: '1990-01-15T17:30:00',
  birth_location_details: { latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const JUNE = { start: '2019-06-01', end: '2019-06-30' };
const idle = () => ({ status: 'idle' });
const toolContext = () => ({ now: new Date('2026-03-08T09:30:00.000Z'), signal: new AbortController().signal });

function engineContext(engine: ChartEngine | null, whenReady = vi.fn(async () => engine!)): ChartEngineContextValue {
  return { engine, whenReady, startBootstrap: vi.fn() } as unknown as ChartEngineContextValue;
}

function rawEngine(compute: (input: PredictiveInput, options?: PredictiveCallOptions) => Promise<PredictiveContexts>) {
  const computePredictive = vi.fn(compute);
  const engine = { computePredictive, meta: () => ({}) } as unknown as ChartEngine;
  return { engine, computePredictive };
}

function loader(engine: ChartEngineContextValue | null, birth: ProcessedBirthData | undefined = BIRTH) {
  return createPeriodChartLoader({
    chart: CHART,
    profileKey: 'p1',
    birth,
    engine,
    cache: createPeriodSkyCache({ readStore: idle }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createPeriodChartLoader', () => {
  it("runs the engine at the period's first day and merges the sky onto the natal chart", async () => {
    const { engine, computePredictive } = rawEngine(async () => SKY);
    const chart = await loader(engineContext(engine))(JUNE, toolContext());
    expect(computePredictive.mock.calls[0]?.[0]).toMatchObject({ referenceInstant: '2019-06-01T00:00:00Z' });
    expect(chart).toMatchObject({ ayanamsa_value: 23.7, transit_context: { instant: 'x' } });
  });

  it("hands periodSky the context's ready engine itself, and asks for the period pool", async () => {
    const { engine, computePredictive } = rawEngine(async () => SKY);
    await loader(engineContext(engine))(JUNE, toolContext());
    expect(computePredictive.mock.contexts[0]).toBe(engine);
    expect(computePredictive.mock.calls[0]?.[1]).toEqual({ retention: 'period' });
  });

  it("is bounded by the memoized engine's tier-sized period pool", async () => {
    // The provider's `engine` is the runtime's memoizeChartEngine(...) wrapper.
    // With a period pool of 1, asking A, B, A recomputes A: the bound applies.
    const raw = rawEngine(async () => SKY);
    const memoized = memoizeChartEngine(raw.engine, 'bundle', new EngineMemo(64, 1));
    const load = loader(engineContext(memoized));
    for (const start of ['2019-06-01', '2019-07-01', '2019-06-01']) {
      await load({ start, end: start }, toolContext());
    }
    expect(raw.computePredictive).toHaveBeenCalledTimes(3);
  });

  it('waits for the engine to boot when it is not ready yet', async () => {
    const { engine } = rawEngine(async () => SKY);
    const context = engineContext(null, vi.fn(async () => engine));
    await expect(loader(context)(JUNE, toolContext())).resolves.toMatchObject({ transit_context: { instant: 'x' } });
    expect(context.startBootstrap).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no engine context', null, BIRTH, 'engine_unavailable'],
    ['no birth zone', 'engine', { ...BIRTH, birth_location_details: { latitude: 0, longitude: 0 } }, 'incomplete_birth_data'],
  ] as const)('names the failure when there is %s', async (_label, engine, birth, reason) => {
    const context = engine ? engineContext(rawEngine(async () => SKY).engine) : null;
    const error = await loader(context, birth as ProcessedBirthData)(JUNE, toolContext()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PeriodSkyUnavailableError);
    expect((error as PeriodSkyUnavailableError).reason).toBe(reason);
  });
});

describe('birthYearOf', () => {
  it('is the local birth year, else the UTC year, else unknown; never the day', () => {
    expect(birthYearOf(BIRTH)).toBe(1990);
    expect(birthYearOf({ ...BIRTH, birth_datetime_local: '' })).toBe(1990);
    expect(birthYearOf(undefined)).toBeUndefined();
  });
});

describe('a slow period compute reaches the model as a timeout value', () => {
  const CONFIG: ProviderConfig = {
    engine: 'openai-http',
    model: 'test-model',
    privacyMode: 'cloud_premium',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
  };
  const decision = (message: Record<string, unknown>) => Response.json({ choices: [{ message }] });

  /** One model turn that calls get_timing for June 2019; returns the tool message the model reads next. */
  async function toolResultSeenByModel(loadPeriodChart: ReturnType<typeof loader>) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timing: AgentTool = createTimingTool({
      chart: CHART,
      birthYear: 1990,
      todayDay: () => '2026-03-08',
      loadPeriodChart,
      periodSkyAllowed: true,
    });
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      if (bodies.length > 1) return decision({ role: 'assistant', content: 'done' });
      const args = JSON.stringify({ section: 'transits', start: '2019-06-01', end: '2019-06-30' });
      return decision({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_timing', arguments: args } }],
      });
    });

    const answer = (async () => {
      let text = '';
      const stream = streamAgentChat({
        config: CONFIG,
        messages: [{ role: 'user', content: 'Transits in June 2019?' }],
        tools: [timing],
        now: new Date('2026-03-08T09:30:00.000Z'),
        fetchImpl: fetchImpl as typeof fetch,
      });
      for await (const token of stream) text += token;
      return text;
    })();
    await vi.advanceTimersByTimeAsync(150_000);
    await answer;

    const toolMessage = bodies[1]?.messages.find((message) => message.role === 'tool');
    return JSON.parse(toolMessage?.content ?? '{}') as { ok?: boolean; value?: { period?: unknown; data?: unknown } };
  }

  const TIMEOUT_VALUE = {
    period: { start: '2019-06-01', end: '2019-06-30', basis: 'period' },
    data: { available: false, reason: 'timeout' },
  };

  it('answers {available: false, reason: "timeout"} before the 150 s tool cap', async () => {
    const never = rawEngine(() => new Promise<PredictiveContexts>(() => undefined));
    const content = await toolResultSeenByModel(loader(engineContext(never.engine)));
    expect(content.ok).toBe(true);
    expect(content.value).toMatchObject(TIMEOUT_VALUE);
  });

  it('counts a cold engine boot inside the same deadline (whenReady never settles)', async () => {
    const booting = engineContext(null, vi.fn(() => new Promise<ChartEngine>(() => undefined)));
    const content = await toolResultSeenByModel(loader(booting));
    expect(content.ok).toBe(true);
    expect(content.value).toMatchObject(TIMEOUT_VALUE);
  });
});
