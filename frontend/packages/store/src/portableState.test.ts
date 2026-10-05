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
  PORTABLE_QUARANTINE_NAMESPACE,
  PORTABLE_STORE_MAX_VERSIONS,
  PORTABLE_STATE_NAMESPACE,
  PORTABLE_STATE_UNAVAILABLE_MESSAGE,
  PortableStateRepository,
  PortableStateTooNewError,
  PortableStateUnavailableError,
  resolvePortableStateMode,
  supportsPortableState,
  assertSupportedPortableStateSchema,
  repairPortableReferences,
  EMPTY_PORTABLE_REPAIR_REPORT,
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

/** Stands in for the canonical-only rebuild: the fake file is one byte, its epoch. */
function rebuildAtEpoch(sqlite: { epoch: number }): () => Promise<Uint8Array> {
  return async () => new Uint8Array([sqlite.epoch]);
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
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));

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
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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

  it('rebuilds every export from the canonical rows at the validated epoch, never the raw file', async () => {
    const sqlite = new MemorySqliteStore();
    const rebuilt: string[][] = [];
    const repository = new PortableStateRepository(
      sqlite,
      async (bytes) => bytes[0] ?? -1,
      async (canonical) => {
        rebuilt.push([...canonical.keys()].sort());
        return new Uint8Array([99]);
      },
    );
    await migrateLegacyState(repository, { get: async () => null, delete: async () => undefined }, []);

    const exported = await repository.exportBytes();

    // A fresh file written from live canonical rows: no free-page residue of a
    // deleted row, and nothing outside the canonical namespace.
    expect(rebuilt).toEqual([[...(await repository.snapshot()).values.keys()].sort()]);
    expect(Array.from(exported)).toEqual([99]);
  });

  it('never exports a quarantine row, even when another tab empties the quarantine mid-export', async () => {
    const sqlite = new MemorySqliteStore();
    const handed: unknown[] = [];
    const repository = new PortableStateRepository(
      sqlite,
      async (bytes) => bytes[0] ?? -1,
      async (canonical: unknown) => {
        handed.push(canonical);
        return new Uint8Array([99]);
      },
    );
    await migrateLegacyState(repository, { get: async () => null, delete: async () => undefined }, []);
    const quarantineKey = `owner/${'a'.repeat(64)}`;
    await repository.applyQuarantine([
      { type: 'put', namespace: PORTABLE_QUARANTINE_NAMESPACE, key: quarantineKey, value: 'held reading' },
    ]);
    // The raw file is serialized while the quarantine row is still in it. The
    // other tab's clear lands after the export's epoch check (quarantine writes
    // are not fenced by the dataset epoch), so the row is gone by the time
    // anything re-reads the quarantine.
    sqlite.exportHook = async () => {
      const raw = new Uint8Array([sqlite.epoch]);
      const read = sqlite.runtimeInfo.bind(sqlite);
      let calls = 0;
      sqlite.runtimeInfo = async () => {
        const info = await read();
        calls += 1;
        if (calls === 2) sqlite.values.delete(`${PORTABLE_QUARANTINE_NAMESPACE}/${quarantineKey}`);
        return info;
      };
      return raw;
    };

    const exported = await repository.exportBytes();

    // The raw SQLite file (which held the quarantine row) never leaves: the
    // export is rebuilt from canonical rows only.
    expect(handed).toHaveLength(1);
    expect(handed[0]).toBeInstanceOf(Map);
    expect([...(handed[0] as Map<string, string>).keys()].some((key) => key.includes(quarantineKey))).toBe(false);
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
    // A relationship reading with a missing owner used to be refused here; it
    // is now repaired (dropped and reported), see repairPortableReferences.
  ] as const)(
    'rejects hostile canonical state with %s',
    async (_label, key, state, expected) => {
      const sqlite = new MemorySqliteStore();
      const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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
          Array.from({ length: 250_001 }, (_, index) => [
            `p${index}`,
            { id: `p${index}` },
          ]),
        ),
        activeProfileId: null,
      },
      /more than 250000 entries/,
    ],
    [
      'array entries',
      { eventsByProfile: { p1: Array.from({ length: 250_001 }, () => ({})) } },
      /more than 250000 entries/,
    ],
    [
      'string length',
      {
        profiles: { p1: { id: 'p1', name: 'x'.repeat(1_000_001) } },
        activeProfileId: 'p1',
      },
      /string exceeds 1000000 characters/,
    ],
    [
      'JSON node count',
      // 20 arrays of 200,000 numbers: under the entry limit, over 4,000,000 nodes.
      { eventsByProfile: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, Array.from({ length: 200_000 }, () => 0)])) },
      /exceeds 4000000 JSON nodes/,
    ],
  ] as const)('rejects canonical rows beyond the %s limit', async (_label, state, expected) => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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
      const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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
    const repository = new PortableStateRepository(sqlite, async (bytes) => bytes[0]!, rebuildAtEpoch(sqlite));
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
        {
          createStore: async () => sqlite,
          validateExport: async (bytes) => bytes[0]!,
          rebuildExport: rebuildAtEpoch(sqlite),
        },
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

/**
 * Production 2026-10-05: one chat thread kept `chart_id` of a chart that a
 * birth-detail edit had regenerated away, and Export refused the whole dataset
 * with `references missing chart "1e251b81"`. A dangling link from a chat
 * thread to a chart is a stale pointer, not corruption: the conversation still
 * belongs to its person. It must never block exporting everything else.
 */
describe('a chat thread whose chart no longer exists', () => {
  const ORPHAN_CHART = '1e251b81';
  const SATURN_QUESTION = 'When does my Saturn return start?';

  function envelope(state: unknown, key: keyof typeof PORTABLE_STORE_MAX_VERSIONS): string {
    return JSON.stringify({ state, version: PORTABLE_STORE_MAX_VERSIONS[key], datasetEpoch: 0 });
  }

  async function seedOrphanedThread(
    extra: ReadonlyArray<readonly [keyof typeof PORTABLE_STORE_MAX_VERSIONS, unknown]> = [],
  ) {
    const sqlite = new MemorySqliteStore();
    const handed: Array<ReadonlyMap<string, string>> = [];
    const repository = new PortableStateRepository(
      sqlite,
      async (bytes) => bytes[0] ?? -1,
      async (canonical) => {
        handed.push(canonical);
        return new Uint8Array([sqlite.epoch]);
      },
    );
    await migrateLegacyState(repository, { get: async () => null, delete: async () => undefined }, []);
    await repository.write(
      'almamesh-profiles',
      envelope({ profiles: { p1: { id: 'p1' } }, activeProfileId: 'p1' }, 'almamesh-profiles'),
    );
    await repository.write(
      'almamesh-chart-library',
      envelope({ charts: { c2: { chart_id: 'c2', profile_id: 'p1' } } }, 'almamesh-chart-library'),
    );
    await repository.write(
      'almamesh-chat-history',
      envelope(
        {
          threads: {
            t1: { id: 't1', profile_id: 'p1', chart_id: ORPHAN_CHART, title: 'Saturn' },
            t2: { id: 't2', profile_id: 'p1', chart_id: 'c2', title: 'Career' },
          },
          messages: {
            t1: [{ id: 'm1', thread_id: 't1', role: 'user', content: SATURN_QUESTION }],
            t2: [],
          },
          summaries: {},
        },
        'almamesh-chat-history',
      ),
    );
    for (const [key, state] of extra) await repository.write(key, envelope(state, key));
    return { repository, handed };
  }

  function chatState(values: ReadonlyMap<string, string>) {
    return (JSON.parse(values.get('almamesh-chat-history')!) as {
      state: {
        threads: Record<string, { chart_id?: string }>;
        messages: Record<string, Array<{ content: string }>>;
      };
    }).state;
  }

  it('exports every row, keeping the thread and its messages but not the dangling chart link', async () => {
    const { repository, handed } = await seedOrphanedThread();
    const live = (await repository.snapshot()).values;

    await expect(repository.exportBytes()).resolves.toBeInstanceOf(Uint8Array);

    expect(handed).toHaveLength(1);
    const exported = handed[0]!;
    expect([...exported.keys()].sort()).toEqual([...live.keys()].sort());
    const chat = chatState(exported);
    expect(chat.threads.t1).toEqual({ id: 't1', profile_id: 'p1', title: 'Saturn' });
    expect(chat.threads.t2!.chart_id).toBe('c2');
    expect(chat.messages.t1![0]!.content).toBe(SATURN_QUESTION);
    for (const [key, value] of live) {
      if (key !== 'almamesh-chat-history') expect(exported.get(key)).toBe(value);
    }
  });

  it('reports which chat threads lost their chart link so the UI can say so', async () => {
    const { repository } = await seedOrphanedThread();

    const report = await repository.exportWithReport();

    expect(report.repairs.unlinkedChatThreadIds).toEqual(['t1']);
    expect(report.bytes).toBeInstanceOf(Uint8Array);
  });

  it('leaves a healthy dataset byte-identical and reports nothing', async () => {
    const { repository, handed } = await seedOrphanedThread();
    await repository.write(
      'almamesh-chart-library',
      envelope(
        {
          charts: {
            c2: { chart_id: 'c2', profile_id: 'p1' },
            [ORPHAN_CHART]: { chart_id: ORPHAN_CHART, profile_id: 'p1' },
          },
        },
        'almamesh-chart-library',
      ),
    );
    const live = (await repository.snapshot()).values;

    const report = await repository.exportWithReport();

    expect(report.repairs).toEqual(EMPTY_PORTABLE_REPAIR_REPORT);
    expect(handed[0]).toEqual(live);
  });

  it('accepts the same orphaned row on import, repaired the same way', () => {
    const values = new Map([
      [
        'almamesh-chart-library',
        envelope({ charts: { c2: { chart_id: 'c2' } } }, 'almamesh-chart-library'),
      ],
      [
        'almamesh-chat-history',
        envelope(
          {
            threads: { t1: { id: 't1', chart_id: ORPHAN_CHART } },
            messages: { t1: [{ id: 'm1', thread_id: 't1', content: SATURN_QUESTION }] },
            summaries: {},
          },
          'almamesh-chat-history',
        ),
      ],
    ]);

    const repaired = repairPortableReferences(values);

    expect(repaired.repairs.unlinkedChatThreadIds).toEqual(['t1']);
    expect(chatState(repaired.values).threads.t1).toEqual({ id: 't1' });
    expect(chatState(repaired.values).messages.t1![0]!.content).toBe(SATURN_QUESTION);
  });

  it.each([
    [
      'a chat thread owned by a person who does not exist',
      [
        [
          'almamesh-chat-history',
          { threads: { t9: { id: 't9', profile_id: 'nobody' } }, messages: { t9: [] }, summaries: {} },
        ],
      ] as const,
      /references missing profile "nobody"/,
    ],
  ])('still refuses real corruption: %s', async (_label, extra, expected) => {
    const { repository } = await seedOrphanedThread(extra);

    await expect(repository.exportBytes()).rejects.toThrow(expected);
  });
});

/**
 * The same bug class as the chat link, found by the 2026-10-05 export audit:
 * normal use leaves a row pointing at a person or chart that is gone, and the
 * validator then refused the whole export (and so Import's safety backup).
 */
describe('repairPortableReferences: every dangling reference normal use can leave', () => {
  type Key = keyof typeof PORTABLE_STORE_MAX_VERSIONS;

  function envelope(state: unknown, key: Key): string {
    return JSON.stringify({ state, version: PORTABLE_STORE_MAX_VERSIONS[key], datasetEpoch: 0 });
  }

  async function seed(rows: ReadonlyArray<readonly [Key, unknown]>) {
    const sqlite = new MemorySqliteStore();
    const handed: Array<ReadonlyMap<string, string>> = [];
    const repository = new PortableStateRepository(
      sqlite,
      async (bytes) => bytes[0] ?? -1,
      async (canonical) => {
        handed.push(canonical);
        return new Uint8Array([sqlite.epoch]);
      },
    );
    await migrateLegacyState(repository, { get: async () => null, delete: async () => undefined }, []);
    await repository.write(
      'almamesh-profiles',
      envelope({ profiles: { p1: { id: 'p1' } }, activeProfileId: 'p1' }, 'almamesh-profiles'),
    );
    await repository.write(
      'almamesh-chart-library',
      envelope({ charts: { c2: { chart_id: 'c2', profile_id: 'p1' } } }, 'almamesh-chart-library'),
    );
    for (const [key, state] of rows) await repository.write(key, envelope(state, key));
    return { repository, handed };
  }

  const stateOf = (values: ReadonlyMap<string, string>, key: string) =>
    (JSON.parse(values.get(key)!) as { state: Record<string, unknown> }).state;

  it('probe 1: leaves out the AI reading of a chart a rename regenerated away, and says so', async () => {
    const { repository, handed } = await seed([
      [
        'almamesh-interpretations',
        {
          byChart: {
            c1: { profileId: 'p1', status: 'complete', sections: {} },
            c2: { profileId: 'p1', status: 'complete', sections: {} },
          },
        },
      ],
    ]);

    const report = await repository.exportWithReport();

    expect(report.repairs.droppedReadingChartIds).toEqual(['c1']);
    expect(Object.keys(stateOf(handed[0]!, 'almamesh-interpretations').byChart as object)).toEqual(['c2']);
  });

  it('probe 2: exports a thread with more than 10,000 messages', async () => {
    const messages = Array.from({ length: 10_001 }, (_, i) => ({ id: `m${i}`, thread_id: 't1', role: 'user', content: 'x' }));
    const { repository } = await seed([
      ['almamesh-chat-history', { threads: { t1: { id: 't1', profile_id: 'p1', title: 'a' } }, messages: { t1: messages }, summaries: {} }],
    ]);

    await expect(repository.exportBytes()).resolves.toBeInstanceOf(Uint8Array);
  });

  it('probe 3: exports a long chat history (about 40,000 short messages)', async () => {
    const threads: Record<string, unknown> = {};
    const messages: Record<string, unknown> = {};
    for (let t = 0; t < 5; t += 1) {
      threads[`t${t}`] = { id: `t${t}`, profile_id: 'p1', title: 'a' };
      messages[`t${t}`] = Array.from({ length: 8_000 }, (_, i) => ({ id: `m${t}-${i}`, thread_id: `t${t}`, role: 'user', content: 'x' }));
    }
    const { repository } = await seed([['almamesh-chat-history', { threads, messages, summaries: {} }]]);

    await expect(repository.exportBytes()).resolves.toBeInstanceOf(Uint8Array);
  });

  it('probe 4: leaves out life events of a person who no longer exists, keeping everyone else', async () => {
    const { repository, handed } = await seed([
      ['almamesh-life-events', { eventsByProfile: { gone: [], p1: [] } }],
    ]);

    const report = await repository.exportWithReport();

    expect(report.repairs.droppedPersonRecords).toEqual(['almamesh-life-events/gone']);
    expect(stateOf(handed[0]!, 'almamesh-life-events').eventsByProfile).toEqual({ p1: [] });
  });

  it('repairs every other dangling person or chart reference in one pass', async () => {
    const { repository, handed } = await seed([
      [
        'almamesh-profiles',
        { profiles: { p1: { id: 'p1', relatedTo: 'gone' }, p2: { id: 'p2', relatedTo: 'p1' } }, activeProfileId: 'gone' },
      ],
      ['almamesh-rectification-records', { recordsByProfile: { gone: { profileId: 'gone' }, p1: { profileId: 'p1' } } }],
      [
        'almamesh-mesh-readings',
        {
          byPair: {
            'gone|p1': { pairKey: 'gone|p1', profileIds: ['gone', 'p1'] },
            'p1|p2': { pairKey: 'p1|p2', profileIds: ['p1', 'p2'] },
          },
        },
      ],
      ['almamesh-interpretations', { byChart: { c2: { profileId: 'gone' } } }],
      ['almamesh-predictive', { status: 'ready', profileKey: 'gone', requestKey: 'r1' }],
    ]);

    const { repairs } = await repository.exportWithReport();

    expect(repairs).toEqual({
      unlinkedChatThreadIds: [],
      droppedReadingChartIds: ['c2'],
      droppedPersonRecords: ['almamesh-rectification-records/gone', 'almamesh-mesh-readings/gone|p1'],
      clearedProfileLinks: ['p1', 'activeProfileId'],
      resetPredictive: true,
    });
    const exported = handed[0]!;
    expect(stateOf(exported, 'almamesh-profiles')).toEqual({
      profiles: { p1: { id: 'p1' }, p2: { id: 'p2', relatedTo: 'p1' } },
      activeProfileId: null,
    });
    expect(Object.keys(stateOf(exported, 'almamesh-mesh-readings').byPair as object)).toEqual(['p1|p2']);
    expect(stateOf(exported, 'almamesh-predictive')).toEqual({ status: 'idle' });
  });

  it('accepts the same rows on import (the snapshot read from a file is repaired, then validated)', () => {
    const values = new Map([
      ['almamesh-profiles', envelope({ profiles: { p1: { id: 'p1' } }, activeProfileId: 'p1' }, 'almamesh-profiles')],
      ['almamesh-chart-library', envelope({ charts: { c2: { chart_id: 'c2', profile_id: 'p1' } } }, 'almamesh-chart-library')],
      ['almamesh-interpretations', envelope({ byChart: { c1: { profileId: 'p1' } } }, 'almamesh-interpretations')],
    ]);

    const { values: repaired, repairs } = repairPortableReferences(values);

    expect(repairs.droppedReadingChartIds).toEqual(['c1']);
    expect(stateOf(repaired, 'almamesh-interpretations')).toEqual({ byChart: {} });
  });

  it.each([
    [
      'a chart owned by a person who does not exist',
      [['almamesh-chart-library', { charts: { c9: { chart_id: 'c9', profile_id: 'nobody' } } }]] as const,
      /references missing profile "nobody"/,
    ],
    [
      'a chart whose key and id disagree',
      [['almamesh-chart-library', { charts: { c9: { chart_id: 'c8' } } }]] as const,
      /chart "c9" has a mismatched id/,
    ],
    [
      'a relationship reading whose owners are not a pair',
      [['almamesh-mesh-readings', { byPair: { x: { pairKey: 'x', profileIds: ['gone'] } } }]] as const,
      /invalid profileIds/,
    ],
  ])('still refuses real corruption: %s', async (_label, rows, expected) => {
    const { repository } = await seed(rows);

    await expect(repository.exportBytes()).rejects.toThrow(expected);
  });
});

