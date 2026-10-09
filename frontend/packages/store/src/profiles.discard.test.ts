/**
 * Rolling back a person whose save failed or timed out (the user cancelled the
 * add). The rollback must win even when the original write commits LATE, after
 * the rollback was requested: the late write must not resurrect the person.
 */
import { describe, expect, it } from 'vitest';

import { setPortableStateRepositoryForTests } from './deletionTombstones';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import { PortableStateRepository } from './portableState';
import { useProfilesStore, whenProfilesCommitted } from './profiles';

async function storedState(
  repository: PortableStateRepository,
): Promise<{ names: string[]; activeProfileId: string | null }> {
  const stored = await repository.read('almamesh-profiles');
  if (stored === null) return { names: [], activeProfileId: null };
  const { state } = JSON.parse(stored) as {
    state: { profiles: Record<string, { name: string }>; activeProfileId: string | null };
  };
  return { names: Object.values(state.profiles).map((p) => p.name), activeProfileId: state.activeProfileId };
}

async function withRepository(
  run: (sqlite: PortableMemoryStore, repository: PortableStateRepository) => Promise<void>,
): Promise<void> {
  const sqlite = new PortableMemoryStore();
  const repository = new PortableStateRepository(sqlite);
  setPortableStateRepositoryForTests(repository);
  try {
    await useProfilesStore.persist.rehydrate();
    await whenProfilesCommitted();
    await run(sqlite, repository);
  } finally {
    useProfilesStore.getState().clearAll();
    await whenProfilesCommitted().catch(() => undefined);
    setPortableStateRepositoryForTests(undefined);
  }
}

describe('discardUnsavedProfile', () => {
  it('removes the person and restores the previous active profile, in memory and on disk', async () => {
    await withRepository(async (_sqlite, repository) => {
      const store = useProfilesStore.getState();
      const me = store.createProfile('Asha Rao');
      await whenProfilesCommitted();

      const staged = store.createProfile('Second Friend');
      store.setActiveProfile(staged);
      useProfilesStore.getState().discardUnsavedProfile(staged, me);

      const state = useProfilesStore.getState();
      expect(Object.values(state.profiles).map((p) => p.name)).toEqual(['Asha Rao']);
      expect(state.activeProfileId).toBe(me);
      await whenProfilesCommitted();
      expect(await storedState(repository)).toEqual({ names: ['Asha Rao'], activeProfileId: me });
    });
  });

  it('a late commit of the original write does not resurrect the discarded person', async () => {
    await withRepository(async (sqlite, repository) => {
      const store = useProfilesStore.getState();
      const me = store.createProfile('Asha Rao');
      await whenProfilesCommitted();

      // The add's write hangs (another tab holds the lock); the UI times out.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      sqlite.beforeBatch = () => held;
      const staged = store.createProfile('Second Friend');
      store.setActiveProfile(staged);

      // The user cancels: roll back while the original write is still pending.
      useProfilesStore.getState().discardUnsavedProfile(staged, me);
      // Then the original write lands late.
      sqlite.beforeBatch = undefined;
      release();
      await whenProfilesCommitted();

      expect(await storedState(repository)).toEqual({ names: ['Asha Rao'], activeProfileId: me });
    });
  });

  it('is a no-op for an unknown id', () => {
    const before = useProfilesStore.getState().profiles;
    useProfilesStore.getState().discardUnsavedProfile('nobody', null);
    expect(useProfilesStore.getState().profiles).toBe(before);
  });
});
