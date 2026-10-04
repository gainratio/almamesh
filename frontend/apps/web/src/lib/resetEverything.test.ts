/**
 * Tests for the "Reset chart / start fresh" coordinator and the per-store
 * `clearAll` actions it composes.
 *
 * Reset semantics under test:
 *  - CLEARED: chart library, profiles,
 *    life events, chat history, interpretations, in-memory mesh edges.
 *  - PRESERVED: canonical SQLite device preferences and the OPFS engine bundle.
 *    Obsolete Web Storage duplicates are removed.
 *
 * All fixtures are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { del as idbDel } from 'idb-keyval';

import { SemanticMemoryStorageUnavailableError } from '@almamesh/memory';
import type { VedicInterpretation } from '@almamesh/shared-types';
import {
  CHART_LIBRARY_FLAG_KEY,
  holdUnreadableInterpretation,
  interpretationQuarantineRows,
  readInterpretationQuarantine,
  resetSessionStateForTests,
  setActiveProfileScope,
  useChartLibraryStore,
  useChatStore,
  useInterpretationStore,
  useLifeEventsStore,
  useMeshStore,
  useMeshReadingsStore,
  usePredictiveStore,
  useProfilesStore,
  useRectificationRecordsStore,
  type StoredChart,
} from '@almamesh/store';

import { clearMemory } from './chatMemory';
import { resetEverything } from './resetEverything';

vi.mock('./chatMemory', () => ({ clearMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock('idb-keyval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb-keyval')>();
  return { ...actual, del: vi.fn().mockResolvedValue(undefined) };
});

const LANGUAGE_KEY = 'almamesh-language';
const LLM_SETTINGS_KEY = 'almamesh-llm-settings';
const INTERPRETATIONS_KEY = 'almamesh-interpretations';
const LEGACY_IDB_KEYS = [
  'almamesh-chart-library',
  'almamesh-profiles',
  'almamesh-life-events',
  'almamesh-chat-history',
  'almamesh-rectification-records',
  'almamesh-predictive',
  'almamesh-interpretations',
  'almamesh-mesh-readings',
  // Older builds kept RAG vectors here; vectors now live in SqliteVectorIndex.
  'almamesh-chat-vectors',
] as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A minimal synthetic chart — only the fields the library store reads. */
function makeChart(chartId: string): StoredChart {
  return {
    chart_id: chartId,
    person_name: 'Test Native',
    is_primary: true,
  } as unknown as StoredChart;
}

/** A minimal valid `VedicInterpretation` (mirrors interpretation.test.ts). */
function makeInterpretation(): VedicInterpretation {
  return {
    summary: { layman: 'A bright year.', technical: 'Jupiter strong.' },
    strengths: [],
    challenges: [],
    life_themes: [],
  };
}

/** Seed every owned store + the preserved/erased localStorage keys. */
function seedEverything(): { profileId: string; chartId: string } {
  const profileId = useProfilesStore.getState().createProfile('Alice');
  const chartId = 'chart-1';
  useChartLibraryStore.getState().saveChart(makeChart(chartId));
  useLifeEventsStore
    .getState()
    .addEvent(profileId, { description: 'Married', date: '2010-06-01' });
  const threadId = useChatStore.getState().ensureThread(profileId, chartId);
  useChatStore.getState().appendMessage(threadId, 'user', 'Tell me about my chart');
  useInterpretationStore
    .getState()
    .setInterpretation(chartId, makeInterpretation(), '2026-06-29T00:00:00.000Z');
  useMeshStore.setState({ edges: { [`${profileId}|other`]: { status: 'idle' } } });
  useMeshReadingsStore.setState({
    byPair: { [`${profileId}|other`]: { profileIds: [profileId, 'other'] } },
  } as never);
  useRectificationRecordsStore.setState({
    recordsByProfile: { [profileId]: { profileId } },
  } as never);
  usePredictiveStore.setState({ status: 'ready', profileKey: profileId, requestKey: 'ready' });
  return { profileId, chartId };
}

