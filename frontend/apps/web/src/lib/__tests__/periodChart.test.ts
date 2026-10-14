import type { ChartEngine, PredictiveContexts } from '@almamesh/browser';
import type { PredictiveCallOptions, PredictiveInput, SiderealChart } from '@almamesh/browser/types';
import type { ProviderConfig } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real memo the runtime wraps every booted engine in (runtime.ts). Not a
// package export: imported by path so this test exercises the real pool bound.
import { EngineMemo, memoizeChartEngine } from '../../../../../packages/browser/src/pyodide/engineMemo';
import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { birthUtcYearOf, birthYearOf, createPeriodChartLoader, PeriodSkyUnavailableError } from '../periodChart';
import { createPeriodSkyCache } from '../periodSky';
import { runChatTurn } from '../chatTurn';
import { readPeriodArgs, stubCallFor, stubEndpoint } from '../../test/stubAnswer';

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

  it("bounds the reading to the period's last day; a Day sends none (the engine's default)", async () => {
    const { engine, computePredictive } = rawEngine(async () => SKY);
    const load = loader(engineContext(engine));
    await load(JUNE, toolContext());
    await load({ start: '2019-01-01', end: '2019-12-31' }, toolContext());
    await load({ start: '2019-09-15', end: '2019-09-15' }, toolContext());
    expect(computePredictive.mock.calls[0]?.[0]).toMatchObject({ readingEnd: '2019-06-30' });
    expect(computePredictive.mock.calls[1]?.[0]).toMatchObject({ referenceInstant: '2019-01-01T00:00:00Z', readingEnd: '2019-12-31' });
    expect(computePredictive.mock.calls[2]?.[0]).not.toHaveProperty('readingEnd');
    expect(computePredictive).toHaveBeenCalledTimes(3);
  });

  it('asks the engine for 24 months only when 12 would end before the period does', async () => {
    const { engine, computePredictive } = rawEngine(async () => SKY);
    const load = loader(engineContext(engine));
    await load(JUNE, toolContext());
    await load({ start: '2027-01-01', end: '2028-06-30' }, toolContext());
    await load({ start: '2028-01-01', end: '2028-12-31' }, toolContext());
    expect(computePredictive.mock.calls[0]?.[0]).not.toHaveProperty('windowMonths');
    expect(computePredictive.mock.calls[1]?.[0]).toMatchObject({
      referenceInstant: '2027-01-01T00:00:00Z',
      windowMonths: 24,
    });
    expect(computePredictive.mock.calls[2]?.[0]).toMatchObject({ windowMonths: 24 });
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

describe('birthUtcYearOf', () => {
  it("is the birth instant's UTC year, else unknown", () => {
    expect(birthUtcYearOf({ ...BIRTH, birth_datetime_utc: '1991-01-01T04:00:00Z' })).toBe(1991);
    expect(birthUtcYearOf({ ...BIRTH, birth_datetime_utc: '' })).toBeUndefined();
    expect(birthUtcYearOf(undefined)).toBeUndefined();
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

  /** One chat turn that reads June 2019 with read_period; returns the tool result the model reads next. */
  async function toolResultSeenByModel(loadPeriodChart: ReturnType<typeof loader>) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchImpl, bodies } = stubEndpoint([{ name: 'read_period', args: readPeriodArgs('2019-06') }, (body) => stubCallFor(body, {})]);
    const answer = (async () => {
      const turn = runChatTurn({
        config: CONFIG, chart: CHART, chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') }, profileKey: 'p1', birth: BIRTH,
        engine: null, question: 'Transits in June 2019?', mode: 'layman', language: 'en', history: [], retrievedContext: [],
        signal: new AbortController().signal, now: new Date('2026-03-08T09:30:00.000Z'), labels: { deciding: 'd', answering: 'a', complete: 'c' },
        seams: { fetchImpl, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true, loadPeriodChart },
      });
      for await (const _snapshot of turn) {
        // drain
      }
    })();
    await vi.advanceTimersByTimeAsync(150_000);
    await answer;
    const messages = bodies[1]?.messages as Array<{ role: string; content: string | null }> | undefined;
    const toolMessage = messages?.find((message) => message.role === 'tool');
    return JSON.parse(toolMessage?.content ?? '{}') as { period?: unknown; available?: unknown; reason?: unknown };
  }

  const TIMEOUT_VALUE = { period: { start: '2019-06-01', end: '2019-06-30' }, available: false, reason: 'timeout' };

  it('answers {available: false, reason: "timeout"} before the 150 s tool cap', async () => {
    const never = rawEngine(() => new Promise<PredictiveContexts>(() => undefined));
    const content = await toolResultSeenByModel(loader(engineContext(never.engine)));
    expect(content).toMatchObject(TIMEOUT_VALUE);
  });

  it('counts a cold engine boot inside the same deadline (whenReady never settles)', async () => {
    const booting = engineContext(null, vi.fn(() => new Promise<ChartEngine>(() => undefined)));
    const content = await toolResultSeenByModel(loader(booting));
    expect(content).toMatchObject(TIMEOUT_VALUE);
  });
});
