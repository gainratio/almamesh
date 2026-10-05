/**
 * Backup & Restore orchestration service (Spec 061).
 *
 * The UI never talks to the storage primitives directly. It talks to this thin
 * service, which composes the already-built pieces from `@almamesh/store` into
 * the three operations a Settings screen needs:
 *
 *   - {@link buildBackupExport} — seal canonical SQLite into one encrypted
 *     `.almamesh` file.
 *   - {@link stageBackupImport} — validate SQLite or legacy JSON, decrypt when
 *     needed, and return a preview ready for confirmation (nothing written yet).
 *   - {@link commitBackupImport} — write a staged envelope into the stores.
 *
 * This module is PURE orchestration plus the browser-deps edge. It does NO file
 * I/O (that is `backupFile.ts`), touches NO DOM, and never reloads the page (the
 * caller does that after a commit). The only impurity is the default deps —
 * real browser tiers, the build app version, and `new Date()` — all injectable
 * via {@link BackupDepsOverride} so tests stay deterministic.
 */

import {
  abortBackupRestore,
  applyBackup,
  applyBrowserBackupAtomically,
  BackupCryptoError,
  BackupError,
  beginBackupRestore,
  clearMemoryRebuildPending,
  collectBackup,
  createBrowserTiers,
  decodeEnvelope,
  encodeEnvelope,
  exportPortableBrowserState,
  finalizeBackupRestore,
  importPortableBrowserState,
  isPortableBundle,
  mergeLegacyPreferencesIntoPortableState,
  MIN_BUNDLE_PASSPHRASE_LENGTH,
  openPortableBundle,
  PORTABLE_STATE_KEYS,
  PortableStateTooNewError,
  PortableStateUnavailableError,
  sealPortableBundle,
  readDeletionTombstones,
  readPortableStateDatabase,
  type BackupDeps,
  type PortableBrowserImportOptions,
  EMPTY_PORTABLE_REPAIR_REPORT,
  type PortableExport,
  type PortableRepairReport,
  repairPortableReferences,
  holdSetAsideRecords,
  type SetAsideRecord,
  type PortableStateSnapshot,
  type StorageTier,
} from '@almamesh/store';
import { safeWarn } from '@almamesh/shared-types';
import type { BackupEnvelope, BackupEnvelopePlain } from '@almamesh/shared-types';
import type { IndexableMessage } from '@almamesh/memory';
import { clearMemory, rebuildMemory } from './chatMemory';
import { publishDeletionNotice } from './deletionPropagation';

const MEMORY_REBUILD_SLA_MS = 30_000;

function withinMemoryRebuildSla(operation: Promise<void>): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error('Semantic-memory rebuild exceeded the 30-second restore SLA.')),
      MEMORY_REBUILD_SLA_MS,
    );
    void operation.then(resolvePromise, rejectPromise).finally(() => clearTimeout(timeout));
  });
}

/**
 * Build-injected app version (Vite `define`). Read with a `typeof` guard so an
 * undefined-at-runtime constant never throws — falling back to `'dev'`.
 */
declare const __APP_VERSION__: string | undefined;

/** The current build's app version, stamped into every export's `app.version`. */
function currentAppVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
}

/**
 * Optional injection of the backup dependencies. Every field defaults to a real
 * browser value; tests override them with in-memory tiers and a fixed clock.
 */
export interface BackupDepsOverride {
  tiers?: Record<'local' | 'idb', StorageTier>;
  appVersion?: string;
  now?: string;
  beginBackupRestore?: typeof beginBackupRestore;
  finalizeBackupRestore?: typeof finalizeBackupRestore;
  abortBackupRestore?: typeof abortBackupRestore;
  clearChatMemory?: () => Promise<void>;
  rebuildChatMemory?: (messages: readonly IndexableMessage[]) => Promise<void>;
  completeMemoryRebuild?: (epoch: number) => Promise<void>;
  publishDatasetNotice?: (notice: {
    readonly kind: 'dataset';
    readonly operation: 'replace';
    readonly phase: 'begin' | 'complete' | 'abort';
    readonly presentStoreKeys: readonly string[];
  }) => void;
  exportPortableState?: () => Promise<PortableExport>;
  readPortableState?: (bytes: Uint8Array) => Promise<PortableStateSnapshot>;
  importPortableState?: (
    bytes: Uint8Array,
    options?: PortableBrowserImportOptions,
  ) => Promise<void>;
  mergeLegacyPreferences?: (bytes: Uint8Array, candidate: unknown) => Promise<Uint8Array>;
  readActiveEpoch?: () => Promise<number>;
  holdSetAside?: (records: readonly SetAsideRecord[]) => Promise<void>;
}

