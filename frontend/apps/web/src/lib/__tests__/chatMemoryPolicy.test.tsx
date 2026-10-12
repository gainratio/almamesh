import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as storeApi from '@almamesh/store';

import {
  migrateChatPersistedState,
  DELETION_TOMBSTONES_KEY,
  CHAT_PERSIST_VERSION,
  PROFILES_PERSIST_VERSION,
  readDeletionTombstones,
  resetSessionStateForTests,
  sessionRowsForTests,
  useChatStore,
  useProfilesStore,
  whenChatCommitted,
  whenProfilesCommitted,
} from '@almamesh/store';
import type { DeviceTier } from '@almamesh/browser';

const doubles = vi.hoisted(() => ({
  tier: 'minimal' as DeviceTier,
  createMemory: vi.fn(),
  createVectorStore: vi.fn(),
  createWorkerEmbedder: vi.fn(),
}));

vi.mock('@almamesh/browser', async (original) => {
  const actual = await original<typeof import('@almamesh/browser')>();
  return { ...actual, devicePolicy: () => actual.devicePolicy(doubles.tier) };
});

vi.mock('@almamesh/memory', async (original) => ({
  ...(await original<typeof import('@almamesh/memory')>()),
  createMemory: doubles.createMemory,
  createVectorStore: doubles.createVectorStore,
  createWorkerEmbedder: doubles.createWorkerEmbedder,
}));

import {
  __resetMemoryForTest,
  clearMemory,
  deleteMemoryForProfile,
  deleteMemoryForThread,
  indexChatMessage,
  rebuildMemory,
  retrieveContext,
  searchMemory,
} from '../chatMemory';
import { useChatThread } from '../../hooks/useChatThread';

const vector = {
  deleteForProfile: vi.fn().mockResolvedValue(undefined),
  deleteForThread: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
};
const semantic = {
  indexMessage: vi.fn().mockResolvedValue(undefined),
  retrieve: vi.fn().mockResolvedValue([{ text: 'semantic result', message_id: 'm', thread_id: 't', score: 1 }]),
  deleteForProfile: vi.fn(),
  deleteForThread: vi.fn(),
  clear: vi.fn().mockResolvedValue(undefined),
};

beforeEach(async () => {
  resetSessionStateForTests();
  __resetMemoryForTest();
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
  await Promise.all([useChatStore.persist.rehydrate(), useProfilesStore.persist.rehydrate()]);
  vi.clearAllMocks();
  doubles.tier = 'minimal';
  doubles.createVectorStore.mockReturnValue(vector);
  doubles.createMemory.mockReturnValue(semantic);
  doubles.createWorkerEmbedder.mockReturnValue({ embed: vi.fn() });
});

afterEach(() => {
  __resetMemoryForTest();
  vi.restoreAllMocks();
});