beforeEach(() => {
  // Clean slate WITHOUT exercising the code under test.
  localStorage.clear();
  // Node has no SQLite Worker: the dataset ledger lives in session memory.
  resetSessionStateForTests();
  setActiveProfileScope(null);
  useChartLibraryStore.setState({ charts: {} });
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
  useLifeEventsStore.setState({ eventsByProfile: {} });
  useChatStore.setState({ threads: {}, messages: {} });
  useInterpretationStore.setState({ byChart: {} });
  useMeshStore.setState({ edges: {} });
  useMeshReadingsStore.setState({ byPair: {} });
  useRectificationRecordsStore.setState({ recordsByProfile: {} });
  usePredictiveStore.getState().reset();
  vi.mocked(clearMemory).mockClear();
  vi.mocked(idbDel).mockReset().mockResolvedValue(undefined);
});

describe('store clearAll actions', () => {
  it('chartLibrary.clearAll empties charts without creating a route-guard flag', () => {
    useChartLibraryStore.getState().saveChart(makeChart('c1'));
    expect(localStorage.getItem(CHART_LIBRARY_FLAG_KEY)).toBeNull();

    useChartLibraryStore.getState().clearAll();

    expect(useChartLibraryStore.getState().listAllCharts()).toEqual([]);
    expect(localStorage.getItem(CHART_LIBRARY_FLAG_KEY)).toBeNull();
  });

  it('profiles.clearAll empties profiles and resets active focus + scope', () => {
    const id = useProfilesStore.getState().createProfile('Bob');
    expect(useProfilesStore.getState().listProfiles()).toHaveLength(1);

    useProfilesStore.getState().clearAll();

    expect(useProfilesStore.getState().listProfiles()).toEqual([]);
    expect(useProfilesStore.getState().activeProfileId).toBeNull();
    void id;
  });

  it('lifeEvents.clearAll empties every profile bucket', () => {
    useLifeEventsStore.getState().addEvent('p1', { description: 'Moved', date: '2015-01-01' });
    expect(useLifeEventsStore.getState().getEvents('p1')).toHaveLength(1);

    useLifeEventsStore.getState().clearAll();

    expect(useLifeEventsStore.getState().eventsByProfile).toEqual({});
  });

  it('chat.clearAll empties threads and messages', () => {
    const threadId = useChatStore.getState().ensureThread('p1');
    useChatStore.getState().appendMessage(threadId, 'user', 'hi');
    expect(useChatStore.getState().listThreads('p1')).toHaveLength(1);

    useChatStore.getState().clearAll();

    expect(useChatStore.getState().threads).toEqual({});
    expect(useChatStore.getState().messages).toEqual({});
  });

  it('interpretation.clearAll empties every chart entry', () => {
    useInterpretationStore
      .getState()
      .setInterpretation('c1', makeInterpretation(), '2026-06-29T00:00:00.000Z');
    expect(useInterpretationStore.getState().getEntry('c1')).toBeDefined();

    useInterpretationStore.getState().clearAll();

    expect(useInterpretationStore.getState().byChart).toEqual({});
  });
});

