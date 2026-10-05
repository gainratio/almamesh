import { describe, expect, it } from 'vitest';
import {
  SqliteStateConflictError,
  type SqliteStateImportStage,
  type SqliteStateMutation,
  type SqliteStateStore,
} from '@gainratio/browser/sqlite';

import {
  LEGACY_MIGRATION_MARKER,
  decodePortablePreferences,
  mergeLegacyPreferencesIntoPortableState,
  migrateLegacyState,
  PORTABLE_DATASET_KEYS,
  PORTABLE_PREFERENCES_KEY,
  PORTABLE_STORE_MAX_VERSIONS,
  PORTABLE_STATE_NAMESPACE,
  PORTABLE_STATE_UNAVAILABLE_MESSAGE,
  PortableStateRepository,
  PortableStateTooNewError,
  PortableStateUnavailableError,
  resolvePortableStateMode,
  supportsPortableState,
  assertSupportedPortableStateSchema,
} from './portableState';

class MemorySqliteStore implements SqliteStateStore {
  readonly name = 'test';
  readonly values = new Map<string, { value: Uint8Array; revision: number }>();
  epoch = 0;
  conflictOnce = false;
  staleConflicts = 0;
  integrityChecks = 0;
  exportCalls = 0;
  exportHook: (() => Promise<Uint8Array>) | undefined;

  async get(namespace: string, key: string) {
    const row = this.values.get(`${namespace}/${key}`);
    return row === undefined ? undefined : { namespace, key, ...row };
  }