describe.each(['minimal', 'lite'] as const)('%s canonical chat memory', (tier) => {
  it('never creates the embedder or semantic index for first send, retrieval, search, or rebuild', async () => {
    doubles.tier = tier;
    const profile = useProfilesStore.getState().createProfile('Test');
    const { result, unmount } = renderHook(() => useChatThread(profile, null));
    await act(async () => {
      await result.current.submit('Tell me about career', async () => 'Career requires steady effort.');
    });
    const state = useChatStore.getState();
    const thread = state.listThreads(profile)[0];
    expect(state.messages[thread.id].map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(await retrieveContext('career', profile)).toContain('Career requires steady effort.');
    expect(await searchMemory('career', profile)).toEqual(expect.arrayContaining([
      expect.objectContaining({ thread_id: thread.id, text: 'Career requires steady effort.' }),
    ]));
    await rebuildMemory([{ id: 'restored', profile_id: profile, thread_id: thread.id, content: 'career' }]);
    expect(doubles.createWorkerEmbedder).not.toHaveBeenCalled();
    expect(doubles.createMemory).not.toHaveBeenCalled();
    expect(doubles.createVectorStore).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps canonical saves and retrieval after rehydrating, and excludes deleted/error/system/foreign messages', async () => {
    doubles.tier = tier;
    const profile = useProfilesStore.getState().createProfile('First');
    const other = useProfilesStore.getState().createProfile('Second');
    const store = useChatStore.getState();
    const thread = store.startThread(profile);
    store.appendMessage(thread, 'assistant', 'career from the canonical history');
    store.appendMessage(thread, 'assistant', 'career failed response', { error: true });
    store.appendMessage(thread, 'system', 'career system instruction');
    store.appendMessage(thread, 'user', '  ');
    const foreign = store.startThread(other);
    store.appendMessage(foreign, 'assistant', 'career foreign');
    const deleted = store.startThread(profile);
    store.appendMessage(deleted, 'assistant', 'career deleted thread');
    sessionRowsForTests().set(DELETION_TOMBSTONES_KEY, {
      ...(await readDeletionTombstones()), threadIds: [deleted],
    });
    const state = useChatStore.getState();
    const snapshot = JSON.stringify({ threads: state.threads, messages: state.messages, summaries: state.summaries });
    useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
    useChatStore.setState(migrateChatPersistedState(JSON.parse(snapshot), 3));
    expect(await retrieveContext('career', profile)).toEqual(['career from the canonical history']);
    sessionRowsForTests().set(DELETION_TOMBSTONES_KEY, {
      ...(await readDeletionTombstones()), profileIds: [profile],
    });
    expect(await searchMemory('career', profile)).toEqual([]);
    expect(doubles.createWorkerEmbedder).not.toHaveBeenCalled();
    expect(doubles.createVectorStore).not.toHaveBeenCalled();
  });

  it('bounds result count, snippet length, and prompt context for long canonical histories', async () => {
    doubles.tier = tier;
    const profile = useProfilesStore.getState().createProfile('Test');
    const store = useChatStore.getState();
    const thread = store.startThread(profile);
    for (let index = 0; index < 50; index += 1) {
      store.appendMessage(thread, 'assistant', `career ${'long content '.repeat(600)}`);
    }
    const hits = await searchMemory('career', profile, 100_000);
    expect(hits).toHaveLength(8);
    expect(hits.every((hit) => hit.text.length <= 512)).toBe(true);
    expect(await retrieveContext('career', profile)).toHaveLength(5);
    expect(await searchMemory('career', profile, 0)).toEqual([]);
    expect(await searchMemory('career', profile, Number.NaN)).toEqual([]);
  });

  it('withholds a pre-restore snapshot until both canonical stores hydrate the completed generation', async () => {
    doubles.tier = tier;
    const profile = useProfilesStore.getState().createProfile('Test');
    const store = useChatStore.getState();
    const thread = store.startThread(profile);
    const oldMessage = store.appendMessage(thread, 'assistant', 'career before the restore');
    await Promise.all([whenChatCommitted(), whenProfilesCommitted()]);
    const previousLedger = await readDeletionTombstones();
    const nextEpoch = previousLedger.activeEpoch + 1;
    const profiles = useProfilesStore.getState();
    sessionRowsForTests().set('almamesh-profiles', JSON.stringify({
      state: { profiles: profiles.profiles, activeProfileId: profiles.activeProfileId },
      version: PROFILES_PERSIST_VERSION, datasetEpoch: nextEpoch,
    }));
    sessionRowsForTests().set('almamesh-chat-history', JSON.stringify({
      state: { threads: useChatStore.getState().threads, summaries: {}, messages: {
        [thread]: [{ ...oldMessage, content: 'career from the restored history' }],
      } },
      version: CHAT_PERSIST_VERSION, datasetEpoch: nextEpoch,
    }));
    sessionRowsForTests().set(DELETION_TOMBSTONES_KEY, {
      ...previousLedger, activeEpoch: nextEpoch, restoreEpoch: nextEpoch,
      restoreInProgress: false, memoryRebuildPending: true,
    });
    expect(await retrieveContext('career', profile)).toEqual([]);
    await useChatStore.persist.rehydrate();
    expect(await searchMemory('career', profile)).toEqual([]);
    await useProfilesStore.persist.rehydrate();
    expect(await retrieveContext('career', profile)).toEqual(['career from the restored history']);
    expect(doubles.createWorkerEmbedder).not.toHaveBeenCalled();
    expect(doubles.createVectorStore).not.toHaveBeenCalled();
  });

  it('fails closed when a rehydrate starts during the awaited ledger read', async () => {
    doubles.tier = tier;
    const profile = useProfilesStore.getState().createProfile('Test');
    const thread = useChatStore.getState().startThread(profile);
    useChatStore.getState().appendMessage(thread, 'assistant', 'career before rehydrate');
    await Promise.all([whenChatCommitted(), whenProfilesCommitted()]);
    const currentLedger = await readDeletionTombstones();
    let releaseLedger!: (ledger: typeof currentLedger) => void;
    const heldLedger = new Promise<typeof currentLedger>((resolve) => { releaseLedger = resolve; });
    const ledgerRead = vi.spyOn(storeApi, 'readDeletionTombstones').mockReturnValueOnce(heldLedger);
    const retrieval = retrieveContext('career', profile);
    await vi.waitFor(() => expect(ledgerRead).toHaveBeenCalledTimes(1));
    const storage = useChatStore.persist.getOptions().storage!;
    let releaseStorage!: (value: null) => void;
    const heldStorage = new Promise<null>((resolve) => { releaseStorage = resolve; });
    vi.spyOn(storage, 'getItem').mockReturnValueOnce(heldStorage);
    const rehydrating = useChatStore.persist.rehydrate();
    expect(useChatStore.persist.hasHydrated()).toBe(false);
    releaseLedger(currentLedger);
    const result = await retrieval;
    releaseStorage(null);
    await rehydrating;
    expect(result).toEqual([]);
    expect(doubles.createWorkerEmbedder).not.toHaveBeenCalled();
  });

  it('purges old vector rows without an embedder and releases the cleanup adapter', async () => {
    doubles.tier = tier;
    await deleteMemoryForProfile('old-profile');
    await deleteMemoryForThread('old-thread');
    await clearMemory();
    expect(vector.deleteForProfile).toHaveBeenCalledWith('old-profile');
    expect(vector.deleteForThread).toHaveBeenCalledWith('old-thread');
    expect(vector.clear).toHaveBeenCalledTimes(1);
    expect(vector.dispose).toHaveBeenCalledTimes(3);
    expect(doubles.createMemory).not.toHaveBeenCalled();
    expect(doubles.createWorkerEmbedder).not.toHaveBeenCalled();
  });

  it('still releases a failed cleanup and can perform the next deletion', async () => {
    doubles.tier = tier;
    vector.deleteForProfile.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(deleteMemoryForProfile('p')).rejects.toThrow('cleanup failed');
    expect(vector.dispose).toHaveBeenCalledTimes(1);
    await deleteMemoryForThread('t');
    expect(vector.deleteForThread).toHaveBeenCalledWith('t');
    expect(vector.dispose).toHaveBeenCalledTimes(2);
    expect(doubles.createWorkerEmbedder).not.toHaveBeenCalled();
  });

  it('serializes cleanup adapters so concurrent deletion does not keep competing SQLite Workers', async () => {
    doubles.tier = tier;
    const order: string[] = [];
    vector.deleteForProfile.mockImplementationOnce(async () => { order.push('profile'); });
    vector.deleteForThread.mockImplementationOnce(async () => { order.push('thread'); });
    vector.dispose.mockImplementationOnce(async () => { order.push('dispose-profile'); });
    vector.dispose.mockImplementationOnce(async () => { order.push('dispose-thread'); });
    await Promise.all([deleteMemoryForProfile('p'), deleteMemoryForThread('t')]);
    expect(order).toEqual(['profile', 'dispose-profile', 'thread', 'dispose-thread']);
    expect(doubles.createWorkerEmbedder).not.toHaveBeenCalled();
  });
});

it('preserves semantic indexing and retrieval on full devices', async () => {
  doubles.tier = 'full';
  const message = { id: 'm', thread_id: 't', profile_id: 'p', content: 'career' };
  await indexChatMessage(message);
  expect(await retrieveContext('career', 'p')).toEqual(['semantic result']);
  expect(await searchMemory('career', 'p')).toEqual(await semantic.retrieve('career', 'p', 8));
  await rebuildMemory([message]);
  expect(semantic.indexMessage).toHaveBeenCalledWith(message);
  expect(semantic.clear).toHaveBeenCalledTimes(1);
  expect(doubles.createMemory).toHaveBeenCalledTimes(1);
  expect(doubles.createWorkerEmbedder).toHaveBeenCalledTimes(1);
  expect(doubles.createVectorStore).toHaveBeenCalledTimes(1);
});