/** How long staging waits for the local SQLite runtime before giving up. */
export const STAGE_DATABASE_TIMEOUT_MS = 30_000;

/** Reject with PortableStateUnavailableError when the SQLite runtime never answers. */
function withinStageTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new PortableStateUnavailableError()),
      STAGE_DATABASE_TIMEOUT_MS,
    );
    void operation.then(resolvePromise, rejectPromise).finally(() => clearTimeout(timeout));
  });
}

interface RestoreIds {
  readonly profileIds: readonly string[];
  readonly threadIds: readonly string[];
  readonly chartIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotState(envelope: BackupEnvelopePlain, key: string): Record<string, unknown> {
  const state = envelope.stores[key]?.state;
  return isRecord(state) ? state : {};
}

function addOwner(target: Set<string>, value: unknown): void {
  if (isRecord(value) && typeof value.profile_id === 'string') {
    target.add(value.profile_id);
  }
}

function restoredIds(envelope: BackupEnvelopePlain): RestoreIds {
  const profiles = snapshotState(envelope, 'almamesh-profiles').profiles;
  const charts = snapshotState(envelope, 'almamesh-chart-library').charts;
  const threads = snapshotState(envelope, 'almamesh-chat-history').threads;
  const profileIds = new Set(isRecord(profiles) ? Object.keys(profiles) : []);
  if (isRecord(charts)) Object.values(charts).forEach((chart) => addOwner(profileIds, chart));
  if (isRecord(threads)) Object.values(threads).forEach((thread) => addOwner(profileIds, thread));
  return {
    profileIds: [...profileIds],
    chartIds: isRecord(charts) ? Object.keys(charts) : [],
    threadIds: isRecord(threads) ? Object.keys(threads) : [],
  };
}

function restoredChatMessages(envelope: BackupEnvelopePlain): readonly IndexableMessage[] {
  const state = snapshotState(envelope, 'almamesh-chat-history');
  const threads = isRecord(state.threads) ? state.threads : {};
  const messages = isRecord(state.messages) ? state.messages : {};
  const restored: IndexableMessage[] = [];
  for (const [threadId, thread] of Object.entries(threads)) {
    const profileId = isRecord(thread) ? thread.profile_id : undefined;
    const threadMessages = messages[threadId];
    if (typeof profileId !== 'string' || !Array.isArray(threadMessages)) continue;
    for (const message of threadMessages) {
      if (!isRecord(message) || typeof message.id !== 'string') continue;
      if (message.error === true) continue;
      if (typeof message.content !== 'string' || message.content.trim().length === 0) continue;
      restored.push({
        id: message.id,
        thread_id: threadId,
        profile_id: profileId,
        content: message.content,
      });
    }
  }
  return restored;
}

/** Resolve the injected/overridden deps into the concrete {@link BackupDeps}. */
function resolveDeps(override?: BackupDepsOverride, datasetEpoch?: number): BackupDeps {
  return {
    tiers: override?.tiers ?? createBrowserTiers(),
    appVersion: override?.appVersion ?? currentAppVersion(),
    now: override?.now ?? new Date().toISOString(),
    ...(datasetEpoch !== undefined ? { datasetEpoch } : {}),
  };
}

export type BackupContent = string | Uint8Array;
const MAX_BACKUP_TEXT_CHARACTERS = 128 * 1024 * 1024;

/** A ready-to-save encrypted backup. */
export interface BackupExport {
  filename: string;
  content: BackupContent;
  /** What the export repaired: dangling person/chart references (see repairPortableReferences). */
  repairs: PortableRepairReport;
}

/**
 * The user-facing export requires a passphrase and yields format v3: exact
 * canonical SQLite bytes sealed with AES-GCM under a PBKDF2-derived key.
 * Dependency-injected pure-tier tests retain the legacy JSON envelope.
 */
export async function buildBackupExport(
  passphrase?: string,
  override?: BackupDepsOverride,
): Promise<BackupExport> {
  if (passphrase === undefined || passphrase.length < MIN_BUNDLE_PASSPHRASE_LENGTH) {
    throw new BackupCryptoError(
      'bad_passphrase',
      `A passphrase of at least ${MIN_BUNDLE_PASSPHRASE_LENGTH} characters is required to export.`,
    );
  }
  const deps = resolveDeps(override);
  if (override?.tiers === undefined) {
    const exported = await (override?.exportPortableState ?? exportPortableBrowserState)();
    const content = await sealPortableBundle(exported.bytes, passphrase, deps);
    return {
      filename: exportBackupFilename(deps.now),
      content,
      repairs: exported.repairs,
    };
  }
  const plain = await collectBackup(deps);
  const encoded = await encodeEnvelope(plain, passphrase);
  const filename = `almamesh-backup-${filenameTimestamp(deps.now)}.json`;
  return { filename, content: JSON.stringify(encoded, null, 2), repairs: EMPTY_PORTABLE_REPAIR_REPORT };
}

/** The name an export will be saved under, known before the export is built. */
export function exportBackupFilename(now: string = new Date().toISOString()): string {
  return `almamesh-backup-${filenameTimestamp(now)}.almamesh`;
}

/** The pre-import safety copy's name, derived from an export name. */
export function safetyBackupFilename(exportName: string): string {
  return exportName.startsWith('almamesh-backup-')
    ? exportName.replace('almamesh-backup-', 'almamesh-backup-before-import-')
    : `almamesh-backup-before-import-${exportName}`;
}

function filenameTimestamp(now: string): string {
  const parsed = new Date(now);
  const iso = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  return iso.replace(/:(?=\d{2}(?::|\.))/g, '-').replace('.', '-');
}

/** A parsed, validated (and decrypted) backup awaiting the user's confirmation. */
export type StagedImport =
  | {
      readonly kind: 'json';
      readonly envelope: BackupEnvelopePlain;
      readonly wasEncrypted: boolean;
      /** What staging repaired (dangling person/chart references); shown before confirm. */
      readonly repairs?: PortableRepairReport;
    }
  | {
      readonly kind: 'sqlite';
      readonly envelope: BackupEnvelopePlain;
      readonly wasEncrypted: false;
      readonly bytes: Uint8Array;
      readonly repairs?: PortableRepairReport;
    }
  | {
      /** Encrypted SQLite bundle, normalized to the current canonical schema. */
      readonly kind: 'bundle';
      readonly envelope: BackupEnvelopePlain;
      readonly wasEncrypted: true;
      readonly bytes: Uint8Array;
      readonly repairs?: PortableRepairReport;
    };

const SQLITE_HEADER = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);
const PORTABLE_PREVIEW_KEYS = new Set<string>(PORTABLE_STATE_KEYS);

