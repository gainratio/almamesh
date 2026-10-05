import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VedicInterpretation } from '@almamesh/shared-types';
import {
  EMPTY_PORTABLE_REPAIR_REPORT,
  resetSessionStateForTests,
  setActiveProfileScope,
  readDeletionTombstones,
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

import {
  applyRemoteDeletionNotice,
  deleteChatThreadData,
  deleteProfileData,
  reconcilePortableReferences,
  resumePendingMemoryRebuild,
} from './profileDataLifecycle';
import { LLM_SETTINGS_CHANGED_EVENT } from './llmSettingsEvents';

function chart(chartId: string, profileId: string): StoredChart {
  return { chart_id: chartId, profile_id: profileId, person_name: profileId, is_primary: true } as StoredChart;
}

function interpretation(summary: string): VedicInterpretation {
  return { summary: { layman: summary, technical: summary }, strengths: [], challenges: [], life_themes: [] };
}

beforeEach(() => {
  // Node has no SQLite Worker: the dataset ledger lives in session memory.
  resetSessionStateForTests();
  setActiveProfileScope(null);
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
  useChartLibraryStore.setState({ charts: {} });
  useChatStore.setState({ threads: {}, messages: {} });
  useLifeEventsStore.setState({ eventsByProfile: {} });
  useInterpretationStore.setState({ byChart: {} });
  useRectificationRecordsStore.setState({ recordsByProfile: {} });
  usePredictiveStore.getState().reset();
  useMeshStore.setState({ edges: {} });
  useMeshReadingsStore.setState({ byPair: {} });
});

describe('deleteProfileData', () => {
  it('does not resolve until the deleted profile snapshot is durable', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    useProfilesStore.getState().createProfile('Survivor');
    const originalStorage = useProfilesStore.persist.getOptions().storage;
    const storageGate = Promise.withResolvers<void>();
    const writes: unknown[] = [];
    const storage: NonNullable<typeof originalStorage> = {
      getItem: () => null,
      setItem: async (_name, value) => {
        await storageGate.promise;
        writes.push(value);
      },
      removeItem: async () => undefined,
    };
    useProfilesStore.persist.setOptions({ storage });

    let resolved = false;
    try {
      const deletion = deleteProfileData(target, {
        deleteMemoryForProfile: vi.fn().mockResolvedValue(undefined),
        // Exercise the per-store snapshot fallback, not the generation commit.
        recordDeletionTombstones: vi.fn(async () => undefined),
      });
      void deletion.then(() => {
        resolved = true;
      });
      await vi.waitFor(() => {
        expect(useProfilesStore.getState().profiles[target]).toBeUndefined();
      });
      await Promise.resolve();

      expect(resolved).toBe(false);
      storageGate.resolve();
      await deletion;

      const latest = writes.at(-1) as { state: { profiles: Record<string, unknown> } };
      expect(latest.state.profiles[target]).toBeUndefined();
    } finally {
      storageGate.resolve();
      useProfilesStore.persist.setOptions({ storage: originalStorage });
    }
  });

  it('waits for every profile persistence attempt before reporting a write failure', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    useProfilesStore.getState().createProfile('Survivor');
    useChatStore.getState().ensureThread(target, 'target-chart');
    const originalProfilesStorage = useProfilesStore.persist.getOptions().storage;
    const originalChatStorage = useChatStore.persist.getOptions().storage;
    const chatGate = Promise.withResolvers<void>();
    let profileWriteCount = 0;
    const profilesStorage: NonNullable<typeof originalProfilesStorage> = {
      getItem: () => null,
      setItem: async () => {
        profileWriteCount += 1;
        if (profileWriteCount > 1) {
          throw new Error('profile persistence blocked');
        }
      },
      removeItem: async () => undefined,
    };
    const chatStorage: NonNullable<typeof originalChatStorage> = {
      getItem: () => null,
      setItem: async () => {
        await chatGate.promise;
      },
      removeItem: async () => undefined,
    };
    useProfilesStore.persist.setOptions({ storage: profilesStorage });
    useChatStore.persist.setOptions({ storage: chatStorage });

    let settled = false;
    try {
      const deletion = deleteProfileData(target, {
        deleteMemoryForProfile: vi.fn().mockResolvedValue(undefined),
        // Exercise the per-store snapshot fallback, not the generation commit.
        recordDeletionTombstones: vi.fn(async () => undefined),
      });
      void deletion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(() => {
        expect(useProfilesStore.getState().profiles[target]).toBeUndefined();
      });
      await Promise.resolve();

      expect(settled).toBe(false);
      chatGate.resolve();
      await expect(deletion).rejects.toThrow(/profile persistence blocked/);
    } finally {
      chatGate.resolve();
      useProfilesStore.persist.setOptions({ storage: originalProfilesStorage });
      useChatStore.persist.setOptions({ storage: originalChatStorage });
    }
  });

  it('waits for every persisted owner store to hydrate before deleting', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    useProfilesStore.getState().createProfile('Survivor');
    const hydration = Promise.withResolvers<void>();
    const waitForHydration = vi.fn(() => hydration.promise);
    const deleteMemoryForProfile = vi.fn().mockResolvedValue(undefined);

    const deletion = deleteProfileData(target, {
      deleteMemoryForProfile,
      waitForHydration,
    });
    await Promise.resolve();

    expect(waitForHydration).toHaveBeenCalledTimes(1);
    expect(deleteMemoryForProfile).not.toHaveBeenCalled();
    useLifeEventsStore.getState().addEvent(target, {
      description: 'Arrived from delayed hydration',
      date: '2012-01-01',
    });
    hydration.resolve();
    await deletion;

    expect(useLifeEventsStore.getState().getEvents(target)).toEqual([]);
  });

  it('serializes concurrent deletions so the final profile and its data survive intact', async () => {
    const first = useProfilesStore.getState().createProfile('First');
    const survivor = useProfilesStore.getState().createProfile('Survivor');
    useLifeEventsStore.getState().addEvent(first, {
      description: 'First event',
      date: '2010-01-01',
    });
    useLifeEventsStore.getState().addEvent(survivor, {
      description: 'Must survive',
      date: '2011-01-01',
    });
    const firstMemoryStarted = Promise.withResolvers<void>();
    const firstMemoryRelease = Promise.withResolvers<void>();
    const deleteMemoryForProfile = vi.fn(async () => {
      firstMemoryStarted.resolve();
      await firstMemoryRelease.promise;
    });

    const firstDeletion = deleteProfileData(first, { deleteMemoryForProfile });
    await firstMemoryStarted.promise;
    const competingDeletion = deleteProfileData(survivor, { deleteMemoryForProfile });
    await Promise.resolve();
    firstMemoryRelease.resolve();
    const results = await Promise.allSettled([firstDeletion, competingDeletion]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(deleteMemoryForProfile).toHaveBeenCalledTimes(1);
    expect(useProfilesStore.getState().profiles[survivor]).toBeDefined();
    expect(useLifeEventsStore.getState().getEvents(survivor)).toHaveLength(1);
  });

  it('deletes every target artifact while preserving the survivor', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    const survivor = useProfilesStore.getState().createProfile('Survivor');
    useChartLibraryStore.getState().saveChart(chart('target-chart', target));
    useChartLibraryStore.getState().saveChart(chart('survivor-chart', survivor));
    useLifeEventsStore.getState().addEvent(target, { description: 'Target event', date: '2010-01-01' });
    useLifeEventsStore.getState().addEvent(survivor, { description: 'Keep event', date: '2011-01-01' });
    const targetThread = useChatStore.getState().ensureThread(target, 'target-chart');
    const survivorThread = useChatStore.getState().ensureThread(survivor, 'survivor-chart');
    useChatStore.getState().appendMessage(targetThread, 'user', 'delete');
    useChatStore.getState().appendMessage(survivorThread, 'user', 'keep');
    useInterpretationStore.getState().setInterpretation('target-chart', interpretation('delete'), '2026-01-01');
    useInterpretationStore.getState().setInterpretation('survivor-chart', interpretation('keep'), '2026-01-01');
    useRectificationRecordsStore.setState({
      recordsByProfile: {
        [target]: { profileId: target },
        [survivor]: { profileId: survivor },
      },
    } as never);
    usePredictiveStore.setState({ status: 'ready', profileKey: target, requestKey: 'target-key' });
    useMeshStore.setState({
      edges: {
        [`${target}|${survivor}`]: { status: 'idle' },
        [`${survivor}|other`]: { status: 'idle' },
      },
    });
    useMeshReadingsStore.setState({
      byPair: {
        [`${target}|${survivor}`]: { profileIds: [target, survivor] },
        [`${survivor}|other`]: { profileIds: [survivor, 'other'] },
      },
    } as never);
    const deleteMemoryForProfile = vi.fn().mockResolvedValue(undefined);

    await deleteProfileData(target, { deleteMemoryForProfile });

    expect(deleteMemoryForProfile).toHaveBeenCalledWith(target);
    expect(useProfilesStore.getState().profiles[target]).toBeUndefined();
    expect(useProfilesStore.getState().profiles[survivor]).toBeDefined();
    expect(useChartLibraryStore.getState().getChart('target-chart')).toBeUndefined();
    expect(useChartLibraryStore.getState().getChart('survivor-chart')).toBeDefined();
    expect(useLifeEventsStore.getState().getEvents(target)).toEqual([]);
    expect(useLifeEventsStore.getState().getEvents(survivor)).toHaveLength(1);
    expect(useChatStore.getState().listThreads(target)).toEqual([]);
    expect(useChatStore.getState().getMessages(survivorThread)).toHaveLength(1);
    expect(useInterpretationStore.getState().getEntry('target-chart')).toBeUndefined();
    expect(useInterpretationStore.getState().getEntry('survivor-chart')).toBeDefined();
    expect(useRectificationRecordsStore.getState().getRecord(target)).toBeNull();
    expect(useRectificationRecordsStore.getState().getRecord(survivor)).not.toBeNull();
    expect(usePredictiveStore.getState().status).toBe('idle');
    expect(useMeshStore.getState().edges[`${target}|${survivor}`]).toBeUndefined();
    expect(useMeshStore.getState().edges[`${survivor}|other`]).toBeDefined();
    expect(useMeshReadingsStore.getState().byPair[`${target}|${survivor}`]).toBeUndefined();
    expect(useMeshReadingsStore.getState().byPair[`${survivor}|other`]).toBeDefined();
    const settledLedger = await readDeletionTombstones();
    expect(settledLedger.profileIds).not.toContain(target);
    expect(settledLedger.chartIds).not.toContain('target-chart');
  });

  it('establishes the generation fence before draining vectors or removing local data', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    useProfilesStore.getState().createProfile('Survivor');
    useChartLibraryStore.getState().saveChart(chart('target-chart', target));
    const threadId = useChatStore.getState().ensureThread(target, 'target-chart');
    const deleteMemoryForProfile = vi.fn(async () => {
      expect(recordDeletionTombstones).toHaveBeenCalledTimes(1);
    });
    const recordDeletionTombstones = vi.fn(async () => {
      expect(deleteMemoryForProfile).not.toHaveBeenCalled();
      expect(useProfilesStore.getState().profiles[target]).toBeDefined();
    });
    const deps = { deleteMemoryForProfile, recordDeletionTombstones };

    await deleteProfileData(target, deps);

    expect(recordDeletionTombstones).toHaveBeenCalledWith({
      profileIds: [target],
      threadIds: [threadId],
      chartIds: ['target-chart'],
    });
  });

  it('allows deterministic chart IDs to be reused after the deletion commit', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    useProfilesStore.getState().createProfile('Survivor');
    useChartLibraryStore.getState().saveChart(chart('deterministic-birth-fingerprint', target));
    const recordDeletionTombstones = vi.fn().mockResolvedValue(undefined);

    await deleteProfileData(target, {
      deleteMemoryForProfile: vi.fn().mockResolvedValue(undefined),
      recordDeletionTombstones,
    });

    const additions = {
      profileIds: [target],
      threadIds: [],
      chartIds: ['deterministic-birth-fingerprint'],
    };
    expect(recordDeletionTombstones).toHaveBeenCalledWith(additions);

    useChartLibraryStore
      .getState()
      .saveChart(chart('deterministic-birth-fingerprint', useProfilesStore.getState().activeProfileId!));
    expect(useChartLibraryStore.getState().getChart('deterministic-birth-fingerprint')).toBeDefined();
  });

  it('refuses the last profile before deleting any owned data', async () => {
    const only = useProfilesStore.getState().createProfile('Only');
    useLifeEventsStore.getState().addEvent(only, { description: 'Keep', date: '2010-01-01' });
    const deleteMemoryForProfile = vi.fn().mockResolvedValue(undefined);

    await expect(deleteProfileData(only, { deleteMemoryForProfile })).rejects.toThrow(/last profile/i);

    expect(deleteMemoryForProfile).not.toHaveBeenCalled();
    expect(useProfilesStore.getState().profiles[only]).toBeDefined();
    expect(useLifeEventsStore.getState().getEvents(only)).toHaveLength(1);
  });

  it('finishes source deletion when best-effort derived-vector draining fails', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    useProfilesStore.getState().createProfile('Survivor');
    useLifeEventsStore.getState().addEvent(target, { description: 'Keep on failure', date: '2010-01-01' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await deleteProfileData(target, {
      deleteMemoryForProfile: vi
        .fn()
        .mockRejectedValue(new Error('private-profile-id must never reach logs')),
    });

    expect(useProfilesStore.getState().profiles[target]).toBeUndefined();
    expect(useLifeEventsStore.getState().getEvents(target)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:lifecycle.memory_drain_failed]');
  });

  it('finishes source deletion within 10 seconds when derived-vector draining hangs', async () => {
    vi.useFakeTimers();
    try {
      const target = useProfilesStore.getState().createProfile('Target');
      useProfilesStore.getState().createProfile('Survivor');
      let settled = false;

      void deleteProfileData(target, {
        deleteMemoryForProfile: () => new Promise<void>(() => undefined),
      }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(settled).toBe(true);
      expect(useProfilesStore.getState().profiles[target]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes historical interpretations from prior chart regenerations', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    const survivor = useProfilesStore.getState().createProfile('Survivor');
    useChartLibraryStore.getState().saveChart(chart('current-target', target));
    useChartLibraryStore.getState().saveChart(chart('current-survivor', survivor));
    const oldRun = useInterpretationStore
      .getState()
      .startInterpretation('historical-target', target);
    useInterpretationStore
      .getState()
      .setInterpretation(
        'historical-target',
        interpretation('old target'),
        '2026-01-01',
        undefined,
        undefined,
        oldRun,
      );
    const survivorRun = useInterpretationStore
      .getState()
      .startInterpretation('historical-survivor', survivor);
    useInterpretationStore
      .getState()
      .setInterpretation(
        'historical-survivor',
        interpretation('keep'),
        '2026-01-01',
        undefined,
        undefined,
        survivorRun,
      );

    await deleteProfileData(target, {
      deleteMemoryForProfile: vi.fn().mockResolvedValue(undefined),
    });

    expect(useInterpretationStore.getState().getEntry('historical-target')).toBeUndefined();
    expect(useInterpretationStore.getState().getEntry('historical-survivor')).toBeDefined();
  });

  it('uses owned chat history to delete legacy interpretations without owner metadata', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    const survivor = useProfilesStore.getState().createProfile('Survivor');
    useChartLibraryStore.getState().saveChart(chart('current-target', target));
    useChartLibraryStore.getState().saveChart(chart('current-survivor', survivor));
    useChatStore.getState().ensureThread(target, 'historical-target');
    useChatStore.getState().ensureThread(survivor, 'historical-survivor');
    useInterpretationStore
      .getState()
      .setInterpretation('historical-target', interpretation('old target'), '2026-01-01');
    useInterpretationStore
      .getState()
      .setInterpretation('historical-survivor', interpretation('keep'), '2026-01-01');

    await deleteProfileData(target, {
      deleteMemoryForProfile: vi.fn().mockResolvedValue(undefined),
    });

    expect(useInterpretationStore.getState().getEntry('historical-target')).toBeUndefined();
    expect(useInterpretationStore.getState().getEntry('historical-survivor')).toBeDefined();
  });

  it('does not guess ownership and erase an ambiguous survivor reading at deletion time', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    const survivor = useProfilesStore.getState().createProfile('Survivor');
    useChartLibraryStore.getState().saveChart(chart('current-target', target));
    useChartLibraryStore.getState().saveChart(chart('current-survivor', survivor));
    useInterpretationStore
      .getState()
      .setInterpretation('orphaned-legacy', interpretation('cannot attribute'), '2026-01-01');
    const survivorRun = useInterpretationStore
      .getState()
      .startInterpretation('explicit-survivor', survivor);
    useInterpretationStore
      .getState()
      .setInterpretation(
        'explicit-survivor',
        interpretation('keep'),
        '2026-01-01',
        undefined,
        undefined,
        survivorRun,
      );

    await deleteProfileData(target, {
      deleteMemoryForProfile: vi.fn().mockResolvedValue(undefined),
    });

    expect(useInterpretationStore.getState().getEntry('orphaned-legacy')).toBeDefined();
    expect(useInterpretationStore.getState().getEntry('explicit-survivor')).toBeDefined();
  });
});

