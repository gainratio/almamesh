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

import { safeWarn } from '@almamesh/shared-types';
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
  portablePreferenceStorage,
  requirePortableStateRepository,
} from './deletionTombstones';
import { PORTABLE_STATE_KEYS, readPortableStateDatabase } from './portableState';

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
  { key: 'almamesh-language', tier: 'local' },
];

/** localStorage route-guard flag — re-set on import iff charts were restored. */
export const CHART_FLAG_KEY = 'almamesh-chart';

/** idb-keyval RAG-embeddings key — deleted on import so vectors rebuild from chat. */
export const CHAT_VECTORS_KEY = 'almamesh-chat-vectors';

/** idb-keyval predictive cache — deleted on import so forecasts rebuild from restored charts. */
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
 * are ignored (forward-compatible). After the writes it sets the chart route-guard
 * flag iff charts came back (else clears it) and deletes derived RAG/predictive
 * caches so they rebuild from the restored source data. Zustand `persist` + each
 * store's `migrate` run on the next app load.
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
  let chartLibraryPresent = false;
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
    if (key === 'almamesh-chart-library') chartLibraryPresent = true;
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

  // Post-write housekeeping: the route-guard flag tracks charts-present.
  if (chartLibraryPresent) await deps.tiers.local.set(CHART_FLAG_KEY, '1');
  else await deps.tiers.local.del(CHART_FLAG_KEY);
  await Promise.all([
    deps.tiers.idb.del(CHAT_VECTORS_KEY),
    deps.tiers.idb.del(PREDICTIVE_CACHE_KEY),
  ]);
}

/**
 * Update the two synchronous browser mirrors after the authoritative SQLite
 * generation commits. They are routing/preferences conveniences, not source
 * data. A quota or privacy-mode failure therefore reports `false` without
 * turning a durable personal-data restore into a false failure.
 */
export async function applyLocalRestoreMirrors(
  local: StorageTier,
  languageSerialized: string | null,
  hasCharts: boolean,
): Promise<boolean> {
  try {
    if (languageSerialized === null) await local.del('almamesh-language');
    else await local.set('almamesh-language', languageSerialized);
    if (hasCharts) await local.set(CHART_FLAG_KEY, '1');
    else await local.del(CHART_FLAG_KEY);
    return true;
  } catch {
    return false;
  }
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
  await commitDatasetGeneration(epoch, writes, [CHAT_VECTORS_KEY, PREDICTIVE_CACHE_KEY], {
    memoryRebuildPending: true,
  });

  const language = envelope.stores['almamesh-language'];
  const mirrorsApplied = await applyLocalRestoreMirrors(
    deps.tiers.local,
    language === undefined
      ? null
      : JSON.stringify({ state: language.state, version: language.version }),
    envelope.stores['almamesh-chart-library'] !== undefined,
  );
  if (!mirrorsApplied) {
    safeWarn('backup.local_mirror_deferred');
  }
}

/** Export the canonical browser dataset as a real, standard SQLite database. */
export async function exportPortableBrowserState(): Promise<Uint8Array> {
  return (await requirePortableStateRepository()).exportBytes();
}

/**
 * Import a validated SQLite transport through the normal generation commit.
 * This retags every Zustand envelope to a fresh local epoch, so existing tabs
 * cannot resurrect the pre-import dataset. Legacy JSON imports remain handled
 * by applyBrowserBackupAtomically.
 */
export async function importPortableBrowserState(bytes: Uint8Array): Promise<void> {
  const imported = await readPortableStateDatabase(bytes);
  const restored = restoredIdsFromPortableRows(imported.values);
  const epoch = await beginBackupRestore(restored);
  try {
    await commitDatasetGeneration(
      epoch,
      PORTABLE_STATE_KEYS.map((key) => ({
        key,
        value: imported.values.get(key) ?? null,
      })),
      [CHAT_VECTORS_KEY, PREDICTIVE_CACHE_KEY],
      { memoryRebuildPending: true },
    );
    const language = imported.values.get('almamesh-language') ?? null;
    const storage = (globalThis as { localStorage?: Partial<Storage> }).localStorage;
    if (language === null) storage?.removeItem?.('almamesh-language');
    else storage?.setItem?.('almamesh-language', language);
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
 * Real browser tiers. Canonical state resolves through SQLite-backed adapters;
 * route flags remain disposable localStorage mirrors and derived caches remain
 * in their rebuildable stores. Window access is lazy so module import is safe.
 */
export function createBrowserTiers(): Record<BackupTier, StorageTier> {
  return {
    local: {
      get: async (key) =>
        key === 'almamesh-language'
          ? await portablePreferenceStorage.getItem(key)
          : window.localStorage.getItem(key),
      set: async (key, value) => {
        if (key === 'almamesh-language') {
          await portablePreferenceStorage.setItem(key, value);
          return;
        }
        window.localStorage.setItem(key, value);
      },
      del: async (key) => {
        if (key === 'almamesh-language') {
          await portablePreferenceStorage.removeItem(key);
          return;
        }
        window.localStorage.removeItem(key);
      },
    },
    idb: {
      get: async (key) => await deletionAwareIdbStorage.getItem(key),
      set: async (key, value) => {
        await deletionAwareIdbStorage.setItem(key, value);
      },
      del: async (key) => {
        await deletionAwareIdbStorage.removeItem(key);
      },
    },
  };
}
