import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeshReading } from '@almamesh/llm';

import {
  MESH_READINGS_PERSIST_VERSION,
  createMeshReadingsStoreCreator,
  meshReadingIdentityMatches,
  meshReadingsStoreCreator,
  migrateMeshReadingsPersistedState,
  type MeshReadingEntry,
  type MeshReadingIdentity,
} from './meshReadings';

const READING: MeshReading = {
  connection: { title: 'Connection', layman: 'Warm.', technical: 'Exact facts.' },
  timing_together: { title: 'Timing', layman: 'Steady.', technical: 'Exact windows.' },
  care: { title: 'Care', layman: 'Listen.', technical: 'Exact contacts.' },
};

const IDENTITY: MeshReadingIdentity = {
  pairKey: 'anchor|member',
  profileIds: ['anchor', 'member'],
  edgeRequestKey: 'edge-v1',
  language: 'en',
};

function entry(identity: MeshReadingIdentity = IDENTITY): MeshReadingEntry {
  return {
    ...identity,
    generationMode: 'layman',
    provider: { engine: 'openai-http', model: 'model-a', baseUrl: 'https://example.test/v1' },
    generatedAt: '2026-10-03T12:00:00.000Z',
    reading: READING,
  };
}

describe('mesh readings store', () => {
  let store: ReturnType<typeof import('zustand/vanilla').createStore<
    ReturnType<typeof meshReadingsStoreCreator>
  >>;

  beforeEach(async () => {
    const { createStore } = await import('zustand/vanilla');
    store = createStore(meshReadingsStoreCreator);
  });

  it('keeps only the latest successful reading per stable pair key', async () => {
    const first = entry();
    const replacement = { ...entry(), generatedAt: '2026-10-03T13:00:00.000Z' };

    await store.getState().saveCompleted(first);
    await store.getState().saveCompleted(replacement);

    expect(store.getState().byPair).toEqual({ 'anchor|member': replacement });
  });

  it.each([
    ['edge request', { edgeRequestKey: 'edge-v2' }],
    ['language', { language: 'es' }],
    ['profile identity', { profileIds: ['anchor', 'other'] }],
  ] as const)('refuses a stale reading when %s changes', (_label, change) => {
    const stored = entry();
    const wanted = { ...IDENTITY, ...change } as MeshReadingIdentity;

    expect(meshReadingIdentityMatches(stored, wanted)).toBe(false);
  });

  it('keeps a saved dual-voice reading visible across mode and provider changes', () => {
    const stored = entry();
    const generatedDifferently = {
      ...stored,
      generationMode: 'expert' as const,
      provider: { ...stored.provider, model: 'different-model' },
    };

    expect(meshReadingIdentityMatches(stored, IDENTITY)).toBe(true);
    expect(meshReadingIdentityMatches(generatedDifferently, IDENTITY)).toBe(true);
  });

  it('returns only an exact identity match', async () => {
    await store.getState().saveCompleted(entry());

    expect(store.getState().getExact(IDENTITY)?.reading).toEqual(READING);
    expect(store.getState().getExact({ ...IDENTITY, language: 'pt' })).toBeUndefined();
  });

  it('removes every pair touching a deleted profile and supports a full reset', async () => {
    await store.getState().saveCompleted(entry());
    await store.getState().saveCompleted(
      entry({ ...IDENTITY, pairKey: 'anchor|other', profileIds: ['anchor', 'other'] }),
    );

    store.getState().deleteForProfile('member');
    expect(Object.keys(store.getState().byPair)).toEqual(['anchor|other']);

    store.getState().clearAll();
    expect(store.getState().byPair).toEqual({});
  });

  it('defensively drops malformed persisted entries', () => {
    expect(
      migrateMeshReadingsPersistedState(
        {
          byPair: {
            'anchor|member': entry(),
            bad: { ...entry(), profileIds: ['only-one'] },
          },
        },
        MESH_READINGS_PERSIST_VERSION,
      ),
    ).toEqual({ byPair: { 'anchor|member': entry() } });
  });

  it('leaves the last good in-memory reading untouched when canonical save fails', async () => {
    const { createStore } = await import('zustand/vanilla');
    const first = entry();
    const failure = new Error('canonical merge failed');
    const persistCompleted = vi
      .fn()
      .mockResolvedValueOnce({ [first.pairKey]: first })
      .mockRejectedValueOnce(failure);
    const durableStore = createStore(createMeshReadingsStoreCreator(persistCompleted));
    await durableStore.getState().saveCompleted(first);
    const replacement = { ...first, generatedAt: '2026-10-03T14:00:00.000Z' };

    await expect(durableStore.getState().saveCompleted(replacement)).rejects.toBe(failure);

    expect(durableStore.getState().byPair).toEqual({ [first.pairKey]: first });
    expect(persistCompleted).toHaveBeenCalledTimes(2);
  });

  it('adopts pairs that another tab committed during the canonical merge', async () => {
    const { createStore } = await import('zustand/vanilla');
    const mine = entry();
    const other = entry({
      ...IDENTITY,
      pairKey: 'other|friend',
      profileIds: ['other', 'friend'],
    });
    const durableStore = createStore(
      createMeshReadingsStoreCreator(async () => ({
        [other.pairKey]: other,
        [mine.pairKey]: mine,
      })),
    );

    await durableStore.getState().saveCompleted(mine);

    expect(durableStore.getState().byPair).toEqual({
      [other.pairKey]: other,
      [mine.pairKey]: mine,
    });
  });
});
