import type { StateStorage } from 'zustand/middleware';
import { deleteLegacyKeyval, readLegacyKeyval } from './legacyKeyval';
import {
  migrateLegacyState,
  openPortableStateRepository,
  isPortableStateKey,
  isPortablePreferenceKey,
  PORTABLE_DATASET_KEYS,
  PORTABLE_LEDGER_KEY,
  PORTABLE_PREFERENCE_MIRROR_KEYS,
  PORTABLE_PREFERENCES_KEY,
  PORTABLE_QUARANTINE_NAMESPACE,
  PORTABLE_STATE_KEYS,
  decodePortablePreferences,
  resolvePortableStateMode,
  type LegacyStateStorage,
  type PortablePreferenceMirrorKey,
  type PortableStateMutation,
  type PortableStateRepository,
  type PortableStateSnapshot,
} from './portableState';
import {
  markPortableStateUnavailable,
  nonDestructiveLegacyStorage,
  openPortableStateWithFallback,
} from './portablePersistence';
import {
  absorbLegacyQuarantine,
  memoryQuarantineRows,
  quarantineKeysOwnedBy,
  repositoryQuarantineRows,
  type InterpretationQuarantineRows,
} from './interpretationQuarantine';
import { browserLocalStorage } from './webStorage';
import {
  createLeaseOwner,
  holdsAnyLease,
  isLeaseAbandoned,
  isLocalLeaseOwner,
  releaseLeaseOwner,
  resetDatasetLeaseForTests,
  RESTORE_LEASE_MS,
  whenLeaseMayHaveEnded,
} from './datasetLease';
import { reportDroppedWrite } from './droppedWrites';

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

/**
 * Runtimes without the SQLite Worker (Node tests, SSR prerender) keep the
 * dataset and its ledger in memory for the session. Never IndexedDB or
 * localStorage: SQLite is the only durable store for app data.
 */
const sessionRows = new Map<string, unknown>();

/** Test seam: the in-memory session rows used when no SQLite repository exists. */
export function sessionRowsForTests(): Map<string, unknown> {
  return sessionRows;
}

/** Test seam: forget the session dataset, ledger and quarantine (a new page load). */
export function resetSessionStateForTests(): void {
  sessionRows.clear();
  sessionQuarantine.clear();
}

/** Session-only quarantine rows for the same runtimes (see interpretationQuarantine.ts). */
const sessionQuarantine = new Map<string, string>();

/**
 * Where quarantined interpretation rows live: the `quarantine` namespace of the
 * portable SQLite file, or session memory where no SQLite repository exists.
 */
export async function interpretationQuarantineRows(): Promise<InterpretationQuarantineRows> {
  const repository = await portableRepository();
  return repository === null
    ? memoryQuarantineRows(sessionQuarantine)
    : repositoryQuarantineRows(repository);
}

function updateSessionRow(key: string, update: (current: unknown) => unknown): void {
  sessionRows.set(key, update(sessionRows.get(key)));
}
let portableRepositoryPromise: Promise<PortableStateRepository> | undefined;
let portableRepositoryOverride: PortableStateRepository | null | undefined;
let observedActiveEpoch = 0;
let observedRestoreEpoch: number | undefined;
let observedRestoreInProgress = false;
const watchedLeases = new Set<string>();
/** Leases this realm took, by generation, so settling one releases its liveness lock. */
const localLeaseOwners = new Map<number, string>();
/**
 * Stores that hydrated while another realm held the lease. Their value is the
 * one at this active generation; if the lease settles without moving it, the
 * hydration is still current and their writes are accepted again.
 */
const leaseHydratedDatasetEpochs = new Map<string, number>();
let leaseRecovery: Promise<boolean> | undefined;
const persistenceMutationQueues = new Map<string, Promise<void>>();
const persistenceMutationFailures = new Map<string, unknown>();
const locallyHydratedDatasetEpochs = new Map<string, number>();
const locallyAcknowledgedDatasetValues = new Map<string, string | null>();
const locallyHydratedPreferenceEpochs = new Map<string, number>();
const inMemoryPreferenceFallback = new Map<string, string>();
let localBackupRestoreEpoch: number | undefined;

const PORTABLE_PREFERENCE_HYDRATION_KEYS = [
  'almamesh-language',
  PORTABLE_PREFERENCES_KEY,
  ...PORTABLE_PREFERENCE_MIRROR_KEYS,
] as const;

/** Serialize one persisted row without blocking independent store keys. */
function enqueuePersistenceMutation(name: string, mutation: () => Promise<void>): Promise<void> {
  const previous = persistenceMutationQueues.get(name) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  persistenceMutationQueues.set(name, current);
  void current.then(
    () => {
      if (persistenceMutationQueues.get(name) !== current) return;
      persistenceMutationQueues.delete(name);
      persistenceMutationFailures.delete(name);
    },
    (error: unknown) => {
      if (persistenceMutationQueues.get(name) !== current) return;
      persistenceMutationQueues.delete(name);
      persistenceMutationFailures.set(name, error);
    },
  );
  return current;
}

/**
 * Resolve once every write queued for `name` has finished (committed or failed).
 * Zustand's persist middleware fires `setItem` without awaiting it, so a store's
 * in-memory state runs ahead of SQLite. A reader that must not show state a
 * reload would lose awaits this first. Failures settle too: the writer's own
 * promise still rejects, and the reader never hangs on a broken disk.
 */
export async function whenPersistenceSettled(name: string): Promise<void> {
  for (
    let pending = persistenceMutationQueues.get(name);
    pending !== undefined;
    pending = persistenceMutationQueues.get(name)
  ) {
    await pending.catch(() => undefined);
  }
}

/** Wait until every queued canonical write is visible to an immediate export. */
export async function flushPortablePersistence(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pending = [...persistenceMutationQueues.values()];
    if (pending.length === 0) {
      const failed = persistenceMutationFailures.values().next();
      if (!failed.done) throw failed.value;
      return;
    }
    const results = await Promise.allSettled(pending);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected !== undefined) throw rejected.reason;
  }
  throw new Error('Portable persistence remained busy while preparing an export.');
}

/** Unit-test seam. Production always opens the OPFS-backed EdgeProc store. */
export function setPortableStateRepositoryForTests(
  repository: PortableStateRepository | null | undefined,
): void {
  portableRepositoryOverride = repository;
  resetSessionStateForTests();
  locallyHydratedDatasetEpochs.clear();
  locallyAcknowledgedDatasetValues.clear();
  locallyHydratedPreferenceEpochs.clear();
  localBackupRestoreEpoch = undefined;
  observedActiveEpoch = 0;
  observedRestoreEpoch = undefined;
  observedRestoreInProgress = false;
  inMemoryPreferenceFallback.clear();
  persistenceMutationFailures.clear();
  leaseHydratedDatasetEpochs.clear();
  watchedLeases.clear();
  localLeaseOwners.clear();
  leaseRecovery = undefined;
  resetDatasetLeaseForTests();
}

function observeDurableLedger(ledger: DeletionTombstones): void {
  observedActiveEpoch = ledger.activeEpoch;
  observedRestoreEpoch = ledger.restoreEpoch;
  observedRestoreInProgress = ledger.restoreInProgress;
}

/** Synchronous active generation after the canonical ledger has hydrated. */
export function readObservedDatasetEpoch(): number {
  return observedActiveEpoch;
}

function markPreferencesHydrated(ledger: DeletionTombstones): void {
  if (ledger.restoreInProgress) return;
  for (const key of PORTABLE_PREFERENCE_HYDRATION_KEYS) {
    locallyHydratedPreferenceEpochs.set(key, ledger.activeEpoch);
  }
}

