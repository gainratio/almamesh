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

/** Canonical dataset snapshots which participate in the deletion generation. */
export const PORTABLE_DATASET_KEYS = [
  'almamesh-profiles',
  'almamesh-chart-library',
  'almamesh-life-events',
  'almamesh-rectification-records',
  'almamesh-chat-history',
  'almamesh-interpretations',
  'almamesh-mesh-readings',
  'almamesh-predictive',
] as const;

/** Preferences travel in SQLite, but do not participate in a dataset epoch. */
export const PORTABLE_PREFERENCES_KEY = 'almamesh-preferences';
export const PORTABLE_PREFERENCE_KEYS = [
  'almamesh-language',
  PORTABLE_PREFERENCES_KEY,
] as const;

/**
 * Canonical rows in the portable SQLite file. Derived embedding/vector caches
 * remain deliberately absent; expensive predictive results are durable user
 * data and travel with the chart that produced them. The single preferences
 * row is versioned and extensible, so adding a setting does not create a
 * growing table of ad-hoc rows.
 */
export const PORTABLE_STATE_KEYS = [
  ...PORTABLE_DATASET_KEYS,
  ...PORTABLE_PREFERENCE_KEYS,
] as const;

type PortableStoreEnvelopeKey = Exclude<
  (typeof PORTABLE_STATE_KEYS)[number],
  typeof PORTABLE_PREFERENCES_KEY
>;
type PortableVersionedRowKey =
  | (typeof PORTABLE_STATE_KEYS)[number]
  | typeof PORTABLE_LEDGER_KEY;

/**
 * Highest canonical row version this build can migrate or hydrate. Zustand
 * entries mirror each store's `persist({ version })`; the custom preferences
 * and generation-ledger rows have their own format version. The complete key
 * type makes a newly portable row a compile-time addition.
 */
export const PORTABLE_STORE_MAX_VERSIONS = {
  'almamesh-profiles': 1,
  'almamesh-chart-library': 1,
  'almamesh-life-events': 4,
  'almamesh-rectification-records': 2,
  'almamesh-chat-history': 2,
  'almamesh-interpretations': 6,
  'almamesh-mesh-readings': 1,
  'almamesh-predictive': 3,
  'almamesh-language': 1,
  'almamesh-preferences': 1,
  'almamesh-deletion-tombstones': 1,
} as const satisfies Readonly<Record<PortableVersionedRowKey, number>>;

/** A structurally valid backup whose store schema requires a newer AlmaMesh. */
export class PortableStateTooNewError extends Error {
  public override readonly name = 'PortableStateTooNewError';

  public constructor(
    public readonly key: PortableVersionedRowKey | 'sqlite-schema',
    public readonly version: number,
    public readonly maxVersion: number,
  ) {
    super(
      `Portable state row "${key}" uses store version ${version}; this build supports through ${maxVersion}.`,
    );
  }
}

