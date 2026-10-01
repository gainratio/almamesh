import type { StateStorage } from 'zustand/middleware';
import {
  createStore,
  del as idbDel,
  get as idbGet,
  promisifyRequest,
  set as idbSet,
  update as idbUpdate,
} from 'idb-keyval';
import {
  migrateLegacyState,
  openPortableStateRepository,
  isPortableStateKey,
  PORTABLE_LEDGER_KEY,
  PORTABLE_STATE_KEYS,
  resolvePortableStateMode,
  type PortableStateRepository,
} from './portableState';

export const DELETION_TOMBSTONES_KEY = 'almamesh-deletion-tombstones';
const RESTORE_EPOCH_MIRROR_KEY = 'almamesh-restore-epoch';
const RESTORE_PROGRESS_MIRROR_KEY = 'almamesh-restore-in-progress';

export interface DeletionTombstones {
  readonly version: 1;
  /** Generation whose snapshots are currently readable. */
  readonly activeEpoch: number;
  readonly restoreEpoch: number;
  readonly restoreInProgress: boolean;
  readonly restoreStartedAt?: number;
  readonly leaseOwner?: string;
  /** Derived vectors were deleted and must be rebuilt from durable chat. */
  readonly memoryRebuildPending: boolean;
  readonly reviveProfileIds?: readonly string[];
  readonly reviveThreadIds?: readonly string[];
  readonly reviveChartIds?: readonly string[];
  readonly profileIds: readonly string[];
  readonly threadIds: readonly string[];
  readonly chartIds: readonly string[];
}

export interface DeletionTombstoneAdditions {
  readonly profileIds?: readonly string[];
  readonly threadIds?: readonly string[];
  readonly chartIds?: readonly string[];
}

const EMPTY_TOMBSTONES: DeletionTombstones = {
  version: 1,
  activeEpoch: 0,
  restoreEpoch: 0,
  restoreInProgress: false,
  memoryRebuildPending: false,
  profileIds: [],
  threadIds: [],
  chartIds: [],
};

const useKeyvalStore = createStore('keyval-store', 'keyval');
let portableRepositoryPromise: Promise<PortableStateRepository> | undefined;
let portableRepositoryOverride: PortableStateRepository | null | undefined;
let observedRestoreEpoch: number | undefined = mirroredRestoreEpoch();
let observedRestoreInProgress = mirroredRestoreInProgress();
const RESTORE_LEASE_MS = 120_000;
const scheduledRecoveryEpochs = new Set<number>();
const persistenceMutationQueues = new Map<string, Promise<void>>();

/** Serialize one persisted row without blocking independent store keys. */
function enqueuePersistenceMutation(name: string, mutation: () => Promise<void>): Promise<void> {
  const previous = persistenceMutationQueues.get(name) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  persistenceMutationQueues.set(name, current);
  const cleanup = (): void => {
    if (persistenceMutationQueues.get(name) === current) persistenceMutationQueues.delete(name);
  };
  void current.then(cleanup, cleanup);
  return current;
}

/** Unit-test seam. Production always opens the OPFS-backed EdgeProc store. */
export function setPortableStateRepositoryForTests(
  repository: PortableStateRepository | null | undefined,
): void {
  portableRepositoryOverride = repository;
}

async function portableRepository(): Promise<PortableStateRepository | null> {
  if (portableRepositoryOverride !== undefined) return portableRepositoryOverride;
  if (resolvePortableStateMode() === 'node-test-fallback') return null;
  portableRepositoryPromise ??= openPortableStateRepository().then(async (repository) => {
    await migrateLegacyState(
      repository,
      {
        get: async (key) => {
          if (key === 'almamesh-language') {
            const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
            return typeof storage?.getItem === 'function' ? storage.getItem(key) : null;
          }
          const value = await idbGet<unknown>(key, useKeyvalStore);
          if (value === undefined) return null;
          return typeof value === 'string' ? value : JSON.stringify(value);
        },
        delete: async (key) => {
          if (key === 'almamesh-language') {
            const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
            storage?.removeItem?.(key);
            return;
          }
          await idbDel(key, useKeyvalStore);
        },
      },
      [...PORTABLE_STATE_KEYS, PORTABLE_LEDGER_KEY],
    );
    return repository;
  });
  return portableRepositoryPromise;
}

/** Production-only handle used by portable SQLite backup orchestration. */
export async function requirePortableStateRepository(): Promise<PortableStateRepository> {
  const repository = await portableRepository();
  if (repository === null) {
    throw new Error('Portable SQLite state is unavailable in this runtime.');
  }
  return repository;
}

function parseDeletionTombstones(raw: string | null): DeletionTombstones {
  if (raw === null) return EMPTY_TOMBSTONES;
  try {
    return mergeDeletionTombstones(JSON.parse(raw) as unknown, {});
  } catch {
    return EMPTY_TOMBSTONES;
  }
}