/** Verified one-time Web Storage import; exported for migration contract tests. */
export async function migrateLegacyPreferencesToRepository(
  repository: PortableStateRepository,
  retireLegacy = true,
): Promise<void> {
  // TODO(remove after 2026-11-04, one release after the SQLite-only move):
  // legacy localStorage preference reader; drop once visitors have migrated.
  const storage = browserLocalStorage();
  const legacyValues: Partial<Record<PortablePreferenceMirrorKey, string>> = {};
  if (
    typeof storage?.getItem === 'function' &&
    typeof storage.removeItem === 'function'
  ) {
    for (const key of PORTABLE_PREFERENCE_MIRROR_KEYS) {
      let value: string | null;
      try {
        value = storage.getItem(key);
      } catch {
        value = null;
      }
      if (value === null) continue;
      try {
        decodePortablePreferences(
          JSON.stringify({ version: 1, values: { ...legacyValues, [key]: value } }),
        );
        legacyValues[key] = value;
      } catch {
        // Corrupt legacy mirrors were never usable state and are omitted from
        // the one-time canonical migration below.
      }
    }
  }
  // Even an empty row is the durable migration marker. Once present, a stale
  // Web Storage value can never resurrect settings after reset or transfer.
  await repository.transact(({ values }) =>
    values.has(PORTABLE_PREFERENCES_KEY)
      ? []
      : [
          {
            type: 'put',
            key: PORTABLE_PREFERENCES_KEY,
            value: JSON.stringify({ version: 1, values: legacyValues }),
          },
        ],
  );

  const canonical = await repository.read(PORTABLE_PREFERENCES_KEY);
  if (canonical === null) throw new Error('Portable preferences migration did not commit.');
  decodePortablePreferences(canonical);
  if (retireLegacy && typeof storage?.removeItem === 'function') {
    // SQLite is verified before legacy browser copies are retired. These keys
    // are never recreated; synchronous consumers use boot-hydrated memory.
    for (const key of [
      ...PORTABLE_PREFERENCE_MIRROR_KEYS,
      RESTORE_EPOCH_MIRROR_KEY,
      RESTORE_PROGRESS_MIRROR_KEY,
      'almamesh-chart',
    ]) {
      try {
        storage.removeItem(key);
      } catch {
        // A blocked legacy store is unreadable and non-authoritative.
      }
    }
  }
  const snapshot = await repository.snapshot();
  const ledger = parseDeletionTombstones(snapshot.values.get(PORTABLE_LEDGER_KEY) ?? null);
  observeDurableLedger(ledger);
  markPreferencesHydrated(ledger);
}

async function portableRepository(): Promise<PortableStateRepository | null> {
  if (portableRepositoryOverride !== undefined) return portableRepositoryOverride;
  let mode: ReturnType<typeof resolvePortableStateMode>;
  try {
    mode = resolvePortableStateMode();
  } catch (error) {
    markPortableStateUnavailable();
    throw error;
  }
  if (mode === 'node-test-fallback') return null;
  portableRepositoryPromise ??= openPortableStateWithFallback({
    open: openPortableStateRepository,
  }).then(async ({ repository, persistence }) => {
    // TODO(remove after 2026-11-04, one release after the SQLite-only move):
    // legacy idb-keyval/localStorage reader for the one-time migration below.
    const legacy: LegacyStateStorage = {
      get: async (key) => {
        if (key === 'almamesh-language') {
          const storage = browserLocalStorage();
          return typeof storage?.getItem === 'function' ? storage.getItem(key) : null;
        }
        const value = await readLegacyKeyval(key);
        if (value === undefined) return null;
        return typeof value === 'string' ? value : JSON.stringify(value);
      },
      delete: async (key) => {
        if (key === 'almamesh-language') {
          const storage = browserLocalStorage();
          storage?.removeItem?.(key);
          return;
        }
        await deleteLegacyKeyval(key);
      },
    };
    await migrateLegacyState(
      repository,
      persistence === 'memory' ? nonDestructiveLegacyStorage(legacy) : legacy,
      [...PORTABLE_STATE_KEYS.filter((key) => key !== PORTABLE_PREFERENCES_KEY), PORTABLE_LEDGER_KEY],
    );
    await migrateLegacyPreferencesToRepository(repository, persistence === 'opfs');
    return repository;
  });
  return portableRepositoryPromise;
}

/** Refresh preference hydration metadata after another realm replaces the dataset. */
export async function refreshPortablePreferenceMirrors(): Promise<void> {
  const repository = await portableRepository();
  if (repository === null) return;
  const snapshot = await repository.snapshot();
  const ledger = parseDeletionTombstones(snapshot.values.get(PORTABLE_LEDGER_KEY) ?? null);
  observeDurableLedger(ledger);
  markPreferencesHydrated(ledger);
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
    const ledger = parseDeletionTombstones(await repository.read(PORTABLE_LEDGER_KEY));
    observeDurableLedger(ledger);
    return ledger;
  }
  const ledger = mergeDeletionTombstones(sessionRows.get(DELETION_TOMBSTONES_KEY), {});
  observeDurableLedger(ledger);
  return ledger;
}

/** Adopt the durable generation before a live realm applies a broadcast change. */
export async function adoptLatestDatasetEpoch(): Promise<{
  readonly changed: boolean;
  readonly epoch: number;
}> {
  const previousRestoreEpoch = observedRestoreEpoch;
  const previousRestoreInProgress = observedRestoreInProgress;
  const ledger = await readDeletionTombstones();
  const changed =
    previousRestoreEpoch === undefined
      ? ledger.restoreEpoch > 0 || ledger.restoreInProgress
      : previousRestoreEpoch !== ledger.restoreEpoch ||
        previousRestoreInProgress !== ledger.restoreInProgress;
  return { changed, epoch: ledger.restoreEpoch };
}

function leaseIdentity(ledger: DeletionTombstones): string {
  return `${ledger.restoreEpoch}:${ledger.leaseOwner ?? ''}:${ledger.restoreStartedAt ?? ''}`;
}

function sameLease(left: DeletionTombstones, right: DeletionTombstones): boolean {
  return left.restoreInProgress && right.restoreInProgress && leaseIdentity(left) === leaseIdentity(right);
}

/**
 * A live lease held elsewhere at hydration: wait for its owner to end (its
 * Web Lock released, or its time up), then settle it if it was abandoned.
 */
function watchForeignLease(ledger: DeletionTombstones): void {
  const id = leaseIdentity(ledger);
  if (!ledger.restoreInProgress || isLocalLeaseOwner(ledger.leaseOwner) || watchedLeases.has(id)) {
    return;
  }
  watchedLeases.add(id);
  void whenLeaseMayHaveEnded(ledger)
    .then(async () => {
      await recoverAbandonedDatasetLease();
      const current = await readDeletionTombstones();
      watchedLeases.delete(id);
      if (!sameLease(current, ledger)) return;
      const retry = globalThis.setTimeout(() => watchForeignLease(current), RESTORE_LEASE_MS);
      (retry as unknown as { unref?: () => void }).unref?.();
    })
    .catch(() => {
      watchedLeases.delete(id);
    });
}

/** A crashed deletion: tombstones recorded, nothing being imported. */
function holdsPendingDeletion(ledger: DeletionTombstones): boolean {
  const reviving =
    (ledger.reviveProfileIds?.length ?? 0) > 0 ||
    (ledger.reviveThreadIds?.length ?? 0) > 0 ||
    (ledger.reviveChartIds?.length ?? 0) > 0;
  const deleting =
    ledger.profileIds.length > 0 || ledger.threadIds.length > 0 || ledger.chartIds.length > 0;
  return deleting && !reviving;
}

function settledLedger(ledger: DeletionTombstones): DeletionTombstones {
  return {
    ...ledger,
    restoreInProgress: false,
    restoreStartedAt: undefined,
    leaseOwner: undefined,
    reviveProfileIds: [],
    reviveThreadIds: [],
    reviveChartIds: [],
  };
}

