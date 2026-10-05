import {
  adoptLatestDatasetEpoch,
  abortBackupRestore,
  beginDatasetMutation,
  clearMemoryRebuildPending,
  refreshPortablePreferenceMirrors,
  whenChartLibraryHydrated,
  whenChatHydrated,
  whenLifeEventsHydrated,
  whenMeshReadingsHydrated,
  whenPredictiveHydrated,
  whenProfilesHydrated,
  whenRectificationRecordsHydrated,
  persistChatDeletion,
  persistProfileDeletion,
  readDeletionTombstones,
  readActiveDatasetStoreKeys,
  recordDeletionTombstones as recordDurableDeletionTombstones,
  useChartLibraryStore,
  useChatStore,
  useInterpretationStore,
  useLifeEventsStore,
  useLanguageStore,
  useMeshStore,
  useMeshReadingsStore,
  usePredictiveStore,
  useProfilesStore,
  useRectificationRecordsStore,
  type DeletionTombstoneAdditions,
} from '@almamesh/store';
import { safeError, safeWarn } from '@almamesh/shared-types';
import type { IndexableMessage } from '@almamesh/memory';

import {
  clearMemory as clearPersistedMemory,
  deleteMemoryForProfile as deletePersistedMemoryForProfile,
  deleteMemoryForThread as deletePersistedMemoryForThread,
  invalidateMemoryRuntime,
  rebuildMemory,
} from './chatMemory';
import { publishDeletionNotice, subscribeDeletionNotices } from './deletionPropagation';
import { notifyLlmSettingsChanged } from './llmSettingsEvents';
import { rehydratePortablePreferences } from './portablePreferences';

export interface ProfileDataLifecycleDeps {
  deleteMemoryForProfile: (profileId: string) => Promise<void>;
  beginDatasetMutation?: () => Promise<number>;
  abortDatasetMutation?: (epoch: number) => Promise<void>;
  recordDeletionTombstones?: (
    additions: DeletionTombstoneAdditions,
    epoch?: number,
  ) => Promise<void>;
  waitForHydration?: () => Promise<void>;
}

const DERIVED_MEMORY_DELETE_SLA_MS = 10_000;

function withinDerivedMemoryDeleteSla(operation: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Derived-memory deletion exceeded its 10-second safety bound.'));
    }, DERIVED_MEMORY_DELETE_SLA_MS);
    void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function waitForProfileStoresHydrated(): Promise<void> {
  const interpretationHydration = useInterpretationStore.persist.hasHydrated()
    ? Promise.resolve()
    : useInterpretationStore.persist.rehydrate();
  await Promise.all([
    whenProfilesHydrated(),
    whenChartLibraryHydrated(),
    whenLifeEventsHydrated(),
    whenMeshReadingsHydrated(),
    whenChatHydrated(),
    whenRectificationRecordsHydrated(),
    whenPredictiveHydrated(),
    interpretationHydration,
  ]);
  useInterpretationStore.getState().backfillProfileOwnership(provableInterpretationOwners());
}

function provableInterpretationOwners(): Readonly<Record<string, string>> {
  const candidates = new Map<string, Set<string>>();
  const add = (chartId: string | undefined, profileId: string | undefined): void => {
    if (chartId === undefined || profileId === undefined) return;
    const owners = candidates.get(chartId) ?? new Set<string>();
    owners.add(profileId);
    candidates.set(chartId, owners);
  };
  for (const chart of useChartLibraryStore.getState().listAllCharts()) {
    add(chart.chart_id, chart.profile_id);
  }
  for (const thread of Object.values(useChatStore.getState().threads)) {
    add(thread.chart_id, thread.profile_id);
  }
  return Object.fromEntries(
    [...candidates].flatMap(([chartId, owners]) =>
      owners.size === 1 ? [[chartId, [...owners][0]!]] : [],
    ),
  );
}

const DEFAULT_DEPS: ProfileDataLifecycleDeps = {
  deleteMemoryForProfile: deletePersistedMemoryForProfile,
  beginDatasetMutation,
  abortDatasetMutation: abortBackupRestore,
  recordDeletionTombstones: recordDurableDeletionTombstones,
  waitForHydration: waitForProfileStoresHydrated,
};

