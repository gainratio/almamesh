/**
 * The production wiring behind every zustand hydration: `portableRepository()`
 * in deletionTombstones.ts. Product rule (2026-10-05): durable OPFS SQLite or
 * nothing. A refused OPFS must report 'blocked' and keep hydration waiting on
 * the SAME pending open (no RAM repository, no throw); allowing storage and
 * rechecking must let that waiting hydration finish without a reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openRepository } = vi.hoisted(() => ({ openRepository: vi.fn() }));

vi.mock('./portableState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portableState')>();
  return {
    ...actual,
    resolvePortableStateMode: () => 'portable' as const,
    openPortableStateRepository: openRepository,
  };
});

vi.mock('./legacyKeyval', () => ({
  readLegacyKeyval: async () => undefined,
  deleteLegacyKeyval: async () => undefined,
}));

import { requirePortableStateRepository } from './deletionTombstones';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import {
  checkPortableStorageAgain,
  portableStatePersistence,
  resetPortableStatePersistenceForTests,
} from './portablePersistence';
import { PortableStateRepository } from './portableState';

afterEach(() => {
  vi.unstubAllGlobals();
  resetPortableStatePersistenceForTests();
});

describe('portableRepository() gate', () => {
  it('waits while OPFS is refused, never opens memory, and resolves the same pending hydration after a recheck', async () => {
    let allowed = false;
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () =>
          allowed
            ? Promise.resolve({ kind: 'directory' })
            : Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')),
      },
    });
    const repository = new PortableStateRepository(new PortableMemoryStore());
    openRepository.mockResolvedValue(repository);

    let hydrated: PortableStateRepository | undefined;
    const hydration = requirePortableStateRepository().then((opened) => {
      hydrated = opened;
      return opened;
    });
    await vi.waitFor(() => expect(portableStatePersistence()).toBe('blocked'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hydrated).toBeUndefined();
    expect(openRepository).not.toHaveBeenCalled();

    allowed = true;
    await expect(checkPortableStorageAgain()).resolves.toBe('opfs');
    await expect(hydration).resolves.toBe(repository);
    expect(openRepository).toHaveBeenCalledOnce();
    // Durable OPFS only: the open is never asked for an in-memory database.
    expect(openRepository.mock.calls[0]).not.toContain('memory');
    await expect(requirePortableStateRepository()).resolves.toBe(repository);
    expect(openRepository).toHaveBeenCalledOnce();
  });
});
