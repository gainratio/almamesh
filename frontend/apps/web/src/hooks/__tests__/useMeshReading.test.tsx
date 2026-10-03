import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeshReading } from '@almamesh/llm';
import type { MeshEdgeCtx } from '@almamesh/shared-types';
import type { MeshReadingEntry, MeshReadingIdentity } from '@almamesh/store';

const mocks = vi.hoisted(() => ({
  contentMode: 'layman' as 'layman' | 'technical',
  language: 'en' as 'en' | 'es' | 'pt',
  getExact: vi.fn<(identity: MeshReadingIdentity) => MeshReadingEntry | undefined>(),
  saveCompleted: vi.fn(),
  stream: vi.fn(),
  lifecycleReady: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../lib/profileDataLifecycle', () => ({
  whenDataLifecycleReady: () => mocks.lifecycleReady(),
}));

vi.mock('@almamesh/store', () => {
  const contentStore = (selector: (state: { contentMode: string }) => unknown): unknown =>
    selector({ contentMode: mocks.contentMode });
  const languageStore = (selector: (state: { language: string }) => unknown): unknown =>
    selector({ language: mocks.language });
  languageStore.getState = () => ({ language: mocks.language });
  const readingsStore = (selector: (state: unknown) => unknown): unknown =>
    selector({ getExact: mocks.getExact });
  readingsStore.getState = () => ({
    getExact: mocks.getExact,
    saveCompleted: mocks.saveCompleted,
  });
  return {
    useContentModeStore: contentStore,
    useLanguageStore: languageStore,
    useMeshReadingsStore: readingsStore,
  };
});

vi.mock('@almamesh/llm', () => ({
  applyInterpretationSettings: (env: unknown) => env,
  resolveProviderConfig: () => ({
    engine: 'openai-http',
    model: 'model-a',
    baseUrl: 'https://example.test/v1',
    privacyMode: 'cloud_premium',
  }),
  configProvenance: () => ({
    engine: 'openai-http',
    model: 'model-a',
    baseUrl: 'https://example.test/v1',
  }),
  streamMeshReading: (...args: unknown[]) => mocks.stream(...args),
}));

import { useMeshReading, type MeshReadingContext } from '../useMeshReading';

const READING: MeshReading = {
  connection: { title: 'Connection', layman: 'Warm.', technical: 'Exact facts.' },
  timing_together: { title: 'Timing', layman: 'Steady.', technical: 'Exact windows.' },
  care: { title: 'Care', layman: 'Listen.', technical: 'Exact contacts.' },
};

const EDGE = { relationship: 'spouse' } as MeshEdgeCtx;
const CONTEXT: MeshReadingContext = {
  pairKey: 'anchor|member',
  profileIds: ['anchor', 'member'],
  edgeRequestKey: 'edge-v1',
};

function storedReading(): MeshReadingEntry {
  return {
    ...CONTEXT,
    language: 'en',
    generationMode: 'layman',
    provider: {
      engine: 'openai-http',
      model: 'model-a',
      baseUrl: 'https://example.test/v1',
    },
    generatedAt: '2026-10-03T12:00:00.000Z',
    reading: READING,
  };
}

describe('useMeshReading durability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contentMode = 'layman';
    mocks.language = 'en';
    mocks.getExact.mockReturnValue(undefined);
    mocks.saveCompleted.mockResolvedValue(undefined);
    mocks.lifecycleReady.mockResolvedValue(undefined);
  });

  it('hydrates an exact saved reading and keeps both voices across a content-mode toggle', async () => {
    mocks.getExact.mockReturnValue(storedReading());
    const { result, rerender } = renderHook(() => useMeshReading(EDGE, CONTEXT));

    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(result.current.reading).toEqual(READING);

    mocks.contentMode = 'technical';
    rerender();
    expect(result.current.status).toBe('complete');
    expect(result.current.reading).toEqual(READING);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('does not display a saved narration for a different deterministic edge identity', async () => {
    mocks.getExact.mockImplementation((identity) =>
      identity.edgeRequestKey === 'edge-v1' ? storedReading() : undefined,
    );
    const { result } = renderHook(() =>
      useMeshReading(EDGE, { ...CONTEXT, edgeRequestKey: 'edge-v2' }),
    );

    await waitFor(() => expect(mocks.getExact).toHaveBeenCalled());
    expect(result.current.status).toBe('idle');
    expect(result.current.reading).toBeUndefined();
  });

  it('persists only the final complete event with identity and secret-free provenance', async () => {
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'section_complete', section: 'connection' };
      yield { type: 'complete', reading: READING };
    });
    const { result } = renderHook(() => useMeshReading(EDGE, CONTEXT));

    act(() => result.current.generate());
    await waitFor(() => expect(result.current.status).toBe('complete'));

    expect(mocks.saveCompleted).toHaveBeenCalledOnce();
    expect(mocks.saveCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        ...CONTEXT,
        language: 'en',
        generationMode: 'layman',
        reading: READING,
      }),
    );
    expect(mocks.saveCompleted.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
  });

  it('does not overwrite the prior completed entry when replacement fails', async () => {
    mocks.getExact.mockReturnValue(storedReading());
    mocks.stream.mockImplementation(async function* () {
      yield* [];
      throw new Error('provider unavailable');
    });
    const { result } = renderHook(() => useMeshReading(EDGE, CONTEXT));
    await waitFor(() => expect(result.current.status).toBe('complete'));

    act(() => result.current.generate());
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(mocks.saveCompleted).not.toHaveBeenCalled();
    expect(result.current.reading).toEqual(READING);
    expect(mocks.getExact(CONTEXT as MeshReadingIdentity)?.reading).toEqual(READING);
  });

  it('does not report completion when canonical SQLite rejects the paid reading', async () => {
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'complete', reading: READING };
    });
    mocks.saveCompleted.mockRejectedValueOnce(new Error('canonical SQLite write failed'));
    const { result } = renderHook(() => useMeshReading(EDGE, CONTEXT));

    act(() => result.current.generate());

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toContain('canonical SQLite write failed');
    expect(result.current.reading).toBeUndefined();
  });

  it('does not start a paid stream until restore/deletion reconciliation is ready', async () => {
    const ready = Promise.withResolvers<void>();
    mocks.lifecycleReady.mockReturnValueOnce(ready.promise);
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'complete', reading: READING };
    });
    const { result } = renderHook(() => useMeshReading(EDGE, CONTEXT));

    act(() => result.current.generate());
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    expect(mocks.stream).not.toHaveBeenCalled();

    ready.resolve();
    await waitFor(() => expect(result.current.status).toBe('complete'));
    expect(mocks.stream).toHaveBeenCalledOnce();
  });
});