/** Rows the dead owner wrote at its own generation are partial; nothing reads them. */
function partialGenerationDeletes(
  values: ReadonlyMap<string, string>,
  ledger: DeletionTombstones,
): PortableStateMutation[] {
  if (ledger.restoreEpoch === ledger.activeEpoch) return [];
  return PORTABLE_DATASET_KEYS.filter((key) => {
    const raw = values.get(key);
    return raw !== undefined && persistedEpoch(raw) === ledger.restoreEpoch;
  }).map((key) => ({ type: 'delete', key }) as const);
}

/** Abort: the last active generation stays the readable dataset. */
function abandonedLeaseAbort(
  values: ReadonlyMap<string, string>,
  ledger: DeletionTombstones,
): PortableStateMutation[] {
  return [
    ...partialGenerationDeletes(values, ledger),
    { type: 'put', key: PORTABLE_LEDGER_KEY, value: serializeDeletionTombstones(settledLedger(ledger)) },
  ];
}

/**
 * Roll a crashed deletion forward: the active rows, minus everything the
 * tombstones name, become a new generation, so the victim cannot come back
 * through an export or a stale tab. Derived vectors are rebuilt from chat.
 */
function abandonedDeletionRollForward(
  values: ReadonlyMap<string, string>,
  quarantine: ReadonlyMap<string, string>,
  ledger: DeletionTombstones,
): PortableStateMutation[] {
  const epoch = Math.max(ledger.restoreEpoch, ledger.activeEpoch) + 1;
  const rows: PortableStateMutation[] = PORTABLE_DATASET_KEYS.flatMap((key) => {
    const raw = values.get(key);
    if (raw === undefined || persistedEpoch(raw) !== ledger.activeEpoch) return [];
    const value = tagPersistedValue(sanitizePersistedValue(key, raw, ledger), epoch);
    return [{ type: 'put', key, value } as const];
  });
  const settled: DeletionTombstones = {
    ...settledLedger(ledger),
    activeEpoch: epoch,
    restoreEpoch: epoch,
    memoryRebuildPending: true,
    profileIds: [],
    threadIds: [],
    chartIds: [],
  };
  return [
    ...partialGenerationDeletes(values, ledger),
    ...rows,
    { type: 'put', key: PORTABLE_LEDGER_KEY, value: serializeDeletionTombstones(settled) },
    ...quarantineKeysOwnedBy(quarantine, ledger.profileIds).map(
      (key) => ({ type: 'delete', namespace: PORTABLE_QUARANTINE_NAMESPACE, key }) as const,
    ),
  ];
}

async function runLeaseRecovery(held?: PortableStateRepository): Promise<boolean> {
  const repository = held ?? (await portableRepository());
  // Session rows die with the page; only the SQLite ledger outlives a crash.
  if (repository === null) return false;
  const observed = parseDeletionTombstones(await repository.read(PORTABLE_LEDGER_KEY));
  if (!(await isLeaseAbandoned(observed))) return false;
  const transaction = await repository.transactWithResult(({ values, quarantine }) => {
    const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
    if (!sameLease(ledger, observed)) return { mutations: [], result: false };
    return {
      mutations: holdsPendingDeletion(ledger)
        ? abandonedDeletionRollForward(values, quarantine, ledger)
        : abandonedLeaseAbort(values, ledger),
      result: true,
    };
  });
  await readDeletionTombstones();
  return transaction.result;
}

/**
 * Settle a lease whose owner is dead: roll a crashed deletion forward, abort
 * anything else. One recovery runs at a time per realm, however many stores
 * hydrate at once. Resolves true when this call changed the ledger.
 */
export function recoverAbandonedDatasetLease(held?: PortableStateRepository): Promise<boolean> {
  leaseRecovery ??= runLeaseRecovery(held).finally(() => {
    leaseRecovery = undefined;
  });
  return leaseRecovery;
}

/** Session-only fallback: no Web Lock owner check, a missing start time is expired. */
function sessionLeaseExpired(ledger: DeletionTombstones): boolean {
  return (
    ledger.restoreStartedAt === undefined ||
    ledger.restoreStartedAt + RESTORE_LEASE_MS <= Date.now()
  );
}

function acquiredLease(
  next: DeletionTombstones,
  epoch: number,
  owner: string,
): DeletionTombstones {
  return {
    ...next,
    restoreEpoch: epoch,
    restoreInProgress: true,
    restoreStartedAt: Date.now(),
    leaseOwner: owner,
  };
}

type LeaseAttempt = { readonly epoch: number } | { readonly busy: DeletionTombstones };

async function acquireRepositoryLease(
  repository: PortableStateRepository,
  owner: string,
  transform: (current: DeletionTombstones) => DeletionTombstones,
): Promise<number> {
  for (;;) {
    const transaction = await repository.transactWithResult<LeaseAttempt>(({ values }) => {
      const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
      if (ledger.restoreInProgress) return { mutations: [], result: { busy: ledger } };
      const epoch = Math.max(ledger.restoreEpoch, ledger.activeEpoch) + 1;
      return {
        mutations: [
          {
            type: 'put' as const,
            key: PORTABLE_LEDGER_KEY,
            value: serializeDeletionTombstones(acquiredLease(transform(ledger), epoch, owner)),
          },
        ],
        result: { epoch },
      };
    });
    if ('epoch' in transaction.result) return transaction.result.epoch;
    // Recover on THIS repository; and whenever nothing changed, pause before
    // retrying, so a lease that cannot be settled never becomes a busy loop.
    const recovered =
      (await isLeaseAbandoned(transaction.result.busy)) &&
      (await recoverAbandonedDatasetLease(repository));
    if (!recovered) await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
}

async function acquireSessionLease(
  owner: string,
  transform: (current: DeletionTombstones) => DeletionTombstones,
): Promise<number> {
  for (;;) {
    let acquiredEpoch: number | undefined;
    updateSessionRow(DELETION_TOMBSTONES_KEY, (current) => {
      const ledger = mergeDeletionTombstones(current, {});
      if (ledger.restoreInProgress && !sessionLeaseExpired(ledger)) return ledger;
      acquiredEpoch = Math.max(ledger.restoreEpoch, ledger.activeEpoch) + 1;
      return acquiredLease(transform(ledger), acquiredEpoch, owner);
    });
    if (acquiredEpoch !== undefined) return acquiredEpoch;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
}

async function acquireDatasetMutationLease(
  transform: (current: DeletionTombstones) => DeletionTombstones,
): Promise<number> {
  const owner = await createLeaseOwner();
  try {
    const repository = await portableRepository();
    const epoch =
      repository === null
        ? await acquireSessionLease(owner, transform)
        : await acquireRepositoryLease(repository, owner, transform);
    localLeaseOwners.set(epoch, owner);
    return epoch;
  } catch (error) {
    releaseLeaseOwner(owner);
    throw error;
  }
}

/** This realm's lease for `epoch` settled: drop its liveness lock. */
function settleLocalLease(epoch: number): void {
  releaseLeaseOwner(localLeaseOwners.get(epoch));
  localLeaseOwners.delete(epoch);
}

/** Atomically add durable tombstones shared by every tab and installed PWA realm. */
export async function recordDeletionTombstones(
  additions: DeletionTombstoneAdditions,
  epoch?: number,
): Promise<void> {
  const repository = await portableRepository();
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
  updateSessionRow(DELETION_TOMBSTONES_KEY, (current) => {
    const ledger = mergeDeletionTombstones(current, {});
    if (!ledger.restoreInProgress || ledger.restoreEpoch !== epoch) return ledger;
    appended = true;
    return mergeDeletionTombstones(ledger, additions);
  });
  if (!appended) throw new Error('Dataset mutation lease is no longer active.');
}

/** Fence stale realms, then permit exactly the IDs carried by a Replace backup. */
export async function beginBackupRestore(restored: DeletionTombstoneAdditions): Promise<number> {
  const epoch = await acquireDatasetMutationLease((current) => ({
    ...current,
    reviveProfileIds: [...(restored.profileIds ?? [])],
    reviveThreadIds: [...(restored.threadIds ?? [])],
    reviveChartIds: [...(restored.chartIds ?? [])],
  }));
  localBackupRestoreEpoch = epoch;
  locallyHydratedDatasetEpochs.clear();
  observedRestoreEpoch = epoch;
  observedRestoreInProgress = true;
  return epoch;
}

/** Fence all other destructive operations before reading the active dataset. */
export async function beginDatasetMutation(): Promise<number> {
  const epoch = await acquireDatasetMutationLease((current) => ({
    ...current,
    reviveProfileIds: [],
    reviveThreadIds: [],
    reviveChartIds: [],
  }));
  observedRestoreEpoch = epoch;
  observedRestoreInProgress = true;
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
    settleLocalLease(epoch);
    observedActiveEpoch = epoch;
    observedRestoreInProgress = false;
    if (localBackupRestoreEpoch === epoch) localBackupRestoreEpoch = undefined;
    return;
  }
  updateSessionRow(
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
  );
  settleLocalLease(epoch);
  observedActiveEpoch = epoch;
  observedRestoreInProgress = false;
  if (localBackupRestoreEpoch === epoch) localBackupRestoreEpoch = undefined;
}

/** Release hydration after a failed Replace; partial snapshots remain explicit. */
export async function abortBackupRestore(epoch: number): Promise<void> {
  try {
    await abortDatasetLease(epoch);
  } finally {
    settleLocalLease(epoch);
  }
}

async function abortDatasetLease(epoch: number): Promise<void> {
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
    if (localBackupRestoreEpoch === epoch) {
      localBackupRestoreEpoch = undefined;
      locallyHydratedDatasetEpochs.clear();
    }
    return;
  }
  updateSessionRow(
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
  );
  const ledger = await readDeletionTombstones();
  observedRestoreEpoch = ledger.restoreEpoch;
  observedRestoreInProgress = false;
  if (localBackupRestoreEpoch === epoch) {
    localBackupRestoreEpoch = undefined;
    locallyHydratedDatasetEpochs.clear();
  }
}

