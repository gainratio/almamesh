import type { ReactNode } from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const boot = vi.hoisted(() => ({
  persistence: 'blocked' as 'blocked' | 'opfs' | 'unavailable',
  listeners: new Set<() => void>(),
  roots: [] as { unmount(): void }[],
  hydration: undefined as Deferred | undefined,
  ownership: undefined as Deferred | undefined,
  provider: vi.fn(),
  app: vi.fn(),
  migrate: vi.fn(),
  checkAgain: vi.fn(),
}));

function publishPersistence(next: typeof boot.persistence): void {
  boot.persistence = next;
  for (const listener of boot.listeners) listener();
}

vi.mock('react-dom/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  const createRoot: typeof original.createRoot = (...args) => {
    const root = original.createRoot(...args);
    boot.roots.push(root);
    return root;
  };
  return { ...original, createRoot, default: { ...original, createRoot } };
});

vi.mock('@almamesh/store', () => ({
  getInitialLanguage: () => 'en',
  useLanguageStore: { getState: () => ({ language: 'en' }) },
  portableStatePersistence: () => boot.persistence,
  subscribePortableStatePersistence: (listener: () => void) => {
    boot.listeners.add(listener);
    return () => boot.listeners.delete(listener);
  },
  siteStorageBlocked: () => false,
  checkPortableStorageAgain: () => boot.checkAgain(),
  markPortableStateUnavailable: () => publishPersistence('unavailable'),
  runProfileMigration: () => boot.migrate(),
  // Imported by portablePreferences; its initializer is controlled below.
  portablePreferenceStorage: {},
  hydrateContentModePreference: vi.fn(),
  whenChartLibraryHydrated: vi.fn(),
  whenProfilesHydrated: vi.fn(),
  whenChatHydrated: vi.fn(),
  whenInterpretationHydrated: vi.fn(),
}));

vi.mock('@almamesh/llm', () => ({
  configureLlmSettingsPersistence: vi.fn(),
  hydrateLlmSettings: vi.fn(),
  LLM_SETTINGS_KEY: 'almamesh-llm-settings',
}));
vi.mock('./lib/modelSuggestion', () => ({
  hydrateSlowModelSuggestion: vi.fn(),
  MODEL_SUGGESTION_DISMISSED_KEY: 'almamesh-model-suggestion-dismissed',
}));
vi.mock('./lib/portablePreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/portablePreferences')>()),
  initializePortableState: () => boot.hydration!.promise,
}));
vi.mock('./lib/swSelfHeal', () => ({ installChunkErrorRecovery: vi.fn() }));
vi.mock('./components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <div data-testid="error-boundary-shell">{children}</div>,
}));
vi.mock('./components/UpdateBanner', () => ({
  UpdateBanner: () => <div data-testid="update-banner-mounted" />,
}));
vi.mock('./providers/AlmaMeshRuntimeProvider', () => ({
  AlmaMeshRuntimeProvider: ({ children }: { children: ReactNode }) => {
    boot.provider();
    return <div data-testid="runtime-provider-mounted">{children}</div>;
  },
}));
vi.mock('./App', () => ({
  default: () => {
    boot.app();
    return <div data-testid="app-mounted" />;
  },
}));

async function start(): Promise<void> {
  await act(async () => { await import('./main'); });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  boot.persistence = 'blocked';
  boot.listeners.clear();
  boot.hydration = deferred();
  boot.ownership = deferred();
  boot.migrate.mockImplementation(() => boot.ownership!.promise);
  boot.checkAgain.mockImplementation(async () => {
    publishPersistence('opfs');
    return 'opfs';
  });
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState({}, '', '/dashboard');
});

afterEach(async () => {
  await act(async () => {
    boot.hydration?.reject(new Error('test finished'));
    boot.ownership?.resolve();
    // Drain the bootstrap continuation before unmounting its real React root.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
  act(() => { for (const root of boot.roots.splice(0)) root.unmount(); });
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

describe('main bootstrap storage/engine ownership', () => {
  it('keeps blocked→OPFS startup engine-free while rows are held and after a failed read', async () => {
    await start();
    expect(screen.getByTestId('storage-blocked-notice')).toBeTruthy();
    expect(screen.getByTestId('update-banner-mounted')).toBeTruthy();
    expect(screen.getByTestId('error-boundary-shell')).toBeTruthy();
    expect(boot.provider).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByTestId('storage-check-again-button')); });
    expect(boot.checkAgain).toHaveBeenCalledOnce();
    expect(boot.persistence).toBe('opfs');
    expect(boot.provider).not.toHaveBeenCalled();
    expect(boot.app).not.toHaveBeenCalled();
    expect(boot.migrate).not.toHaveBeenCalled();

    await act(async () => { boot.hydration!.reject(new Error('stored row unreadable')); });
    expect(screen.getByTestId('storage-blocked-notice').getAttribute('data-reason')).toBe('database-unavailable');
    expect(screen.getByTestId('storage-reload-button')).toBeTruthy();
    expect(screen.getByTestId('update-banner-mounted')).toBeTruthy();
    expect(boot.provider).not.toHaveBeenCalled();
    expect(boot.app).not.toHaveBeenCalled();
  });

  it('continues Check again in place but mounts the engine only after hydration and ownership succeed', async () => {
    await start();
    await act(async () => { fireEvent.click(screen.getByTestId('storage-check-again-button')); });
    expect(boot.provider).not.toHaveBeenCalled();

    await act(async () => { boot.hydration!.resolve(); });
    expect(boot.migrate).toHaveBeenCalledOnce();
    expect(boot.provider).not.toHaveBeenCalled();
    expect(boot.app).not.toHaveBeenCalled();
    expect(screen.getByTestId('update-banner-mounted')).toBeTruthy();

    await act(async () => { boot.ownership!.resolve(); });
    expect(screen.getByTestId('runtime-provider-mounted')).toBeTruthy();
    expect(screen.getByTestId('app-mounted')).toBeTruthy();
    expect(screen.queryByTestId('storage-blocked-notice')).toBeNull();
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('never mounts the engine or App when an initially open database fails hydration', async () => {
    boot.persistence = 'opfs';
    await start();
    expect(boot.provider).not.toHaveBeenCalled();
    await act(async () => { boot.hydration!.reject(new Error('read failed')); });
    expect(screen.getByTestId('storage-blocked-notice').getAttribute('data-reason')).toBe('database-unavailable');
    expect(boot.migrate).not.toHaveBeenCalled();
    expect(boot.provider).not.toHaveBeenCalled();
    expect(boot.app).not.toHaveBeenCalled();
  });

  it('keeps a failed ownership migration engine-free after successful hydration', async () => {
    boot.persistence = 'opfs';
    await start();
    await act(async () => { boot.hydration!.resolve(); });
    expect(boot.migrate).toHaveBeenCalledOnce();
    expect(boot.provider).not.toHaveBeenCalled();
    await act(async () => { boot.ownership!.reject(new Error('migration failed')); });
    expect(screen.getByTestId('storage-blocked-notice').getAttribute('data-reason')).toBe('database-unavailable');
    expect(boot.provider).not.toHaveBeenCalled();
    expect(boot.app).not.toHaveBeenCalled();
  });
});
