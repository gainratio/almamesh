import { describe, expect, it } from 'vitest';
import {
  SqliteStateConflictError,
  type SqliteStateImportStage,
  type SqliteStateMutation,
  type SqliteStateStore,
} from '@gainratio/browser/sqlite';

import {
  LEGACY_MIGRATION_MARKER,
  migrateLegacyState,
  PORTABLE_STATE_NAMESPACE,
  PORTABLE_STATE_UNAVAILABLE_MESSAGE,
  PortableStateRepository,
  PortableStateUnavailableError,
  resolvePortableStateMode,
  supportsPortableState,
} from './portableState';

class MemorySqliteStore implements SqliteStateStore {
  readonly name = 'test';
  readonly values = new Map<string, { value: Uint8Array; revision: number }>();
  epoch = 0;
  conflictOnce = false;
  integrityChecks = 0;

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
    return new Uint8Array([1]);
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

  it('refuses credentials and derived caches at the portable-state boundary', async () => {
    const repository = new PortableStateRepository(new MemorySqliteStore());

    await expect(repository.write('almamesh-llm-settings', 'secret')).rejects.toThrow(
      /not canonical AlmaMesh data/,
    );
    await expect(repository.write('almamesh-chat-vectors', 'derived')).rejects.toThrow(
      /not canonical AlmaMesh data/,
    );
    await expect(repository.write('almamesh-predictive', 'derived')).rejects.toThrow(
      /not canonical AlmaMesh data/,
    );
  });

  it('migrates legacy rows once, verifies SQLite, then removes the redundant IDB copy', async () => {
    const sqlite = new MemorySqliteStore();
    const repository = new PortableStateRepository(sqlite);
    const source = new Map<string, string>([
      ['almamesh-profiles', '{"state":{},"version":1}'],
      ['almamesh-chat-history', '{"state":{},"version":2}'],
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
      migrateLegacyState(repository, legacy, ['almamesh-profiles', 'almamesh-chat-history']),
    ).resolves.toEqual({
      imported: true,
      importedKeys: ['almamesh-profiles', 'almamesh-chat-history'],
    });
    expect(await repository.read(LEGACY_MIGRATION_MARKER)).toBe('complete');
    expect(sqlite.integrityChecks).toBe(1);
    expect(deleted).toEqual(['almamesh-profiles', 'almamesh-chat-history']);

    deleted.length = 0;
    await expect(
      migrateLegacyState(repository, legacy, ['almamesh-profiles', 'almamesh-chat-history']),
    ).resolves.toEqual({ imported: false, importedKeys: [] });
    expect(deleted).toEqual(['almamesh-profiles', 'almamesh-chat-history']);
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
    const repository = new PortableStateRepository(new MemorySqliteStore());

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
});