/** Distinguish a valid future database from malformed or obsolete bytes. */
export function assertSupportedPortableStateSchema(schemaVersion: number): void {
  if (schemaVersion > PORTABLE_STATE_SCHEMA_VERSION) {
    throw new PortableStateTooNewError(
      'sqlite-schema',
      schemaVersion,
      PORTABLE_STATE_SCHEMA_VERSION,
    );
  }
  if (schemaVersion !== PORTABLE_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported portable state schema version ${schemaVersion}.`);
  }
}

/** Preference keys stored inside the single versioned SQLite preference row. */
export const PORTABLE_PREFERENCE_MIRROR_KEYS = [
  'almamesh-llm-settings',
  'almamesh-content-mode',
  'almamesh-model-suggestion-dismissed',
] as const;
export type PortablePreferenceMirrorKey = (typeof PORTABLE_PREFERENCE_MIRROR_KEYS)[number];

export interface PortablePreferences {
  readonly version: 1;
  readonly values: Readonly<Partial<Record<PortablePreferenceMirrorKey, string>>>;
}

const ALLOWED_PORTABLE_KEYS = new Set<string>([
  ...PORTABLE_STATE_KEYS,
  PORTABLE_LEDGER_KEY,
  LEGACY_MIGRATION_MARKER,
]);

export function isPortableStateKey(key: string): boolean {
  return ALLOWED_PORTABLE_KEYS.has(key);
}

export function isPortablePreferenceKey(key: string): boolean {
  return (PORTABLE_PREFERENCE_KEYS as readonly string[]).includes(key);
}

const MAX_TRANSACTION_ATTEMPTS = 8;
const MAX_CANONICAL_ROWS = 1_000;
const MAX_COLLECTION_ENTRIES = 10_000;
const MAX_STRING_CHARACTERS = 1_000_000;
const MAX_JSON_NODES = 200_000;
const MAX_JSON_DEPTH = 64;
const MAX_IDENTIFIER_CHARACTERS = 512;
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
  readonly #validateExport: (bytes: Uint8Array) => Promise<number>;
  #writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    store: SqliteStateStore,
    validateExport: (bytes: Uint8Array) => Promise<number> = validatePortableExportDatabase,
  ) {
    this.#store = store;
    this.#validateExport = validateExport;
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
    // One writer at a time per realm. The SQLite epoch covers the whole file,
    // so two of this tab's writes to different keys conflict with each other;
    // left concurrent, boot hydration lost most CAS attempts to itself and a
    // ninth concurrent writer failed outright. Other tabs still race through
    // the epoch CAS below.
    const turn = this.#writeQueue.then(() => this.#compareAndSwap(transform));
    this.#writeQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async #compareAndSwap<Result>(
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
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const before = await this.#store.runtimeInfo();
      const bytes = await this.#store.exportBytes();
      // This validates the exact byte array that would leave the browser and
      // returns the SQLite epoch embedded in that file.
      const exportedEpoch = await this.#validateExport(bytes);
      const snapshot = await this.snapshot();
      const after = await this.#store.runtimeInfo();
      if (
        before.epoch !== exportedEpoch ||
        before.epoch !== snapshot.epoch ||
        before.epoch !== after.epoch
      ) {
        continue;
      }
      validatePortableSnapshot(snapshot);
      return bytes;
    }
    throw new Error('Portable state remained busy while exporting a consistent snapshot.');
  }

  public async checkIntegrity(): Promise<void> {
    await this.#store.checkIntegrity();
  }

  public dispose(): Promise<void> {
    return this.#store.dispose();
  }
}

/** Validate the exact export in an isolated store without touching live state. */
async function validatePortableExportDatabase(bytes: Uint8Array): Promise<number> {
  const store = await createSqliteStateStore({
    name: 'almamesh-export-validation',
    initialSchemaVersion: PORTABLE_STATE_SCHEMA_VERSION,
    persistence: 'memory',
  });
  let stageId: string | undefined;
  try {
    const stage = await store.stageImport(bytes);
    stageId = stage.stageId;
    if (stage.schemaVersion !== PORTABLE_STATE_SCHEMA_VERSION) {
      throw new Error(`Unsupported portable state schema version ${stage.schemaVersion}.`);
    }
    return stage.epoch;
  } finally {
    try {
      if (stageId !== undefined) await store.discardImport(stageId);
    } finally {
      await store.dispose();
    }
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
    assertSupportedPortableStateSchema(stage.schemaVersion);
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
 * Upgrade an encrypted legacy-v2 `{ database, settings }` payload entirely in
 * memory. The live browser database is untouched: callers receive a new,
 * revalidated SQLite file which can go through the normal atomic import path.
 */
export async function mergeLegacyPreferencesIntoPortableState(
  bytes: Uint8Array,
  candidate: unknown,
  options: {
    /** Unit-test seam; production always uses the EdgeProc in-memory store. */
    readonly createStore?: () => Promise<SqliteStateStore>;
    /** Unit-test seam for fake SQLite bytes; production re-opens exact bytes. */
    readonly validateExport?: (bytes: Uint8Array) => Promise<number>;
  } = {},
): Promise<Uint8Array> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Legacy portable settings are not an object.');
  }
  const legacy: Partial<Record<PortablePreferenceMirrorKey, string>> = {};
  for (const key of PORTABLE_PREFERENCE_MIRROR_KEYS) {
    const value = (candidate as Record<string, unknown>)[key];
    if (value === undefined) continue;
    validatePortablePreferenceMirror(key, value);
    legacy[key] = value;
  }

  const store = await (options.createStore?.() ??
    createSqliteStateStore({
      name: 'almamesh-legacy-preference-upgrade',
      initialSchemaVersion: PORTABLE_STATE_SCHEMA_VERSION,
      persistence: 'memory',
    }));
  const repository = new PortableStateRepository(store, options.validateExport);
  try {
    const stage = await store.stageImport(bytes);
    if (stage.schemaVersion !== PORTABLE_STATE_SCHEMA_VERSION) {
      throw new Error(`Unsupported portable state schema version ${stage.schemaVersion}.`);
    }
    await store.commitImport(stage.stageId, { expectedEpoch: 0 });
    await repository.checkIntegrity();
    validatePortableSnapshot(await repository.snapshot());

    const current = await readPortablePreferences(repository);
    await repository.write(
      PORTABLE_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        // The separate settings section was the authority in legacy v2, so it
        // wins if a transitional database happened to contain the same field.
        values: { ...current.values, ...legacy },
      }),
    );
    return await repository.exportBytes();
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
    const migrationAlreadyComplete = values.has(LEGACY_MIGRATION_MARKER);
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
    if (!migrationAlreadyComplete) {
      mutations.push({
        type: 'put',
        key: LEGACY_MIGRATION_MARKER,
        value: 'complete',
      });
    }
    return {
      mutations,
      result: { imported: !migrationAlreadyComplete || importedKeys.length > 0, importedKeys },
    };
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

/** Read the versioned canonical preference row, tolerating a fresh database. */
export async function readPortablePreferences(
  repository: PortableStateRepository,
): Promise<PortablePreferences> {
  const raw = await repository.read(PORTABLE_PREFERENCES_KEY);
  return raw === null ? { version: 1, values: {} } : decodePortablePreferences(raw);
}

/** Decode one canonical preferences row after enforcing its typed size limits. */
export function decodePortablePreferences(value: string): PortablePreferences {
  return parsePortablePreferences(value);
}

function toSqliteMutation(mutation: PortableStateMutation): SqliteStateMutation {
  assertPortableKey(mutation.key);
  if (mutation.type === 'put' && mutation.key === PORTABLE_PREFERENCES_KEY) {
    parsePortablePreferences(mutation.value);
  }
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
    Number.isSafeInteger(ledger.version) &&
    (ledger.version as number) > PORTABLE_STORE_MAX_VERSIONS[PORTABLE_LEDGER_KEY]
  ) {
    throw new PortableStateTooNewError(
      PORTABLE_LEDGER_KEY,
      ledger.version as number,
      PORTABLE_STORE_MAX_VERSIONS[PORTABLE_LEDGER_KEY],
    );
  }
  if (
    ledger.version !== 1 ||
    !Number.isSafeInteger(ledger.activeEpoch) ||
    !Number.isSafeInteger(ledger.restoreEpoch) ||
    ledger.restoreInProgress !== false
  ) {
    throw new Error('Portable state generation ledger is not settled or valid.');
  }
  const envelopes = new Map<PortableStoreEnvelopeKey, Record<string, unknown>>();
  for (const [key, value] of snapshot.values) {
    if (key === PORTABLE_LEDGER_KEY) continue;
    if (key === LEGACY_MIGRATION_MARKER) {
      if (value !== 'complete') throw new Error('Portable migration marker is invalid.');
      continue;
    }
    if (key === PORTABLE_PREFERENCES_KEY) {
      parsePortablePreferences(value);
      continue;
    }
    const envelope = parseJsonRecord(value, key);
    if (
      !Number.isSafeInteger(envelope.version) ||
      (envelope.version as number) < 0 ||
      !('state' in envelope)
    ) {
      throw new Error(`Portable state row "${key}" is not a Zustand envelope.`);
    }
    const envelopeKey = key as PortableStoreEnvelopeKey;
    const maxVersion = PORTABLE_STORE_MAX_VERSIONS[envelopeKey];
    if ((envelope.version as number) > maxVersion) {
      throw new PortableStateTooNewError(envelopeKey, envelope.version as number, maxVersion);
    }
    validateBoundedJson(envelope.state, envelopeKey);
    if (!isPlainRecord(envelope.state)) {
      throw new Error(`Portable state row "${envelopeKey}" has a non-object state.`);
    }
    if (
      !isPortablePreferenceKey(key) &&
      (envelope.datasetEpoch ?? 0) !== ledger.activeEpoch
    ) {
      throw new Error(`Portable state row "${key}" is outside the active generation.`);
    }
    envelopes.set(envelopeKey, envelope);
  }
  validateCanonicalDataset(envelopes);
}

/** Bound hostile JSON before store migrations or React ever see it. */
function validateBoundedJson(value: unknown, row: string): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new Error(`Portable state row "${row}" exceeds ${MAX_JSON_NODES} JSON nodes.`);
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new Error(`Portable state row "${row}" exceeds JSON depth ${MAX_JSON_DEPTH}.`);
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_STRING_CHARACTERS) {
        throw new Error(
          `Portable state row "${row}" string exceeds ${MAX_STRING_CHARACTERS} characters.`,
        );
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_COLLECTION_ENTRIES) {
        throw new Error(
          `Portable state row "${row}" contains an array with more than ${MAX_COLLECTION_ENTRIES} entries.`,
        );
      }
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isPlainRecord(current.value)) continue;
    const entries = Object.entries(current.value);
    if (entries.length > MAX_COLLECTION_ENTRIES) {
      throw new Error(
        `Portable state row "${row}" contains an object with more than ${MAX_COLLECTION_ENTRIES} entries.`,
      );
    }
    for (const [key, child] of entries) {
      if (key.length > MAX_IDENTIFIER_CHARACTERS) {
        throw new Error(`Portable state row "${row}" contains an oversized object key.`);
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function requireStateMap(
  envelopes: ReadonlyMap<PortableStoreEnvelopeKey, Record<string, unknown>>,
  row: PortableStoreEnvelopeKey,
  field: string,
): Record<string, unknown> | undefined {
  const envelope = envelopes.get(row);
  if (envelope === undefined) return undefined;
  const state = envelope.state as Record<string, unknown>;
  const value = state[field];
  if (!isPlainRecord(value)) {
    throw new Error(`Portable state row "${row}" has invalid ${field}.`);
  }
  return value;
}

function assertIdentifier(value: string, row: string): void {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_CHARACTERS) {
    throw new Error(`Portable state row "${row}" contains an invalid identifier.`);
  }
}

function assertMapEntriesAreRecords(map: Record<string, unknown>, row: string, noun: string): void {
  for (const [id, entry] of Object.entries(map)) {
    assertIdentifier(id, row);
    if (!isPlainRecord(entry)) {
      throw new Error(`Portable state row "${row}" ${noun} "${id}" is not an object.`);
    }
  }
}

function assertKnownReference(
  candidate: unknown,
  known: ReadonlySet<string> | undefined,
  row: string,
  noun: string,
): void {
  if (candidate === undefined) return;
  if (typeof candidate !== 'string') {
    throw new Error(`Portable state row "${row}" has a non-string ${noun} reference.`);
  }
  assertIdentifier(candidate, row);
  if (known !== undefined && !known.has(candidate)) {
    throw new Error(`Portable state row "${row}" references missing ${noun} "${candidate}".`);
  }
}

/** Validate the small cross-row domain graph without importing application stores. */
function validateCanonicalDataset(
  envelopes: ReadonlyMap<PortableStoreEnvelopeKey, Record<string, unknown>>,
): void {
  const profiles = requireStateMap(envelopes, 'almamesh-profiles', 'profiles');
  const profileIds = profiles === undefined ? undefined : new Set(Object.keys(profiles));
  if (profiles !== undefined) {
    assertMapEntriesAreRecords(profiles, 'almamesh-profiles', 'profile');
    for (const [profileId, value] of Object.entries(profiles)) {
      const profile = value as Record<string, unknown>;
      if (profile.id !== profileId) {
        throw new Error(`Portable state row "almamesh-profiles" profile "${profileId}" has a mismatched id.`);
      }
      assertKnownReference(profile.relatedTo, profileIds, 'almamesh-profiles', 'profile');
    }
    const state = envelopes.get('almamesh-profiles')!.state as Record<string, unknown>;
    const active = state.activeProfileId;
    if (active !== null && active !== undefined) {
      assertKnownReference(active, profileIds, 'almamesh-profiles', 'profile');
    }
  }

  const charts = requireStateMap(envelopes, 'almamesh-chart-library', 'charts');
  const chartIds = charts === undefined ? undefined : new Set(Object.keys(charts));
  if (charts !== undefined) {
    assertMapEntriesAreRecords(charts, 'almamesh-chart-library', 'chart');
    for (const [chartId, value] of Object.entries(charts)) {
      const chart = value as Record<string, unknown>;
      if (chart.chart_id !== chartId) {
        throw new Error(`Portable state row "almamesh-chart-library" chart "${chartId}" has a mismatched id.`);
      }
      assertKnownReference(chart.profile_id, profileIds, 'almamesh-chart-library', 'profile');
    }
  }

  for (const [row, field] of [
    ['almamesh-life-events', 'eventsByProfile'],
    ['almamesh-rectification-records', 'recordsByProfile'],
  ] as const) {
    const byProfile = requireStateMap(envelopes, row, field);
    if (byProfile === undefined) continue;
    for (const [profileId, value] of Object.entries(byProfile)) {
      assertKnownReference(profileId, profileIds, row, 'profile');
      if (row === 'almamesh-life-events' && !Array.isArray(value)) {
        throw new Error(`Portable state row "${row}" events for "${profileId}" are not an array.`);
      }
      if (row === 'almamesh-life-events' && Array.isArray(value)) {
        const version = envelopes.get(row)!.version as number;
        if (version >= 2) {
          for (const event of value) {
            if (!isPlainRecord(event) || typeof event.id !== 'string') {
              throw new Error(`Portable state row "${row}" has an invalid life event.`);
            }
            assertIdentifier(event.id, row);
          }
        }
      }
      if (row === 'almamesh-rectification-records' && !isPlainRecord(value)) {
        throw new Error(`Portable state row "${row}" record for "${profileId}" is not an object.`);
      }
      if (
        row === 'almamesh-rectification-records' &&
        isPlainRecord(value) &&
        value.profileId !== undefined &&
        value.profileId !== profileId
      ) {
        throw new Error(`Portable state row "${row}" has a mismatched profile id.`);
      }
    }
  }

  const threads = requireStateMap(envelopes, 'almamesh-chat-history', 'threads');
  const threadIds = threads === undefined ? undefined : new Set(Object.keys(threads));
  if (threads !== undefined) {
    assertMapEntriesAreRecords(threads, 'almamesh-chat-history', 'thread');
    for (const [threadId, value] of Object.entries(threads)) {
      const thread = value as Record<string, unknown>;
      if (thread.id !== threadId) {
        throw new Error(`Portable state row "almamesh-chat-history" thread "${threadId}" has a mismatched id.`);
      }
      assertKnownReference(thread.profile_id, profileIds, 'almamesh-chat-history', 'profile');
      assertKnownReference(thread.chart_id, chartIds, 'almamesh-chat-history', 'chart');
    }
    const chat = envelopes.get('almamesh-chat-history')!.state as Record<string, unknown>;
    const chatVersion = envelopes.get('almamesh-chat-history')!.version as number;
    for (const field of ['messages', 'summaries'] as const) {
      const map = chat[field];
      if (field === 'summaries' && map === undefined && chatVersion < 2) continue;
      if (!isPlainRecord(map)) {
        throw new Error(`Portable state row "almamesh-chat-history" has invalid ${field}.`);
      }
      for (const [threadId, value] of Object.entries(map)) {
        if (!threadIds!.has(threadId)) {
          throw new Error(`Portable state row "almamesh-chat-history" ${field} reference missing thread "${threadId}".`);
        }
        if (field === 'messages' ? !Array.isArray(value) : !isPlainRecord(value)) {
          throw new Error(`Portable state row "almamesh-chat-history" has invalid ${field} for "${threadId}".`);
        }
        if (field === 'messages' && Array.isArray(value)) {
          for (const message of value) {
            if (
              !isPlainRecord(message) ||
              typeof message.id !== 'string' ||
              message.thread_id !== threadId
            ) {
              throw new Error('Portable state row "almamesh-chat-history" has an invalid message.');
            }
            assertIdentifier(message.id, 'almamesh-chat-history');
          }
        }
        if (field === 'summaries' && isPlainRecord(value)) {
          if (value.thread_id !== threadId) {
            throw new Error('Portable state row "almamesh-chat-history" has a mismatched summary thread.');
          }
          const owner = (threads[threadId] as Record<string, unknown>).profile_id;
          if (value.profile_id !== owner) {
            throw new Error('Portable state row "almamesh-chat-history" has a mismatched summary owner.');
          }
        }
      }
    }
  }

  const interpretations = requireStateMap(envelopes, 'almamesh-interpretations', 'byChart');
  if (interpretations !== undefined) {
    assertMapEntriesAreRecords(interpretations, 'almamesh-interpretations', 'interpretation');
    for (const [chartId, value] of Object.entries(interpretations)) {
      assertKnownReference(chartId, chartIds, 'almamesh-interpretations', 'chart');
      assertKnownReference(
        (value as Record<string, unknown>).profileId,
        profileIds,
        'almamesh-interpretations',
        'profile',
      );
    }
  }

  const readings = requireStateMap(envelopes, 'almamesh-mesh-readings', 'byPair');
  if (readings !== undefined) {
    assertMapEntriesAreRecords(readings, 'almamesh-mesh-readings', 'reading');
    for (const [pairKey, value] of Object.entries(readings)) {
      const reading = value as Record<string, unknown>;
      if (reading.pairKey !== pairKey) {
        throw new Error('Portable state row "almamesh-mesh-readings" has a mismatched pair key.');
      }
      const owners = reading.profileIds;
      if (!Array.isArray(owners) || owners.length !== 2) {
        throw new Error('Portable state row "almamesh-mesh-readings" has invalid profileIds.');
      }
      for (const owner of owners) {
        assertKnownReference(owner, profileIds, 'almamesh-mesh-readings', 'profile');
      }
    }
  }

  const predictive = envelopes.get('almamesh-predictive')?.state as
    | Record<string, unknown>
    | undefined;
  if (predictive !== undefined) {
    if (predictive.status !== 'idle' && predictive.status !== 'ready') {
      throw new Error('Portable state row "almamesh-predictive" has invalid status.');
    }
    if (predictive.status === 'ready' && typeof predictive.requestKey !== 'string') {
      throw new Error('Portable state row "almamesh-predictive" has an invalid request key.');
    }
    const profileKey = predictive.profileKey;
    if (profileKey !== undefined) {
      if (typeof profileKey !== 'string') {
        throw new Error('Portable state row "almamesh-predictive" has a non-string identity reference.');
      }
      assertIdentifier(profileKey, 'almamesh-predictive');
      if (
        profileIds !== undefined &&
        chartIds !== undefined &&
        !profileIds.has(profileKey) &&
        !chartIds.has(profileKey)
      ) {
        throw new Error(
          `Portable state row "almamesh-predictive" references missing profile or chart "${profileKey}".`,
        );
      }
    }
  }

  const language = envelopes.get('almamesh-language')?.state as
    | Record<string, unknown>
    | undefined;
  if (
    language !== undefined &&
    language.language !== 'en' &&
    language.language !== 'es' &&
    language.language !== 'pt'
  ) {
    throw new Error('Portable state row "almamesh-language" has an invalid language.');
  }
}

function parsePortablePreferences(value: string): PortablePreferences {
  if (value.length > 65_536) {
    throw new Error('Portable preferences row exceeds 64 KiB.');
  }
  const row = parseJsonRecord(value, PORTABLE_PREFERENCES_KEY);
  if (
    Number.isSafeInteger(row.version) &&
    (row.version as number) > PORTABLE_STORE_MAX_VERSIONS[PORTABLE_PREFERENCES_KEY]
  ) {
    throw new PortableStateTooNewError(
      PORTABLE_PREFERENCES_KEY,
      row.version as number,
      PORTABLE_STORE_MAX_VERSIONS[PORTABLE_PREFERENCES_KEY],
    );
  }
  if (row.version !== 1 || !isPlainRecord(row.values)) {
    throw new Error('Portable preferences row has an unsupported shape or version.');
  }
  const values: Partial<Record<PortablePreferenceMirrorKey, string>> = {};
  for (const [key, raw] of Object.entries(row.values)) {
    if (!(PORTABLE_PREFERENCE_MIRROR_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Portable preferences contain unknown key "${key}".`);
    }
    validatePortablePreferenceMirror(key as PortablePreferenceMirrorKey, raw);
    values[key as PortablePreferenceMirrorKey] = raw as string;
  }
  return { version: 1, values };
}

