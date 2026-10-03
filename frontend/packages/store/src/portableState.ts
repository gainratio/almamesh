import {
  createSqliteStateStore,
  SqliteStateConflictError,
  type SqliteStateMutation,
  type SqliteStateRuntimeInfo,
  type SqliteStateStore,
} from '@gainratio/browser/sqlite';

export const PORTABLE_STATE_DATABASE = 'almamesh-user-state';
export const PORTABLE_STATE_NAMESPACE = 'canonical';
export const PORTABLE_STATE_SCHEMA_VERSION = 1;
export const LEGACY_MIGRATION_MARKER = 'meta/legacy-idb-migration-v1';
export const PORTABLE_LEDGER_KEY = 'almamesh-deletion-tombstones';
export const PORTABLE_STATE_UNAVAILABLE_MESSAGE =
  'Portable SQLite requires cross-origin isolation, Web Workers, OPFS, SharedArrayBuffer, and Atomics.waitAsync.';

export class PortableStateUnavailableError extends Error {
  public override readonly name = 'PortableStateUnavailableError';

  public constructor() {
    super(PORTABLE_STATE_UNAVAILABLE_MESSAGE);
  }
}

/**
 * Canonical personal-data snapshots. Derived vector/predictive caches and
 * provider credentials are deliberately absent from this allowlist.
 */
export const PORTABLE_STATE_KEYS = [
  'almamesh-profiles',
  'almamesh-chart-library',
  'almamesh-life-events',
  'almamesh-rectification-records',
  'almamesh-chat-history',
  'almamesh-interpretations',
  'almamesh-language',
] as const;

const ALLOWED_PORTABLE_KEYS = new Set<string>([
  ...PORTABLE_STATE_KEYS,
  PORTABLE_LEDGER_KEY,
  LEGACY_MIGRATION_MARKER,
]);

export function isPortableStateKey(key: string): boolean {
  return ALLOWED_PORTABLE_KEYS.has(key);
}

const MAX_TRANSACTION_ATTEMPTS = 8;
const MAX_CANONICAL_ROWS = 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const INITIAL_PORTABLE_LEDGER = JSON.stringify({
  version: 1,
  activeEpoch: 0,
  restoreEpoch: 0,
  restoreInProgress: false,
  memoryRebuildPending: false,
  profileIds: [],
  threadIds: [],
  chartIds: [],
});

export type PortableStateMutation =
  | { readonly type: 'put'; readonly key: string; readonly value: string }
  | { readonly type: 'delete'; readonly key: string };

export interface PortableStateSnapshot {
  readonly epoch: number;
  readonly values: ReadonlyMap<string, string>;
}

export interface LegacyStateStorage {
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/**
 * AlmaMesh's thin application mapping over the shared EdgeProc SQLite Lego.
 * Values remain the existing versioned Zustand JSON envelopes, which keeps the
 * migration small while making the complete canonical dataset one SQLite file.
 */
export class PortableStateRepository {
  readonly #store: SqliteStateStore;

  public constructor(store: SqliteStateStore) {
    this.#store = store;
  }

  public async read(key: string): Promise<string | null> {
    assertPortableKey(key);
    const row = await this.#store.get(PORTABLE_STATE_NAMESPACE, key);
    return row === undefined ? null : decode(row.value, key);
  }

