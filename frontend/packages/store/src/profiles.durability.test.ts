/**
 * The profiles store updates memory synchronously and writes SQLite later.
 * A surface that tells the user "added" (or navigates as if it were) must await
 * `whenProfilesCommitted()`, or a full page load in that window loses the person.
 */
import { describe, expect, it } from 'vitest';

import { setPortableStateRepositoryForTests } from './deletionTombstones';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import { PortableStateRepository } from './portableState';
import { useProfilesStore, whenProfilesCommitted } from './profiles';

const PROFILES_ROW = 'almamesh-profiles';

async function storedNames(repository: PortableStateRepository): Promise<string[]> {
  const stored = await repository.read(PROFILES_ROW);
  if (stored === null) return [];
  const { state } = JSON.parse(stored) as {
    state: { profiles: Record<string, { name: string }> };
  };
  return Object.values(state.profiles).map((p) => p.name);
}

async function withRepository(
  run: (sqlite: PortableMemoryStore, repository: PortableStateRepository) => Promise<void>,
): Promise<void> {
  const sqlite = new PortableMemoryStore();
  const repository = new PortableStateRepository(sqlite);
  setPortableStateRepositoryForTests(repository);
  try {
    await useProfilesStore.persist.rehydrate();
    // Hydrating an empty row writes the initial state; let it land first.
    await whenProfilesCommitted();
    await run(sqlite, repository);
  } finally {
    useProfilesStore.getState().clearAll();
    await whenProfilesCommitted().catch(() => undefined);
    setPortableStateRepositoryForTests(undefined);
  }
}

describe('whenProfilesCommitted (the add-a-person durability barrier)', () => {
  it('resolves only after a newly created person is in SQLite', async () => {
    await withRepository(async (sqlite, repository) => {
      sqlite.batchDelayMs = 25;
      useProfilesStore.getState().createProfile('Second Friend');
      // Memory already has the person; SQLite does not yet. A reload now loses them.
      expect(await storedNames(repository)).toEqual([]);

      await whenProfilesCommitted();
      expect(await storedNames(repository)).toEqual(['Second Friend']);
    });
  });

  it('rejects with the write error when the person could not be saved', async () => {
    await withRepository(async (sqlite) => {
      sqlite.failNext = new Error('disk full');
      useProfilesStore.getState().createProfile('Second Friend');
      await expect(whenProfilesCommitted()).rejects.toThrow('disk full');
    });
  });
});