function validatePortablePreferenceMirror(
  key: PortablePreferenceMirrorKey,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Portable preference "${key}" is not a string.`);
  }
  if (key === 'almamesh-model-suggestion-dismissed') {
    if (value.length === 0 || value.length > 512) {
      throw new Error('Portable model-suggestion preference is invalid.');
    }
    return;
  }
  if (value.length > 16_384) {
    throw new Error(`Portable preference "${key}" exceeds 16 KiB.`);
  }
  const parsed = parseJsonRecord(value, key);
  if (key === 'almamesh-content-mode') {
    if (
      Object.keys(parsed).length !== 1 ||
      (parsed.contentMode !== 'layman' && parsed.contentMode !== 'technical')
    ) {
      throw new Error('Portable content mode is invalid.');
    }
    return;
  }
  const allowed = new Set([
    'apiBase',
    'apiKey',
    'model',
    'interpretationModel',
    'chatModel',
    'privacyMode',
    'engine',
  ]);
  const maximumLength: Readonly<Record<string, number>> = {
    apiBase: 2_048,
    apiKey: 8_192,
    model: 512,
    interpretationModel: 512,
    chatModel: 512,
    privacyMode: 128,
    engine: 128,
  };
  for (const [setting, settingValue] of Object.entries(parsed)) {
    if (
      !allowed.has(setting) ||
      typeof settingValue !== 'string' ||
      settingValue.length > maximumLength[setting]!
    ) {
      throw new Error(`Portable LLM setting "${setting}" is invalid.`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
