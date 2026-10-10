import { describe, expect, it } from 'vitest';

import {
  beginBackupRestore,
  commitDatasetGeneration,
  setPortableStateRepositoryForTests,
} from './deletionTombstones';
import { DEVICE_CODE_KEY, type DeviceRows, deviceRows, getDeviceCode } from './deviceRows';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import {
  PORTABLE_DEVICE_NAMESPACE,
  PORTABLE_STATE_KEYS,
  PortableStateRepository,
} from './portableState';

function memoryRows(): DeviceRows & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    read: async (key) => map.get(key) ?? null,
    write: async (key, value) => {
      map.set(key, value);
    },
    remove: async (keys) => {
      keys.forEach((key) => map.delete(key));
    },
    list: async (prefix) => new Map([...map].filter(([key]) => key.startsWith(prefix))),
  };
}

describe('getDeviceCode', () => {
  it('pins the device-code row key', () => {
    expect(DEVICE_CODE_KEY).toBe('device-code');
  });

  it('mints 6 lowercase hex once and then returns the same code', async () => {
    const rows = memoryRows();
    const first = await getDeviceCode(rows);
    expect(first).toMatch(/^[0-9a-f]{6}$/);
    expect(await getDeviceCode(rows)).toBe(first);
    expect(rows.map.get('device-code')).toBe(first);
  });

  it('replaces a corrupt stored code', async () => {
    const rows = memoryRows();
    rows.map.set('device-code', 'Priya');
    const code = await getDeviceCode(rows);
    expect(code).toMatch(/^[0-9a-f]{6}$/);
    expect(rows.map.get('device-code')).toBe(code);
  });
});

describe('device rows across a restore', () => {
  it('leaves the device code and drive credential byte-identical after a restore from another device', async () => {
    const sqlite = new PortableMemoryStore();
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      await deviceRows.write('device-code', '7f3a2c');
      await deviceRows.write('drive-credential/google-drive', 'CANARY-CREDENTIAL');
      const rowOf = (key: string) => sqlite.values.get(`${PORTABLE_DEVICE_NAMESPACE}/${key}`);
      const before = new Map(
        ['device-code', 'drive-credential/google-drive'].map((key) => [key, structuredClone(rowOf(key))]),
      );

      // The same commit importPortableBrowserState runs: every canonical key
      // replaced by the other device's file (absent keys cleared).
      const otherDevice = new Map([
        ['almamesh-language', JSON.stringify({ state: { language: 'pt' }, version: 1 })],
      ]);
      const epoch = await beginBackupRestore({});
      await commitDatasetGeneration(
        epoch,
        PORTABLE_STATE_KEYS.map((key) => ({ key, value: otherDevice.get(key) ?? null })),
        { memoryRebuildPending: true },
      );

      // The restore really applied: the other device's row is now canonical here.
      expect(await repository.read('almamesh-language')).toContain('"pt"');
      expect(await deviceRows.read('almamesh-language')).toBeNull();
      for (const [key, row] of before) expect(rowOf(key)).toEqual(row);
      expect(await getDeviceCode()).toBe('7f3a2c');
      expect([...(await deviceRows.list('drive-credential/')).values()]).toEqual(['CANARY-CREDENTIAL']);
      await deviceRows.remove(['drive-credential/google-drive']);
      expect(await deviceRows.read('drive-credential/google-drive')).toBeNull();
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });
});