function hasSqliteHeader(bytes: Uint8Array): boolean {
  return SQLITE_HEADER.every((value, index) => bytes[index] === value);
}

function envelopeFromPortableSnapshot(snapshot: PortableStateSnapshot): BackupEnvelopePlain {
  const stores: BackupEnvelopePlain['stores'] = {};
  for (const [key, value] of snapshot.values) {
    if (!PORTABLE_PREVIEW_KEYS.has(key)) continue;
    try {
      const parsed = JSON.parse(value) as { state?: unknown; version?: unknown };
      if (typeof parsed.version === 'number' && 'state' in parsed) {
        stores[key] = { state: parsed.state, version: parsed.version };
      }
    } catch {
      // The store validator already checked all canonical rows. This guard keeps
      // preview construction total if a future metadata row is non-JSON.
    }
  }
  return {
    format: 'almamesh-backup',
    formatVersion: 1,
    app: { version: 'portable-sqlite' },
    exportedAt: new Date().toISOString(),
    encryption: 'none',
    stores,
  };
}

/**
 * Detect and validate picked SQLite bytes or legacy JSON text, then decrypt
 * encrypted JSON when needed.
 * Nothing is written — the caller previews {@link StagedImport.envelope} and
 * only then calls {@link commitBackupImport}.
 *
 * Failure modes are typed so the UI can message the exact reason:
 *  - invalid SQLite/JSON, not an AlmaMesh backup, or a below-range version
 *    ⇒ {@link BackupError} `bad_format`
 *  - made by a newer app (`formatVersion > 2`) ⇒ {@link BackupError} `too_new`
 *  - encrypted but no passphrase given ⇒ {@link BackupCryptoError}
 *    `bad_passphrase` (so the UI knows to prompt), and a wrong passphrase
 *    surfaces the same error from `decodeEnvelope`.
 */
