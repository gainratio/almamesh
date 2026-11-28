import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportPortableBrowserState,
  PortableStateRepository,
  seedPortableLedger,
  setPortableStateRepositoryForTests,
} from '@almamesh/store';
import {
  CREDENTIAL_ROW_PREFIX,
  createCredentialStore,
  deleteDriveDeviceRows,
} from './credentialStore';
import { deleteDeviceKey, getDeviceKey, readDeviceKeyRecords } from './deviceKey';
import { createMemoryDeviceRows } from './testing/memoryCredentials';

const CANARY_TOKEN = 'ya29.CANARY_SECRET_DRIVE_TOKEN_987654';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  setPortableStateRepositoryForTests(undefined);
  vi.unstubAllGlobals();
});

describe('credentialStore', () => {
  it('encrypts tokens at rest so the canary appears nowhere in plaintext storage', async () => {
    const rows = createMemoryDeviceRows();
    const store = createCredentialStore(rows, getDeviceKey);
    await store.write('google-drive', { accessToken: CANARY_TOKEN, expiresAt: 1_900_000_000_000 });

    const serializedRows = JSON.stringify([...rows.map.entries()]);
    expect(serializedRows).not.toContain(CANARY_TOKEN);
    expect(JSON.stringify(localStorage)).not.toContain(CANARY_TOKEN);
    expect(JSON.stringify(sessionStorage)).not.toContain(CANARY_TOKEN);
    const idbRecords = await readDeviceKeyRecords();
    expect(JSON.stringify(idbRecords)).not.toContain(CANARY_TOKEN);

    expect(await store.read('google-drive')).toEqual({
      accessToken: CANARY_TOKEN,
      expiresAt: 1_900_000_000_000,
    });
  });

  it('binds ciphertext to the provider key via AAD and self-cleans tampered or key-lost rows', async () => {
    const rows = createMemoryDeviceRows();
    const store = createCredentialStore(rows, getDeviceKey);
    await store.write('google-drive', { accessToken: CANARY_TOKEN, expiresAt: 1_900_000_000_000 });

    const googleCiphertext = rows.map.get(`${CREDENTIAL_ROW_PREFIX}google-drive`)!;
    rows.map.set(`${CREDENTIAL_ROW_PREFIX}dropbox`, googleCiphertext);
    expect(await store.read('dropbox')).toBeNull();
    expect(rows.map.has(`${CREDENTIAL_ROW_PREFIX}dropbox`)).toBe(false);

    await deleteDeviceKey();
    expect(await store.read('google-drive')).toBeNull();
    expect(rows.map.has(`${CREDENTIAL_ROW_PREFIX}google-drive`)).toBe(false);
  });

  it('deletes all drive-* device rows while preserving device-code', async () => {
    const rows = createMemoryDeviceRows();
    rows.map.set('device-code', '7f3a2c');
    rows.map.set('drive-credential/google-drive', 'cipher');
    rows.map.set('drive-last-backup/google-drive', '2026-10-10T00:00:00.000Z');

    await deleteDriveDeviceRows(rows);

    expect([...rows.map.keys()]).toEqual(['device-code']);
  });

  it('never exports drive credentials in portable SQLite backups', async () => {
    const values = new Map<string, { value: Uint8Array; revision: number }>();
    let epoch = 1;
    const fakeSqlite = {
      name: 'test',
      get: async (ns: string, key: string) => {
        const found = values.get(`${ns}/${key}`);
        return found ? { namespace: ns, key, ...found } : undefined;
      },
      list: async ({ namespace }: { namespace: string }) => ({
        rows: [...values.entries()]
          .filter(([k]) => k.startsWith(`${namespace}/`))
          .map(([k, v]) => ({ namespace, key: k.slice(namespace.length + 1), ...v })),
      }),
      batch: async (mutations: readonly { type: string; namespace: string; key: string; value?: Uint8Array }[]) => {
        epoch += 1;
        for (const m of mutations) {
          if (m.type === 'delete') values.delete(`${m.namespace}/${m.key}`);
          else if (m.value) values.set(`${m.namespace}/${m.key}`, { value: m.value, revision: epoch });
        }
        return { changed: mutations.length, epoch };
      },
      put: async (namespace: string, key: string, value: Uint8Array) => {
        epoch += 1;
        values.set(`${namespace}/${key}`, { value, revision: epoch });
        return { changed: 1, epoch };
      },
      delete: async () => ({ changed: 0, epoch }),
      runtimeInfo: async () => ({
        name: 'test',
        sqliteVersion: '3.53.4',
        persistence: 'opfs' as const,
        ownership: 'isolated-worker' as const,
        schemaVersion: 1,
        epoch,
        rowCount: values.size,
      }),
      checkIntegrity: async () => ({ ok: true as const, message: 'ok' as const }),
      exportBytes: async () => new TextEncoder().encode(JSON.stringify([...values.keys()])),
      stageImport: async () => ({ stageId: 's', schemaVersion: 1, epoch, rowCount: 0, byteLength: 1 }),
      discardImport: async () => undefined,
      commitImport: async () => ({ changed: 0, epoch, schemaVersion: 1 }),
      reset: async () => ({ changed: 0, epoch }),
      migrate: async () => ({ changed: 0, epoch, schemaVersion: 1 }),
      dispose: async () => undefined,
    };
    const repo = new PortableStateRepository(
      fakeSqlite,
      async () => epoch,
      async (canonical) => new TextEncoder().encode(JSON.stringify([...canonical.entries()])),
    );
    setPortableStateRepositoryForTests(repo);
    await seedPortableLedger(repo);
    await repo.writeDevice('drive-credential/google-drive', CANARY_TOKEN);

    const exported = await exportPortableBrowserState();
    const text = new TextDecoder().decode(exported.bytes);
    expect(text).not.toContain(CANARY_TOKEN);
    expect(text).not.toContain('drive-credential/');
  });
});