  public async snapshot(): Promise<PortableStateSnapshot> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const before = await this.#store.runtimeInfo();
      const page = await this.#store.list({
        namespace: PORTABLE_STATE_NAMESPACE,
        limit: MAX_CANONICAL_ROWS,
      });
      const after = await this.#store.runtimeInfo();
      if (page.nextKey !== undefined) {
        throw new Error('Portable state exceeds the supported canonical row count.');
      }
      if (before.epoch !== after.epoch) continue;
      for (const row of page.rows) assertPortableKey(row.key);
      return {
        epoch: before.epoch,
        values: new Map(page.rows.map((row) => [row.key, decode(row.value, row.key)])),
      };
    }
    throw new Error('Portable state remained busy while reading a consistent snapshot.');
  }

  /** Apply a pure snapshot transformation with bounded optimistic retries. */
  public async transact(
    transform: (snapshot: PortableStateSnapshot) => readonly PortableStateMutation[],
  ): Promise<number> {
    const result = await this.transactWithResult((snapshot) => ({
      mutations: transform(snapshot),
      result: snapshot.epoch,
    }));
    return result.epoch;
  }

  /** Return attempt-local metadata only from the CAS attempt that actually won. */
  public async transactWithResult<Result>(
    transform: (snapshot: PortableStateSnapshot) => {
      readonly mutations: readonly PortableStateMutation[];
      readonly result: Result;
    },
  ): Promise<{ readonly epoch: number; readonly result: Result }> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const snapshot = await this.snapshot();
      const { mutations, result: attemptResult } = transform(snapshot);
      if (mutations.length === 0) return { epoch: snapshot.epoch, result: attemptResult };
      try {
        const result = await this.#store.batch(mutations.map(toSqliteMutation), {
          expectedEpoch: snapshot.epoch,
        });
        return { epoch: result.epoch, result: attemptResult };
      } catch (error) {
        if (error instanceof SqliteStateConflictError) continue;
        throw error;
      }
    }
    throw new Error('Portable state remained busy while committing a transaction.');
  }

  public async write(key: string, value: string): Promise<number> {
    assertPortableKey(key);
    return this.transact(() => [{ type: 'put', key, value }]);
  }

  public async delete(key: string): Promise<number> {
    assertPortableKey(key);
    return this.transact(() => [{ type: 'delete', key }]);
  }

  public runtimeInfo(): Promise<SqliteStateRuntimeInfo> {
    return this.#store.runtimeInfo();
  }

  public async exportBytes(): Promise<Uint8Array> {
    validatePortableSnapshot(await this.snapshot());
    return this.#store.exportBytes();
  }

  public async checkIntegrity(): Promise<void> {
    await this.#store.checkIntegrity();
  }

  public dispose(): Promise<void> {
    return this.#store.dispose();
  }
}

/** 'memory' is the session-only fallback for browsers that refuse OPFS (see portablePersistence.ts). */
export async function openPortableStateRepository(
  persistence: 'opfs' | 'memory' = 'opfs',
): Promise<PortableStateRepository> {
  return new PortableStateRepository(
    await createSqliteStateStore({
      name: PORTABLE_STATE_DATABASE,
      initialSchemaVersion: PORTABLE_STATE_SCHEMA_VERSION,
      persistence,
    }),
  );
}

export interface PortableStateCapabilities {
  readonly Worker?: unknown;
  readonly SharedArrayBuffer?: unknown;
  readonly Atomics?: { readonly waitAsync?: unknown };
  readonly crossOriginIsolated?: boolean;
  readonly navigator?: {
    readonly storage?: { readonly getDirectory?: unknown };
  };
}

/** OPFS SQLite is a production-browser capability, never a silent IDB fallback. */
export function supportsPortableState(
  candidate: PortableStateCapabilities = globalThis as PortableStateCapabilities,
): boolean {
  return (
    candidate.crossOriginIsolated === true &&
    typeof candidate.Worker === 'function' &&
    typeof candidate.navigator?.storage?.getDirectory === 'function' &&
    typeof candidate.SharedArrayBuffer === 'function' &&
    typeof candidate.Atomics?.waitAsync === 'function'
  );
}

export type PortableStateMode = 'portable' | 'node-test-fallback';

/** Real browsers fail closed; only Node-based tests/SSR retain the IDB seam. */
export function resolvePortableStateMode(
  candidate: PortableStateCapabilities = globalThis as PortableStateCapabilities,
  nodeRuntime = typeof (
    globalThis as typeof globalThis & {
      process?: { versions?: { node?: unknown } };
    }
  ).process?.versions?.node === 'string',
): PortableStateMode {
  if (supportsPortableState(candidate)) return 'portable';
  if (nodeRuntime) return 'node-test-fallback';
  throw new PortableStateUnavailableError();
}

/** Refuse foreign rows, credentials, caches, or inconsistent generations before import. */
export async function validatePortableStateDatabase(bytes: Uint8Array): Promise<void> {
  await readPortableStateDatabase(bytes);
}

/** Read a validated transport database without exposing arbitrary SQL. */
export async function readPortableStateDatabase(bytes: Uint8Array): Promise<PortableStateSnapshot> {
  const store = await createSqliteStateStore({
    name: 'almamesh-import-validation',
    initialSchemaVersion: PORTABLE_STATE_SCHEMA_VERSION,
    persistence: 'memory',
  });
  const repository = new PortableStateRepository(store);
  try {
    const stage = await store.stageImport(bytes);
    if (stage.schemaVersion !== PORTABLE_STATE_SCHEMA_VERSION) {
      throw new Error(`Unsupported portable state schema version ${stage.schemaVersion}.`);
    }
    await store.commitImport(stage.stageId, { expectedEpoch: 0 });
    await repository.checkIntegrity();
    const snapshot = await repository.snapshot();
    validatePortableSnapshot(snapshot);
    return snapshot;
  } finally {
    await repository.dispose();
  }
}