describe('deleteChatThreadData', () => {
  it('records a durable thread tombstone before vector deletion and local removal', async () => {
    const threadId = useChatStore.getState().ensureThread('profile', 'chart');
    const deleteMemoryForThread = vi.fn().mockResolvedValue(undefined);
    const recordDeletionTombstones = vi.fn(async () => {
      expect(deleteMemoryForThread).not.toHaveBeenCalled();
      expect(useChatStore.getState().threads[threadId]).toBeDefined();
    });
    const deps = { deleteMemoryForThread, recordDeletionTombstones };

    await deleteChatThreadData(threadId, deps);

    expect(recordDeletionTombstones).toHaveBeenCalledWith({ threadIds: [threadId] });
  });

  it('does not resolve until the deleted conversation snapshot is durable', async () => {
    const threadId = useChatStore.getState().ensureThread('profile', 'chart');
    useChatStore.getState().appendMessage(threadId, 'user', 'private question');
    const originalStorage = useChatStore.persist.getOptions().storage;
    const storageGate = Promise.withResolvers<void>();
    const writes: unknown[] = [];
    const storage: NonNullable<typeof originalStorage> = {
      getItem: () => null,
      setItem: async (_name, value) => {
        await storageGate.promise;
        writes.push(value);
      },
      removeItem: async () => undefined,
    };
    useChatStore.persist.setOptions({ storage });

    let resolved = false;
    try {
      const deletion = deleteChatThreadData(threadId, {
        deleteMemoryForThread: vi.fn().mockResolvedValue(undefined),
        // Exercise the per-store snapshot fallback, not the generation commit.
        recordDeletionTombstones: vi.fn(async () => undefined),
      });
      void deletion.then(() => {
        resolved = true;
      });
      await vi.waitFor(() => {
        expect(useChatStore.getState().threads[threadId]).toBeUndefined();
      });
      await Promise.resolve();

      expect(resolved).toBe(false);
      storageGate.resolve();
      await deletion;

      const latest = writes.at(-1) as {
        state: { threads: Record<string, unknown>; messages: Record<string, unknown> };
      };
      expect(latest.state.threads[threadId]).toBeUndefined();
      expect(latest.state.messages[threadId]).toBeUndefined();
    } finally {
      storageGate.resolve();
      useChatStore.persist.setOptions({ storage: originalStorage });
    }
  });

  it('rejects when the durable conversation snapshot cannot be written', async () => {
    const threadId = useChatStore.getState().ensureThread('profile', 'chart');
    const originalStorage = useChatStore.persist.getOptions().storage;
    let writeCount = 0;
    const storage: NonNullable<typeof originalStorage> = {
      getItem: () => null,
      setItem: async () => {
        writeCount += 1;
        if (writeCount > 1) {
          throw new Error('chat persistence blocked');
        }
      },
      removeItem: async () => undefined,
    };
    useChatStore.persist.setOptions({ storage });

    try {
      await expect(
        deleteChatThreadData(threadId, {
          deleteMemoryForThread: vi.fn().mockResolvedValue(undefined),
        // Exercise the per-store snapshot fallback, not the generation commit.
        recordDeletionTombstones: vi.fn(async () => undefined),
        }),
      ).rejects.toThrow(/chat persistence blocked/);
    } finally {
      useChatStore.persist.setOptions({ storage: originalStorage });
    }
  });

  it('deletes vectors before removing the thread and its messages', async () => {
    const threadId = useChatStore.getState().ensureThread('profile', 'chart');
    useChatStore.getState().appendMessage(threadId, 'user', 'private question');
    const deleteMemoryForThread = vi.fn().mockResolvedValue(undefined);

    await deleteChatThreadData(threadId, { deleteMemoryForThread });

    expect(deleteMemoryForThread).toHaveBeenCalledWith(threadId);
    expect(useChatStore.getState().threads[threadId]).toBeUndefined();
    expect(useChatStore.getState().getMessages(threadId)).toEqual([]);
  });

  it('deletes the conversation when best-effort vector draining fails', async () => {
    const threadId = useChatStore.getState().ensureThread('profile', 'chart');

    await deleteChatThreadData(threadId, {
      deleteMemoryForThread: vi.fn().mockRejectedValue(new Error('storage blocked')),
    });

    expect(useChatStore.getState().threads[threadId]).toBeUndefined();
  });
});

