import { describe, it, expect, vi, afterEach } from 'vitest';

// Automatic recovery must never discard the signed-bundle cache: it holds the
// anti-rollback floor, and only an explicit user reset may wipe it.
const clearAlmaBundleCache = vi.fn();
vi.mock('@almamesh/browser', () => ({ clearAlmaBundleCache }));

import {
  healStrandedServiceWorker,
  recoverSeveredServiceWorkerChannel,
  reloadForUpdate,
  installChunkErrorRecovery,
} from '../swSelfHeal';

const HEAL_KEY = 'almamesh:sw-precache-heal';
const RESTORE_RELOAD_KEY = 'almamesh:restore-reload';

const IMMUTABLE = ['almamesh-pyodide-immutable', 'almamesh-bundle-immutable'];
const RUNTIME = ['almamesh-signals', 'almamesh-pubkey'];
const PRECACHE = 'workbox-precache-v2-https://almamesh.com/';

/** Build a mocked browser env; precacheEntries are the URLs inside the precache. */
function stubEnv(opts: {
  controller?: unknown;
  cacheNames: string[];
  cacheNameReads?: string[][];
  precacheEntries?: string[];
  healFlagSet?: boolean;
  cachesThrows?: boolean;
}) {
  const unregister = vi.fn().mockResolvedValue(true);
  const getDirectory = vi.fn();
  vi.stubGlobal('navigator', {
    storage: { getDirectory },
    serviceWorker: {
      controller: 'controller' in opts ? opts.controller : {},
      getRegistration: vi.fn().mockResolvedValue({ active: { state: 'activated' } }),
      getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
    },
  });
  const cacheDelete = vi.fn().mockResolvedValue(true);
  const cacheNames = opts.cacheNameReads ?? [opts.cacheNames];
  let cacheRead = 0;
  vi.stubGlobal('caches', {
    keys: opts.cachesThrows
      ? vi.fn().mockRejectedValue(new Error('caches boom'))
      : vi.fn().mockImplementation(() => Promise.resolve(
          cacheNames[Math.min(cacheRead++, cacheNames.length - 1)],
        )),
    delete: cacheDelete,
    open: vi.fn().mockResolvedValue({
      keys: vi.fn().mockResolvedValue((opts.precacheEntries ?? []).map((url) => ({ url }))),
    }),
  });
  const reload = vi.fn();
  vi.stubGlobal('location', { reload, origin: 'https://almamesh.com' });
  const store = new Map<string, string>();
  if (opts.healFlagSet) store.set(HEAL_KEY, '1');
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  });
  return { unregister, cacheDelete, reload, getDirectory };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('healStrandedServiceWorker', () => {
  it('un-wedges an active SW with NO precache cache (unregister + reload)', async () => {
    const { unregister, reload } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME] });
    await healStrandedServiceWorker();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does NOTHING when the precache is present and holds the app shell', async () => {
    const { unregister, reload } = stubEnv({
      cacheNames: [...IMMUTABLE, ...RUNTIME, PRECACHE],
      precacheEntries: [
        'https://almamesh.com/?__WB_REVISION__=abc',
        'https://almamesh.com/assets/index-x.js?__WB_REVISION__=def',
      ],
    });
    await healStrandedServiceWorker();
    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not unregister when WebKit exposes a healthy precache after a transient empty read', async () => {
    const healthyCaches = [...IMMUTABLE, ...RUNTIME, PRECACHE];
    const { unregister, reload } = stubEnv({
      cacheNames: healthyCaches,
      cacheNameReads: [[], healthyCaches],
      precacheEntries: ['https://almamesh.com/?__WB_REVISION__=abc'],
    });

    await healStrandedServiceWorker();

    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not unregister when WebKit hides a healthy precache across consecutive browser tasks', async () => {
    const healthyCaches = [...IMMUTABLE, ...RUNTIME, PRECACHE];
    const { unregister, reload } = stubEnv({
      cacheNames: healthyCaches,
      cacheNameReads: [[], [], healthyCaches],
      precacheEntries: ['https://almamesh.com/?__WB_REVISION__=abc'],
    });

    await healStrandedServiceWorker();

    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not destructively heal while WebKit temporarily hides the active registration', async () => {
    const { unregister, reload } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME] });
    vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(undefined);

    await healStrandedServiceWorker();

    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does NOTHING when no service worker controls the page', async () => {
    const { unregister, reload } = stubEnv({ controller: null, cacheNames: [...IMMUTABLE] });
    await healStrandedServiceWorker();
    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at most once per session (loop guard)', async () => {
    const { reload } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME], healFlagSet: true });
    await healStrandedServiceWorker();
    expect(reload).not.toHaveBeenCalled();
  });

  it('coalesces concurrent self-heal checks into one destructive recovery', async () => {
    vi.useFakeTimers();
    const { unregister, reload } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME] });

    try {
      const recoveries = Promise.all([
        healStrandedServiceWorker(),
        healStrandedServiceWorker(),
      ]);
      await vi.runAllTimersAsync();
      await recoveries;

      expect(unregister).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a second recovery reload immediately after backup restore reload', async () => {
    const { reload } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME] });
    sessionStorage.setItem(RESTORE_RELOAD_KEY, '1');

    await healStrandedServiceWorker();

    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RESTORE_RELOAD_KEY)).toBeNull();
  });

  it('never throws (best-effort) even if caches access fails', async () => {
    stubEnv({ cacheNames: [], cachesThrows: true });
    await expect(healStrandedServiceWorker()).resolves.toBeUndefined();
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('installChunkErrorRecovery', () => {
  it('reloads (once, guarded) when a vite:preloadError carries a chunk error', async () => {
    const { reload } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME, PRECACHE] });
    const target = new EventTarget();
    installChunkErrorRecovery(target as unknown as Window);

    const evt = new Event('vite:preloadError', { cancelable: true });
    (evt as unknown as { payload: unknown }).payload = new Error(
      'Failed to fetch dynamically imported module: /assets/HeroForceField-x.js',
    );
    target.dispatchEvent(evt);
    await flush();

    expect(evt.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('recovers a chunk error surfaced via unhandledrejection', async () => {
    const { reload } = stubEnv({ cacheNames: [...IMMUTABLE, PRECACHE] });
    const target = new EventTarget();
    installChunkErrorRecovery(target as unknown as Window);

    const evt = new Event('unhandledrejection') as unknown as { reason: unknown };
    (evt as { reason: unknown }).reason = new Error(
      'error loading dynamically imported module',
    );
    target.dispatchEvent(evt as unknown as Event);
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-chunk error', async () => {
    const { reload } = stubEnv({ cacheNames: [...IMMUTABLE] });
    const target = new EventTarget();
    installChunkErrorRecovery(target as unknown as Window);

    const evt = new Event('unhandledrejection') as unknown as { reason: unknown };
    (evt as { reason: unknown }).reason = new Error('some unrelated rejection');
    target.dispatchEvent(evt as unknown as Event);
    await flush();

    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at most once per session across repeated chunk errors', async () => {
    const { reload } = stubEnv({ cacheNames: [...IMMUTABLE, PRECACHE] });
    const target = new EventTarget();
    installChunkErrorRecovery(target as unknown as Window);

    for (let i = 0; i < 3; i++) {
      const evt = new Event('vite:preloadError', { cancelable: true });
      (evt as unknown as { payload: unknown }).payload = new Error(
        'Failed to fetch dynamically imported module',
      );
      target.dispatchEvent(evt);
      await flush();
    }
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('reloadForUpdate', () => {
  it('drops the stale shell caches but PRESERVES the immutable engine caches, then reloads', async () => {
    const { unregister, cacheDelete, reload } = stubEnv({
      cacheNames: [...IMMUTABLE, ...RUNTIME, PRECACHE],
    });
    await reloadForUpdate();
    expect(unregister).toHaveBeenCalledTimes(1);
    const deleted = cacheDelete.mock.calls.map((c) => c[0]);
    expect(deleted).toEqual(expect.arrayContaining([...RUNTIME, PRECACHE]));
    expect(deleted).not.toContain('almamesh-pyodide-immutable');
    expect(deleted).not.toContain('almamesh-bundle-immutable');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('automatic self-heal never touches OPFS (bundle cache + rollback floor)', () => {
  it('the SW precache heal leaves OPFS and the *-immutable engine caches alone', async () => {
    const { reload, cacheDelete, getDirectory } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME] });
    await healStrandedServiceWorker();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getDirectory).not.toHaveBeenCalled();
    expect(clearAlmaBundleCache).not.toHaveBeenCalled();
    const deleted = cacheDelete.mock.calls.map((c) => c[0]);
    expect(deleted).not.toContain('almamesh-pyodide-immutable');
    expect(deleted).not.toContain('almamesh-bundle-immutable');
  });

  it('chunk-error recovery and reloadForUpdate leave OPFS alone', async () => {
    const { reload, getDirectory } = stubEnv({ cacheNames: [...IMMUTABLE, PRECACHE] });
    const target = new EventTarget();
    installChunkErrorRecovery(target as unknown as Window);
    const evt = new Event('vite:preloadError', { cancelable: true });
    (evt as unknown as { payload: unknown }).payload = new Error(
      'Failed to fetch dynamically imported module',
    );
    target.dispatchEvent(evt);
    await flush();
    await reloadForUpdate();

    expect(reload).toHaveBeenCalledTimes(2);
    expect(getDirectory).not.toHaveBeenCalled();
    expect(clearAlmaBundleCache).not.toHaveBeenCalled();
  });
});

// WebKit restarts its network process under memory pressure (iOS jetsam, a
// loaded CI runner). The SW registration and caches survive on disk, but the
// ALREADY-LOADED document's channel to its service worker is severed: every
// controlled fetch — even the precached shell — rejects with "Load failed", so
// an engine boot in flight can never recover in that document. Only a fresh
// navigation re-attaches it. Evidence: scripts/verify-webkit-engine.mjs
// --first-session with the network process SIGKILLed at offline boot.
describe('recoverSeveredServiceWorkerChannel', () => {
  const CHANNEL_KEY = 'almamesh:sw-channel-reload';
  const HEALTHY = {
    cacheNames: [...IMMUTABLE, ...RUNTIME, PRECACHE],
    precacheEntries: ['https://almamesh.com/?__WB_REVISION__=abc'],
  };

  function stubShellFetch(outcome: 'resolves' | 'rejects') {
    const fetchShell = outcome === 'resolves'
      ? vi.fn().mockResolvedValue({ ok: true, status: 200 })
      : vi.fn().mockRejectedValue(new TypeError('Load failed'));
    vi.stubGlobal('fetch', fetchShell);
    return fetchShell;
  }

  it('reloads once, non-destructively, when the cached shell is unreachable through the controller', async () => {
    const { unregister, cacheDelete, reload } = stubEnv(HEALTHY);
    const fetchShell = stubShellFetch('rejects');
    await expect(recoverSeveredServiceWorkerChannel()).resolves.toBe(true);
    expect(fetchShell).toHaveBeenCalledWith('/', { cache: 'no-store' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();
    expect(cacheDelete).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHANNEL_KEY)).toBe('1');
    expect(sessionStorage.getItem(HEAL_KEY)).toBeNull();
  });

  it('does nothing when the controller still serves the shell (a real outage, not a severed channel)', async () => {
    const { reload } = stubEnv(HEALTHY);
    stubShellFetch('resolves');
    await expect(recoverSeveredServiceWorkerChannel()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing for an uncontrolled page', async () => {
    const { reload } = stubEnv({ ...HEALTHY, controller: null });
    const fetchShell = stubShellFetch('rejects');
    await expect(recoverSeveredServiceWorkerChannel()).resolves.toBe(false);
    expect(fetchShell).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves a missing precache to the stranded-worker heal', async () => {
    const { reload } = stubEnv({ cacheNames: [...IMMUTABLE, ...RUNTIME] });
    stubShellFetch('rejects');
    await expect(recoverSeveredServiceWorkerChannel()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at most once per tab session', async () => {
    const { reload } = stubEnv(HEALTHY);
    stubShellFetch('rejects');
    await recoverSeveredServiceWorkerChannel();
    await expect(recoverSeveredServiceWorkerChannel()).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never throws when CacheStorage itself fails', async () => {
    const { reload } = stubEnv({ cacheNames: [], cachesThrows: true });
    stubShellFetch('rejects');
    await expect(recoverSeveredServiceWorkerChannel()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
