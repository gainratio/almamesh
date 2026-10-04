/**
 * "Reset chart / start fresh" — the surgical reset that returns a returning
 * visitor to a clean onboarding WITHOUT throwing away the things that make the
 * next start fast and personal.
 *
 * CLEARED (chart + everything derived from it):
 *  - the chart library
 *  - profiles (and the mesh people they hold)
 *  - life events
 *  - chat history (threads + messages)
 *  - generated interpretations
 *  - confirmed rectification records
 *  - persisted predictive contexts
 *  - semantic chat-memory vectors
 *  - quarantined (unreadable) interpretations held in SQLite
 *  - in-memory mesh edges
 *
 * PRESERVED on purpose:
 *  - the OPFS engine bundle (~38 MB, cached for offline) — never touched, so the
 *    next chart computes immediately without a re-download
 *  - the canonical SQLite language and AI settings (portable preferences)
 *
 * This is deliberately NOT `resetAppData` (the nuclear "wedged client" hatch that
 * unregisters service workers + clears ALL caches/IndexedDB/OPFS). Start-fresh
 * keeps the engine and your preferences; it only forgets your chart and its data.
 *
 * After the clear, the route guard reads the empty hydrated chart store and `RootRoute` falls back
 * to the Landing splash, so the caller should navigate to `/`.
 */

import {
  CHART_LIBRARY_FLAG_KEY,
  INTERPRETATION_QUARANTINE_KEY,
  abortBackupRestore,
  bumpRestoreEpoch,
  commitDatasetGeneration,
  whenChartLibraryHydrated,
  whenChatHydrated,
  whenLifeEventsHydrated,
  whenMeshReadingsHydrated,
  whenPredictiveHydrated,
  whenProfilesHydrated,
  whenRectificationRecordsHydrated,
  useChartLibraryStore,
  useChatStore,
  useInterpretationStore,
  useLifeEventsStore,
  useMeshStore,
  useMeshReadingsStore,
  usePredictiveStore,
  useProfilesStore,
  useRectificationRecordsStore,
} from '@almamesh/store';
import { SemanticMemoryStorageUnavailableError } from '@almamesh/memory';
import { createStore, del as idbDel } from 'idb-keyval';
import { clearMemory } from './chatMemory';
import { publishDeletionNotice } from './deletionPropagation';

/** Legacy browser keys removed after canonical SQLite has taken authority. */
const INTERPRETATIONS_KEY = 'almamesh-interpretations';
const LEGACY_LOCAL_STORAGE_KEYS = [
  CHART_LIBRARY_FLAG_KEY,
  INTERPRETATIONS_KEY,
  // An older build's localStorage quarantine (now migrated into SQLite): erase it too.
  INTERPRETATION_QUARANTINE_KEY,
  'almamesh-language',
  'almamesh-llm-settings',
  'almamesh-content-mode',
  'almamesh-model-suggestion-dismissed',
  'almamesh-restore-epoch',
  'almamesh-restore-in-progress',
] as const;
const RESET_IDB_KEYS = [
  'almamesh-chart-library',
  'almamesh-profiles',
  'almamesh-life-events',
  'almamesh-chat-history',
  'almamesh-rectification-records',
  'almamesh-predictive',
  'almamesh-interpretations',
  'almamesh-mesh-readings',
] as const;
const legacyKeyvalStore = createStore('keyval-store', 'keyval');

async function clearLegacyPersistedRows(): Promise<void> {
  await Promise.all(RESET_IDB_KEYS.map((key) => idbDel(key, legacyKeyvalStore)));
}

function getUsableLocalStorage(): Pick<Storage, 'removeItem'> | null {
  try {
    const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
    if (typeof storage?.removeItem !== 'function') {
      return null;
    }
    return { removeItem: storage.removeItem.bind(storage) };
  } catch {
    return null;
  }
}

