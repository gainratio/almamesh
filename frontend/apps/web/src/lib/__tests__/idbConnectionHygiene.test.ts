/**
 * public/idb-connection-hygiene.js: every IndexedDB connection the page opens
 * closes when another context deletes its database, so "Reset & reload" is not
 * blocked by the page's own idb-keyval connection.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

const SCRIPT = readFileSync(resolve(__dirname, '../../../public/idb-connection-hygiene.js'), 'utf8');

/** Run the classic script against `factory` as the page's indexedDB. */
function install(factory: IDBFactory): void {
  new Function('globalThis', SCRIPT)({ indexedDB: factory });
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('s');
    request.onsuccess = () => done(request.result);
    request.onerror = () => fail(request.error);
  });
}

function deleteOutcome(factory: IDBFactory, name: string): Promise<'deleted' | 'blocked'> {
  return new Promise((done) => {
    const request = factory.deleteDatabase(name);
    request.onblocked = () => done('blocked');
    request.onsuccess = () => done('deleted');
  });
}

describe('idb-connection-hygiene.js', () => {
  it('lets a delete through a connection the page left open', async () => {
    const factory = new IDBFactory();
    install(factory);
    await open(factory, 'keyval-store');
    expect(await deleteOutcome(factory, 'keyval-store')).toBe('deleted');
  });

  it('is what makes the difference: without it the delete is blocked', async () => {
    const factory = new IDBFactory();
    await open(factory, 'keyval-store');
    expect(await deleteOutcome(factory, 'keyval-store')).toBe('blocked');
  });

  it('installs once, however often it runs', () => {
    const factory = new IDBFactory();
    install(factory);
    const patched = factory.open;
    install(factory);
    expect(factory.open).toBe(patched);
  });

  it('is loaded by the page before any module script', () => {
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
    const hygiene = html.indexOf('src="/idb-connection-hygiene.js"');
    expect(hygiene).toBeGreaterThan(-1);
    expect(hygiene).toBeLessThan(html.indexOf('type="module"'));
  });
});