  async list(options: { namespace: string }) {
    const prefix = `${options.namespace}/`;
    return {
      rows: [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({
          namespace: options.namespace,
          key: key.slice(prefix.length),
          ...row,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    };
  }

  async batch(mutations: readonly SqliteStateMutation[], options = {}) {
    if (this.conflictOnce) {
      this.conflictOnce = false;
      this.epoch += 1;
      throw new SqliteStateConflictError('simulated competing tab');
    }
    if (options.expectedEpoch !== undefined && options.expectedEpoch !== this.epoch) {
      this.staleConflicts += 1;
      throw new SqliteStateConflictError('stale');
    }
    this.epoch += 1;
    for (const mutation of mutations) {
      const key = `${mutation.namespace}/${mutation.key}`;
      if (mutation.type === 'delete') this.values.delete(key);
      else
        this.values.set(key, {
          value: mutation.value.slice(),
          revision: this.epoch,
        });
    }
    return { changed: mutations.length, epoch: this.epoch };
  }

  put(namespace: string, key: string, value: Uint8Array, options = {}) {
    return this.batch([{ type: 'put', namespace, key, value }], options);
  }

  delete(namespace: string, key: string, options = {}) {
    return this.batch([{ type: 'delete', namespace, key }], options);
  }

  async runtimeInfo() {
    return {
      name: this.name,
      sqliteVersion: '3.53.4',
      persistence: 'memory' as const,
      ownership: 'isolated-worker' as const,
      schemaVersion: 1,
      epoch: this.epoch,
      rowCount: this.values.size,
    };
  }

  async checkIntegrity() {
    this.integrityChecks += 1;
    return { ok: true as const, message: 'ok' as const };
  }

  async exportBytes() {
    this.exportCalls += 1;
    return this.exportHook === undefined ? new Uint8Array([this.epoch]) : this.exportHook();
  }
  async stageImport(): Promise<SqliteStateImportStage> {
    return {
      stageId: 'stage',
      schemaVersion: 1,
      epoch: 0,
      rowCount: 0,
      byteLength: 1,
    };
  }
  async discardImport() {}
  async commitImport() {
    return { changed: 0, epoch: this.epoch, schemaVersion: 1 };
  }
  async reset() {
    this.values.clear();
    this.epoch += 1;
    return { changed: 0, epoch: this.epoch };
  }
  async migrate() {
    return { changed: 0, epoch: this.epoch, schemaVersion: 1 };
  }
  async dispose() {}
}

describe('PortableStateRepository', () => {
  it('classifies a future physical SQLite schema as too new', () => {
    expect(() => assertSupportedPortableStateSchema(2)).toThrowError(
      expect.objectContaining({
        name: 'PortableStateTooNewError',
        key: 'sqlite-schema',
        version: 2,
        maxVersion: 1,
      }),
    );
  });

  it('requires every SQLite opfs-wl browser capability explicitly', () => {
    const capable = {
      crossOriginIsolated: true,
      Worker: class {},
      SharedArrayBuffer: class {},
      Atomics: { waitAsync: () => undefined },
      navigator: { storage: { getDirectory: () => undefined } },
    };

    expect(supportsPortableState(capable)).toBe(true);
    expect(resolvePortableStateMode(capable, false)).toBe('portable');
    expect(supportsPortableState({ ...capable, crossOriginIsolated: false })).toBe(false);
    expect(supportsPortableState({ ...capable, Worker: undefined })).toBe(false);
    expect(supportsPortableState({ ...capable, SharedArrayBuffer: undefined })).toBe(false);
    expect(supportsPortableState({ ...capable, Atomics: {} })).toBe(false);
    expect(supportsPortableState({ ...capable, navigator: { storage: {} } })).toBe(false);
  });

  it('uses a stable typed error for unsupported production browsers', () => {
    expect(new PortableStateUnavailableError()).toMatchObject({
      name: 'PortableStateUnavailableError',
      message: PORTABLE_STATE_UNAVAILABLE_MESSAGE,
    });
    expect(() => resolvePortableStateMode({}, false)).toThrow(PortableStateUnavailableError);
    expect(resolvePortableStateMode({}, true)).toBe('node-test-fallback');
  });

  it('stores the existing JSON envelope as UTF-8 and reads one consistent snapshot', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite);
    const value = JSON.stringify({
      state: { profiles: { p1: { id: 'p1' } } },
      version: 1,
    });

    await repository.write('almamesh-profiles', value);

    expect(await repository.read('almamesh-profiles')).toBe(value);
    const snapshot = await repository.snapshot();
    expect(snapshot.values.get('almamesh-profiles')).toBe(value);
    expect(sqlite.values.has(`${PORTABLE_STATE_NAMESPACE}/almamesh-profiles`)).toBe(true);
  });

  it('retries a stale multi-tab compare-and-swap without a partial commit', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite);
    sqlite.conflictOnce = true;

    await repository.transact(() => [
      { type: 'put', key: 'almamesh-profiles', value: '1' },
      { type: 'put', key: 'almamesh-chat-history', value: '2' },
    ]);

    expect(await repository.read('almamesh-profiles')).toBe('1');
    expect(await repository.read('almamesh-chat-history')).toBe('2');
    expect(sqlite.epoch).toBe(2);
  });

