import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_KEY_DB, deleteDeviceKey, getDeviceKey, readDeviceKeyRecords } from './deviceKey';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deviceKey (Owner ruling R0)', () => {
  it('does not create almamesh-device-keys when merely probing records on a fresh browser', async () => {
    expect(await readDeviceKeyRecords()).toEqual([]);
    expect(await indexedDB.databases()).toEqual([]);
  });

  it('mints exactly one non-extractable AES-GCM CryptoKey and reuses it across concurrent calls', async () => {
    const [first, second] = await Promise.all([getDeviceKey(), getDeviceKey()]);
    expect(first).toBe(second);
    expect(first.type).toBe('secret');
    expect(first.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', first)).rejects.toThrow();

    const records = await readDeviceKeyRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.key).toBe('credential-key');
    expect((records[0]?.value as CryptoKey).extractable).toBe(false);
  });

  it('deletes the almamesh-device-keys database cleanly without blocking', async () => {
    await getDeviceKey();
    expect((await indexedDB.databases()).map((db) => db.name)).toEqual([DEVICE_KEY_DB]);

    await deleteDeviceKey();
    expect(await indexedDB.databases()).toEqual([]);
    expect(await readDeviceKeyRecords()).toEqual([]);
  });
});
