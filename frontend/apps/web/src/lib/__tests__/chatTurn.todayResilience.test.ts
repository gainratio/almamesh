import { WorkerCrashError, type ChartEngine, type PredictiveContexts } from '@almamesh/browser';
import type { ProviderConfig } from '@almamesh/llm';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { usePredictiveStore, type CurrentPlace } from '@almamesh/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { generalAnswer, readPeriodArgs, stubCallFor, stubEndpoint } from '../../test/stubAnswer';
import { runChatTurn, type ChatToolCall, type ChatTurnInput } from '../chatTurn';
import { __resetPeriodSkyCacheForTest } from '../periodSky';
import { buildEnsurePredictiveInput, predictiveReferenceInstant } from '../predictive';
import { periodReadingFixture } from './periodReadingFixtures';
import { CHART, TRANSITS } from './timingFixtures';

const CONFIG: ProviderConfig = {
  engine: 'openai-http',
  model: 'm',
  privacyMode: 'local_only',
  baseUrl: 'http://localhost:11434/v1',
};
const BIRTH = {
  birth_datetime_utc: '1990-01-15T12:00:00Z',
  birth_datetime_local: '1990-01-15T17:30:00',
  birth_location_details: { city: 'Delhi', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const NOVATO: CurrentPlace = {
  label: 'Novato, California, United States',
  timezone: 'America/Los_Angeles',
  latitude: 38.1074,
  longitude: -122.5697,
};
const NOW = new Date('2019-09-15T23:36:00.000Z'); // 16:36 PDT on 2019-09-15 in Novato
const FULL_CONTEXTS = {
  transit_context: TRANSITS,
  varga_context_full: { charts: {}, vargottama: [], shadvarga_own_sign: [], vimshopaka: [] },
  strength_context: { sunrise_utc_iso: '1990-01-15T01:42:00+00:00', ashtakavarga: { bhinna: {}, sarva: { bindus: {}, total: 337 } }, shadbala: { planets: {} } },
  domains_context: { instant: '2019-09-15T00:00:00Z', forecasts: {} },
  period_reading: periodReadingFixture('delhi-2019-09-15-day'),
} as unknown as PredictiveContexts;

function makeTurnInput(fetchImpl: typeof fetch, overrides: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return {
    config: CONFIG, chart: CHART,
    chartAsOf: { basis: 'chart', instant: new Date('2019-09-15T00:00:00Z') },
    profileKey: 'p1', birth: BIRTH, engine: null, question: 'outlook today?',
    mode: 'layman', language: 'en', history: [], retrievedContext: [], currentPlace: NOVATO,
    signal: new AbortController().signal, now: NOW,
    labels: { deciding: 'Thinking', answering: 'Answering', complete: 'Done' },
    seams: { fetchImpl, viewerZone: () => 'America/Los_Angeles', periodSkyAllowed: true },
    ...overrides,
  };
}

async function runOutlookTurn(overrides: Partial<ChatTurnInput> = {}): Promise<{ calls: ChatToolCall[]; reply: string }> {
  const calls: ChatToolCall[] = [];
  const { fetchImpl } = stubEndpoint([
    { name: 'read_period', args: readPeriodArgs('today') },
    (body) => {
      const toolMsg = (body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
      if (toolMsg?.content.includes('"available":false')) return { name: 'answer', args: generalAnswer('Unavailable.') };
      return stubCallFor(body, {}, 'Grounded today outlook in Novato.');
    },
  ]);
  let reply = '';
  for await (const snap of runChatTurn(makeTurnInput(fetchImpl, { onToolCall: (c) => calls.push(c), ...overrides }))) {
    reply = snap;
  }
  return { calls, reply };
}

beforeEach(() => {
  usePredictiveStore.getState().reset();
  __resetPeriodSkyCacheForTest();
});

describe('returning-device iPhone "outlook today?" resilience', () => {
  it('1. serves today from hydrated usePredictiveStore immediately even when engine is unbooted/offline', async () => {
    const storeInput = buildEnsurePredictiveInput('p1', BIRTH, predictiveReferenceInstant(NOW, 'America/Los_Angeles'))!;
    await usePredictiveStore.getState().ensurePredictive({ computePredictive: async () => FULL_CONTEXTS }, storeInput);

    const { calls, reply } = await runOutlookTurn({ engine: null });
    expect(calls.map((c) => [c.toolName, c.status])).toEqual([['read_period', 'complete']]);
    expect(reply).toContain('Grounded today outlook in Novato.');
  });

  it('2. does not fail with superseded error when stored chart is un-reanchored and usePredictiveLayer writes', async () => {
    const computePredictive = vi.fn(async () => {
      const oldInput = buildEnsurePredictiveInput('p1', BIRTH, '2019-09-05T00:00:00Z')!;
      void usePredictiveStore.getState().ensurePredictive({ computePredictive: async () => FULL_CONTEXTS }, oldInput);
      return FULL_CONTEXTS;
    });
    const runtime = { computePredictive, computeMoonWindow: vi.fn(async () => ({ days: [] })), meta: () => null } as unknown as ChartEngine;
    const engine = { engine: runtime, error: null, startBootstrap: vi.fn(), whenReady: async () => runtime, reboot: async () => runtime } as unknown as ChartEngineContextValue;

    const { calls, reply } = await runOutlookTurn({
      engine,
      chartAsOf: { basis: 'chart', instant: new Date('2019-09-05T00:00:00Z') },
    });
    expect(calls.map((c) => [c.toolName, c.status])).toEqual([['read_period', 'complete']]);
    expect(reply).toContain('Grounded today outlook in Novato.');
  });

  it('3. recomputes when hydrated usePredictiveStore is ready for today but lacks period_reading', async () => {
    const storeInput = buildEnsurePredictiveInput('p1', BIRTH, predictiveReferenceInstant(NOW, 'America/Los_Angeles'))!;
    const withoutReading = { ...FULL_CONTEXTS, period_reading: undefined } as unknown as PredictiveContexts;
    await usePredictiveStore.getState().ensurePredictive({ computePredictive: async () => withoutReading }, storeInput);

    const computePredictive = vi.fn(async () => FULL_CONTEXTS);
    const runtime = { computePredictive, computeMoonWindow: vi.fn(async () => ({ days: [] })), meta: () => null } as unknown as ChartEngine;
    const engine = { engine: runtime, error: null, startBootstrap: vi.fn(), whenReady: async () => runtime, reboot: async () => runtime } as unknown as ChartEngineContextValue;

    const { calls, reply } = await runOutlookTurn({ engine });
    expect(computePredictive).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => [c.toolName, c.status])).toEqual([['read_period', 'complete']]);
    expect(reply).toContain('Grounded today outlook in Novato.');
  });

  it('4. follows transient WebKit boot failure ("Load failed") during SW reload', async () => {
    const runtime = { computePredictive: vi.fn(async () => FULL_CONTEXTS), computeMoonWindow: vi.fn(async () => ({ days: [] })), meta: () => null } as unknown as ChartEngine;
    let attempts = 0;
    const whenReady = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Load failed');
      return runtime;
    });
    const engine = { engine: null, error: null, startBootstrap: vi.fn(), whenReady, reboot: async () => runtime } as unknown as ChartEngineContextValue;

    const { calls, reply } = await runOutlookTurn({ engine });
    expect(whenReady).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => [c.toolName, c.status])).toEqual([['read_period', 'complete']]);
    expect(reply).toContain('Grounded today outlook in Novato.');
  });

  it('5. reboots once and succeeds when iOS Low Power Mode terminates a previously-ready Worker mid-turn', async () => {
    const freshRuntime = { computePredictive: vi.fn(async () => FULL_CONTEXTS), computeMoonWindow: vi.fn(async () => ({ days: [] })), meta: () => null } as unknown as ChartEngine;
    let liveEngine: ChartEngine | null = null;
    let liveError: Error | null = null;
    const deadRuntime = {
      computePredictive: vi.fn(async () => {
        const crash = new WorkerCrashError('chart worker terminated');
        liveEngine = null;
        liveError = crash;
        throw crash;
      }),
      computeMoonWindow: vi.fn(async () => ({ days: [] })),
      meta: () => null,
    } as unknown as ChartEngine;
    liveEngine = deadRuntime;
    const reboot = vi.fn(async () => {
      liveEngine = freshRuntime;
      liveError = null;
      return freshRuntime;
    });
    const engine = {
      get engine() { return liveEngine; },
      get error() { return liveError; },
      startBootstrap: vi.fn(),
      whenReady: async () => { throw liveError ?? new Error('dead'); },
      reboot,
    } as unknown as ChartEngineContextValue;

    const { calls, reply } = await runOutlookTurn({ engine });
    expect(reboot).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => [c.toolName, c.status])).toEqual([['read_period', 'complete']]);
    expect(calls[0]?.result).not.toHaveProperty('available', false);
    expect(reply).toContain('Grounded today outlook in Novato.');
  });

  it('6. reboots once and succeeds when read_varga (D60) hits a mid-turn Worker crash on iPhone', async () => {
    const vargaPayload = { chart: 'D60', lagna_sign: 'aries', lagna_sign_lord: 'mars', lagna_vargottama: false, placements: {} };
    const freshRuntime = { computeVargaDetail: vi.fn(async () => vargaPayload), meta: () => null } as unknown as ChartEngine;
    let liveError: Error | null = null;
    const deadRuntime = {
      computeVargaDetail: vi.fn(async () => {
        const crash = new WorkerCrashError('chart worker terminated');
        liveError = crash;
        throw crash;
      }),
      meta: () => null,
    } as unknown as ChartEngine;
    const reboot = vi.fn(async () => { liveError = null; return freshRuntime; });
    const engine = { get engine() { return liveError ? null : deadRuntime; }, get error() { return liveError; }, startBootstrap: vi.fn(), whenReady: async () => deadRuntime, reboot } as unknown as ChartEngineContextValue;
    const calls: ChatToolCall[] = [];
    const { fetchImpl } = stubEndpoint([
      { name: 'read_varga', args: { division: 'D60', focus_planets: null } },
      { name: 'answer', args: generalAnswer('D60 recovered after reboot.') },
    ]);
    let reply = '';
    const vargaChart = { ...CHART, lagna: { ...CHART.lagna, longitude: 15.2 } };
    for await (const snap of runChatTurn(makeTurnInput(fetchImpl, { chart: vargaChart, engine, question: 'Inspect my D60 Shashtiamsa chart', onToolCall: (c) => calls.push(c) }))) reply = snap;
    expect(reboot).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => [c.toolName, c.status])).toEqual([['read_varga', 'complete']]);
    expect(reply).toContain('D60 recovered after reboot.');
  });
});