export interface DatasetSnapshotWrite {
  readonly key: string;
  readonly value: string | null;
}

/**
 * Crash-atomic personal-data Replace. Canonical snapshots and the generation
 * flip share one SQLite transaction; rebuildable caches remain outside it and
 * are fenced by the committed generation/rebuild marker.
 */
export async function commitDatasetGeneration(
  epoch: number,
  writes: readonly DatasetSnapshotWrite[],
  options: {
    readonly afterWrite?: (index: number) => void;
    readonly memoryRebuildPending?: boolean;
    /** The committing realm's live Zustand stores already equal `writes`. */
    readonly adoptLocalWrites?: boolean;
    /**
     * For deletion generations, transform the latest canonical row instead of
     * a possibly stale tab snapshot. The tombstone sanitizer removes only the
     * requested owners while preserving unrelated concurrent additions.
     */
    readonly sanitizeCanonicalKeys?: readonly string[];
    /** Start fresh: drop every quarantined interpretation in the same batch. */
    readonly clearInterpretationQuarantine?: boolean;
  } = {},
): Promise<void> {
  for (const write of writes) {
    if (!isPortableStateKey(write.key)) {
      throw new Error(`Dataset write "${write.key}" is not canonical SQLite data.`);
    }
  }
  const repository = await portableRepository();
  await absorbLegacyQuarantine(
    browserLocalStorage(),
    repository === null ? memoryQuarantineRows(sessionQuarantine) : repositoryQuarantineRows(repository),
    await pendingDeletedProfileIds(repository),
    options.clearInterpretationQuarantine === true,
  );
  let previousActiveEpoch: number | undefined;
  if (repository === null) {
    commitSessionGeneration(epoch, writes, options);
  } else {
    for (const [index] of writes.entries()) options.afterWrite?.(index);
    const committed = await repository.transactWithResult(({ values, quarantine }) => {
      const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
      if (!ledger.restoreInProgress || ledger.restoreEpoch !== epoch) {
        throw new Error('Dataset Replace generation is no longer active.');
      }
      const effectiveLedger = subtractRestoredTombstones(ledger, {
        profileIds: ledger.reviveProfileIds,
        threadIds: ledger.reviveThreadIds,
        chartIds: ledger.reviveChartIds,
      });
      const mutations: PortableStateMutation[] = writes.map((write) => {
        const canonical = values.get(write.key);
        const sourceValue =
          options.sanitizeCanonicalKeys?.includes(write.key) === true && canonical !== undefined
            ? canonical
            : write.value;
        return sourceValue === null
          ? ({ type: 'delete', key: write.key } as const)
          : ({
              type: 'put',
              key: write.key,
              value:
                isPortablePreferenceKey(write.key)
                  ? sourceValue
                  : tagPersistedValue(
                      sanitizePersistedValue(write.key, sourceValue, effectiveLedger),
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
      mutations.push(
        ...quarantineDeletes(quarantine, effectiveLedger.profileIds, options).map(
          (key) => ({ type: 'delete', namespace: PORTABLE_QUARANTINE_NAMESPACE, key }) as const,
        ),
      );
      return { mutations, result: effectiveLedger };
    });
    previousActiveEpoch = committed.result.activeEpoch;
  }
  settleLocalLease(epoch);
  observedRestoreEpoch = epoch;
  observedActiveEpoch = epoch;
  observedRestoreInProgress = false;
  if (repository !== null && options.adoptLocalWrites === true) {
    for (const write of writes) {
      if (isPortablePreferenceKey(write.key)) continue;
      locallyHydratedDatasetEpochs.set(write.key, epoch);
      locallyAcknowledgedDatasetValues.set(write.key, write.value);
    }
  }
  if (repository !== null) {
    // Preferences are not part of the dataset generation. A preference this
    // tab hydrated at the previous generation, and that this commit did not
    // replace, is still current: carry it forward, or every later language or
    // settings change in this tab is refused until a reload.
    const replaced = new Set(writes.map((write) => write.key));
    // The settings mirrors (AI key, model, ...) live inside the preferences row.
    if (replaced.has(PORTABLE_PREFERENCES_KEY)) {
      for (const key of PORTABLE_PREFERENCE_MIRROR_KEYS) replaced.add(key);
    }
    for (const [key, hydrated] of locallyHydratedPreferenceEpochs) {
      if (hydrated === previousActiveEpoch && !replaced.has(key)) {
        locallyHydratedPreferenceEpochs.set(key, epoch);
      }
    }
  }
  if (localBackupRestoreEpoch === epoch) localBackupRestoreEpoch = undefined;
}

/** Profiles the pending generation deletes (tombstones not revived by a restore). */
async function pendingDeletedProfileIds(
  repository: PortableStateRepository | null,
): Promise<readonly string[]> {
  const ledger =
    repository === null
      ? mergeDeletionTombstones(sessionRows.get(DELETION_TOMBSTONES_KEY), {})
      : parseDeletionTombstones(await repository.read(PORTABLE_LEDGER_KEY));
  const revived = new Set(ledger.reviveProfileIds ?? []);
  return ledger.profileIds.filter((id) => !revived.has(id));
}

/** Quarantine keys a generation commit must delete alongside its dataset rows. */
function quarantineDeletes(
  held: ReadonlyMap<string, string>,
  deletedProfileIds: readonly string[],
  options: { readonly clearInterpretationQuarantine?: boolean },
): string[] {
  return options.clearInterpretationQuarantine === true
    ? [...held.keys()]
    : quarantineKeysOwnedBy(held, deletedProfileIds);
}

/** The in-memory twin of the SQLite generation commit: stage everything, then apply at once. */
function commitSessionGeneration(
  epoch: number,
  writes: readonly DatasetSnapshotWrite[],
  options: Parameters<typeof commitDatasetGeneration>[2] & object,
): void {
  const ledger = mergeDeletionTombstones(sessionRows.get(DELETION_TOMBSTONES_KEY), {});
  if (!ledger.restoreInProgress || ledger.restoreEpoch !== epoch) {
    throw new Error('Dataset Replace generation is no longer active.');
  }
  const effectiveLedger = subtractRestoredTombstones(ledger, {
    profileIds: ledger.reviveProfileIds,
    threadIds: ledger.reviveThreadIds,
    chartIds: ledger.reviveChartIds,
  });
  const staged = writes.map((write, index) => {
    const value =
      write.value === null
        ? null
        : tagPersistedValue(sanitizePersistedValue(write.key, write.value, effectiveLedger), epoch);
    options.afterWrite?.(index);
    return { key: write.key, value };
  });
  for (const { key, value } of staged) {
    if (value === null) sessionRows.delete(key);
    else sessionRows.set(key, value);
  }
  const held = new Map(sessionQuarantine);
  for (const key of quarantineDeletes(held, effectiveLedger.profileIds, options)) {
    sessionQuarantine.delete(key);
  }
  sessionRows.set(DELETION_TOMBSTONES_KEY, {
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
  });
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
  updateSessionRow(DELETION_TOMBSTONES_KEY, (current) => {
    const ledger = mergeDeletionTombstones(current, {});
    return expectedEpoch === undefined || ledger.activeEpoch === expectedEpoch
      ? { ...ledger, memoryRebuildPending: false }
      : ledger;
  });
}

function persistedEpoch(value: string): number {
  try {
    const parsed = JSON.parse(value) as { datasetEpoch?: unknown };
    return Number.isSafeInteger(parsed.datasetEpoch) ? (parsed.datasetEpoch as number) : 0;
  } catch {
    return 0;
  }
}

const ABSENT = Symbol('absent');
type MergeNode = unknown | typeof ABSENT;

function mergeNodeEqual(left: MergeNode, right: MergeNode): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function arraysHaveStableObjectIds(...arrays: readonly unknown[][]): boolean {
  return arrays.every((values) =>
    values.every((value) => isRecord(value) && typeof value.id === 'string'),
  );
}

function mergeObjectArrays(
  base: readonly unknown[],
  local: readonly unknown[],
  remote: readonly unknown[],
): readonly unknown[] {
  const byId = (values: readonly unknown[]) =>
    new Map(values.map((value) => [(value as { id: string }).id, value]));
  const baseById = byId(base);
  const localById = byId(local);
  const remoteById = byId(remote);
  const merged = new Map<string, unknown>();
  const ids = new Set([...baseById.keys(), ...remoteById.keys(), ...localById.keys()]);
  for (const id of ids) {
    const value = mergeAtomicDatasetNode(
      baseById.has(id) ? baseById.get(id) : ABSENT,
      localById.has(id) ? localById.get(id) : ABSENT,
      remoteById.has(id) ? remoteById.get(id) : ABSENT,
    );
    if (value !== ABSENT) merged.set(id, value);
  }
  const order = [...remoteById.keys(), ...localById.keys()];
  return [...new Set(order)].flatMap((id) => (merged.has(id) ? [merged.get(id)] : []));
}

/** One logical record is atomic: deletion wins; a true conflict is local-wins. */
function mergeAtomicDatasetNode(base: MergeNode, local: MergeNode, remote: MergeNode): MergeNode {
  if (base === ABSENT) {
    if (local === ABSENT) return remote;
    if (remote === ABSENT) return local;
  } else if (local === ABSENT || remote === ABSENT) {
    return ABSENT;
  }
  if (mergeNodeEqual(local, base)) return remote;
  if (mergeNodeEqual(remote, base) || mergeNodeEqual(local, remote)) return local;
  return local;
}

type EntryMerger = (base: MergeNode, local: MergeNode, remote: MergeNode) => MergeNode;

function mergeRecordMap(
  baseValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
  mergeEntry: EntryMerger = mergeAtomicDatasetNode,
): Record<string, unknown> {
  const base = isRecord(baseValue) ? baseValue : {};
  const local = isRecord(localValue) ? localValue : {};
  const remote = isRecord(remoteValue) ? remoteValue : {};
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(remote), ...Object.keys(local)]);
  for (const key of keys) {
    const value = mergeEntry(
      key in base ? base[key] : ABSENT,
      key in local ? local[key] : ABSENT,
      key in remote ? remote[key] : ABSENT,
    );
    if (value !== ABSENT) result[key] = value;
  }
  return result;
}

function mergeStableIdArrayNode(base: MergeNode, local: MergeNode, remote: MergeNode): MergeNode {
  if (
    Array.isArray(base) &&
    Array.isArray(local) &&
    Array.isArray(remote) &&
    arraysHaveStableObjectIds(base, local, remote)
  ) {
    return mergeObjectArrays(base, local, remote);
  }
  return mergeAtomicDatasetNode(base, local, remote);
}

function anchorIds(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, profile]) => isRecord(profile) && profile.relationship === 'self')
    .map(([profileId]) => profileId);
}

