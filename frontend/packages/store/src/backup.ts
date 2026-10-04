/**
 * Backup & Restore — core storage collect/apply (Spec 061).
 *
 * AlmaMesh is local-first with no server. A "backup" is one portable file the
 * user carries between browsers. This module is the PURE core of that transfer:
 * it reads the persisted user-data stores VERBATIM into a typed envelope
 * ({@link collectBackup}) and writes an envelope back ({@link applyBackup}),
 * staged all-or-nothing. It never re-implements Zustand migration — each store's
 * own `persist` + `migrate` runs on the next app load from the `{state, version}`
 * blob restored here.
 *
 * Every tier is reached through the injectable {@link StorageTier} facade, so the
 * pure functions are unit-testable with in-memory fakes. In production the
 * historical `idb` tier name maps to canonical SQLite rows; language does too.
 * The caller supplies the timestamp + app version (no `Date.now()` here) so
 * legacy JSON exports stay deterministic in tests.
 */

import type {
  BackupEnvelopePlain,
  BackupStoreSnapshot,
  BackupStores,
} from '@almamesh/shared-types';
import {
  abortBackupRestore,
  beginBackupRestore,
  commitDatasetGeneration,
  deletionAwareIdbStorage,
  flushPortablePersistence,
  portablePreferenceStorage,
  readCanonicalDatasetValue,
  requirePortableStateRepository,
} from './deletionTombstones';
import {
  decodePortablePreferences,
  PORTABLE_PREFERENCES_KEY,
  PORTABLE_STATE_KEYS,
  readPortableStateDatabase,
} from './portableState';

/** Compatibility tier labels retained by the legacy JSON backup envelope. */
export type BackupTier = 'local' | 'idb';

/**
 * A tiny async key/value facade over one storage tier — the seam that lets the
 * pure collect/apply logic run against in-memory fakes in tests and real browser
 * storage in production.
 */
export interface StorageTier {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * The single source of truth for what a backup contains. Adding a future
 * persisted store is a one-line change here. Order is preserved (export order).
 */
export const BACKUP_STORES: ReadonlyArray<{ key: string; tier: BackupTier }> = [
  { key: 'almamesh-profiles', tier: 'idb' },
  { key: 'almamesh-chart-library', tier: 'idb' },
  { key: 'almamesh-life-events', tier: 'idb' },
  { key: 'almamesh-rectification-records', tier: 'idb' },
  { key: 'almamesh-chat-history', tier: 'idb' },
  { key: 'almamesh-interpretations', tier: 'idb' },
  { key: 'almamesh-mesh-readings', tier: 'idb' },
  { key: 'almamesh-predictive', tier: 'idb' },
  { key: 'almamesh-language', tier: 'local' },
];

/** Canonical completed predictive results; the historical name remains API-compatible. */
export const PREDICTIVE_CACHE_KEY = 'almamesh-predictive';

/** A typed, code-tagged failure so the UI can message the exact refusal reason. */
export class BackupError extends Error {
  constructor(
    public code: 'bad_format' | 'too_new' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * The destination changed after its pre-import safety snapshot. Replace must
 * stop so data created in another tab is never absent from both the live
 * database and the safety file.
 */
export class PortableImportRevisionConflictError extends Error {
  public override readonly name = 'PortableImportRevisionConflictError';

  public constructor(
    public readonly safetyRevision: number,
    public readonly fencedRevision: number,
  ) {
    super(
      'Your AlmaMesh data changed after the safety backup. Start the import again so a fresh safety backup includes those changes.',
    );
  }
}

let armedPortableImportRevision: number | undefined;

/** Read the exact monotonic SQLite revision after all writes in this realm settle. */
export async function readPortableStateRevision(): Promise<number> {
  await flushPortablePersistence();
  const repository = await requirePortableStateRepository();
  return (await repository.runtimeInfo()).epoch;
}

/** Arm the next production Replace with the revision protected by its safety file. */
export function armPortableImportRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Portable import safety revision is invalid.');
  }
  armedPortableImportRevision = revision;
}

/** Clear an unconsumed fence when orchestration exits before Replace starts. */
export function clearPortableImportRevisionFence(): void {
  armedPortableImportRevision = undefined;
}

/**
 * Acquiring the restore lease is exactly one SQLite transaction. Therefore its
 * revision must be the safety revision plus one. Any larger value proves that a
 * canonical write landed after the safety snapshot and before the lease.
 */
export function assertPortableImportRevision(
  safetyRevision: number,
  fencedRevision: number,
): void {
  if (fencedRevision !== safetyRevision + 1) {
    throw new PortableImportRevisionConflictError(safetyRevision, fencedRevision);
  }
}

async function enforceArmedPortableImportRevision(): Promise<void> {
  const safetyRevision = armedPortableImportRevision;
  armedPortableImportRevision = undefined;
  if (safetyRevision === undefined) return;
  const repository = await requirePortableStateRepository();
  const fencedRevision = (await repository.runtimeInfo()).epoch;
  assertPortableImportRevision(safetyRevision, fencedRevision);
}

/**
 * The injected dependencies of the pure collect/apply functions: the tier
 * facades plus the export-edge stamps (app build version + ISO timestamp).
 */
export interface BackupDeps {
  tiers: Record<BackupTier, StorageTier>;
  appVersion: string;
  now: string;
  /** Generation assigned by the cross-realm Replace coordinator. */
  datasetEpoch?: number;
}

/** Parse one persisted `{ state, version }` blob, rejecting anything malformed. */
function parseSnapshot(key: string, raw: string): BackupStoreSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupError('corrupt', `Store "${key}" holds unparseable JSON.`);
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof parsed !== 'object' || parsed === null || typeof version !== 'number') {
    throw new BackupError('corrupt', `Store "${key}" is missing a numeric persist version.`);
  }
  return { version, state: (parsed as { state: unknown }).state };
}