/**
 * One-time, crash-resumable migration from the old idb-keyval records. The
 * SQLite batch lands before legacy deletion, so interruption can only leave a
 * redundant source copy which the next start safely removes.
 */
export async function migrateLegacyState(
  repository: PortableStateRepository,
  legacy: LegacyStateStorage,
  keys: readonly string[],
): Promise<{
  readonly imported: boolean;
  readonly importedKeys: readonly string[];
}> {
  const legacyValues = await Promise.all(
    keys.map(async (key) => [key, await legacy.get(key)] as const),
  );
  const transaction = await repository.transactWithResult(({ values }) => {
    if (values.has(LEGACY_MIGRATION_MARKER)) {
      return {
        mutations: values.has(PORTABLE_LEDGER_KEY)
          ? []
          : ([
              {
                type: 'put',
                key: PORTABLE_LEDGER_KEY,
                value: INITIAL_PORTABLE_LEDGER,
              },
            ] as const),
        result: { imported: false, importedKeys: [] as string[] },
      };
    }
    const importedKeys: string[] = [];
    const mutations: PortableStateMutation[] = [];
    for (const [key, value] of legacyValues) {
      if (value === null || values.has(key)) continue;
      importedKeys.push(key);
      mutations.push({ type: 'put', key, value });
    }
    if (!values.has(PORTABLE_LEDGER_KEY) && !importedKeys.includes(PORTABLE_LEDGER_KEY)) {
      mutations.push({
        type: 'put',
        key: PORTABLE_LEDGER_KEY,
        value: INITIAL_PORTABLE_LEDGER,
      });
    }
    mutations.push({
      type: 'put',
      key: LEGACY_MIGRATION_MARKER,
      value: 'complete',
    });
    return { mutations, result: { imported: true, importedKeys } };
  });
  const { imported, importedKeys } = transaction.result;
  await repository.checkIntegrity();
  for (const [key, value] of legacyValues) {
    if (value !== null && importedKeys.includes(key) && (await repository.read(key)) !== value) {
      throw new Error(`Portable state migration verification failed for "${key}".`);
    }
  }
  await Promise.all(keys.map((key) => legacy.delete(key)));
  return { imported, importedKeys };
}

function toSqliteMutation(mutation: PortableStateMutation): SqliteStateMutation {
  assertPortableKey(mutation.key);
  return mutation.type === 'put'
    ? {
        type: 'put',
        namespace: PORTABLE_STATE_NAMESPACE,
        key: mutation.key,
        value: encoder.encode(mutation.value),
      }
    : {
        type: 'delete',
        namespace: PORTABLE_STATE_NAMESPACE,
        key: mutation.key,
      };
}

function assertPortableKey(key: string): void {
  if (!isPortableStateKey(key)) {
    throw new Error(`Portable state key "${key}" is not canonical AlmaMesh data.`);
  }
}

function validatePortableSnapshot(snapshot: PortableStateSnapshot): void {
  const ledgerRaw = snapshot.values.get(PORTABLE_LEDGER_KEY);
  if (ledgerRaw === undefined) throw new Error('Portable state is missing its generation ledger.');
  const ledger = parseJsonRecord(ledgerRaw, PORTABLE_LEDGER_KEY);
  if (
    ledger.version !== 1 ||
    !Number.isSafeInteger(ledger.activeEpoch) ||
    !Number.isSafeInteger(ledger.restoreEpoch) ||
    ledger.restoreInProgress !== false
  ) {
    throw new Error('Portable state generation ledger is not settled or valid.');
  }
  for (const [key, value] of snapshot.values) {
    if (key === PORTABLE_LEDGER_KEY) continue;
    if (key === LEGACY_MIGRATION_MARKER) {
      if (value !== 'complete') throw new Error('Portable migration marker is invalid.');
      continue;
    }
    const envelope = parseJsonRecord(value, key);
    if (typeof envelope.version !== 'number' || !('state' in envelope)) {
      throw new Error(`Portable state row "${key}" is not a Zustand envelope.`);
    }
    if (key !== 'almamesh-language' && envelope.datasetEpoch !== ledger.activeEpoch) {
      throw new Error(`Portable state row "${key}" is outside the active generation.`);
    }
  }
}

function parseJsonRecord(value: string, key: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to one stable validation error.
  }
  throw new Error(`Portable state row "${key}" is not valid JSON.`);
}

function decode(bytes: Uint8Array, key: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new Error(`Portable state row "${key}" is not valid UTF-8.`, {
      cause: error,
    });
  }
}