export async function stageBackupImport(
  content: BackupContent,
  passphrase?: string,
  override?: Pick<BackupDepsOverride, 'readPortableState' | 'mergeLegacyPreferences'>,
): Promise<StagedImport> {
  if (content instanceof Uint8Array) {
    if (isPortableBundle(content)) {
      const { database } = await openPortableBundle(content, passphrase ?? '');
      if (!hasSqliteHeader(database)) {
        throw new BackupError('corrupt', 'The backup unlocked but holds no AlmaMesh database.');
      }
      const { envelope, repairs } = await readPortableEnvelope(database, override);
      return { kind: 'bundle', envelope, wasEncrypted: true, bytes: database, repairs };
    }
    if (!hasSqliteHeader(content)) {
      throw new BackupError('bad_format', 'This file is not an AlmaMesh backup.');
    }
    const bytes = content.slice();
    const { envelope, repairs } = await readPortableEnvelope(bytes, override);
    return { kind: 'sqlite', envelope, wasEncrypted: false, bytes, repairs };
  }
  if (content.length > MAX_BACKUP_TEXT_CHARACTERS) {
    throw new BackupError('bad_format', 'This backup file is too large to import safely.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new BackupError('bad_format', 'This file is not valid JSON, so it is not an AlmaMesh backup.');
  }

  const record = parsed as { format?: unknown; formatVersion?: unknown; encryption?: unknown };
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    record.format !== 'almamesh-backup' ||
    typeof record.formatVersion !== 'number'
  ) {
    throw new BackupError('bad_format', 'This file is not an AlmaMesh backup.');
  }
  if (isPortableBundle(parsed)) {
    // Validates the header first (bad_format), then asks for the passphrase.
    const { database, settings } = await openPortableBundle(parsed, passphrase ?? '');
    if (!hasSqliteHeader(database)) {
      throw new BackupError('corrupt', 'The backup unlocked but holds no AlmaMesh database.');
    }
    const bytes = Object.keys(settings).length === 0
      ? database
      : await (override?.mergeLegacyPreferences ?? mergeLegacyPreferencesIntoPortableState)(
          database,
          settings,
        );
    const { envelope, repairs } = await readPortableEnvelope(bytes, override);
    return { kind: 'bundle', envelope, wasEncrypted: true, bytes, repairs };
  }
  if (record.formatVersion > 2) {
    throw new BackupError(
      'too_new',
      'This backup was made by a newer version of AlmaMesh. Update the app first.',
    );
  }
  if (record.formatVersion < 1 || record.formatVersion === 2) {
    throw new BackupError('bad_format', 'This backup has an invalid format version.');
  }

  const wasEncrypted = record.encryption === 'aes-gcm';
  if (wasEncrypted && !passphrase) {
    throw new BackupCryptoError(
      'bad_passphrase',
      'This backup is encrypted — enter its passphrase to open it.',
    );
  }

  const { envelope, repairs } = repairEnvelopeReferences(
    await decodeEnvelope(parsed as BackupEnvelope, passphrase),
  );
  return { kind: 'json', envelope, wasEncrypted, repairs };
}

/**
 * Legacy JSON backups never passed the portable validator, and a chat has
 * pointed at a regenerated chart since the first release. Repair dangling
 * person/chart references the same way export and the SQLite import do, so
 * importing an old file cannot poison every later export.
 */
function repairEnvelopeReferences(envelope: BackupEnvelopePlain): {
  readonly envelope: BackupEnvelopePlain;
  readonly repairs: PortableRepairReport;
} {
  const values = new Map(
    Object.entries(envelope.stores).map(([key, snapshot]) => [key, JSON.stringify(snapshot)]),
  );
  const repaired = repairPortableReferences(values);
  if (repaired.values === values) return { envelope, repairs: repaired.repairs };
  const stores: BackupEnvelopePlain['stores'] = {};
  for (const [key, value] of repaired.values) {
    stores[key] = JSON.parse(value) as BackupEnvelopePlain['stores'][string];
  }
  return { envelope: { ...envelope, stores }, repairs: repaired.repairs };
}

/**
 * Validate canonical SQLite bytes in an isolated in-memory database. A runtime
 * that cannot start (no OPFS/worker support) surfaces as
 * PortableStateUnavailableError instead of hanging or posing as a bad file.
 */
async function readPortableEnvelope(
  bytes: Uint8Array,
  override?: Pick<BackupDepsOverride, 'readPortableState'>,
): Promise<{ readonly envelope: BackupEnvelopePlain; readonly repairs: PortableRepairReport }> {
  try {
    const read = override?.readPortableState ?? readPortableStateDatabase;
    const snapshot = await withinStageTimeout(read(bytes));
    return {
      envelope: envelopeFromPortableSnapshot(snapshot),
      repairs: 'repairs' in snapshot ? (snapshot.repairs as PortableRepairReport) : EMPTY_PORTABLE_REPAIR_REPORT,
    };
  } catch (error) {
    if (error instanceof PortableStateUnavailableError) throw error;
    if (error instanceof PortableStateTooNewError) {
      throw new BackupError(
        'too_new',
        'This backup was made by a newer version of AlmaMesh. Update the app first.',
      );
    }
    throw new BackupError('bad_format', 'This SQLite file is not a valid AlmaMesh backup.');
  }
}

