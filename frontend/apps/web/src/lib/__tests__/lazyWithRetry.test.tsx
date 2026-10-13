import { describe, it, expect, vi, afterEach } from 'vitest';

import { LEAVING_WINDOW_MS } from '../documentLeaving';
import { loadWithRetry } from '../lazyWithRetry';

const FakeModule = { default: () => null };

function stubBrowser(flags: Record<string, string> = {}) {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  // Automatic chunk recovery must never touch OPFS (bundle cache + rollback floor).
  const getDirectory = vi.fn();
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  const store = new Map<string, string>(Object.entries(flags));
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  });
  return { reload, getDirectory };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const chunkError = () => new Error('Failed to fetch dynamically imported module: /assets/X-abc.js');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.dispatchEvent(new Event('pageshow'));
});

describe('loadWithRetry', () => {
  it('resolves the module on first success (no retry)', async () => {
    stubBrowser();
    const factory = vi.fn().mockResolvedValue(FakeModule);
    await expect(loadWithRetry(factory, 'Dashboard')).resolves.toBe(FakeModule);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries once after a transient failure, then resolves (no reload)', async () => {
    const { reload } = stubBrowser();
    const factory = vi.fn().mockRejectedValueOnce(chunkError()).mockResolvedValue(FakeModule);
    await expect(loadWithRetry(factory, 'Dashboard')).resolves.toBe(FakeModule);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once (held, unsettled) when a chunk error survives the retry', async () => {
    const { reload, getDirectory } = stubBrowser();
    const factory = vi.fn().mockRejectedValue(chunkError());
    let settled = false;
    void loadWithRetry(factory, 'Dashboard').then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); // Suspense holds through the reload
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('does NOT reload a second time for the same chunk (loop guard) — it rethrows', async () => {
    const { reload } = stubBrowser({ 'almamesh:chunk-reload:Dashboard': '1' });
    const err = chunkError();
    const factory = vi.fn().mockRejectedValue(err);
    await expect(loadWithRetry(factory, 'Dashboard')).rejects.toBe(err);
    expect(reload).not.toHaveBeenCalled();
  });

  it('rethrows a non-chunk error without reloading', async () => {
    const { reload } = stubBrowser();
    const err = new Error('boom in module top-level');
    const factory = vi.fn().mockRejectedValue(err);
    await expect(loadWithRetry(factory, 'Dashboard')).rejects.toBe(err);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  // WebKit cancels the outgoing page's chunk loads when a navigation starts and
  // keeps its scripts running until the new page commits; a reload then would
  // replace the visitor's navigation (Safari: /onboarding landed back on `/`).
  it('does not reload for a chunk cancelled by a navigation away; holds, then surfaces it if the page stays', async () => {
    vi.useFakeTimers();
    const { reload } = stubBrowser();
    window.dispatchEvent(new Event('beforeunload'));
    const err = new TypeError('Importing a module script failed.');
    const factory = vi.fn().mockRejectedValue(err);
    let outcome: unknown = 'pending';
    void loadWithRetry(factory, 'Landing').then(
      () => { outcome = 'resolved'; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(LEAVING_WINDOW_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('almamesh:chunk-reload:Landing')).toBeNull();
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe(err);
    expect(reload).not.toHaveBeenCalled();
  });
});
