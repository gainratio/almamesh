import type { PersistOptions } from 'zustand/middleware';

import { useChartLibraryStore } from './chartLibrary';
import { useChatStore } from './chat';
import { useInterpretationStore } from './interpretation';
import { useLifeEventsStore } from './lifeEvents';
import { useMeshReadingsStore } from './meshReadings';
import { usePredictiveStore } from './predictive';
import { useProfilesStore } from './profiles';
import { useRectificationRecordsStore } from './rectificationRecords';
import {
  commitDatasetGeneration,
  readDeletionTombstones,
  type DatasetSnapshotWrite,
} from './deletionTombstones';

interface PersistedStore<State extends object, PersistedState> {
  getState: () => State;
  persist: {
    getOptions: () => Partial<PersistOptions<State, PersistedState>>;
  };
}

/**
 * Write and await an authoritative snapshot through a store's own Zustand
 * persistence adapter. Store actions intentionally remain synchronous; this
 * is the explicit durability boundary for destructive multi-store workflows.
 */
async function persistCurrentSnapshot<State extends object, PersistedState>(
  store: PersistedStore<State, PersistedState>,
): Promise<void> {
  const options = store.persist.getOptions();
  if (!options.storage || !options.name) {
    throw new Error('Persisted store has no durable storage adapter.');
  }
  const current = { ...store.getState() };
  const state = options.partialize
    ? options.partialize(current)
    : (current as unknown as PersistedState);
  await options.storage.setItem(options.name, {
    state,
    version: options.version ?? 0,
  });
}

function currentDatasetSnapshot<State extends object, PersistedState>(
  store: PersistedStore<State, PersistedState>,
): DatasetSnapshotWrite {
  const options = store.persist.getOptions();
  if (!options.name) throw new Error('Persisted store has no persistence key.');
  const current = { ...store.getState() };
  const state = options.partialize
    ? options.partialize(current)
    : (current as unknown as PersistedState);
  return {
    key: options.name,
    value: JSON.stringify({ state, version: options.version ?? 0 }),
  };
}

async function commitPendingDeletionGeneration(): Promise<boolean> {
  const ledger = await readDeletionTombstones();
  const hasDeletionIds =
    ledger.profileIds.length > 0 || ledger.threadIds.length > 0 || ledger.chartIds.length > 0;
  if (!ledger.restoreInProgress || !hasDeletionIds) return false;
  await commitDatasetGeneration(
    ledger.restoreEpoch,
    [
      currentDatasetSnapshot(useProfilesStore),
      currentDatasetSnapshot(useChartLibraryStore),
      currentDatasetSnapshot(useLifeEventsStore),
      currentDatasetSnapshot(useChatStore),
      currentDatasetSnapshot(useInterpretationStore),
      currentDatasetSnapshot(useMeshReadingsStore),
      currentDatasetSnapshot(useRectificationRecordsStore),
      currentDatasetSnapshot(usePredictiveStore),
    ],
    {
      adoptLocalWrites: true,
      memoryRebuildPending: true,
      sanitizeCanonicalKeys: [
        'almamesh-profiles',
        'almamesh-chart-library',
        'almamesh-life-events',
        'almamesh-chat-history',
        'almamesh-interpretations',
        'almamesh-mesh-readings',
        'almamesh-rectification-records',
        'almamesh-predictive',
      ],
    },
  );
  return true;
}

/** Await every persisted snapshot changed by profile deletion. */
export async function persistProfileDeletion(): Promise<void> {
  if (await commitPendingDeletionGeneration()) return;
  const results = await Promise.allSettled([
    persistCurrentSnapshot(useProfilesStore),
    persistCurrentSnapshot(useChartLibraryStore),
    persistCurrentSnapshot(useLifeEventsStore),
    persistCurrentSnapshot(useChatStore),
    persistCurrentSnapshot(useInterpretationStore),
    persistCurrentSnapshot(useMeshReadingsStore),
    persistCurrentSnapshot(useRectificationRecordsStore),
    persistCurrentSnapshot(usePredictiveStore),
  ]);
  const failed = results.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected',
  );
  if (failed) {
    throw failed.reason;
  }
}

/** Await the persisted chat snapshot changed by conversation deletion. */
export async function persistChatDeletion(): Promise<void> {
  if (await commitPendingDeletionGeneration()) return;
  await persistCurrentSnapshot(useChatStore);
}