/**
 * Write a staged envelope into the stores (Replace), revive only IDs explicitly
 * carried by that backup, then drain/replace semantic memory from restored chat.
 * The promise resolves only after search backfill succeeds. Deliberately does
 * NOT reload the page or take the pre-import safety-net export — the caller owns
 * both.
 */
export async function commitBackupImport(
  stagedOrPlain: StagedImport | BackupEnvelopePlain,
  override?: BackupDepsOverride,
): Promise<void> {
  const staged: StagedImport =
    'kind' in stagedOrPlain
      ? stagedOrPlain
      : { kind: 'json', envelope: stagedOrPlain, wasEncrypted: false };
  const plain = staged.envelope;
  const browserEffects = override?.tiers === undefined;
  const beginRestore =
    override?.beginBackupRestore ?? (browserEffects ? beginBackupRestore : async () => 0);
  const rebuild =
    override?.rebuildChatMemory ?? (browserEffects ? rebuildMemory : async () => undefined);
  const clear = override?.clearChatMemory ?? (browserEffects ? clearMemory : async () => undefined);
  const publish =
    override?.publishDatasetNotice ?? (browserEffects ? publishDeletionNotice : () => undefined);
  const finalizeRestore =
    override?.finalizeBackupRestore ??
    (browserEffects ? finalizeBackupRestore : async () => undefined);
  const abortRestore =
    override?.abortBackupRestore ?? (browserEffects ? abortBackupRestore : async () => undefined);
  const deps = resolveDeps(override);
  if (staged.kind === 'sqlite' || staged.kind === 'bundle') {
    const presentStoreKeys = Object.keys(plain.stores);
    publish({ kind: 'dataset', operation: 'replace', phase: 'begin', presentStoreKeys });
    try {
      const importState = override?.importPortableState ?? importPortableBrowserState;
      if (staged.kind === 'sqlite') {
        await importState(staged.bytes, { preserveMissingPreferences: true });
      } else {
        await importState(staged.bytes);
      }
    } catch (error) {
      publish({ kind: 'dataset', operation: 'replace', phase: 'abort', presentStoreKeys });
      throw error;
    }
    try {
      await withinMemoryRebuildSla(rebuild(restoredChatMessages(plain)));
      const epoch = await (override?.readActiveEpoch ?? (async () =>
        (await readDeletionTombstones()).activeEpoch))();
      await (override?.completeMemoryRebuild ??
        (browserEffects ? clearMemoryRebuildPending : async () => undefined))(epoch);
    } catch {
      safeWarn('backup.memory_rebuild_deferred');
    }
    publish({ kind: 'dataset', operation: 'replace', phase: 'complete', presentStoreKeys });
    return;
  }
  // User-written records of a person the file no longer holds stay on this
  // device (set aside), never dropped with the import.
  const setAside = staged.repairs?.setAside ?? [];
  if (setAside.length > 0) await (override?.holdSetAside ?? holdSetAsideRecords)(setAside);
  const epoch = await beginRestore(restoredIds(plain));
  let rollback: BackupEnvelopePlain;
  try {
    rollback = await collectBackup(deps);
  } catch (error) {
    await abortRestore(epoch);
    throw error;
  }
  const presentStoreKeys = Object.keys(plain.stores);
  publish({ kind: 'dataset', operation: 'replace', phase: 'begin', presentStoreKeys });
  const applyGeneration = async (
    envelope: BackupEnvelopePlain,
    generation: number,
  ): Promise<void> => {
    if (browserEffects) {
      await applyBrowserBackupAtomically(envelope, resolveDeps(override), generation);
    } else {
      await applyBackup(envelope, resolveDeps(override, generation));
      await finalizeRestore(generation);
    }
  };
  try {
    if (!browserEffects) await clear();
    await applyGeneration(plain, epoch);
  } catch (error) {
    if (browserEffects) {
      await abortRestore(epoch);
    } else {
      try {
        await applyGeneration(rollback, epoch);
      } catch {
        await abortRestore(epoch);
      }
    }
    publish({
      kind: 'dataset',
      operation: 'replace',
      phase: 'abort',
      presentStoreKeys: Object.keys(rollback.stores),
    });
    throw error;
  }
  try {
    await withinMemoryRebuildSla(rebuild(restoredChatMessages(plain)));
    await (override?.completeMemoryRebuild ??
      (browserEffects ? clearMemoryRebuildPending : async () => undefined))(epoch);
  } catch {
    safeWarn('backup.memory_rebuild_deferred');
  }
  publish({ kind: 'dataset', operation: 'replace', phase: 'complete', presentStoreKeys });
}
