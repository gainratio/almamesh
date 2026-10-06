import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { EngineOperationError } from '@almamesh/browser';

import '../../i18n/config';
import { ErrorBoundary } from '../ErrorBoundary';
import { recordEngineBootFailure } from '../../lib/engineLifecycle';

// Keep the reset hermetic: no real sync Worker in jsdom.
const clearAlmaBundleCache = vi.fn().mockResolvedValue(undefined);
vi.mock('@almamesh/browser', async (orig) => ({
  ...(await orig<typeof import('@almamesh/browser')>()),
  clearAlmaBundleCache: () => clearAlmaBundleCache(),
}));

/** An IndexedDB delete request that succeeds on the next microtask. */
function succeedingDelete() {
  return vi.fn(() => {
    const request: { onsuccess: (() => void) | null } = { onsuccess: null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  });
}

/** A child that throws on render so the boundary trips into its fallback. */
function Boom(): never {
  throw new Error('stale-state boom');
}

/** A child that throws a failed-chunk-import error (stale SW cache after deploy). */
function ChunkBoom(): never {
  throw new Error('Failed to fetch dynamically imported module: /assets/Dashboard-x.js');
}

function stubBrowserForReload() {
  const unregister = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
  });
  vi.stubGlobal('caches', {
    keys: vi.fn().mockResolvedValue(['workbox-precache-v2-x', 'almamesh-bundle-immutable']),
    delete: vi.fn().mockResolvedValue(true),
  });
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  });
  return { unregister, reload };
}

describe('ErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the caught error itself; silence the noise but keep the spy so
    // we can assert OUR componentDidCatch logging fired with the real error.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    recordEngineBootFailure(null);
    clearAlmaBundleCache.mockClear();
  });

  it('renders the fallback with a reset-app-data escape hatch when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    // The bulletproof escape hatch for a stranded returning visitor.
    expect(screen.getByRole('button', { name: /reset app data/i })).toBeTruthy();
    // The existing recovery actions remain.
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /refresh page/i })).toBeTruthy();
  });

  it('shows the update card and auto-reloads (engine-preserving) on a failed chunk import', async () => {
    const { unregister, reload } = stubBrowserForReload();

    render(
      <ErrorBoundary>
        <ChunkBoom />
      </ErrorBoundary>,
    );

    // A chunk failure is a deploy/update artifact, not a crash — distinct copy.
    expect(screen.getByText('Updating to the latest version')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    // Auto-heals once: unregister SW + reload, WITHOUT the nuclear data wipe.
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(unregister).toHaveBeenCalled();
  });

  it('does NOT auto-reload a second time once the per-session chunk-heal guard is set', async () => {
    const { reload } = stubBrowserForReload();
    // Simulate an earlier chunk-heal already performed THIS session: the boundary's
    // one-shot guard flag (EB_CHUNK_HEAL_KEY) is set. A second chunk error must
    // still show the update card but NOT auto-reload again — the no-loop guarantee.
    sessionStorage.setItem('almamesh:eb-chunk-heal', '1');

    render(
      <ErrorBoundary>
        <ChunkBoom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Updating to the latest version')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).not.toHaveBeenCalled();
  });

  it('does NOT auto-reload for a normal (non-chunk) error', async () => {
    const { reload } = stubBrowserForReload();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).not.toHaveBeenCalled();
  });

  it('logs the real underlying error (never hides the cause behind a blank fallback)', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const loggedOurError = consoleError.mock.calls.some((args: unknown[]) =>
      args.some((a) => a instanceof Error && a.message === 'stale-state boom'),
    );
    expect(loggedOurError).toBe(true);
  });

  it('reset handler clears every stale-state source best-effort, then reloads', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }]);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistrations } });

    const cacheKeys = vi.fn().mockResolvedValue(['a', 'b']);
    const cacheDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { keys: cacheKeys, delete: cacheDelete });

    const lsClear = vi.fn();
    vi.stubGlobal('localStorage', {
      clear: lsClear,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      key: () => null,
      length: 0,
    });

    const idbDatabases = vi.fn().mockResolvedValue([{ name: 'almamesh-x' }]);
    const idbDeleteDatabase = succeedingDelete();
    vi.stubGlobal('indexedDB', {
      databases: idbDatabases,
      deleteDatabase: idbDeleteDatabase,
    });

    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /reset app data/i }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(unregister).toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledTimes(2);
    expect(lsClear).toHaveBeenCalled();
    expect(idbDeleteDatabase).toHaveBeenCalledWith('almamesh-x');
  });

  it('still reloads even when one cleanup path throws (best-effort, isolated)', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockRejectedValue(new Error('SW boom')),
      },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn().mockRejectedValue(new Error('caches boom')),
      delete: vi.fn(),
    });
    const lsClear = vi.fn(() => {
      throw new Error('ls boom');
    });
    vi.stubGlobal('localStorage', {
      clear: lsClear,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      key: () => null,
      length: 0,
    });
    vi.stubGlobal('indexedDB', undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /reset app data/i }));

    // One failing path must not block the others or the final reload.
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('does not reload when a user database could not be deleted, and says why', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('indexedDB', {
      databases: vi.fn().mockResolvedValue([{ name: 'keyval-store' }]),
      deleteDatabase: vi.fn(() => {
        const request: { onerror: (() => void) | null } = { onerror: null };
        queueMicrotask(() => request.onerror?.());
        return request;
      }),
    });
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /reset app data/i }));

    const alert = await screen.findByTestId('reset-incomplete');
    expect(alert.textContent).toContain('Close every AlmaMesh tab');
    expect(alert.getAttribute('data-databases')).toBe('keyval-store');
    expect(reload).not.toHaveBeenCalled();
  });

  it('after a ROLLBACK boot refusal, warns of tampering and needs a two-step confirm before the reset', async () => {
    recordEngineBootFailure(
      new EngineOperationError({ code: 'rollback', message: 'refusing rollback: sequence is not fresher' }),
    );
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('indexedDB', undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('rollback-warning').textContent).toMatch(/older version of the engine/);
    fireEvent.click(screen.getByRole('button', { name: /reset app data/i }));
    await Promise.resolve();
    expect(clearAlmaBundleCache).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('rollback-reset-confirm'));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(clearAlmaBundleCache).toHaveBeenCalledTimes(1);
  });
});