function normalizeMergedProfiles(
  baseState: Record<string, unknown>,
  localState: Record<string, unknown>,
  remoteState: Record<string, unknown>,
  mergedState: Record<string, unknown>,
): Record<string, unknown> {
  const profiles = isRecord(mergedState.profiles) ? mergedState.profiles : {};
  const baseAnchors = anchorIds(baseState.profiles);
  const localAnchors = anchorIds(localState.profiles);
  const remoteAnchors = anchorIds(remoteState.profiles);
  const preferred = !mergeNodeEqual(localAnchors, baseAnchors)
    ? localAnchors
    : !mergeNodeEqual(remoteAnchors, baseAnchors)
      ? remoteAnchors
      : anchorIds(profiles);
  const anchorId = preferred.find((profileId) => profileId in profiles);
  const normalized = Object.fromEntries(
    Object.entries(profiles).map(([profileId, profile]) => {
      if (!isRecord(profile)) return [profileId, profile];
      if (profileId === anchorId) {
        return [profileId, { ...profile, relationship: 'self', relatedTo: undefined }];
      }
      if (profile.relationship === 'self') {
        const { relationship: _relationship, relatedTo: _relatedTo, ...plain } = profile;
        return [profileId, plain];
      }
      if (typeof profile.relationship === 'string') {
        return [profileId, { ...profile, relatedTo: anchorId }];
      }
      const { relatedTo: _relatedTo, ...plain } = profile;
      return [profileId, plain];
    }),
  );
  return { ...mergedState, profiles: normalized };
}

function primaryByScope(value: unknown): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  if (!isRecord(value)) return result;
  for (const [chartId, chart] of Object.entries(value)) {
    if (!isRecord(chart) || chart.is_primary !== true) continue;
    const scope = typeof chart.profile_id === 'string' ? chart.profile_id : '__orphan__';
    result.set(scope, [...(result.get(scope) ?? []), chartId]);
  }
  return result;
}

function normalizeMergedCharts(
  baseState: Record<string, unknown>,
  localState: Record<string, unknown>,
  remoteState: Record<string, unknown>,
  mergedState: Record<string, unknown>,
): Record<string, unknown> {
  const charts = isRecord(mergedState.charts) ? mergedState.charts : {};
  const basePrimary = primaryByScope(baseState.charts);
  const localPrimary = primaryByScope(localState.charts);
  const remotePrimary = primaryByScope(remoteState.charts);
  const mergedPrimary = primaryByScope(charts);
  const scopes = new Set([
    ...basePrimary.keys(),
    ...localPrimary.keys(),
    ...remotePrimary.keys(),
    ...mergedPrimary.keys(),
  ]);
  const selected = new Map<string, string>();
  for (const scope of scopes) {
    const baseIds = basePrimary.get(scope) ?? [];
    const localIds = localPrimary.get(scope) ?? [];
    const remoteIds = remotePrimary.get(scope) ?? [];
    const preferred = !mergeNodeEqual(localIds, baseIds)
      ? localIds
      : !mergeNodeEqual(remoteIds, baseIds)
        ? remoteIds
        : (mergedPrimary.get(scope) ?? []);
    const chartId = preferred.find((id) => id in charts);
    if (chartId !== undefined) selected.set(scope, chartId);
  }
  return {
    ...mergedState,
    charts: Object.fromEntries(
      Object.entries(charts).map(([chartId, chart]) => {
        if (!isRecord(chart)) return [chartId, chart];
        const scope = typeof chart.profile_id === 'string' ? chart.profile_id : '__orphan__';
        return [chartId, { ...chart, is_primary: selected.get(scope) === chartId }];
      }),
    ),
  };
}