function serializeDeletionTombstones(value: DeletionTombstones): string {
  return JSON.stringify(value);
}

function mirroredRestoreEpoch(): number | undefined {
  const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
  if (typeof storage?.getItem !== 'function') {
    return undefined;
  }
  const raw = storage.getItem(RESTORE_EPOCH_MIRROR_KEY);
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function mirrorRestoreEpoch(epoch: number, restoreInProgress?: boolean): void {
  const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
  if (typeof storage?.setItem === 'function') {
    storage.setItem(RESTORE_EPOCH_MIRROR_KEY, String(epoch));
    if (restoreInProgress !== undefined) {
      storage.setItem(RESTORE_PROGRESS_MIRROR_KEY, restoreInProgress ? '1' : '0');
    }
  }
}

function mirroredRestoreInProgress(): boolean {
  const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
  return (
    typeof storage?.getItem === 'function' && storage.getItem(RESTORE_PROGRESS_MIRROR_KEY) === '1'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function mergeDeletionTombstones(
  current: unknown,
  additions: DeletionTombstoneAdditions,
): DeletionTombstones {
  const existing = isRecord(current) ? current : EMPTY_TOMBSTONES;
  return {
    version: 1,
    restoreEpoch:
      typeof existing.restoreEpoch === 'number' && Number.isSafeInteger(existing.restoreEpoch)
        ? existing.restoreEpoch
        : 0,
    activeEpoch:
      typeof existing.activeEpoch === 'number' && Number.isSafeInteger(existing.activeEpoch)
        ? existing.activeEpoch
        : typeof existing.restoreEpoch === 'number' && Number.isSafeInteger(existing.restoreEpoch)
          ? existing.restoreEpoch
          : 0,
    restoreInProgress: existing.restoreInProgress === true,
    ...(typeof existing.restoreStartedAt === 'number'
      ? { restoreStartedAt: existing.restoreStartedAt }
      : {}),
    ...(typeof existing.leaseOwner === 'string' ? { leaseOwner: existing.leaseOwner } : {}),
    memoryRebuildPending: existing.memoryRebuildPending === true,
    ...(stringList(existing.reviveProfileIds).length > 0
      ? { reviveProfileIds: stringList(existing.reviveProfileIds) }
      : {}),
    ...(stringList(existing.reviveThreadIds).length > 0
      ? { reviveThreadIds: stringList(existing.reviveThreadIds) }
      : {}),
    ...(stringList(existing.reviveChartIds).length > 0
      ? { reviveChartIds: stringList(existing.reviveChartIds) }
      : {}),
    profileIds: [...new Set([...stringList(existing.profileIds), ...(additions.profileIds ?? [])])],
    threadIds: [...new Set([...stringList(existing.threadIds), ...(additions.threadIds ?? [])])],
    chartIds: [...new Set([...stringList(existing.chartIds), ...(additions.chartIds ?? [])])],
  };
}

export function shouldAcceptRestoreEpoch(observed: number | undefined, current: number): boolean {
  return observed === current || (observed === undefined && current === 0);
}

export function subtractRestoredTombstones(
  current: unknown,
  restored: DeletionTombstoneAdditions,
): DeletionTombstones {
  const existing = mergeDeletionTombstones(current, {});
  const profileIds = new Set(restored.profileIds ?? []);
  const threadIds = new Set(restored.threadIds ?? []);
  const chartIds = new Set(restored.chartIds ?? []);
  return {
    version: 1,
    activeEpoch: existing.activeEpoch,
    restoreEpoch: existing.restoreEpoch,
    restoreInProgress: existing.restoreInProgress,
    ...(existing.restoreStartedAt !== undefined
      ? { restoreStartedAt: existing.restoreStartedAt }
      : {}),
    ...(existing.leaseOwner !== undefined ? { leaseOwner: existing.leaseOwner } : {}),
    memoryRebuildPending: existing.memoryRebuildPending,
    ...(existing.reviveProfileIds !== undefined
      ? { reviveProfileIds: existing.reviveProfileIds }
      : {}),
    ...(existing.reviveThreadIds !== undefined
      ? { reviveThreadIds: existing.reviveThreadIds }
      : {}),
    ...(existing.reviveChartIds !== undefined ? { reviveChartIds: existing.reviveChartIds } : {}),
    profileIds: existing.profileIds.filter((id) => !profileIds.has(id)),
    threadIds: existing.threadIds.filter((id) => !threadIds.has(id)),
    chartIds: existing.chartIds.filter((id) => !chartIds.has(id)),
  };
}

export async function readDeletionTombstones(): Promise<DeletionTombstones> {
  const repository = await portableRepository();
  if (repository !== null) {
    return parseDeletionTombstones(await repository.read(PORTABLE_LEDGER_KEY));
  }
  if (typeof indexedDB === 'undefined') {
    return EMPTY_TOMBSTONES;
  }
  return mergeDeletionTombstones(
    await idbGet<unknown>(DELETION_TOMBSTONES_KEY, useKeyvalStore),
    {},
  );
}

/** Adopt the durable generation before a live realm applies a broadcast change. */
export async function adoptLatestDatasetEpoch(): Promise<{
  readonly changed: boolean;
  readonly epoch: number;
}> {
  const ledger = await readDeletionTombstones();
  const changed =
    observedRestoreEpoch !== ledger.restoreEpoch ||
    observedRestoreInProgress !== ledger.restoreInProgress;
  observedRestoreEpoch = ledger.restoreEpoch;
  observedRestoreInProgress = ledger.restoreInProgress;
  mirrorRestoreEpoch(ledger.restoreEpoch, ledger.restoreInProgress);
  return { changed, epoch: ledger.restoreEpoch };
}

function scheduleAbandonedRestoreRecovery(ledger: DeletionTombstones): void {
  if (
    !ledger.restoreInProgress ||
    ledger.restoreStartedAt === undefined ||
    scheduledRecoveryEpochs.has(ledger.restoreEpoch) ||
    ledger.profileIds.length > 0 ||
    ledger.threadIds.length > 0 ||
    ledger.chartIds.length > 0
  ) {
    return;
  }
  scheduledRecoveryEpochs.add(ledger.restoreEpoch);
  const delay = Math.max(0, ledger.restoreStartedAt + RESTORE_LEASE_MS - Date.now());
  const timer = globalThis.setTimeout(() => {
    scheduledRecoveryEpochs.delete(ledger.restoreEpoch);
    void readDeletionTombstones().then(async (current) => {
      if (current.restoreInProgress && current.restoreEpoch === ledger.restoreEpoch) {
        await abortBackupRestore(current.restoreEpoch);
      }
    });
  }, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
}

function leaseExpired(ledger: DeletionTombstones): boolean {
  return (
    ledger.restoreStartedAt !== undefined &&
    ledger.restoreStartedAt + RESTORE_LEASE_MS <= Date.now()
  );
}

function leaseOwner(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function acquireDatasetMutationLease(
  transform: (current: DeletionTombstones) => DeletionTombstones,
): Promise<number> {
  const owner = leaseOwner();
  const repository = await portableRepository();
  if (repository !== null) {
    for (;;) {
      const transaction = await repository.transactWithResult(({ values }) => {
        const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
        if (ledger.restoreInProgress && !leaseExpired(ledger)) {
          return { mutations: [], result: undefined as number | undefined };
        }
        const next = transform(ledger);
        const acquiredEpoch = Math.max(ledger.restoreEpoch, ledger.activeEpoch) + 1;
        return {
          mutations: [
            {
              type: 'put',
              key: PORTABLE_LEDGER_KEY,
              value: serializeDeletionTombstones({
                ...next,
                restoreEpoch: acquiredEpoch,
                restoreInProgress: true,
                restoreStartedAt: Date.now(),
                leaseOwner: owner,
              }),
            },
          ],
          result: acquiredEpoch,
        };
      });
      if (transaction.result !== undefined) return transaction.result;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    }
  }
  for (;;) {
    let acquiredEpoch: number | undefined;
    await idbUpdate<unknown>(
      DELETION_TOMBSTONES_KEY,
      (current) => {
        const ledger = mergeDeletionTombstones(current, {});
        if (ledger.restoreInProgress && !leaseExpired(ledger)) return ledger;
        const next = transform(ledger);
        acquiredEpoch = Math.max(ledger.restoreEpoch, ledger.activeEpoch) + 1;
        return {
          ...next,
          restoreEpoch: acquiredEpoch,
          restoreInProgress: true,
          restoreStartedAt: Date.now(),
          leaseOwner: owner,
        };
      },
      useKeyvalStore,
    );
    if (acquiredEpoch !== undefined) return acquiredEpoch;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
}

/** Atomically add durable tombstones shared by every tab and installed PWA realm. */
export async function recordDeletionTombstones(
  additions: DeletionTombstoneAdditions,
  epoch?: number,
): Promise<void> {
  const repository = await portableRepository();
  if (repository === null && typeof indexedDB === 'undefined') {
    return;
  }
  const activeEpoch =
    epoch ??
    (await acquireDatasetMutationLease((current) => ({
      ...mergeDeletionTombstones(current, additions),
      reviveProfileIds: [],
      reviveThreadIds: [],
      reviveChartIds: [],
    })));
  if (epoch !== undefined) {
    await appendDeletionTombstones(epoch, additions, repository);
  }
  observedRestoreEpoch = activeEpoch;
  observedRestoreInProgress = true;
  mirrorRestoreEpoch(activeEpoch, true);
}

async function appendDeletionTombstones(
  epoch: number,
  additions: DeletionTombstoneAdditions,
  repositoryOverride?: PortableStateRepository | null,
): Promise<void> {
  const repository = repositoryOverride ?? (await portableRepository());
  if (repository !== null) {
    const transaction = await repository.transactWithResult(({ values }) => {
      const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
      if (!ledger.restoreInProgress || ledger.restoreEpoch !== epoch) {
        return { mutations: [], result: false };
      }
      return {
        mutations: [
          {
            type: 'put',
            key: PORTABLE_LEDGER_KEY,
            value: serializeDeletionTombstones(mergeDeletionTombstones(ledger, additions)),
          },
        ],
        result: true,
      };
    });
    if (!transaction.result) throw new Error('Dataset mutation lease is no longer active.');
    return;
  }
  let appended = false;
  await idbUpdate<unknown>(
    DELETION_TOMBSTONES_KEY,
    (current) => {
      const ledger = mergeDeletionTombstones(current, {});
      if (!ledger.restoreInProgress || ledger.restoreEpoch !== epoch) return ledger;
      appended = true;
      return mergeDeletionTombstones(ledger, additions);
    },
    useKeyvalStore,
  );
  if (!appended) throw new Error('Dataset mutation lease is no longer active.');
}

/** Fence stale realms, then permit exactly the IDs carried by a Replace backup. */
export async function beginBackupRestore(restored: DeletionTombstoneAdditions): Promise<number> {
  if ((await portableRepository()) === null && typeof indexedDB === 'undefined') {
    return 0;
  }
  const epoch = await acquireDatasetMutationLease((current) => ({
    ...current,
    reviveProfileIds: [...(restored.profileIds ?? [])],
    reviveThreadIds: [...(restored.threadIds ?? [])],
    reviveChartIds: [...(restored.chartIds ?? [])],
  }));
  observedRestoreEpoch = epoch;
  observedRestoreInProgress = true;
  mirrorRestoreEpoch(epoch, true);
  return epoch;
}

/** Fence all other destructive operations before reading the active dataset. */
export async function beginDatasetMutation(): Promise<number> {
  if ((await portableRepository()) === null && typeof indexedDB === 'undefined') return 0;
  const epoch = await acquireDatasetMutationLease((current) => ({
    ...current,
    reviveProfileIds: [],
    reviveThreadIds: [],
    reviveChartIds: [],
  }));
  observedRestoreEpoch = epoch;
  observedRestoreInProgress = true;
  mirrorRestoreEpoch(epoch, true);
  return epoch;
}

/** Publish a completed Replace generation only after all source snapshots land. */
export async function finalizeBackupRestore(epoch: number): Promise<void> {
  const repository = await portableRepository();
  if (repository !== null) {
    const transaction = await repository.transactWithResult(({ values }) => {
      const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
      if (ledger.restoreEpoch !== epoch) return { mutations: [], result: false };
      return {
        mutations: [
          {
            type: 'put',
            key: PORTABLE_LEDGER_KEY,
            value: serializeDeletionTombstones({
              ...ledger,
              activeEpoch: epoch,
              restoreInProgress: false,
              restoreStartedAt: undefined,
              leaseOwner: undefined,
              reviveProfileIds: [],
              reviveThreadIds: [],
              reviveChartIds: [],
            }),
          },
        ],
        result: true,
      };
    });
    if (!transaction.result) throw new Error('Dataset Replace generation is no longer active.');
    mirrorRestoreEpoch(epoch, false);
    observedRestoreInProgress = false;
    return;
  }
  if (typeof indexedDB === 'undefined') {
    return;
  }
  await idbUpdate<unknown>(
    DELETION_TOMBSTONES_KEY,
    (current) => {
      const ledger = mergeDeletionTombstones(current, {});
      return ledger.restoreEpoch === epoch
        ? {
            ...ledger,
            activeEpoch: epoch,
            restoreInProgress: false,
            restoreStartedAt: undefined,
            leaseOwner: undefined,
            reviveProfileIds: [],
            reviveThreadIds: [],
            reviveChartIds: [],
          }
        : ledger;
    },
    useKeyvalStore,
  );
  mirrorRestoreEpoch(epoch, false);
  observedRestoreInProgress = false;
}

/** Release hydration after a failed Replace; partial snapshots remain explicit. */
export async function abortBackupRestore(epoch: number): Promise<void> {
  const repository = await portableRepository();
  if (repository !== null) {
    await repository.transact(({ values }) => {
      const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
      if (ledger.restoreEpoch !== epoch) return [];
      return [
        {
          type: 'put',
          key: PORTABLE_LEDGER_KEY,
          value: serializeDeletionTombstones({
            ...ledger,
            restoreInProgress: false,
            restoreStartedAt: undefined,
            leaseOwner: undefined,
            reviveProfileIds: [],
            reviveThreadIds: [],
            reviveChartIds: [],
          }),
        },
      ];
    });
    const ledger = await readDeletionTombstones();
    observedRestoreEpoch = ledger.restoreEpoch;
    observedRestoreInProgress = false;
    mirrorRestoreEpoch(ledger.restoreEpoch, false);
    return;
  }
  if (typeof indexedDB === 'undefined') {
    return;
  }
  await idbUpdate<unknown>(
    DELETION_TOMBSTONES_KEY,
    (current) => {
      const ledger = mergeDeletionTombstones(current, {});
      return ledger.restoreEpoch === epoch
        ? {
            ...ledger,
            restoreEpoch: ledger.restoreEpoch,
            restoreInProgress: false,
            restoreStartedAt: undefined,
            leaseOwner: undefined,
            reviveProfileIds: [],
            reviveThreadIds: [],
            reviveChartIds: [],
          }
        : ledger;
    },
    useKeyvalStore,
  );
  const ledger = await readDeletionTombstones();
  observedRestoreEpoch = ledger.restoreEpoch;
  observedRestoreInProgress = false;
  mirrorRestoreEpoch(ledger.restoreEpoch, false);
}

export interface DatasetSnapshotWrite {
  readonly key: string;
  readonly value: string | null;
}

function keepVectorRecord(record: unknown, ledger: DeletionTombstones): boolean {
  if (!isRecord(record)) return true;
  const profileId = typeof record.profile_id === 'string' ? record.profile_id : undefined;
  const threadId = typeof record.thread_id === 'string' ? record.thread_id : undefined;
  return (
    (profileId === undefined || !ledger.profileIds.includes(profileId)) &&
    (threadId === undefined || !ledger.threadIds.includes(threadId))
  );
}

function retagVectorPayload(value: unknown, ledger: DeletionTombstones, epoch: number): unknown {
  if (Array.isArray(value)) {
    return {
      generation: epoch,
      records: value.filter((record) => keepVectorRecord(record, ledger)),
    };
  }
  if (!isRecord(value) || !Array.isArray(value.records)) return undefined;
  return {
    ...value,
    generation: epoch,
    records: value.records.filter((record) => keepVectorRecord(record, ledger)),
  };
}

/**
 * Crash-atomic personal-data Replace. Canonical snapshots and the generation
 * flip share one SQLite transaction; rebuildable caches remain outside it and
 * are fenced by the committed generation/rebuild marker.
 */
export async function commitDatasetGeneration(
  epoch: number,
  writes: readonly DatasetSnapshotWrite[],
  deletedKeys: readonly string[] = [],
  options: {
    readonly afterWrite?: (index: number) => void;
    readonly retagGenerationKeys?: readonly string[];
    readonly memoryRebuildPending?: boolean;
  } = {},
): Promise<void> {
  const repository = await portableRepository();
  if (repository !== null) {
    const derivedWrites = writes.filter((write) => !isPortableStateKey(write.key));
    const retagged =
      typeof indexedDB === 'undefined'
        ? []
        : await Promise.all(
            (options.retagGenerationKeys ?? []).map(async (key) => ({
              key,
              value: await idbGet<unknown>(key, useKeyvalStore),
            })),
          );
    for (const [index, write] of writes.entries()) {
      if (isPortableStateKey(write.key)) options.afterWrite?.(index);
    }
    const transaction = await repository.transactWithResult(({ values }) => {
      const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
      if (!ledger.restoreInProgress || ledger.restoreEpoch !== epoch) {
        throw new Error('Dataset Replace generation is no longer active.');
      }
      const effectiveLedger = subtractRestoredTombstones(ledger, {
        profileIds: ledger.reviveProfileIds,
        threadIds: ledger.reviveThreadIds,
        chartIds: ledger.reviveChartIds,
      });
      const mutations = writes
        .filter((write) => isPortableStateKey(write.key))
        .map((write) => {
          return write.value === null
            ? ({ type: 'delete', key: write.key } as const)
            : ({
                type: 'put',
                key: write.key,
                value:
                  write.key === 'almamesh-language'
                    ? write.value
                    : tagPersistedValue(
                        sanitizePersistedValue(write.key, write.value, effectiveLedger),
                        epoch,
                      ),
              } as const);
        });
      mutations.push({
        type: 'put',
        key: PORTABLE_LEDGER_KEY,
        value: serializeDeletionTombstones({
          ...effectiveLedger,
          activeEpoch: epoch,
          restoreEpoch: epoch,
          restoreInProgress: false,
          restoreStartedAt: undefined,
          leaseOwner: undefined,
          memoryRebuildPending: options.memoryRebuildPending ?? ledger.memoryRebuildPending,
          profileIds: [],
          threadIds: [],
          chartIds: [],
          reviveProfileIds: [],
          reviveThreadIds: [],
          reviveChartIds: [],
        }),
      });
      return { mutations, result: effectiveLedger };
    });
    const effectiveLedger = transaction.result;
    if (typeof indexedDB !== 'undefined') {
      for (const write of derivedWrites) {
        if (write.value === null) await idbDel(write.key, useKeyvalStore);
        else {
          const sanitized = sanitizePersistedValue(write.key, write.value, effectiveLedger);
          await idbSet(write.key, tagPersistedValue(sanitized, epoch), useKeyvalStore);
        }
      }
      for (const entry of retagged) {
        const value = retagVectorPayload(entry.value, effectiveLedger, epoch);
        if (value !== undefined) await idbSet(entry.key, value, useKeyvalStore);
      }
      await Promise.all(deletedKeys.map((key) => idbDel(key, useKeyvalStore)));
    }
    observedRestoreEpoch = epoch;
    observedRestoreInProgress = false;
    mirrorRestoreEpoch(epoch, false);
    return;
  }
  if (typeof indexedDB === 'undefined') {
    return;
  }
  await useKeyvalStore(
    'readwrite',
    (store) =>
      new Promise<void>((resolve, reject) => {
        const ledgerRequest = store.get(DELETION_TOMBSTONES_KEY);
        ledgerRequest.onerror = () => reject(ledgerRequest.error);
        ledgerRequest.onsuccess = () => {
          const ledger = mergeDeletionTombstones(ledgerRequest.result, {});
          if (!ledger.restoreInProgress || ledger.restoreEpoch !== epoch) {
            reject(new Error('Dataset Replace generation is no longer active.'));
            return;
          }
          const effectiveLedger = subtractRestoredTombstones(ledger, {
            profileIds: ledger.reviveProfileIds,
            threadIds: ledger.reviveThreadIds,
            chartIds: ledger.reviveChartIds,
          });
          const finish = (retagged: readonly { key: string; value: unknown }[]): void => {
            for (const [index, write] of writes.entries()) {
              if (write.value === null) store.delete(write.key);
              else {
                const sanitized = sanitizePersistedValue(write.key, write.value, effectiveLedger);
                store.put(tagPersistedValue(sanitized, epoch), write.key);
              }
              try {
                options.afterWrite?.(index);
              } catch (error) {
                store.transaction.abort();
                reject(error);
                return;
              }
            }
            for (const entry of retagged) {
              const value = retagVectorPayload(entry.value, effectiveLedger, epoch);
              if (value !== undefined) store.put(value, entry.key);
            }
            for (const key of deletedKeys) store.delete(key);
            store.put(
              {
                ...effectiveLedger,
                activeEpoch: epoch,
                restoreEpoch: epoch,
                restoreInProgress: false,
                restoreStartedAt: undefined,
                leaseOwner: undefined,
                memoryRebuildPending: options.memoryRebuildPending ?? ledger.memoryRebuildPending,
                profileIds: [],
                threadIds: [],
                chartIds: [],
                reviveProfileIds: [],
                reviveThreadIds: [],
                reviveChartIds: [],
              },
              DELETION_TOMBSTONES_KEY,
            );
            void promisifyRequest(store.transaction).then(() => resolve(), reject);
          };
          const keys = options.retagGenerationKeys ?? [];
          if (keys.length === 0) {
            finish([]);
            return;
          }
          const retagged: { key: string; value: unknown }[] = [];
          let remaining = keys.length;
          for (const key of keys) {
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              retagged.push({ key, value: request.result });
              remaining -= 1;
              if (remaining === 0) finish(retagged);
            };
          }
        };
      }),
  );
  observedRestoreEpoch = epoch;
  observedRestoreInProgress = false;
  mirrorRestoreEpoch(epoch, false);
}

export async function bumpRestoreEpoch(): Promise<number> {
  return beginBackupRestore({});
}

/** Clear the durable rebuild obligation only after a complete successful reindex. */
export async function clearMemoryRebuildPending(expectedEpoch?: number): Promise<void> {
  const repository = await portableRepository();
  if (repository !== null) {
    await repository.transact(({ values }) => {
      const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
      if (expectedEpoch !== undefined && ledger.activeEpoch !== expectedEpoch) return [];
      return [
        {
          type: 'put',
          key: PORTABLE_LEDGER_KEY,
          value: serializeDeletionTombstones({
            ...ledger,
            memoryRebuildPending: false,
          }),
        },
      ];
    });
    return;
  }
  if (typeof indexedDB === 'undefined') return;
  await idbUpdate<unknown>(
    DELETION_TOMBSTONES_KEY,
    (current) => {
      const ledger = mergeDeletionTombstones(current, {});
      return expectedEpoch === undefined || ledger.activeEpoch === expectedEpoch
        ? { ...ledger, memoryRebuildPending: false }
        : ledger;
    },
    useKeyvalStore,
  );
}

function persistedEpoch(value: string): number {
  try {
    const parsed = JSON.parse(value) as { datasetEpoch?: unknown };
    return Number.isSafeInteger(parsed.datasetEpoch) ? (parsed.datasetEpoch as number) : 0;
  } catch {
    return 0;
  }
}

export function tagPersistedValue(value: string, epoch: number): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? JSON.stringify({ ...parsed, datasetEpoch: epoch }) : value;
  } catch {
    return value;
  }
}

async function readIdbValueAndLedger(
  name: string,
): Promise<{ readonly value: unknown; readonly ledger: DeletionTombstones }> {
  return useKeyvalStore('readonly', async (store) => {
    const [value, ledger] = await Promise.all([
      promisifyRequest(store.get(name)),
      promisifyRequest(store.get(DELETION_TOMBSTONES_KEY)),
    ]);
    return { value, ledger: mergeDeletionTombstones(ledger, {}) };
  });
}

function setSanitizedIdbValue(name: string, value: string): Promise<void> {
  return useKeyvalStore(
    'readwrite',
    (store) =>
      new Promise<void>((resolve, reject) => {
        const ledgerRequest = store.get(DELETION_TOMBSTONES_KEY);
        ledgerRequest.onerror = () => reject(ledgerRequest.error);
        ledgerRequest.onsuccess = () => {
          try {
            const tombstones = mergeDeletionTombstones(ledgerRequest.result, {});
            if (
              !tombstones.restoreInProgress &&
              shouldAcceptRestoreEpoch(observedRestoreEpoch, tombstones.restoreEpoch)
            ) {
              const sanitized = sanitizePersistedValue(name, value, tombstones);
              store.put(tagPersistedValue(sanitized, tombstones.activeEpoch), name);
            }
            void promisifyRequest(store.transaction).then(() => resolve(), reject);
          } catch (error) {
            reject(error);
          }
        };
      }),
  );
}

/**
 * Historical adapter name retained by the stores. Production routes canonical
 * rows through SQLite CAS; the IndexedDB path exists only for Node tests and
 * explicitly derived caches. A stale tab cannot write across a tombstone.
 */
export const deletionAwareIdbStorage: StateStorage = {
  getItem: async (name) => {
    const repository = await portableRepository();
    if (repository !== null && isPortableStateKey(name)) {
      const snapshot = await repository.snapshot();
      const tombstones = parseDeletionTombstones(snapshot.values.get(PORTABLE_LEDGER_KEY) ?? null);
      observedRestoreEpoch = tombstones.restoreEpoch;
      observedRestoreInProgress = tombstones.restoreInProgress;
      mirrorRestoreEpoch(tombstones.restoreEpoch, tombstones.restoreInProgress);
      scheduleAbandonedRestoreRecovery(tombstones);
      const value = snapshot.values.get(name);
      if (value === undefined || persistedEpoch(value) !== tombstones.activeEpoch) return null;
      return sanitizePersistedValue(name, value, tombstones);
    }
    if (typeof indexedDB === 'undefined') {
      return null;
    }
    const { value, ledger: tombstones } = await readIdbValueAndLedger(name);
    observedRestoreEpoch = tombstones.restoreEpoch;
    observedRestoreInProgress = tombstones.restoreInProgress;
    mirrorRestoreEpoch(tombstones.restoreEpoch, tombstones.restoreInProgress);
    scheduleAbandonedRestoreRecovery(tombstones);
    if (typeof value !== 'string' || persistedEpoch(value) !== tombstones.activeEpoch) {
      return null;
    }
    return sanitizePersistedValue(name, value, tombstones);
  },
  setItem: (name, value) =>
    enqueuePersistenceMutation(name, async () => {
      const repository = await portableRepository();
      if (repository !== null && isPortableStateKey(name)) {
        await repository.transact(({ values }) => {
          const tombstones = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
          if (
            tombstones.restoreInProgress ||
            !shouldAcceptRestoreEpoch(observedRestoreEpoch, tombstones.restoreEpoch)
          ) {
            return [];
          }
          const sanitized = sanitizePersistedValue(name, value, tombstones);
          return [
            {
              type: 'put',
              key: name,
              value: tagPersistedValue(sanitized, tombstones.activeEpoch),
            },
          ];
        });
        return;
      }
      if (typeof indexedDB !== 'undefined') {
        await setSanitizedIdbValue(name, value);
      }
    }),
  removeItem: (name) =>
    enqueuePersistenceMutation(name, async () => {
      const repository = await portableRepository();
      if (repository !== null && isPortableStateKey(name)) {
        await repository.delete(name);
        return;
      }
      if (typeof indexedDB !== 'undefined') {
        await idbDel(name, useKeyvalStore);
      }
    }),
};

/**
 * Portable preferences share the SQLite file but are not dataset-generation
 * records. localStorage is only a disposable boot mirror and Node-test fallback.
 */
export const portablePreferenceStorage: StateStorage = {
  getItem: async (name) => {
    const repository = await portableRepository();
    if (repository !== null && isPortableStateKey(name)) return repository.read(name);
    const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
    return typeof storage?.getItem === 'function' ? storage.getItem(name) : null;
  },
  setItem: (name, value) =>
    enqueuePersistenceMutation(name, async () => {
      const repository = await portableRepository();
      if (repository !== null && isPortableStateKey(name)) await repository.write(name, value);
      const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
      storage?.setItem?.(name, value);
    }),
  removeItem: (name) =>
    enqueuePersistenceMutation(name, async () => {
      const repository = await portableRepository();
      if (repository !== null && isPortableStateKey(name)) await repository.delete(name);
      const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
      storage?.removeItem?.(name);
    }),
};

export async function readActiveDatasetStoreKeys(
  keys: readonly string[],
): Promise<readonly string[]> {
  const reads = await Promise.all(
    keys.map(async (key) => ({
      key,
      value: await deletionAwareIdbStorage.getItem(key),
    })),
  );
  return reads.filter((entry) => entry.value !== null).map((entry) => entry.key);
}

function dropRecordKeys(
  value: unknown,
  shouldDrop: (key: string, entry: unknown) => boolean,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => !shouldDrop(key, entry)),
  );
}

function entryOwner(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.profile_id === 'string' ? entry.profile_id : undefined;
}

function interpretationOwner(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.profileId === 'string' ? entry.profileId : undefined;
}

function sanitizeProfiles(
  state: Record<string, unknown>,
  profileIds: ReadonlySet<string>,
): Record<string, unknown> {
  const kept = dropRecordKeys(state.profiles, (profileId) => profileIds.has(profileId));
  const profiles = Object.fromEntries(
    Object.entries(kept).map(([profileId, profile]) => {
      if (!isRecord(profile) || !profileIds.has(String(profile.relatedTo ?? ''))) {
        return [profileId, profile];
      }
      const { relationship: _relationship, relatedTo: _relatedTo, ...unlinked } = profile;
      return [profileId, unlinked];
    }),
  );
  const active = state.activeProfileId;
  const activeProfileId =
    typeof active === 'string' && active in profiles ? active : (Object.keys(profiles)[0] ?? null);
  return { ...state, profiles, activeProfileId };
}

function sanitizeChat(
  state: Record<string, unknown>,
  profileIds: ReadonlySet<string>,
  threadIds: ReadonlySet<string>,
): Record<string, unknown> {
  const threads = dropRecordKeys(
    state.threads,
    (threadId, thread) => threadIds.has(threadId) || profileIds.has(entryOwner(thread) ?? ''),
  );
  const messages = dropRecordKeys(state.messages, (threadId) => !(threadId in threads));
  return { ...state, threads, messages };
}

function sanitizeState(
  name: string,
  state: Record<string, unknown>,
  tombstones: DeletionTombstones,
): Record<string, unknown> {
  const profileIds = new Set(tombstones.profileIds);
  const threadIds = new Set(tombstones.threadIds);
  const chartIds = new Set(tombstones.chartIds);
  switch (name) {
    case 'almamesh-profiles':
      return sanitizeProfiles(state, profileIds);
    case 'almamesh-chart-library':
      return {
        ...state,
        charts: dropRecordKeys(
          state.charts,
          (chartId, chart) => chartIds.has(chartId) || profileIds.has(entryOwner(chart) ?? ''),
        ),
      };
    case 'almamesh-life-events':
      return {
        ...state,
        eventsByProfile: dropRecordKeys(state.eventsByProfile, (profileId) =>
          profileIds.has(profileId),
        ),
      };
    case 'almamesh-rectification-records':
      return {
        ...state,
        recordsByProfile: dropRecordKeys(state.recordsByProfile, (profileId) =>
          profileIds.has(profileId),
        ),
      };
    case 'almamesh-chat-history':
      return sanitizeChat(state, profileIds, threadIds);
    case 'almamesh-predictive':
      return typeof state.profileKey === 'string' && profileIds.has(state.profileKey)
        ? { status: 'idle' }
        : state;
    case 'almamesh-interpretations':
      return {
        ...state,
        byChart: dropRecordKeys(
          state.byChart,
          (chartId, entry) =>
            chartIds.has(chartId) || profileIds.has(interpretationOwner(entry) ?? ''),
        ),
      };
    default:
      return state;
  }
}

export function sanitizePersistedValue(
  name: string,
  value: string,
  tombstones: DeletionTombstones,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) {
    return value;
  }
  return JSON.stringify({
    ...parsed,
    state: sanitizeState(name, parsed.state, tombstones),
  });
}