export interface ResetEverythingDeps {
  waitForHydration: () => Promise<void>;
  clearPersisted: (epoch?: number) => Promise<void>;
  beginDatasetReset?: () => Promise<number>;
  /** Optional only for injected non-atomic persistence; the browser commit finalizes itself. */
  finalizeDatasetReset?: (epoch: number) => Promise<void>;
  abortDatasetReset?: (epoch: number) => Promise<void>;
  publishDatasetReset?: (notice: {
    kind: 'dataset';
    operation: 'reset';
    phase: 'begin' | 'complete';
  }) => void;
}

async function waitForResetStoresHydrated(): Promise<void> {
  await Promise.all([
    whenChartLibraryHydrated(),
    whenProfilesHydrated(),
    whenLifeEventsHydrated(),
    whenMeshReadingsHydrated(),
    whenChatHydrated(),
    whenRectificationRecordsHydrated(),
    whenPredictiveHydrated(),
  ]);
}

const DEFAULT_DEPS: ResetEverythingDeps = {
  waitForHydration: waitForResetStoresHydrated,
  clearPersisted: async (epoch) => {
    if (epoch === undefined) return;
    // One SQLite batch: dataset rows, the quarantine of unreadable
    // interpretations (personal data too), and the generation flip.
    await commitDatasetGeneration(
      epoch,
      RESET_IDB_KEYS.map((key) => ({ key, value: null })),
      { memoryRebuildPending: false, clearInterpretationQuarantine: true },
    );
  },
  beginDatasetReset: bumpRestoreEpoch,
  abortDatasetReset: abortBackupRestore,
  publishDatasetReset: publishDeletionNotice,
};

/**
 * Wipe the chart and everything derived from it, then resolve so the caller can
 * navigate to `/`. Each store is cleared in memory, then its canonical SQLite
 * row is deleted through an awaited persistence seam, so even a hard reload
 * re-hydrates from nothing. Legacy IndexedDB mirrors are retired as cleanup.
 * Preserves the OPFS engine bundle and canonical SQLite preferences.
 */
export async function resetEverything(deps: ResetEverythingDeps = DEFAULT_DEPS): Promise<void> {
  await deps.waitForHydration();

  const epoch = await (deps.beginDatasetReset ?? bumpRestoreEpoch)();
  const publishReset = deps.publishDatasetReset ?? publishDeletionNotice;
  publishReset({ kind: 'dataset', operation: 'reset', phase: 'begin' });
  try {
    // The generation fence lands before vector draining, so another live
    // realm's in-flight embed cannot repopulate the reset dataset after clear.
    try {
      await clearMemory();
    } catch (error) {
      // Semantic memory is optional and intentionally unavailable on browsers
      // without OPFS. The durable generation commit below still makes every
      // prior vector unreachable; an unrelated SQLite failure remains fatal so
      // a real deletion defect cannot be mistaken for a capability limitation.
      if (!(error instanceof SemanticMemoryStorageUnavailableError)) {
        throw error;
      }
    }

    useChartLibraryStore.getState().clearAll();
    useProfilesStore.getState().clearAll();
    useLifeEventsStore.getState().clearAll();
    useChatStore.getState().clearAll();
    useInterpretationStore.getState().clearAll();
    useMeshReadingsStore.getState().clearAll();
    useRectificationRecordsStore.getState().clearAll();
    usePredictiveStore.getState().reset();
    useMeshStore.getState().reset();

    await deps.clearPersisted(epoch);
    await clearLegacyPersistedRows();
    const storage = getUsableLocalStorage();
    for (const key of LEGACY_LOCAL_STORAGE_KEYS) storage?.removeItem(key);
    await deps.finalizeDatasetReset?.(epoch);
    publishReset({ kind: 'dataset', operation: 'reset', phase: 'complete' });
  } catch (error) {
    await (deps.abortDatasetReset ?? abortBackupRestore)(epoch);
    throw error;
  }
}