function mergeDatasetState(
  name: string,
  baseState: Record<string, unknown>,
  localState: Record<string, unknown>,
  remoteState: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeRecordMap(baseState, localState, remoteState);
  switch (name) {
    case 'almamesh-profiles': {
      merged.profiles = mergeRecordMap(
        baseState.profiles,
        localState.profiles,
        remoteState.profiles,
      );
      return normalizeMergedProfiles(baseState, localState, remoteState, merged);
    }
    case 'almamesh-chart-library': {
      merged.charts = mergeRecordMap(baseState.charts, localState.charts, remoteState.charts);
      return normalizeMergedCharts(baseState, localState, remoteState, merged);
    }
    case 'almamesh-life-events':
      merged.eventsByProfile = mergeRecordMap(
        baseState.eventsByProfile,
        localState.eventsByProfile,
        remoteState.eventsByProfile,
        mergeStableIdArrayNode,
      );
      return merged;
    case 'almamesh-rectification-records':
      merged.recordsByProfile = mergeRecordMap(
        baseState.recordsByProfile,
        localState.recordsByProfile,
        remoteState.recordsByProfile,
      );
      return merged;
    case 'almamesh-chat-history':
      merged.threads = mergeRecordMap(baseState.threads, localState.threads, remoteState.threads);
      merged.messages = mergeRecordMap(
        baseState.messages,
        localState.messages,
        remoteState.messages,
        mergeStableIdArrayNode,
      );
      merged.summaries = mergeRecordMap(
        baseState.summaries,
        localState.summaries,
        remoteState.summaries,
      );
      return merged;
    case 'almamesh-interpretations':
      merged.byChart = mergeRecordMap(baseState.byChart, localState.byChart, remoteState.byChart);
      return merged;
    case 'almamesh-mesh-readings':
      merged.byPair = mergeRecordMap(baseState.byPair, localState.byPair, remoteState.byPair);
      return merged;
    default:
      return merged;
  }
}

function normalizeMergedChatEnvelope(value: string, baseValue: string | null): string {
  try {
    const envelope = JSON.parse(value) as unknown;
    if (!isRecord(envelope) || !isRecord(envelope.state)) return value;
    const threads = isRecord(envelope.state.threads) ? envelope.state.threads : {};
    const messages = isRecord(envelope.state.messages) ? envelope.state.messages : {};
    const baseEnvelope = baseValue === null ? null : (JSON.parse(baseValue) as unknown);
    const baseThreads =
      isRecord(baseEnvelope) && isRecord(baseEnvelope.state) && isRecord(baseEnvelope.state.threads)
        ? baseEnvelope.state.threads
        : {};
    const normalizedThreads = Object.fromEntries(
      Object.entries(threads).map(([threadId, rawThread]) => {
        if (!isRecord(rawThread)) return [threadId, rawThread];
        const list = Array.isArray(messages[threadId]) ? messages[threadId] : [];
        const latest = list.reduce(
          (timestamp, message) =>
            isRecord(message) &&
            typeof message.created_at === 'string' &&
            message.created_at > timestamp
              ? message.created_at
              : timestamp,
          typeof rawThread.updated_at === 'string' ? rawThread.updated_at : '',
        );
        const baseThread = baseThreads[threadId];
        const firstUserMessage = list.find(
          (message) => isRecord(message) && message.role === 'user',
        );
        const title =
          isRecord(baseThread) && baseThread.title === null && isRecord(firstUserMessage)
            ? String(firstUserMessage.content ?? '').trim() || null
            : rawThread.title;
        return [
          threadId,
          {
            ...rawThread,
            title,
            message_count: list.length,
            ...(latest === '' ? {} : { updated_at: latest }),
          },
        ];
      }),
    );
    return JSON.stringify({
      ...envelope,
      state: { ...envelope.state, threads: normalizedThreads },
    });
  } catch {
    return value;
  }
}

function mergePersistedDatasetValue(
  name: string,
  base: string | null,
  local: string,
  remote: string | null,
  tombstones: DeletionTombstones,
): string {
  const parseEnvelope = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return { state: {} };
    try {
      const parsed = JSON.parse(sanitizePersistedValue(name, raw, tombstones)) as unknown;
      return isRecord(parsed) && isRecord(parsed.state) ? parsed : null;
    } catch {
      return null;
    }
  };
  const baseEnvelope = parseEnvelope(base);
  const localEnvelope = parseEnvelope(local);
  const remoteEnvelope = parseEnvelope(remote);
  if (baseEnvelope === null || localEnvelope === null || remoteEnvelope === null) {
    return sanitizePersistedValue(name, local, tombstones);
  }
  const state = mergeDatasetState(
    name,
    baseEnvelope.state as Record<string, unknown>,
    localEnvelope.state as Record<string, unknown>,
    remoteEnvelope.state as Record<string, unknown>,
  );
  const merged = JSON.stringify({
    ...remoteEnvelope,
    ...localEnvelope,
    state,
  });
  const normalized =
    name === 'almamesh-chat-history' ? normalizeMergedChatEnvelope(merged, base) : merged;
  return sanitizePersistedValue(name, normalized, tombstones);
}

export function tagPersistedValue(value: string, epoch: number): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? JSON.stringify({ ...parsed, datasetEpoch: epoch }) : value;
  } catch {
    return value;
  }
}

function readSessionValueAndLedger(name: string): {
  readonly value: unknown;
  readonly ledger: DeletionTombstones;
} {
  return {
    value: sessionRows.get(name),
    ledger: mergeDeletionTombstones(sessionRows.get(DELETION_TOMBSTONES_KEY), {}),
  };
}

function setSanitizedSessionValue(name: string, value: string): void {
  const tombstones = mergeDeletionTombstones(sessionRows.get(DELETION_TOMBSTONES_KEY), {});
  if (
    !tombstones.restoreInProgress &&
    shouldAcceptRestoreEpoch(observedRestoreEpoch, tombstones.restoreEpoch)
  ) {
    const sanitized = sanitizePersistedValue(name, value, tombstones);
    sessionRows.set(name, tagPersistedValue(sanitized, tombstones.activeEpoch));
  }
}

/**
 * Hydrate at a settled generation: a lease whose owner is dead is recovered
 * before any store reads, so the realm's writes are accepted. A live lease
 * held elsewhere is watched until it ends.
 */
async function settledSnapshot(repository: PortableStateRepository): Promise<{
  readonly snapshot: PortableStateSnapshot;
  readonly tombstones: DeletionTombstones;
}> {
  let snapshot = await repository.snapshot();
  let tombstones = parseDeletionTombstones(snapshot.values.get(PORTABLE_LEDGER_KEY) ?? null);
  if (!tombstones.restoreInProgress) return { snapshot, tombstones };
  await recoverAbandonedDatasetLease();
  snapshot = await repository.snapshot();
  tombstones = parseDeletionTombstones(snapshot.values.get(PORTABLE_LEDGER_KEY) ?? null);
  watchForeignLease(tombstones);
  return { snapshot, tombstones };
}

