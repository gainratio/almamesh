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

  // CONTRACT REVERSED (#246 grade). These used to assert that a browser which
  // cannot list databases (Firefox < 126) "may" have the legacy one, so the
  // read opened it and CREATED an empty keyval-store. The existence check now
  // opens and aborts the upgrade: nothing is created, legacy data still reads.
  const withoutListing = () => ({ open: factory.open.bind(factory) });
  const listingRefused = () => ({
    open: factory.open.bind(factory),
    databases: () => Promise.reject(new Error('blocked')),
  });

  for (const [label, limited] of [
    ['cannot list databases', withoutListing],
    ['refuses to list databases', listingRefused],
  ] as const) {
    it(`creates no database on a fresh browser that ${label}`, async () => {
      useIndexedDb(limited());
      expect(await legacyKeyvalDatabaseExists()).toBe(false);
      expect(await readLegacyKeyval('almamesh-profiles')).toBeUndefined();
      await deleteLegacyKeyval('almamesh-profiles');
      expect(await databaseNames()).toEqual([]);
    });

    it(`still reads legacy rows on a browser that ${label}`, async () => {
      await set('almamesh-profiles', '{"state":{}}', createStore('keyval-store', 'keyval'));
      useIndexedDb(limited());
      expect(await legacyKeyvalDatabaseExists()).toBe(true);
      expect(await readLegacyKeyval('almamesh-profiles')).toBe('{"state":{}}');
    });
  }

  it('says no database when there is no IndexedDB at all', async () => {
    useIndexedDb(undefined);
    expect(await legacyKeyvalDatabaseExists()).toBe(false);
  });
});
