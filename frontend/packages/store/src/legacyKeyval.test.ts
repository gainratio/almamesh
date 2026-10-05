import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, set } from 'idb-keyval';

import { deleteLegacyKeyval, legacyKeyvalDatabaseExists, readLegacyKeyval } from './legacyKeyval';

const original = globalThis.indexedDB;
let factory: IDBFactory;

function useIndexedDb(value: unknown): void {
  Object.defineProperty(globalThis, 'indexedDB', { value, configurable: true });
}

async function databaseNames(): Promise<string[]> {
  return (await factory.databases()).flatMap((database) => (database.name ? [database.name] : []));
}

beforeEach(() => {
  factory = new IDBFactory();
  useIndexedDb(factory);
});

afterEach(() => useIndexedDb(original));

describe('legacy idb-keyval reader', () => {
  it('reads and deletes nothing, and creates no database, on a browser that never had one', async () => {
    expect(await legacyKeyvalDatabaseExists()).toBe(false);
    expect(await readLegacyKeyval('almamesh-profiles')).toBeUndefined();
    await deleteLegacyKeyval('almamesh-profiles');
    expect(await databaseNames()).toEqual([]);
  });

  it('still migrates rows an older build left behind', async () => {
    await set('almamesh-profiles', '{"state":{}}', createStore('keyval-store', 'keyval'));
    expect(await legacyKeyvalDatabaseExists()).toBe(true);
    expect(await readLegacyKeyval('almamesh-profiles')).toBe('{"state":{}}');
    await deleteLegacyKeyval('almamesh-profiles');
    expect(await readLegacyKeyval('almamesh-profiles')).toBeUndefined();
  });

  it('assumes the database may exist when the browser cannot list databases', async () => {
    useIndexedDb({ open: factory.open.bind(factory) });
    expect(await legacyKeyvalDatabaseExists()).toBe(true);
  });

  it('assumes the database may exist when listing databases fails', async () => {
    useIndexedDb({ databases: () => Promise.reject(new Error('blocked')) });
    expect(await legacyKeyvalDatabaseExists()).toBe(true);
  });

  it('says no database when there is no IndexedDB at all', async () => {
    useIndexedDb(undefined);
    expect(await legacyKeyvalDatabaseExists()).toBe(false);
  });
});
