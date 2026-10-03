import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserLocalStorage, siteStorageBlocked } from './webStorage';

/** Safari with "Block all cookies": the getter itself throws. */
function blockLocalStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

function provideLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return storage;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.resetModules();
});

describe('browserLocalStorage', () => {
  it('returns the browser Storage when the origin may use it', () => {
    const storage = provideLocalStorage();
    expect(browserLocalStorage()).toBe(storage);
  });

  it('returns undefined instead of throwing when the browser blocks storage', () => {
    blockLocalStorage();
    expect(() => browserLocalStorage()).not.toThrow();
    expect(browserLocalStorage()).toBeUndefined();
  });

  it('returns undefined in a runtime without Web Storage', () => {
    expect(browserLocalStorage()).toBeUndefined();
  });

  it('returns undefined for a partial Storage shell without the methods', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
    expect(browserLocalStorage()).toBeUndefined();
  });
});

describe('siteStorageBlocked', () => {
  it('is true only when touching Web Storage throws', () => {
    blockLocalStorage();
    expect(siteStorageBlocked()).toBe(true);
  });

  it('is false when storage is available', () => {
    provideLocalStorage();
    expect(siteStorageBlocked()).toBe(false);
  });

  it('is false in a runtime that simply has no Web Storage (Node, prerender)', () => {
    expect(siteStorageBlocked()).toBe(false);
  });
});

describe('store modules under blocked storage', () => {
  it('evaluates deletionTombstones without throwing (the Safari blank-page bug)', async () => {
    blockLocalStorage();
    await expect(import('./deletionTombstones')).resolves.toBeDefined();
  });
});