export interface ChatThreadDataLifecycleDeps {
  deleteMemoryForThread: (threadId: string) => Promise<void>;
  beginDatasetMutation?: () => Promise<number>;
  abortDatasetMutation?: (epoch: number) => Promise<void>;
  recordDeletionTombstones?: (
    additions: DeletionTombstoneAdditions,
    epoch?: number,
  ) => Promise<void>;
}

export type DeletionNotice =
  | {
      readonly kind: 'profile';
      readonly profileId: string;
      readonly chartIds: readonly string[];
      readonly threadIds: readonly string[];
    }
  | { readonly kind: 'thread'; readonly threadId: string }
  | {
      readonly kind: 'dataset';
      readonly operation: 'reset' | 'replace';
      readonly phase?: 'begin' | 'complete' | 'abort';
      readonly presentStoreKeys?: readonly string[];
    };

export interface RemoteDeletionDeps {
  deleteMemoryForProfile: (profileId: string) => Promise<void>;
  deleteMemoryForThread: (threadId: string) => Promise<void>;
  clearMemory?: () => Promise<void>;
  invalidateMemoryRuntime?: () => void;
  refreshPreferences?: () => Promise<void>;
}

const DEFAULT_CHAT_DEPS: ChatThreadDataLifecycleDeps = {
  deleteMemoryForThread: deletePersistedMemoryForThread,
  beginDatasetMutation,
  abortDatasetMutation: abortBackupRestore,
  recordDeletionTombstones: recordDurableDeletionTombstones,
};

let destructiveOperationTail: Promise<void> = Promise.resolve();

const PERSONAL_STORE_KEYS = [
  'almamesh-chart-library',
  'almamesh-profiles',
  'almamesh-life-events',
  'almamesh-chat-history',
  'almamesh-interpretations',
  'almamesh-mesh-readings',
  'almamesh-rectification-records',
  'almamesh-predictive',
] as const;

function withDestructiveOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = destructiveOperationTail.then(operation, operation);
  destructiveOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function targetChartIds(profileId: string): readonly string[] {
  const chartIds = useChartLibraryStore
    .getState()
    .listAllCharts()
    .filter((chart) => chart.profile_id === profileId)
    .map((chart) => chart.chart_id);
  for (const thread of useChatStore.getState().listThreads(profileId)) {
    if (thread.chart_id !== undefined) {
      chartIds.push(thread.chart_id);
    }
  }
  return [...new Set(chartIds)];
}

function assertDeletableProfile(profileId: string): void {
  const profiles = useProfilesStore.getState().profiles;
  if (!(profileId in profiles)) {
    throw new Error('Cannot delete a profile that does not exist.');
  }
  if (Object.keys(profiles).length <= 1) {
    throw new Error('Cannot delete the last profile — at least one person must remain.');
  }
}

/** Delete one person and every on-device artifact owned by that profile. */
export async function deleteProfileData(
  profileId: string,
  deps: ProfileDataLifecycleDeps = DEFAULT_DEPS,
): Promise<void> {
  await withDestructiveOperationLock(async () => {
    await (deps.waitForHydration ?? waitForProfileStoresHydrated)();
    const epoch = await deps.beginDatasetMutation?.();
    try {
      if (epoch !== undefined) await replaceLiveDataset(undefined, false);
      assertDeletableProfile(profileId);
    } catch (error) {
      if (epoch !== undefined) await deps.abortDatasetMutation?.(epoch);
      throw error;
    }
    assertDeletableProfile(profileId);
    const chartIds = targetChartIds(profileId);
    const threadIds = useChatStore
      .getState()
      .listThreads(profileId)
      .map((thread) => thread.id);
    const tombstones = {
      profileIds: [profileId],
      threadIds,
      chartIds,
    };
    try {
      const record = deps.recordDeletionTombstones ?? recordDurableDeletionTombstones;
      if (epoch === undefined) await record(tombstones);
      else await record(tombstones, epoch);
    } catch (error) {
      if (epoch !== undefined) await deps.abortDatasetMutation?.(epoch);
      throw error;
    }
    try {
      await withinDerivedMemoryDeleteSla(deps.deleteMemoryForProfile(profileId));
    } catch {
      safeWarn('lifecycle.memory_drain_failed');
    }
    assertDeletableProfile(profileId);
    useLifeEventsStore.getState().clearEvents(profileId);
    useRectificationRecordsStore.getState().clearRecord(profileId);
    useChatStore.getState().deleteThreadsForProfile(profileId);
    useInterpretationStore.getState().deleteForProfile(profileId, chartIds);
    if (usePredictiveStore.getState().profileKey === profileId) {
      usePredictiveStore.getState().reset();
    }
    useMeshStore.getState().invalidateEdgesFor(profileId);
    useMeshReadingsStore.getState().deleteForProfile(profileId);
    useProfilesStore.getState().deleteProfile(profileId);
    await persistProfileDeletion();
    publishDeletionNotice({ kind: 'profile', profileId, chartIds, threadIds });
  });
}