describe('durable memory rebuild recovery', () => {
  it('rebuilds from durable chat and clears the marker only after success', async () => {
    const threadId = useChatStore.getState().ensureThread('profile', 'chart');
    useChatStore.getState().appendMessage(threadId, 'user', 'restored question');
    const rebuild = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);

    await resumePendingMemoryRebuild({
      readLedger: vi.fn().mockResolvedValue({
        version: 1,
        activeEpoch: 4,
        restoreEpoch: 4,
        restoreInProgress: false,
        memoryRebuildPending: true,
        profileIds: [],
        threadIds: [],
        chartIds: [],
      }),
      waitForChat: vi.fn().mockResolvedValue(undefined),
      rebuild,
      complete,
    });

    expect(rebuild).toHaveBeenCalledWith([
      expect.objectContaining({
        thread_id: threadId,
        profile_id: 'profile',
        content: 'restored question',
      }),
    ]);
    expect(complete).toHaveBeenCalledWith(4);
  });

  it('keeps the durable marker when a resumed rebuild fails', async () => {
    const complete = vi.fn();
    await expect(
      resumePendingMemoryRebuild({
        readLedger: vi.fn().mockResolvedValue({
          version: 1,
          activeEpoch: 4,
          restoreEpoch: 4,
          restoreInProgress: false,
          memoryRebuildPending: true,
          profileIds: [],
          threadIds: [],
          chartIds: [],
        }),
        waitForChat: vi.fn().mockResolvedValue(undefined),
        rebuild: vi.fn().mockRejectedValue(new Error('embedder unavailable')),
        complete,
      }),
    ).rejects.toThrow(/embedder unavailable/);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('cross-realm deletion propagation', () => {
  it('purges every live selector and vector task when another realm resets the dataset', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    useChartLibraryStore.getState().saveChart(chart('target-chart', target));
    useLifeEventsStore
      .getState()
      .addEvent(target, { description: 'must disappear', date: '2010-01-01' });
    const threadId = useChatStore.getState().ensureThread(target, 'target-chart');
    useChatStore.getState().appendMessage(threadId, 'user', 'private question');
    const clearMemory = vi.fn().mockResolvedValue(undefined);
    const refreshPreferences = vi.fn().mockResolvedValue(undefined);

    await applyRemoteDeletionNotice(
      { kind: 'dataset', operation: 'reset', phase: 'complete' },
      {
        clearMemory,
        refreshPreferences,
        deleteMemoryForProfile: vi.fn(),
        deleteMemoryForThread: vi.fn(),
      },
    );

    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(refreshPreferences).toHaveBeenCalledTimes(1);
    expect(useProfilesStore.getState().profiles).toEqual({});
    expect(useChartLibraryStore.getState().charts).toEqual({});
    expect(useLifeEventsStore.getState().eventsByProfile).toEqual({});
    expect(useChatStore.getState().threads).toEqual({});
  });

  it('notifies open AI consumers after a remote Replace refreshes preferences', async () => {
    const refreshed = vi.fn();
    window.addEventListener(LLM_SETTINGS_CHANGED_EVENT, refreshed, { once: true });

    await applyRemoteDeletionNotice(
      { kind: 'dataset', operation: 'replace', phase: 'complete', presentStoreKeys: [] },
      {
        refreshPreferences: vi.fn().mockResolvedValue(undefined),
        deleteMemoryForProfile: vi.fn(),
        deleteMemoryForThread: vi.fn(),
      },
    );

    expect(refreshed).toHaveBeenCalledOnce();
  });

  it('purges an already-open realm when another tab deletes a profile', async () => {
    const target = useProfilesStore.getState().createProfile('Target');
    const survivor = useProfilesStore.getState().createProfile('Survivor');
    useChartLibraryStore.getState().saveChart(chart('target-chart', target));
    useLifeEventsStore.getState().addEvent(target, {
      description: 'must disappear',
      date: '2010-01-01',
    });
    const threadId = useChatStore.getState().ensureThread(target, 'target-chart');
    useChatStore.getState().appendMessage(threadId, 'user', 'private question');
    const run = useInterpretationStore.getState().startInterpretation('target-chart', target);
    useInterpretationStore
      .getState()
      .setInterpretation(
        'target-chart',
        interpretation('private reading'),
        '2026-01-01',
        undefined,
        undefined,
        run,
      );
    const deleteMemoryForProfile = vi.fn().mockResolvedValue(undefined);

    await applyRemoteDeletionNotice(
      {
        kind: 'profile',
        profileId: target,
        chartIds: ['target-chart'],
        threadIds: [threadId],
      },
      { deleteMemoryForProfile, deleteMemoryForThread: vi.fn() },
    );

    expect(deleteMemoryForProfile).toHaveBeenCalledWith(target);
    expect(useProfilesStore.getState().profiles[target]).toBeUndefined();
    expect(useProfilesStore.getState().profiles[survivor]).toBeDefined();
    expect(useChartLibraryStore.getState().getChart('target-chart')).toBeUndefined();
    expect(useLifeEventsStore.getState().getEvents(target)).toEqual([]);
    expect(useChatStore.getState().threads[threadId]).toBeUndefined();
    expect(useInterpretationStore.getState().getEntry('target-chart')).toBeUndefined();
  });
});

describe('dangling person/chart references (boot self-heal)', () => {
  const QUESTION = 'When does my Saturn return start?';

  function seedOrphan(): { orphan: string; healthy: string } {
    useChartLibraryStore.setState({ charts: { c2: chart('c2', 'p1') } });
    const orphan = useChatStore.getState().ensureThread('p1', '1e251b81');
    useChatStore.getState().appendMessage(orphan, 'user', QUESTION);
    const healthy = useChatStore.getState().ensureThread('p2', 'c2');
    return { orphan, healthy };
  }

  it('unlinks the dangling chart link, keeps the conversation, and persists the repair', async () => {
    const { orphan, healthy } = seedOrphan();
    const persist = vi.fn().mockResolvedValue(undefined);

    const repaired = await reconcilePortableReferences({ hydrated: async () => true, persist });

    expect(repaired.unlinkedChatThreadIds).toEqual([orphan]);
    expect(useChatStore.getState().threads[orphan]).not.toHaveProperty('chart_id');
    expect(useChatStore.getState().getMessages(orphan)[0]!.content).toBe(QUESTION);
    expect(useChatStore.getState().threads[healthy]!.chart_id).toBe('c2');
    expect(persist).toHaveBeenCalledOnce();
  });

  it('forgets an AI reading for a replaced chart and life events of a person who is gone', async () => {
    useProfilesStore.setState({ profiles: { p1: { id: 'p1', name: 'p1' } as never }, activeProfileId: 'p1' });
    useChartLibraryStore.setState({ charts: { c2: chart('c2', 'p1') } });
    const run = useInterpretationStore.getState().startInterpretation('c1', 'p1');
    useInterpretationStore.getState().startInterpretation('c2', 'p1');
    useLifeEventsStore.setState({ eventsByProfile: { gone: [], p1: [] } });
    const persist = vi.fn().mockResolvedValue(undefined);

    const repaired = await reconcilePortableReferences({ hydrated: async () => true, persist });

    expect(repaired.droppedReadingChartIds).toEqual(['c1']);
    expect(repaired.droppedPersonRecords).toEqual(['almamesh-life-events/gone']);
    expect(Object.keys(useInterpretationStore.getState().byChart)).toEqual(['c2']);
    expect(useLifeEventsStore.getState().eventsByProfile).toEqual({ p1: [] });
    // The run still streaming for the replaced chart cannot write it back.
    await useInterpretationStore.getState().setInterpretation('c1', interpretation('late'), 'now', undefined, undefined, run);
    expect(useInterpretationStore.getState().byChart.c1).toBeUndefined();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('writes nothing when every chat link is live', async () => {
    useChartLibraryStore.setState({ charts: { c2: chart('c2', 'p1') } });
    useChatStore.getState().ensureThread('p1', 'c2');
    const persist = vi.fn();

    await expect(reconcilePortableReferences({ hydrated: async () => true, persist })).resolves.toEqual(
      EMPTY_PORTABLE_REPAIR_REPORT,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it('never repairs against a chart library that failed to hydrate', async () => {
    const { orphan } = seedOrphan();
    const persist = vi.fn();

    await expect(reconcilePortableReferences({ hydrated: async () => false, persist })).resolves.toEqual(
      EMPTY_PORTABLE_REPAIR_REPORT,
    );
    expect(useChatStore.getState().threads[orphan]!.chart_id).toBe('1e251b81');
    expect(persist).not.toHaveBeenCalled();
  });

  it('runs on boot, so a device already holding the dangling link recovers with no user action', async () => {
    vi.resetModules();
    vi.doMock('@almamesh/store', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@almamesh/store')>()),
      readDeletionTombstones: vi.fn().mockResolvedValue({
        version: 1,
        activeEpoch: 0,
        restoreEpoch: 0,
        restoreInProgress: false,
        memoryRebuildPending: false,
        profileIds: [],
        threadIds: [],
        chartIds: [],
      }),
      adoptLatestDatasetEpoch: vi.fn().mockResolvedValue({ changed: false, epoch: 0 }),
      persistProfileDeletion: vi.fn().mockResolvedValue(undefined),
    }));
    try {
      const store = await import('@almamesh/store');
      store.useChartLibraryStore.setState({ charts: { c2: chart('c2', 'p1') } });
      const orphan = store.useChatStore.getState().ensureThread('p1', '1e251b81');

      const lifecycle = await import('./profileDataLifecycle');
      await lifecycle.whenDataLifecycleReady();

      expect(store.useChatStore.getState().threads[orphan]).not.toHaveProperty('chart_id');
    } finally {
      vi.doUnmock('@almamesh/store');
    }
  });
});

describe('startup data-lifecycle readiness', () => {
  const emptyLedger = {
    version: 1 as const,
    activeEpoch: 0,
    restoreEpoch: 0,
    restoreInProgress: false,
    memoryRebuildPending: false,
    profileIds: [],
    threadIds: [],
    chartIds: [],
  };

  it('stays pending until the initial reconcile and resume pass finishes', async () => {
    const initialRead = Promise.withResolvers<typeof emptyLedger>();
    vi.resetModules();
    vi.doMock('@almamesh/store', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@almamesh/store')>()),
      readDeletionTombstones: vi
        .fn()
        .mockImplementationOnce(() => initialRead.promise)
        .mockResolvedValue(emptyLedger),
      adoptLatestDatasetEpoch: vi.fn().mockResolvedValue({ changed: false, epoch: 0 }),
    }));

    try {
      const lifecycle = await import('./profileDataLifecycle');
      let ready = false;
      void lifecycle.whenDataLifecycleReady().then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);

      initialRead.resolve(emptyLedger);
      await lifecycle.whenDataLifecycleReady();
      expect(ready).toBe(true);
    } finally {
      vi.doUnmock('@almamesh/store');
    }
  });

  it('serializes a visibility reconciliation behind the initial pass', async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let active = 0;
    let maximumActive = 0;
    const adoptLatestDatasetEpoch = vi
      .fn()
      .mockImplementationOnce(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await first.promise;
        active -= 1;
        return { changed: false, epoch: 0 };
      })
      .mockImplementationOnce(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await second.promise;
        active -= 1;
        return { changed: false, epoch: 0 };
      });
    vi.resetModules();
    vi.doMock('@almamesh/store', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@almamesh/store')>()),
      readDeletionTombstones: vi.fn().mockResolvedValue(emptyLedger),
      adoptLatestDatasetEpoch,
    }));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    try {
      const lifecycle = await import('./profileDataLifecycle');
      await vi.waitFor(() => expect(adoptLatestDatasetEpoch).toHaveBeenCalledTimes(1));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      expect(adoptLatestDatasetEpoch).toHaveBeenCalledTimes(1);

      first.resolve();
      await vi.waitFor(() => expect(adoptLatestDatasetEpoch).toHaveBeenCalledTimes(2));
      let ready = false;
      void lifecycle.whenDataLifecycleReady().then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);

      second.resolve();
      await lifecycle.whenDataLifecycleReady();
      expect(ready).toBe(true);
      expect(maximumActive).toBe(1);
    } finally {
      first.resolve();
      second.resolve();
      visibility.mockRestore();
      vi.doUnmock('@almamesh/store');
    }
  });

  it('reports a startup reconciliation failure and still releases readiness', async () => {
    const safeError = vi.fn();
    vi.resetModules();
    vi.doMock('@almamesh/store', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@almamesh/store')>()),
      readDeletionTombstones: vi.fn().mockRejectedValue(new Error('ledger unavailable')),
    }));
    vi.doMock('@almamesh/shared-types', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@almamesh/shared-types')>()),
      safeError,
    }));

    try {
      const lifecycle = await import('./profileDataLifecycle');
      await expect(lifecycle.whenDataLifecycleReady()).resolves.toBeUndefined();
      expect(safeError).toHaveBeenCalledWith('lifecycle.remote_deletion_failed');
    } finally {
      vi.doUnmock('@almamesh/store');
      vi.doUnmock('@almamesh/shared-types');
    }
  });
});
