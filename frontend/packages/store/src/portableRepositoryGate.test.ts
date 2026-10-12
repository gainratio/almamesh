/**
 * The production wiring behind every zustand hydration: `portableRepository()`
 * in deletionTombstones.ts.
 *
 * - OPFS refused (Safari Private Browsing): open the SAME store in memory,
 *   report 'memory', and never run the legacy migration (it deletes the legacy
 *   rows it copies, and a RAM copy dies with the tab). Rule 2026-10-11.
 * - Site storage blocked: report 'blocked' and keep hydration waiting on the
 *   SAME pending open; allowing storage and rechecking lets that waiting
 *   hydration finish on OPFS without a reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openRepository, readLegacy, deleteLegacy } = vi.hoisted(() => ({
  openRepository: vi.fn(),
  readLegacy: vi.fn(async (): Promise<unknown> => undefined),
  deleteLegacy: vi.fn(async () => undefined),
}));

vi.mock('./portableState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portableState')>();
  return {
    ...actual,
    resolvePortableStateMode: () => 'portable' as const,
    openPortableStateRepository: openRepository,
  };
});

vi.mock('./legacyKeyval', () => ({
  readLegacyKeyval: readLegacy,
  deleteLegacyKeyval: deleteLegacy,
}));

/** A fresh module graph per test: portableRepository() caches its one open. */
async function load() {
  vi.resetModules();
  const { requirePortableStateRepository } = await import('./deletionTombstones');
  const persistence = await import('./portablePersistence');
  const { PortableMemoryStore } = await import('./portableMemoryStore.testkit');
  const { PortableStateRepository } = await import('./portableState');
  return {
    requirePortableStateRepository,
    ...persistence,
    repository: new PortableStateRepository(new PortableMemoryStore()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'localStorage');
  openRepository.mockReset();
  readLegacy.mockClear();
  deleteLegacy.mockClear();
});

/** Safari "Block all cookies": the localStorage getter throws until lifted. */
function blockSiteStorage(): { allow: () => void } {
  let allowed = false;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (!allowed) throw new DOMException('The operation is insecure.', 'SecurityError');
      return undefined;
    },
  });
  return { allow: () => (allowed = true) };
}

describe('portableRepository() gate', () => {
  it('opens the store in memory when OPFS is refused, and leaves legacy rows alone', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () =>
          Promise.reject(new DOMException('The operation failed for an unknown transient reason.', 'UnknownError')),
      },
    });
    readLegacy.mockResolvedValue('{"state":{"legacy":true}}');
    const { requirePortableStateRepository, portableStatePersistence, repository } = await load();
    openRepository.mockResolvedValue(repository);

    await expect(requirePortableStateRepository()).resolves.toBe(repository);
    expect(portableStatePersistence()).toBe('memory');
    expect(openRepository).toHaveBeenCalledOnce();
    expect(openRepository).toHaveBeenCalledWith('memory');
    expect(readLegacy).not.toHaveBeenCalled();
    expect(deleteLegacy).not.toHaveBeenCalled();
  });

  it('waits while site storage is blocked and resolves the same pending hydration on OPFS after a recheck', async () => {
    const site = blockSiteStorage();
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({ kind: 'directory' }) } });
    const { requirePortableStateRepository, portableStatePersistence, checkPortableStorageAgain, repository } = await load();
    openRepository.mockResolvedValue(repository);

    let hydrated: typeof repository | undefined;
    const hydration = requirePortableStateRepository().then((opened) => {
      hydrated = opened;
      return opened;
    });
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hydrated).toBeUndefined();
    expect(openRepository).not.toHaveBeenCalled();

    site.allow();
    await expect(checkPortableStorageAgain()).resolves.toBe('opfs');
    await expect(hydration).resolves.toBe(repository);
    expect(openRepository).toHaveBeenCalledOnce();
    expect(openRepository).toHaveBeenCalledWith('opfs');
    await expect(requirePortableStateRepository()).resolves.toBe(repository);
    expect(openRepository).toHaveBeenCalledOnce();
  });
});