/** Delete one conversation and its derived semantic-memory vectors atomically. */
export async function deleteChatThreadData(
  threadId: string,
  deps: ChatThreadDataLifecycleDeps = DEFAULT_CHAT_DEPS,
): Promise<void> {
  await withDestructiveOperationLock(async () => {
    const epoch = await deps.beginDatasetMutation?.();
    try {
      if (epoch !== undefined) await replaceLiveDataset(undefined, false);
    } catch (error) {
      if (epoch !== undefined) await deps.abortDatasetMutation?.(epoch);
      throw error;
    }
    if (!(threadId in useChatStore.getState().threads)) {
      if (epoch !== undefined) await deps.abortDatasetMutation?.(epoch);
      return;
    }
    const tombstones = { threadIds: [threadId] };
    try {
      const record = deps.recordDeletionTombstones ?? recordDurableDeletionTombstones;
      if (epoch === undefined) await record(tombstones);
      else await record(tombstones, epoch);
    } catch (error) {
      if (epoch !== undefined) await deps.abortDatasetMutation?.(epoch);
      throw error;
    }
    try {
      await withinDerivedMemoryDeleteSla(deps.deleteMemoryForThread(threadId));
    } catch {
      safeWarn('lifecycle.memory_drain_failed');
    }
    useChatStore.getState().deleteThread(threadId);
    await persistChatDeletion();
    publishDeletionNotice({ kind: 'thread', threadId });
  });
}

function purgeLocalProfile(profileId: string, chartIds: readonly string[]): void {
  useLifeEventsStore.getState().clearEvents(profileId);
  useRectificationRecordsStore.getState().clearRecord(profileId);
  useChatStore.getState().deleteThreadsForProfile(profileId);
  useInterpretationStore.getState().deleteForProfile(profileId, chartIds);
  if (usePredictiveStore.getState().profileKey === profileId) {
    usePredictiveStore.getState().reset();
  }
  useMeshStore.getState().invalidateEdgesFor(profileId);
  useMeshReadingsStore.getState().deleteForProfile(profileId);
  useChartLibraryStore.getState().deleteChartsForProfile(profileId);
  const profiles = useProfilesStore.getState().profiles;
  if (!(profileId in profiles)) {
    return;
  }
  if (Object.keys(profiles).length === 1) {
    useProfilesStore.getState().clearAll();
  } else {
    useProfilesStore.getState().deleteProfile(profileId);
  }
}

async function replaceLiveDataset(
  presentStoreKeys?: readonly string[],
  persist = true,
): Promise<void> {
  const present = new Set(
    presentStoreKeys ?? (await readActiveDatasetStoreKeys(PERSONAL_STORE_KEYS)),
  );
  const stores = [
    {
      key: 'almamesh-chart-library',
      rehydrate: () => useChartLibraryStore.persist.rehydrate(),
      clear: () => useChartLibraryStore.getState().clearAll(),
    },
    {
      key: 'almamesh-profiles',
      rehydrate: () => useProfilesStore.persist.rehydrate(),
      clear: () => useProfilesStore.getState().clearAll(),
    },
    {
      key: 'almamesh-life-events',
      rehydrate: () => useLifeEventsStore.persist.rehydrate(),
      clear: () => useLifeEventsStore.getState().clearAll(),
    },
    {
      key: 'almamesh-chat-history',
      rehydrate: () => useChatStore.persist.rehydrate(),
      clear: () => useChatStore.getState().clearAll(),
    },
    {
      key: 'almamesh-interpretations',
      rehydrate: () => useInterpretationStore.persist.rehydrate(),
      clear: () => useInterpretationStore.getState().clearAll(),
    },
    {
      key: 'almamesh-mesh-readings',
      rehydrate: () => useMeshReadingsStore.persist.rehydrate(),
      clear: () => useMeshReadingsStore.getState().clearAll(),
    },
    {
      key: 'almamesh-rectification-records',
      rehydrate: () => useRectificationRecordsStore.persist.rehydrate(),
      clear: () => useRectificationRecordsStore.getState().clearAll(),
    },
    {
      key: 'almamesh-predictive',
      rehydrate: () => usePredictiveStore.persist.rehydrate(),
      clear: () => usePredictiveStore.getState().reset(),
    },
  ] as const;
  await Promise.all(
    stores.map(async (store) => {
      if (present.has(store.key)) await store.rehydrate();
      else store.clear();
    }),
  );
  if (persist) await persistProfileDeletion();
}

