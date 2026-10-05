/**
 * "Allow storage" asks the browser for persistent storage. Firefox shows a real
 * prompt; other browsers answer silently. A missing or throwing API must never
 * stop the recheck that follows.
 */
import { describe, expect, it, vi } from 'vitest';
import { requestPersistentStorage } from './storagePermission';

describe('requestPersistentStorage', () => {
  it('asks the browser to persist storage and reports its answer', async () => {
    const persist = vi.fn(async () => true);
    await expect(requestPersistentStorage({ persist })).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('reports false when the browser has no StorageManager', async () => {
    await expect(requestPersistentStorage(undefined)).resolves.toBe(false);
  });

  it('reports false when persist() is missing', async () => {
    await expect(requestPersistentStorage({})).resolves.toBe(false);
  });

  it('reports false instead of throwing when persist() rejects', async () => {
    const persist = vi.fn(async () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    await expect(requestPersistentStorage({ persist })).resolves.toBe(false);
  });

  it('defaults to navigator.storage', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { ...navigator, storage: { persist } });
    try {
      await expect(requestPersistentStorage()).resolves.toBe(true);
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