  it('serializes this realm\'s own concurrent writes instead of racing its own epoch', async () => {
    // Boot hydrates every persisted store at once. Each write used to read the
    // same epoch and race the others to SQLite, so all but one lost the CAS
    // (Firefox logs each loss as SqliteStateConflictError) and, past
    // MAX_TRANSACTION_ATTEMPTS writers, a write failed outright.
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite);

    await Promise.all(
      PORTABLE_DATASET_KEYS.flatMap((key) => [
        repository.write(key, `${key}-a`),
        repository.write(key, `${key}-b`),
      ]),
    );

    expect(sqlite.staleConflicts).toBe(0);
    expect(sqlite.epoch).toBe(PORTABLE_DATASET_KEYS.length * 2);
    for (const key of PORTABLE_DATASET_KEYS) {
      expect(await repository.read(key)).toBe(`${key}-b`);
    }
  });

  it('stores predictive results and settings while refusing only derived vector caches', async () => {
    const repository = new PortableStateRepository(new MemorySqliteStore());

    const llmSettings = JSON.stringify({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-synthetic',
      interpretationModel: 'example/model',
      privacyMode: 'cloud_premium',
    });
    const contentMode = JSON.stringify({ contentMode: 'technical' });
    const preferences = JSON.stringify({
      version: 1,
      values: {
        'almamesh-llm-settings': llmSettings,
        'almamesh-content-mode': contentMode,
      },
    });

    await expect(repository.write(PORTABLE_PREFERENCES_KEY, preferences)).resolves.toBe(1);
    await expect(repository.read(PORTABLE_PREFERENCES_KEY)).resolves.toBe(preferences);
    await expect(repository.write('almamesh-chat-vectors', 'derived')).rejects.toThrow(
      /not canonical AlmaMesh data/,
    );
    const predictive = JSON.stringify({
      state: { status: 'ready', profileKey: 'profile-1', requestKey: 'request-1' },
      version: 3,
      datasetEpoch: 0,
    });
    await expect(repository.write('almamesh-predictive', predictive)).resolves.toBe(2);
    await expect(repository.read('almamesh-predictive')).resolves.toBe(predictive);
    expect(PORTABLE_DATASET_KEYS).toContain('almamesh-predictive');
  });

  it('rejects oversized or unknown portable setting fields at the SQLite boundary', async () => {
    const repository = new PortableStateRepository(new MemorySqliteStore());

    await expect(
      repository.write(
        PORTABLE_PREFERENCES_KEY,
        JSON.stringify({
          version: 1,
          values: { 'almamesh-llm-settings': JSON.stringify({ apiKey: 'x'.repeat(8_193) }) },
        }),
      ),
    ).rejects.toThrow(/invalid/);
    await expect(
      repository.write(
        PORTABLE_PREFERENCES_KEY,
        JSON.stringify({
          version: 1,
          values: { 'almamesh-llm-settings': JSON.stringify({ surprise: 'value' }) },
        }),
      ),
    ).rejects.toThrow(/unknown|invalid/);
  });

  it('migrates legacy rows once, verifies SQLite, then removes the redundant IDB copy', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite);
    const source = new Map<string, string>([
      ['almamesh-profiles', '{"state":{},"version":1}'],
      ['almamesh-chat-history', '{"state":{},"version":2}'],
      [
        'almamesh-predictive',
        '{"state":{"status":"ready","profileKey":"profile-1"},"version":3}',
      ],
    ]);
    const deleted: string[] = [];
    const legacy = {
      get: async (key: string) => source.get(key) ?? null,
      delete: async (key: string) => {
        deleted.push(key);
        source.delete(key);
      },
    };

    await expect(
      migrateLegacyState(repository, legacy, [
        'almamesh-profiles',
        'almamesh-chat-history',
        'almamesh-predictive',
      ]),
    ).resolves.toEqual({
      imported: true,
      importedKeys: ['almamesh-profiles', 'almamesh-chat-history', 'almamesh-predictive'],
    });
    expect(await repository.read(LEGACY_MIGRATION_MARKER)).toBe('complete');
    expect(sqlite.integrityChecks).toBe(1);
    expect(deleted).toEqual([
      'almamesh-profiles',
      'almamesh-chat-history',
      'almamesh-predictive',
    ]);
    expect(await repository.read('almamesh-predictive')).toContain('profile-1');

    deleted.length = 0;
    await expect(
      migrateLegacyState(repository, legacy, [
        'almamesh-profiles',
        'almamesh-chat-history',
        'almamesh-predictive',
      ]),
    ).resolves.toEqual({ imported: false, importedKeys: [] });
    expect(deleted).toEqual([
      'almamesh-profiles',
      'almamesh-chat-history',
      'almamesh-predictive',
    ]);
  });

  it('reports only the migration CAS attempt that wins after a competing write', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite);
    sqlite.conflictOnce = true;
    const deleted: string[] = [];

    await expect(
      migrateLegacyState(
        repository,
        {
          get: async () => JSON.stringify({ state: { language: 'es' }, version: 1 }),
          delete: async (key) => {
            deleted.push(key);
          },
        },
        ['almamesh-language'],
      ),
    ).resolves.toEqual({ imported: true, importedKeys: ['almamesh-language'] });
    expect(deleted).toEqual(['almamesh-language']);
  });

  it('initializes a settled ledger for a fresh browser so its SQLite file is exportable', async () => {
    const repository = new PortableStateRepository(
      new MemorySqliteStore(),
      async (bytes) => bytes[0]!,
    );

    await expect(
      migrateLegacyState(repository, { get: async () => null, delete: async () => undefined }, []),
    ).resolves.toEqual({ imported: true, importedKeys: [] });
    await expect(repository.exportBytes()).resolves.toEqual(new Uint8Array([1]));
    expect(
      JSON.parse((await repository.read('almamesh-deletion-tombstones')) as string),
    ).toMatchObject({
      activeEpoch: 0,
      restoreEpoch: 0,
      restoreInProgress: false,
    });
  });

  it('retries when another runtime changes the live epoch during export', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
    await migrateLegacyState(
      repository,
      { get: async () => null, delete: async () => undefined },
      [],
    );
    let firstExport = true;
    sqlite.exportHook = async () => {
      if (!firstExport) return new Uint8Array([sqlite.epoch]);
      firstExport = false;
      const ledgerKey = `${PORTABLE_STATE_NAMESPACE}/almamesh-deletion-tombstones`;
      const current = JSON.parse(
        new TextDecoder().decode(sqlite.values.get(ledgerKey)!.value),
      ) as Record<string, unknown>;
      await sqlite.put(
        PORTABLE_STATE_NAMESPACE,
        'almamesh-deletion-tombstones',
        new TextEncoder().encode(JSON.stringify({ ...current, restoreInProgress: true })),
      );
      const invalidExportEpoch = sqlite.epoch;
      await sqlite.put(
        PORTABLE_STATE_NAMESPACE,
        'almamesh-deletion-tombstones',
        new TextEncoder().encode(JSON.stringify({ ...current, restoreInProgress: false })),
      );
      return new Uint8Array([invalidExportEpoch]);
    };

    await expect(repository.exportBytes()).resolves.toEqual(new Uint8Array([3]));
    expect(sqlite.exportCalls).toBe(2);
  });

  it('returns a compacted copy of the validated file, so deleted rows cannot ride along in free pages', async () => {
    const sqlite = new MemorySqliteStore();
    const compacted: number[][] = [];
    const repository = new PortableStateRepository(
      sqlite,
      async (bytes) => bytes[0] ?? -1,
      async (bytes) => {
        compacted.push(Array.from(bytes));
        return new Uint8Array([99]);
      },
    );
    await migrateLegacyState(repository, { get: async () => null, delete: async () => undefined }, []);

    const exported = await repository.exportBytes();

    // MemorySqliteStore exports one byte: its epoch. The compactor saw exactly
    // that validated file, and its output is what leaves the browser.
    expect(compacted).toEqual([[sqlite.epoch]]);
    expect(Array.from(exported)).toEqual([99]);
  });

  it('validates the exact serialized bytes before returning an export', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async () => {
      throw new Error('serialized SQLite is not importable');
    });
    await migrateLegacyState(
      repository,
      { get: async () => null, delete: async () => undefined },
      [],
    );

    await expect(repository.exportBytes()).rejects.toThrow('serialized SQLite is not importable');
  });

  it.each([
    [
      'null profile records',
      'almamesh-profiles',
      { profiles: { p1: null }, activeProfileId: 'p1' },
      /profile "p1" is not an object/,
    ],
    [
      'dangling chart owners',
      'almamesh-chart-library',
      { charts: { c1: { chart_id: 'c1', profile_id: 'missing' } } },
      /references missing profile "missing"/,
    ],
    [
      'messages for a missing chat thread',
      'almamesh-chat-history',
      { threads: {}, messages: { missing: [] }, summaries: {} },
      /messages reference missing thread "missing"/,
    ],
    [
      'relationship readings with a missing owner',
      'almamesh-mesh-readings',
      {
        byPair: {
          'p1|missing': { pairKey: 'p1|missing', profileIds: ['p1', 'missing'] },
        },
      },
      /references missing profile "missing"/,
    ],
  ] as const)(
    'rejects hostile canonical state with %s',
    async (_label, key, state, expected) => {
      const sqlite = new MemorySqliteStore();
      const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
      await migrateLegacyState(
        repository,
        { get: async () => null, delete: async () => undefined },
        [],
      );
      await repository.write(
        'almamesh-profiles',
        JSON.stringify({
          state: { profiles: { p1: { id: 'p1' } }, activeProfileId: 'p1' },
          version: 1,
          datasetEpoch: 0,
        }),
      );
      await repository.write(
        key,
        JSON.stringify({ state, version: PORTABLE_STORE_MAX_VERSIONS[key], datasetEpoch: 0 }),
      );

      await expect(repository.exportBytes()).rejects.toThrow(expected);
    },
  );

  it.each([
    [
      'object entries',
      {
        profiles: Object.fromEntries(
          Array.from({ length: 10_001 }, (_, index) => [
            `p${index}`,
            { id: `p${index}` },
          ]),
        ),
        activeProfileId: null,
      },
      /more than 10000 entries/,
    ],
    [
      'array entries',
      { eventsByProfile: { p1: Array.from({ length: 10_001 }, () => ({})) } },
      /more than 10000 entries/,
    ],
    [
      'string length',
      {
        profiles: { p1: { id: 'p1', name: 'x'.repeat(1_000_001) } },
        activeProfileId: 'p1',
      },
      /string exceeds 1000000 characters/,
    ],
  ] as const)('rejects canonical rows beyond the %s limit', async (_label, state, expected) => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
    await migrateLegacyState(
      repository,
      { get: async () => null, delete: async () => undefined },
      [],
    );
    const key = 'eventsByProfile' in state ? 'almamesh-life-events' : 'almamesh-profiles';
    await repository.write(
      key,
      JSON.stringify({ state, version: PORTABLE_STORE_MAX_VERSIONS[key], datasetEpoch: 0 }),
    );

    await expect(repository.exportBytes()).rejects.toThrow(expected);
  });

  it('accepts a predictive result keyed by a known chart fallback', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
    await migrateLegacyState(
      repository,
      { get: async () => null, delete: async () => undefined },
      [],
    );
    await repository.write(
      'almamesh-profiles',
      JSON.stringify({
        state: { profiles: { p1: { id: 'p1' } }, activeProfileId: 'p1' },
        version: 1,
        datasetEpoch: 0,
      }),
    );
    await repository.write(
      'almamesh-chart-library',
      JSON.stringify({
        state: { charts: { c1: { chart_id: 'c1', profile_id: 'p1' } } },
        version: 1,
        datasetEpoch: 0,
      }),
    );
    await repository.write(
      'almamesh-predictive',
      JSON.stringify({
        state: { status: 'ready', profileKey: 'c1', requestKey: 'request-1' },
        version: 3,
        datasetEpoch: 0,
      }),
    );

    await expect(repository.exportBytes()).resolves.toEqual(new Uint8Array([4]));
  });

  it('accepts a legacy chat envelope from before summaries were persisted', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
    await migrateLegacyState(
      repository,
      { get: async () => null, delete: async () => undefined },
      [],
    );
    await repository.write(
      'almamesh-chat-history',
      JSON.stringify({
        state: {
          threads: { t1: { id: 't1' } },
          messages: { t1: [] },
        },
        version: 1,
        datasetEpoch: 0,
      }),
    );

    await expect(repository.exportBytes()).resolves.toEqual(new Uint8Array([2]));
  });

  it('fails clearly after bounded retries when the live epoch never settles', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
    await migrateLegacyState(
      repository,
      { get: async () => null, delete: async () => undefined },
      [],
    );
    sqlite.exportHook = async () => {
      const exportedEpoch = sqlite.epoch;
      await sqlite.put(
        PORTABLE_STATE_NAMESPACE,
        'almamesh-deletion-tombstones',
        sqlite.values.get(
          `${PORTABLE_STATE_NAMESPACE}/almamesh-deletion-tombstones`,
        )!.value,
      );
      return new Uint8Array([exportedEpoch]);
    };

    await expect(repository.exportBytes()).rejects.toThrow(
      'Portable state remained busy while exporting a consistent snapshot.',
    );
    expect(sqlite.exportCalls).toBe(8);
  });

  it.each(
    Object.entries(PORTABLE_STORE_MAX_VERSIONS).filter(
      ([key]) => key !== PORTABLE_PREFERENCES_KEY && key !== 'almamesh-deletion-tombstones',
    ),
  )(
    'rejects a future %s Zustand envelope with a typed compatibility error',
    async (key, maxVersion) => {
      const sqlite = new MemorySqliteStore();
      const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
      await migrateLegacyState(
        repository,
        { get: async () => null, delete: async () => undefined },
        [],
      );
      await repository.write(
        key,
        JSON.stringify({ state: {}, version: maxVersion + 1, datasetEpoch: 0 }),
      );

      await expect(repository.exportBytes()).rejects.toMatchObject({
        name: 'PortableStateTooNewError',
        key,
        version: maxVersion + 1,
        maxVersion,
      } satisfies Partial<PortableStateTooNewError>);
    },
  );

  it.each([
    [
      PORTABLE_PREFERENCES_KEY,
      JSON.stringify({ version: 2, values: {} }),
    ],
    [
      'almamesh-deletion-tombstones',
      JSON.stringify({
        version: 2,
        activeEpoch: 0,
        restoreEpoch: 0,
        restoreInProgress: false,
      }),
    ],
  ] as const)('rejects a future %s row through the typed compatibility path', async (key, value) => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!);
    await migrateLegacyState(
      repository,
      { get: async () => null, delete: async () => undefined },
      [],
    );
    await sqlite.put(PORTABLE_STATE_NAMESPACE, key, new TextEncoder().encode(value));

    await expect(repository.exportBytes()).rejects.toMatchObject({
      name: 'PortableStateTooNewError',
      key,
      version: 2,
      maxVersion: 1,
    } satisfies Partial<PortableStateTooNewError>);
  });

  it('upgrades legacy encrypted settings into staged SQLite bytes without touching live state', async () => {
    const sqlite = new MemorySqliteStore();
    const staged = new PortableStateRepository(sqlite);
    await migrateLegacyState(
      staged,
      { get: async () => null, delete: async () => undefined },
      [],
    );
    const live = new PortableStateRepository(new MemorySqliteStore());

    await expect(
      mergeLegacyPreferencesIntoPortableState(
        new Uint8Array([1]),
        {
        'almamesh-llm-settings': JSON.stringify({
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-legacy-synthetic',
        }),
        evil: 'drop-me',
        },
        { createStore: async () => sqlite, validateExport: async (bytes) => bytes[0]! },
      ),
    ).resolves.toEqual(new Uint8Array([2]));

    expect(await live.read(PORTABLE_PREFERENCES_KEY)).toBeNull();
    expect(
      decodePortablePreferences((await staged.read(PORTABLE_PREFERENCES_KEY))!).values[
        'almamesh-llm-settings'
      ],
    ).toContain('sk-legacy-synthetic');
  });
});