async function refreshLivePreferences(): Promise<void> {
  await refreshPortablePreferenceMirrors();
  await Promise.all([useLanguageStore.persist.rehydrate(), rehydratePortablePreferences()]);
}

/** Apply a deletion broadcast from another live tab/PWA realm without echoing it. */
export async function applyRemoteDeletionNotice(
  notice: DeletionNotice,
  deps: RemoteDeletionDeps = {
    deleteMemoryForProfile: deletePersistedMemoryForProfile,
    deleteMemoryForThread: deletePersistedMemoryForThread,
    clearMemory: clearPersistedMemory,
    invalidateMemoryRuntime,
  },
): Promise<void> {
  await withDestructiveOperationLock(async () => {
    if (notice.kind === 'dataset') {
      await waitForProfileStoresHydrated();
      await adoptLatestDatasetEpoch();
      if (notice.phase === 'begin') {
        deps.invalidateMemoryRuntime?.();
        return;
      }
      if (notice.phase === 'complete' || notice.phase === undefined) {
        await (deps.refreshPreferences ?? refreshLivePreferences)();
        notifyLlmSettingsChanged({ replace: true });
      }
      if (notice.operation === 'reset') {
        await deps.clearMemory?.();
        useChartLibraryStore.getState().clearAll();
        useProfilesStore.getState().clearAll();
        useLifeEventsStore.getState().clearAll();
        useChatStore.getState().clearAll();
        useInterpretationStore.getState().clearAll();
        useMeshReadingsStore.getState().clearAll();
        useRectificationRecordsStore.getState().clearAll();
        usePredictiveStore.getState().reset();
        useMeshStore.getState().reset();
        await persistProfileDeletion();
        return;
      }
      await replaceLiveDataset(notice.presentStoreKeys);
      usePredictiveStore.getState().reset();
      useMeshStore.getState().reset();
      deps.invalidateMemoryRuntime?.();
      return;
    }
    const generation = await adoptLatestDatasetEpoch();
    if (generation.changed) await replaceLiveDataset(undefined, false);
    if (notice.kind === 'thread') {
      await whenChatHydrated();
      try {
        await withinDerivedMemoryDeleteSla(deps.deleteMemoryForThread(notice.threadId));
      } catch {
        safeWarn('lifecycle.memory_drain_failed');
      }
      useChatStore.getState().deleteThread(notice.threadId);
      await persistChatDeletion();
      return;
    }
    await waitForProfileStoresHydrated();
    try {
      await withinDerivedMemoryDeleteSla(deps.deleteMemoryForProfile(notice.profileId));
    } catch {
      safeWarn('lifecycle.memory_drain_failed');
    }
    purgeLocalProfile(notice.profileId, notice.chartIds);
    await persistProfileDeletion();
  });
}

function reportRemoteDeletionError(): void {
  safeError('lifecycle.remote_deletion_failed');
}

async function reconcileDurableDeletionLedger(): Promise<void> {
  const tombstones = await readDeletionTombstones();
  const generation = await adoptLatestDatasetEpoch();
  if (generation.changed && tombstones.profileIds.length === 0 && tombstones.threadIds.length === 0) {
    await applyRemoteDeletionNotice({ kind: 'dataset', operation: 'replace' });
    return;
  }
  for (const profileId of tombstones.profileIds) {
    await applyRemoteDeletionNotice({
      kind: 'profile',
      profileId,
      chartIds: tombstones.chartIds,
      threadIds: tombstones.threadIds,
    });
  }
  for (const threadId of tombstones.threadIds) {
    await applyRemoteDeletionNotice({ kind: 'thread', threadId });
  }
}