async function readDeletionAwareValue(
  name: string,
  acknowledgeHydration: boolean,
): Promise<string | null> {
  const repository = await portableRepository();
  if (repository !== null && isPortableStateKey(name)) {
    const { snapshot, tombstones } = await settledSnapshot(repository);
    observeDurableLedger(tombstones);
    const value = snapshot.values.get(name);
    if (!tombstones.restoreInProgress) {
      locallyHydratedDatasetEpochs.set(name, tombstones.activeEpoch);
      leaseHydratedDatasetEpochs.delete(name);
    } else if (acknowledgeHydration) {
      leaseHydratedDatasetEpochs.set(name, tombstones.activeEpoch);
    }
    if (value === undefined || persistedEpoch(value) !== tombstones.activeEpoch) {
      if (acknowledgeHydration) locallyAcknowledgedDatasetValues.set(name, null);
      return null;
    }
    const sanitized = sanitizePersistedValue(name, value, tombstones);
    if (acknowledgeHydration) locallyAcknowledgedDatasetValues.set(name, sanitized);
    return sanitized;
  }
  const { value, ledger: tombstones } = readSessionValueAndLedger(name);
  observeDurableLedger(tombstones);
  if (!tombstones.restoreInProgress) {
    locallyHydratedDatasetEpochs.set(name, tombstones.activeEpoch);
  }
  if (typeof value !== 'string' || persistedEpoch(value) !== tombstones.activeEpoch) {
    if (acknowledgeHydration) locallyAcknowledgedDatasetValues.set(name, null);
    return null;
  }
  const sanitized = sanitizePersistedValue(name, value, tombstones);
  if (acknowledgeHydration) locallyAcknowledgedDatasetValues.set(name, sanitized);
  return sanitized;
}

/** Read canonical state for export/diagnostics without changing a live store's merge base. */
export function readCanonicalDatasetValue(name: string): Promise<string | null> {
  return readDeletionAwareValue(name, false);
}

/** What this realm knew when a store asked to persist (captured synchronously). */
interface DatasetWriteContext {
  readonly name: string;
  readonly hydratedEpoch: number | undefined;
  /** The store hydrated from SQLite (possibly during another realm's lease). */
  readonly hydrated: boolean;
  /** Written while this realm held a lease: part of its own Replace or deletion. */
  readonly ownLease: boolean;
}

type DatasetWriteGate =
  | { readonly accepted: true; readonly activeEpoch: number; readonly promoted: boolean }
  | { readonly accepted: false; readonly ledger: DeletionTombstones };

function datasetWriteContext(name: string): DatasetWriteContext {
  const hydratedEpoch = locallyHydratedDatasetEpochs.get(name);
  return {
    name,
    hydratedEpoch,
    hydrated: hydratedEpoch !== undefined || leaseHydratedDatasetEpochs.has(name),
    ownLease: holdsAnyLease(),
  };
}

/** The generation fence every canonical dataset write passes inside its SQLite transaction. */
function gateDatasetWrite(
  context: DatasetWriteContext,
  ledger: DeletionTombstones,
): DatasetWriteGate {
  const promoted =
    context.hydratedEpoch === undefined &&
    leaseHydratedDatasetEpochs.get(context.name) === ledger.activeEpoch;
  const hydratedEpoch = promoted ? ledger.activeEpoch : context.hydratedEpoch;
  if (
    ledger.restoreInProgress ||
    !shouldAcceptRestoreEpoch(observedRestoreEpoch, ledger.restoreEpoch) ||
    hydratedEpoch !== ledger.activeEpoch
  ) {
    return { accepted: false, ledger };
  }
  return { accepted: true, activeEpoch: ledger.activeEpoch, promoted };
}

/** Adopt a promoted hydration, or make a refusal this realm did not cause visible. */
function settleDatasetWrite(context: DatasetWriteContext, gate: DatasetWriteGate): void {
  if (gate.accepted) {
    if (gate.promoted) {
      locallyHydratedDatasetEpochs.set(context.name, gate.activeEpoch);
      leaseHydratedDatasetEpochs.delete(context.name);
    }
    return;
  }
  const ownRefusal = context.ownLease || isLocalLeaseOwner(gate.ledger.leaseOwner);
  if (ownRefusal || !context.hydrated) return;
  reportDroppedWrite(
    context.name,
    gate.ledger.restoreInProgress ? 'dataset-busy' : 'stale-generation',
  );
}

/**
 * Historical adapter name retained by the stores. Production routes canonical
 * rows through SQLite CAS; the IndexedDB path exists only for Node tests and
 * explicitly derived caches. A stale tab cannot write across a tombstone, and
 * a write the fence refuses for another realm is reported, never silent.
 */
export const deletionAwareIdbStorage: StateStorage = {
  getItem: (name) => readDeletionAwareValue(name, true),
  setItem: (name, value) => {
    const context = datasetWriteContext(name);
    return enqueuePersistenceMutation(name, async () => {
      const repository = await portableRepository();
      if (repository !== null && isPortableStateKey(name)) {
        const hasMergeBase = locallyAcknowledgedDatasetValues.has(name);
        const mergeBase = locallyAcknowledgedDatasetValues.get(name) ?? null;
        const transaction = await repository.transactWithResult<DatasetWriteGate>(({ values }) => {
          const tombstones = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
          const gate = gateDatasetWrite(context, tombstones);
          if (!gate.accepted) return { mutations: [], result: gate };
          const rawCurrent = values.get(name);
          const current =
            rawCurrent === undefined || persistedEpoch(rawCurrent) !== tombstones.activeEpoch
              ? null
              : rawCurrent;
          const candidate = hasMergeBase
            ? mergePersistedDatasetValue(name, mergeBase, value, current, tombstones)
            : sanitizePersistedValue(name, value, tombstones);
          return {
            mutations: [
              {
                type: 'put' as const,
                key: name,
                value: tagPersistedValue(candidate, tombstones.activeEpoch),
              },
            ],
            result: gate,
          };
        });
        settleDatasetWrite(context, transaction.result);
        if (transaction.result.accepted) locallyAcknowledgedDatasetValues.set(name, value);
        return;
      }
      setSanitizedSessionValue(name, value);
      locallyAcknowledgedDatasetValues.set(name, value);
    });
  },
  removeItem: (name) => {
    const context = datasetWriteContext(name);
    return enqueuePersistenceMutation(name, async () => {
      const repository = await portableRepository();
      if (repository !== null && isPortableStateKey(name)) {
        const transaction = await repository.transactWithResult<DatasetWriteGate>(({ values }) => {
          const tombstones = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
          const gate = gateDatasetWrite(context, tombstones);
          return gate.accepted
            ? { mutations: [{ type: 'delete' as const, key: name }], result: gate }
            : { mutations: [], result: gate };
        });
        settleDatasetWrite(context, transaction.result);
        if (transaction.result.accepted) locallyAcknowledgedDatasetValues.set(name, null);
        return;
      }
      sessionRows.delete(name);
      locallyAcknowledgedDatasetValues.set(name, null);
    });
  },
};

/**
 * Atomically merge one dataset envelope with the latest canonical row.
 *
 * This is reserved for additive paid artifacts (for example relationship
 * narrations) where two tabs may complete different keys concurrently. Normal
 * Zustand snapshots remain replace writes so deletion/reset semantics stay
 * explicit and generation-fenced.
 */
export function mergeDeletionAwarePersistedValue(
  name: string,
  merge: (current: string | null) => string,
): Promise<string> {
  const hydratedEpoch = locallyHydratedDatasetEpochs.get(name);
  let merged: string | undefined;
  const completion = enqueuePersistenceMutation(name, async () => {
    const repository = await portableRepository();
    if (repository !== null && isPortableStateKey(name)) {
      const transaction = await repository.transactWithResult(({ values }) => {
        const tombstones = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
        if (
          tombstones.restoreInProgress ||
          !shouldAcceptRestoreEpoch(observedRestoreEpoch, tombstones.restoreEpoch) ||
          hydratedEpoch !== tombstones.activeEpoch
        ) {
          return { mutations: [], result: null };
        }
        const raw = values.get(name);
        const current =
          raw === undefined || persistedEpoch(raw) !== tombstones.activeEpoch
            ? null
            : sanitizePersistedValue(name, raw, tombstones);
        const candidate = sanitizePersistedValue(name, merge(current), tombstones);
        return {
          mutations: [
            {
              type: 'put' as const,
              key: name,
              value: tagPersistedValue(candidate, tombstones.activeEpoch),
            },
          ],
          result: candidate,
        };
      });
      if (transaction.result === null) {
        throw new Error('Dataset generation changed before the merged write could commit.');
      }
      merged = transaction.result;
      return;
    }
    const { value, ledger } = readSessionValueAndLedger(name);
    const current =
      typeof value === 'string' && persistedEpoch(value) === ledger.activeEpoch
        ? sanitizePersistedValue(name, value, ledger)
        : null;
    merged = sanitizePersistedValue(name, merge(current), ledger);
    setSanitizedSessionValue(name, merged);
  });
  return completion.then(() => {
    if (merged === undefined) throw new Error('Merged dataset write produced no value.');
    return merged;
  });
}