/**
 * Read every present store from its tier into a plaintext envelope. A store that
 * is absent (a fresh, never-hydrated store) is simply skipped; a present store
 * whose bytes are malformed throws {@link BackupError} `corrupt`.
 */
export async function collectBackup(deps: BackupDeps): Promise<BackupEnvelopePlain> {
  const stores: BackupStores = {};
  for (const entry of BACKUP_STORES) {
    const raw = await deps.tiers[entry.tier].get(entry.key);
    if (raw === null) continue;
    stores[entry.key] = parseSnapshot(entry.key, raw);
  }
  return {
    format: 'almamesh-backup',
    formatVersion: 1,
    app: { version: deps.appVersion },
    exportedAt: deps.now,
    encryption: 'none',
    stores,
  };
}

/** One store staged for writing: the destination + the exact bytes to write. */
interface StagedWrite {
  key: string;
  tier: BackupTier;
  serialized: string;
}

/**
 * Restore an envelope (Replace). Validates the envelope shape, then stages every
 * known store fully in memory BEFORE touching storage.
 *
 * The all-or-nothing guarantee is real for VALIDATION and STAGING: an invalid,
 * too-new, or corrupt-to-serialize file is rejected up front, so a bad file never
 * begins a write. The WRITES themselves are NOT transactional — `localStorage`
 * and an arbitrary injected compatibility tier cannot be rolled back together,
 * so a mid-write storage failure can leave a partial replace. Production browser
 * restores use {@link applyBrowserBackupAtomically} instead.
 *
 * This is a TRUE "Replace all": a known store the envelope OMITS is DELETED, so
 * no stale local data survives an import of a sparse backup. Unknown store keys
 * are ignored (forward-compatible). After the writes it deletes derived RAG
 * vectors so they rebuild from restored chat. Predictive results are canonical
 * and restored with their chart. Zustand `persist` + each store's `migrate` run
 * on the next app load.
 */
export async function applyBackup(envelope: BackupEnvelopePlain, deps: BackupDeps): Promise<void> {
  if (envelope.format !== 'almamesh-backup') {
    throw new BackupError('bad_format', 'This file is not an AlmaMesh backup.');
  }
  if (envelope.formatVersion > 1) {
    throw new BackupError(
      'too_new',
      'This backup was made by a newer version of AlmaMesh. Update the app first.',
    );
  }
  if (envelope.formatVersion < 1) {
    throw new BackupError('bad_format', 'This backup has an invalid format version.');
  }

  const tierByKey = new Map<string, BackupTier>(BACKUP_STORES.map((e) => [e.key, e.tier]));

  // STAGE — serialize every known store up front; any throw aborts before writes.
  const staged: StagedWrite[] = [];
  for (const [key, snapshot] of Object.entries(envelope.stores)) {
    const tier = tierByKey.get(key);
    if (tier === undefined) continue; // unknown/future key — ignore, don't fail
    staged.push({
      key,
      tier,
      serialized: JSON.stringify({
        state: snapshot.state,
        version: snapshot.version,
        ...(deps.datasetEpoch !== undefined && tier === 'idb'
          ? { datasetEpoch: deps.datasetEpoch }
          : {}),
      }),
    });
  }

  // WRITE — reached only once every present store staged cleanly. Not atomic
  // against a mid-write storage failure (see docstring); such a failure rejects.
  for (const item of staged) {
    await deps.tiers[item.tier].set(item.key, item.serialized);
  }

  // REPLACE — a known store the backup omitted must not keep stale local data.
  const presentKeys = new Set(Object.keys(envelope.stores));
  for (const entry of BACKUP_STORES) {
    if (!presentKeys.has(entry.key)) await deps.tiers[entry.tier].del(entry.key);
  }

  // Derived semantic memory never travels as user data. It lives in the
  // SqliteVectorIndex and is rebuilt from chat via the memoryRebuildPending
  // marker the atomic Replace sets; there is no IndexedDB vector key to clear.
}