function restoredMemoryMessages(): readonly IndexableMessage[] {
  const chat = useChatStore.getState();
  const messages: IndexableMessage[] = [];
  for (const thread of Object.values(chat.threads)) {
    for (const message of chat.messages[thread.id] ?? []) {
      if (message.error === true || message.content.trim().length === 0) continue;
      messages.push({
        id: message.id,
        thread_id: thread.id,
        profile_id: thread.profile_id,
        content: message.content,
      });
    }
  }
  return messages;
}

export interface PendingMemoryRebuildDeps {
  readonly readLedger?: typeof readDeletionTombstones;
  readonly waitForChat?: typeof whenChatHydrated;
  readonly rebuild?: (messages: readonly IndexableMessage[]) => Promise<void>;
  readonly complete?: (epoch: number) => Promise<void>;
}

export async function resumePendingMemoryRebuild(
  deps: PendingMemoryRebuildDeps = {},
): Promise<void> {
  const ledger = await (deps.readLedger ?? readDeletionTombstones)();
  if (!ledger.memoryRebuildPending) return;
  await (deps.waitForChat ?? whenChatHydrated)();
  await (deps.rebuild ?? rebuildMemory)(restoredMemoryMessages());
  await (deps.complete ?? clearMemoryRebuildPending)(ledger.activeEpoch);
}

export interface ChatChartLinkDeps {
  /** True only when both the chart library and chat hydrated successfully. */
  readonly hydrated?: () => Promise<boolean>;
  readonly persist?: () => Promise<void>;
}

async function chartsAndChatHydrated(): Promise<boolean> {
  const outcomes = await Promise.all([whenChartLibraryHydrated(), whenChatHydrated()]);
  return outcomes.every((outcome) => outcome.status === 'hydrated');
}

/**
 * Self-heal a chat thread whose `chart_id` names a chart that no longer exists
 * (a chart regenerated by a birth-detail edit before the regeneration learned
 * to unlink chat). The thread and its messages stay with their person; only
 * the dead link goes, so Export and Import accept the dataset again.
 */
export async function reconcileChatChartLinks(
  deps: ChatChartLinkDeps = {},
): Promise<readonly string[]> {
  // A chart library that failed to hydrate looks empty; repairing against it
  // would unlink every thread.
  if (!(await (deps.hydrated ?? chartsAndChatHydrated)())) return [];
  const liveChartIds = new Set(Object.keys(useChartLibraryStore.getState().charts));
  const unlinked = useChatStore.getState().unlinkMissingCharts(liveChartIds);
  if (unlinked.length === 0) return unlinked;
  safeWarn('lifecycle.chat_chart_links_repaired');
  await (deps.persist ?? persistChatDeletion)();
  return unlinked;
}

async function reconcileAndResume(): Promise<void> {
  await reconcileDurableDeletionLedger();
  await reconcileChatChartLinks();
  await resumePendingMemoryRebuild();
}

// One ordered startup/lifecycle lane. A paid or otherwise stateful caller can
// await this barrier before mutating a hydrated store, knowing that the initial
// durable-ledger adoption and any already-scheduled visibility reconciliation
// cannot later replace its live state with an older snapshot.
let dataLifecycleReadiness: Promise<void> = Promise.resolve();

function scheduleDataLifecycleReconciliation(): void {
  dataLifecycleReadiness = dataLifecycleReadiness
    .then(() => reconcileAndResume())
    .catch(() => {
      reportRemoteDeletionError();
      // Readiness describes completion of the startup attempt, not its success.
      // The coded diagnostic above remains the product-visible failure signal;
      // swallowing here prevents a fire-and-forget startup rejection.
    });
}

/** Wait until all startup/visibility reconciliation already scheduled has settled. */
export function whenDataLifecycleReady(): Promise<void> {
  return dataLifecycleReadiness;
}

subscribeDeletionNotices((notice) => {
  void applyRemoteDeletionNotice(notice).catch(reportRemoteDeletionError);
});

if (typeof document !== 'undefined') {
  scheduleDataLifecycleReconciliation();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleDataLifecycleReconciliation();
    }
  });
}