/**
 * Portable preferences share the SQLite file but are not dataset-generation
 * records. Synchronous consumers use boot-hydrated memory, never Web Storage.
 */
function preferenceValueFromSnapshot(
  values: ReadonlyMap<string, string>,
  name: string,
): string | null {
  if (isPortableStateKey(name)) return values.get(name) ?? null;
  if (!(PORTABLE_PREFERENCE_MIRROR_KEYS as readonly string[]).includes(name)) return null;
  const raw = values.get(PORTABLE_PREFERENCES_KEY);
  const preferences =
    raw === undefined ? { version: 1 as const, values: {} } : decodePortablePreferences(raw);
  return preferences.values[name as PortablePreferenceMirrorKey] ?? null;
}

interface PortablePreferenceMutationOutcome {
  readonly accepted: boolean;
  readonly activeEpoch: number;
}

async function commitPortablePreferenceMutation(
  repository: PortableStateRepository,
  name: string,
  value: string | null,
  queuedRestoreEpoch: number | undefined,
  hydratedEpoch: number | undefined,
): Promise<PortablePreferenceMutationOutcome> {
  const transaction = await repository.transactWithResult(({ values }) => {
    const ledger = parseDeletionTombstones(values.get(PORTABLE_LEDGER_KEY) ?? null);
    const hydratedGenerationMatches =
      hydratedEpoch === undefined
        ? shouldAcceptRestoreEpoch(queuedRestoreEpoch, ledger.activeEpoch)
        : hydratedEpoch === ledger.activeEpoch;
    if (
      ledger.restoreInProgress ||
      !shouldAcceptRestoreEpoch(queuedRestoreEpoch, ledger.restoreEpoch) ||
      !hydratedGenerationMatches
    ) {
      return {
        mutations: [],
        result: {
          accepted: false,
          activeEpoch: ledger.activeEpoch,
        },
      };
    }
    if (isPortableStateKey(name)) {
      return {
        mutations:
          value === null
            ? [{ type: 'delete' as const, key: name }]
            : [{ type: 'put' as const, key: name, value }],
        result: { accepted: true, activeEpoch: ledger.activeEpoch },
      };
    }
    if ((PORTABLE_PREFERENCE_MIRROR_KEYS as readonly string[]).includes(name)) {
      const raw = values.get(PORTABLE_PREFERENCES_KEY);
      const current =
        raw === undefined
          ? { version: 1 as const, values: {} }
          : decodePortablePreferences(raw);
      const nextValues = { ...current.values };
      if (value === null) delete nextValues[name as PortablePreferenceMirrorKey];
      else nextValues[name as PortablePreferenceMirrorKey] = value;
      const candidate = JSON.stringify({ version: 1, values: nextValues });
      // Decode the full candidate before the repository serializes it so the
      // existing typed allowlist and size limits remain the boundary.
      decodePortablePreferences(candidate);
      return {
        mutations: [{ type: 'put' as const, key: PORTABLE_PREFERENCES_KEY, value: candidate }],
        result: { accepted: true, activeEpoch: ledger.activeEpoch },
      };
    }
    return {
      mutations: [],
      result: { accepted: true, activeEpoch: ledger.activeEpoch },
    };
  });
  return transaction.result;
}

export const portablePreferenceStorage: StateStorage = {
  getItem: async (name) => {
    const repository = await portableRepository();
    if (repository !== null) {
      const snapshot = await repository.snapshot();
      const ledger = parseDeletionTombstones(snapshot.values.get(PORTABLE_LEDGER_KEY) ?? null);
      observeDurableLedger(ledger);
      if (!ledger.restoreInProgress) {
        locallyHydratedPreferenceEpochs.set(name, ledger.activeEpoch);
      }
      if (
        isPortableStateKey(name) ||
        (PORTABLE_PREFERENCE_MIRROR_KEYS as readonly string[]).includes(name)
      ) {
        return preferenceValueFromSnapshot(snapshot.values, name);
      }
    }
    return inMemoryPreferenceFallback.get(name) ?? null;
  },
  setItem: (name, value) => {
    const queuedRestoreEpoch = observedRestoreEpoch;
    const hydratedEpoch = locallyHydratedPreferenceEpochs.get(name);
    return enqueuePersistenceMutation(name, async () => {
      if (localBackupRestoreEpoch !== undefined) return;
      const repository = await portableRepository();
      if (repository === null) {
        inMemoryPreferenceFallback.set(name, value);
        return;
      }
      const outcome = await commitPortablePreferenceMutation(
        repository,
        name,
        value,
        queuedRestoreEpoch,
        hydratedEpoch,
      );
      if (!outcome.accepted) return;
      locallyHydratedPreferenceEpochs.set(name, outcome.activeEpoch);
    });
  },
  removeItem: (name) => {
    const queuedRestoreEpoch = observedRestoreEpoch;
    const hydratedEpoch = locallyHydratedPreferenceEpochs.get(name);
    return enqueuePersistenceMutation(name, async () => {
      if (localBackupRestoreEpoch !== undefined) return;
      const repository = await portableRepository();
      if (repository === null) {
        inMemoryPreferenceFallback.delete(name);
        return;
      }
      const outcome = await commitPortablePreferenceMutation(
        repository,
        name,
        null,
        queuedRestoreEpoch,
        hydratedEpoch,
      );
      if (!outcome.accepted) return;
      locallyHydratedPreferenceEpochs.set(name, outcome.activeEpoch);
    });
  },
};

export async function readActiveDatasetStoreKeys(
  keys: readonly string[],
): Promise<readonly string[]> {
  const reads = await Promise.all(
    keys.map(async (key) => ({
      key,
      value: await readCanonicalDatasetValue(key),
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

function firstProfileByCreatedAt(profiles: Record<string, unknown>): string | null {
  const profileIds = Object.keys(profiles);
  profileIds.sort((leftId, rightId) => {
    const left = profiles[leftId];
    const right = profiles[rightId];
    const leftCreatedAt = isRecord(left) && typeof left.createdAt === 'string' ? left.createdAt : null;
    const rightCreatedAt =
      isRecord(right) && typeof right.createdAt === 'string' ? right.createdAt : null;
    if (leftCreatedAt !== null && rightCreatedAt !== null) {
      return leftCreatedAt.localeCompare(rightCreatedAt) || leftId.localeCompare(rightId);
    }
    if (leftCreatedAt !== null) return -1;
    if (rightCreatedAt !== null) return 1;
    return leftId.localeCompare(rightId);
  });
  return profileIds[0] ?? null;
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
    typeof active === 'string' && active in profiles ? active : firstProfileByCreatedAt(profiles);
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
  const summaries = dropRecordKeys(state.summaries, (threadId) => !(threadId in threads));
  return { ...state, threads, messages, summaries };
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
    case 'almamesh-mesh-readings':
      return {
        ...state,
        byPair: dropRecordKeys(state.byPair, (_pairKey, entry) => {
          if (!isRecord(entry) || !Array.isArray(entry.profileIds)) return true;
          return entry.profileIds.some(
            (profileId) => typeof profileId === 'string' && profileIds.has(profileId),
          );
        }),
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