describe('resetEverything', () => {
  it('publishes reset only after its fenced empty generation is durable', async () => {
    seedEverything();
    const events: string[] = [];
    vi.mocked(clearMemory).mockImplementationOnce(async () => {
      events.push('clear-memory');
    });
    const beginDatasetReset = vi.fn(async () => {
      events.push('begin');
      return 9;
    });
    const clearPersisted = vi.fn(async () => {
      events.push('clear-persisted');
    });
    const finalizeDatasetReset = vi.fn(async () => {
      events.push('finalize');
    });
    const publishDatasetReset = vi.fn(() => {
      events.push('publish');
    });

    await resetEverything({
      waitForHydration: () => Promise.resolve(),
      beginDatasetReset,
      clearPersisted,
      finalizeDatasetReset,
      publishDatasetReset,
    });

    expect(finalizeDatasetReset).toHaveBeenCalledWith(9);
    expect(publishDatasetReset).toHaveBeenNthCalledWith(1, {
      kind: 'dataset',
      operation: 'reset',
      phase: 'begin',
    });
    expect(publishDatasetReset).toHaveBeenNthCalledWith(2, {
      kind: 'dataset',
      operation: 'reset',
      phase: 'complete',
    });
    expect(events).toEqual([
      'begin',
      'publish',
      'clear-memory',
      'clear-persisted',
      'finalize',
      'publish',
    ]);
  });

  it('waits for every persisted store hydration barrier before deleting anything', async () => {
    const hydration = deferred();
    const waitForHydration = vi.fn(() => hydration.promise);

    const pending = resetEverything({
      waitForHydration,
      clearPersisted: () => Promise.resolve(),
    });
    await Promise.resolve();

    expect(waitForHydration).toHaveBeenCalledTimes(1);
    expect(clearMemory).not.toHaveBeenCalled();

    hydration.resolve();
    await pending;
    expect(clearMemory).toHaveBeenCalledTimes(1);
  });

  it('does not resolve until every durable persistence deletion finishes', async () => {
    const deletion = deferred();
    const clearPersisted = vi.fn(() => deletion.promise);
    let settled = false;

    const pending = resetEverything({
      waitForHydration: () => Promise.resolve(),
      beginDatasetReset: () => Promise.resolve(1),
      finalizeDatasetReset: () => Promise.resolve(),
      clearPersisted,
    }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(clearPersisted).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    deletion.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it('commits the fenced reset when optional semantic storage is unavailable', async () => {
    const clearPersisted = vi.fn(async () => undefined);
    vi.mocked(clearMemory).mockRejectedValueOnce(
      new SemanticMemoryStorageUnavailableError(new DOMException('OPFS unavailable')),
    );

    await expect(
      resetEverything({
        waitForHydration: () => Promise.resolve(),
        beginDatasetReset: () => Promise.resolve(4),
        clearPersisted,
      }),
    ).resolves.toBeUndefined();

    expect(clearPersisted).toHaveBeenCalledWith(4);
  });

  it('still aborts when semantic memory fails for a non-capability reason', async () => {
    const clearPersisted = vi.fn(async () => undefined);
    vi.mocked(clearMemory).mockRejectedValueOnce(new Error('SQLite clear failed'));

    await expect(
      resetEverything({
        waitForHydration: () => Promise.resolve(),
        beginDatasetReset: () => Promise.resolve(4),
        clearPersisted,
      }),
    ).rejects.toThrow('SQLite clear failed');

    expect(clearPersisted).not.toHaveBeenCalled();
  });

  it('rejects when durable persistence deletion fails', async () => {
    const failure = new Error('IndexedDB deletion blocked');

    await expect(
      resetEverything({
        waitForHydration: () => Promise.resolve(),
        clearPersisted: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });

  it('propagates a legacy keyval cleanup failure and aborts the fenced reset', async () => {
    const failure = new Error('Legacy IndexedDB deletion blocked');
    const abortDatasetReset = vi.fn(async () => undefined);
    vi.mocked(idbDel).mockImplementation(async (key) => {
      if (key === 'almamesh-profiles') throw failure;
    });

    await expect(
      resetEverything({
        waitForHydration: () => Promise.resolve(),
        beginDatasetReset: () => Promise.resolve(11),
        clearPersisted: () => Promise.resolve(),
        abortDatasetReset,
      }),
    ).rejects.toBe(failure);

    expect(abortDatasetReset).toHaveBeenCalledOnce();
    expect(abortDatasetReset).toHaveBeenCalledWith(11);
  });

  it('clears every owned store and obsolete Web Storage duplicates', async () => {
    localStorage.setItem(LANGUAGE_KEY, JSON.stringify({ state: { language: 'es' }, version: 0 }));
    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify({ endpoint: 'https://example' }));
    const { profileId, chartId } = seedEverything();

    expect(localStorage.getItem(CHART_LIBRARY_FLAG_KEY)).toBeNull();
    expect(useInterpretationStore.getState().getEntry(chartId)).toBeDefined();

    await resetEverything();

    // Cleared:
    expect(useChartLibraryStore.getState().listAllCharts()).toEqual([]);
    expect(useProfilesStore.getState().listProfiles()).toEqual([]);
    expect(useLifeEventsStore.getState().getEvents(profileId)).toEqual([]);
    expect(useChatStore.getState().threads).toEqual({});
    expect(useInterpretationStore.getState().getEntry(chartId)).toBeUndefined();
    expect(useMeshStore.getState().edges).toEqual({});
    expect(useMeshReadingsStore.getState().byPair).toEqual({});
    expect(useRectificationRecordsStore.getState().recordsByProfile).toEqual({});
    expect(usePredictiveStore.getState().status).toBe('idle');
    expect(usePredictiveStore.getState().profileKey).toBeUndefined();
    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CHART_LIBRARY_FLAG_KEY)).toBeNull();
    expect(localStorage.getItem(INTERPRETATIONS_KEY)).toBeNull();

    // Canonical preferences live in SQLite; obsolete browser duplicates go.
    expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LLM_SETTINGS_KEY)).toBeNull();
  });

  it('start fresh erases the SQLite quarantine and an old build’s localStorage copy', async () => {
    const rows = await interpretationQuarantineRows();
    for (const raw of ['unattributed-unreadable', '{"state":{"byChart":{"c":{"profileId":"p"}}}}']) {
      expect(await holdUnreadableInterpretation({ source: 'canonical-sqlite', raw }, rows)).toBe(true);
    }
    localStorage.setItem(
      'almamesh-interpretations.quarantine',
      JSON.stringify([{ quarantinedAt: '2026-10-04T12:00:00.000Z', source: 'legacy-local-storage', raw: 'x' }]),
    );
    seedEverything();

    await resetEverything();

    expect(await readInterpretationQuarantine(rows)).toEqual([]);
    expect(localStorage.getItem('almamesh-interpretations.quarantine')).toBeNull();
  });

  it('removes every legacy row and Web Storage duplicate while preserving the OPFS engine', async () => {
    localStorage.setItem(LANGUAGE_KEY, JSON.stringify({ state: { language: 'pt' }, version: 0 }));
    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify({ model: 'local' }));
    const legacyRows = new Map<string, { stale: boolean }>(
      LEGACY_IDB_KEYS.map((key) => [key, { stale: true }]),
    );
    vi.mocked(idbDel).mockImplementation(async (key) => {
      legacyRows.delete(String(key));
    });
    const getDirectory = vi.fn();
    Object.defineProperty(navigator, 'storage', {
      value: { getDirectory },
      configurable: true,
    });

    await resetEverything({
      waitForHydration: () => Promise.resolve(),
      beginDatasetReset: () => Promise.resolve(7),
      clearPersisted: () => Promise.resolve(),
    });

    expect(legacyRows.size).toBe(0);
    expect(vi.mocked(idbDel).mock.calls.map(([key]) => key)).toEqual(LEGACY_IDB_KEYS);
    expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LLM_SETTINGS_KEY)).toBeNull();
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('never touches the OPFS engine bundle', async () => {
    const getDirectory = vi.fn();
    Object.defineProperty(navigator, 'storage', {
      value: { getDirectory },
      configurable: true,
    });
    seedEverything();

    await resetEverything();

    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('resolves cleanly so the caller can then navigate', async () => {
    await expect(resetEverything()).resolves.toBeUndefined();
  });

  it('calls native localStorage methods with their required receiver', async () => {
    const originalStorage = globalThis.localStorage;
    const storage = {
      removeItem: vi.fn(function (this: unknown) {
        if (this !== storage) throw new TypeError('Illegal invocation');
      }),
    };
    vi.stubGlobal('localStorage', storage);

    try {
      await resetEverything({
        waitForHydration: () => Promise.resolve(),
        clearPersisted: () => Promise.resolve(),
        beginDatasetReset: () => Promise.resolve(1),
      });
      expect(storage.removeItem).toHaveBeenCalledWith(CHART_LIBRARY_FLAG_KEY);
      expect(storage.removeItem).toHaveBeenCalledWith(INTERPRETATIONS_KEY);
    } finally {
      vi.stubGlobal('localStorage', originalStorage);
    }
  });

  it('does not crash when an SSR host exposes a partial localStorage shell', async () => {
    vi.stubGlobal('localStorage', {});
    await expect(
      resetEverything({
        waitForHydration: () => Promise.resolve(),
        clearPersisted: () => Promise.resolve(),
        beginDatasetReset: () => Promise.resolve(1),
        finalizeDatasetReset: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();
  });
});