/** Production Replace: commit every canonical store and generation pointer atomically in SQLite. */
export async function applyBrowserBackupAtomically(
  envelope: BackupEnvelopePlain,
  deps: BackupDeps,
  epoch: number,
): Promise<void> {
  if (envelope.format !== 'almamesh-backup' || envelope.formatVersion !== 1) {
    await applyBackup(envelope, deps);
    return;
  }
  await enforceArmedPortableImportRevision();
  const writes = BACKUP_STORES.map((entry) => {
    const snapshot = envelope.stores[entry.key];
    return {
      key: entry.key,
      value:
        snapshot === undefined
          ? null
          : JSON.stringify({
              state: snapshot.state,
              version: snapshot.version,
            }),
    };
  });
  await commitDatasetGeneration(epoch, writes, { memoryRebuildPending: true });
}

/** Export the canonical browser dataset as a real, standard SQLite database. */
export async function exportPortableBrowserState(): Promise<Uint8Array> {
  await flushPortablePersistence();
  return (await requirePortableStateRepository()).exportBytes();
}

/**
 * Import a validated SQLite transport through the normal generation commit.
 * This retags every Zustand envelope to a fresh local epoch, so existing tabs
 * cannot resurrect the pre-import dataset. Legacy JSON imports remain handled
 * by applyBrowserBackupAtomically.
 */
export interface PortableBrowserImportOptions {
  /** Historical raw SQLite files predate canonical settings; keep the destination row if absent. */
  readonly preserveMissingPreferences?: boolean;
}

export async function importPortableBrowserState(
  bytes: Uint8Array,
  options: PortableBrowserImportOptions = {},
): Promise<void> {
  const imported = await readPortableStateDatabase(bytes);
  const restored = restoredIdsFromPortableRows(imported.values);
  const importedPreferences = imported.values.get(PORTABLE_PREFERENCES_KEY);
  const preservedPreferences =
    importedPreferences === undefined && options.preserveMissingPreferences === true
      ? await (await requirePortableStateRepository()).read(PORTABLE_PREFERENCES_KEY)
      : null;
  const preferencesRaw = importedPreferences ?? preservedPreferences ?? undefined;
  if (preferencesRaw !== undefined) decodePortablePreferences(preferencesRaw);
  const epoch = await beginBackupRestore(restored);
  try {
    await enforceArmedPortableImportRevision();
    await commitDatasetGeneration(
      epoch,
      PORTABLE_STATE_KEYS.map((key) => ({
        key,
        value:
          key === PORTABLE_PREFERENCES_KEY
            ? (preferencesRaw ?? null)
            : (imported.values.get(key) ?? null),
      })),
      { memoryRebuildPending: true },
    );
  } catch (error) {
    await abortBackupRestore(epoch);
    throw error;
  }
}

function restoredIdsFromPortableRows(values: ReadonlyMap<string, string>): {
  readonly profileIds: readonly string[];
  readonly threadIds: readonly string[];
  readonly chartIds: readonly string[];
} {
  const state = (key: string): Record<string, unknown> => {
    const value = values.get(key);
    if (value === undefined) return {};
    try {
      const parsed = JSON.parse(value) as { state?: unknown };
      return parsed.state !== null &&
        typeof parsed.state === 'object' &&
        !Array.isArray(parsed.state)
        ? (parsed.state as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const keys = (value: unknown): readonly string[] =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  return {
    profileIds: keys(state('almamesh-profiles').profiles),
    chartIds: keys(state('almamesh-chart-library').charts),
    threadIds: keys(state('almamesh-chat-history').threads),
  };
}

/**
 * Real browser tiers. Both historical tier names resolve to canonical SQLite;
 * derived caches remain outside the export and are rebuilt from canonical rows.
 */
export function createBrowserTiers(): Record<BackupTier, StorageTier> {
  return {
    local: {
      get: async (key) => await portablePreferenceStorage.getItem(key),
      set: async (key, value) => {
        await portablePreferenceStorage.setItem(key, value);
      },
      del: async (key) => {
        await portablePreferenceStorage.removeItem(key);
      },
    },
    idb: {
      get: async (key) => await readCanonicalDatasetValue(key),
      set: async (key, value) => {
        await deletionAwareIdbStorage.setItem(key, value);
      },
      del: async (key) => {
        await deletionAwareIdbStorage.removeItem(key);
      },
    },
  };
}
