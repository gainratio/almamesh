/**
 * Rolling back a person whose save failed or timed out (the user cancelled the
 * add). The rollback must win even when the original write commits LATE, after
 * the rollback was requested: the late write must not resurrect the person.
 */
import { describe, expect, it, vi } from 'vitest';

import { setPortableStateRepositoryForTests } from './deletionTombstones';
import { readDroppedWrites, resetDroppedWritesForTests } from './droppedWrites';
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

  it('a late commit cannot resurrect the person even when the rollback write itself fails once', async () => {
    await withRepository(async (sqlite, repository) => {
      const store = useProfilesStore.getState();
      const me = store.createProfile('Asha Rao');
      await whenProfilesCommitted();

      // Batch 1 (the add) hangs; batch 2 (the rollback) fails; later ones work.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let batches = 0;
      sqlite.beforeBatch = () => {
        batches += 1;
        if (batches === 1) return held;
        if (batches === 2) return Promise.reject(new Error('disk busy'));
        return Promise.resolve();
      };
      const staged = store.createProfile('Second Friend');
      useProfilesStore.getState().discardUnsavedProfile(staged, me);
      release();
      // The add has landed (with the person) and the rollback write has failed.
      await vi.waitFor(() => expect(batches).toBeGreaterThanOrEqual(2), { timeout: 3000 });

      await vi.waitFor(
        async () => {
          expect(await storedState(repository)).toEqual({ names: ['Asha Rao'], activeProfileId: me });
        },
        { timeout: 3000, interval: 20 },
      );
      sqlite.beforeBatch = undefined;
    });
  });

  it('when storage stays broken: stops at the retry cap and reports the failure once, without names', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetDroppedWritesForTests();
    await withRepository(async (sqlite, repository) => {
      const store = useProfilesStore.getState();
      const me = store.createProfile('Asha Rao');
      await whenProfilesCommitted();

      // The add lands late; every write after it fails for good.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let batches = 0;
      sqlite.beforeBatch = () => {
        batches += 1;
        return batches === 1 ? held : Promise.reject(new Error('disk gone'));
      };
      const staged = store.createProfile('Second Friend');
      useProfilesStore.getState().discardUnsavedProfile(staged, me);
      release();

      await vi.waitFor(() => expect(readDroppedWrites()).toHaveLength(1), {
        timeout: 8000,
        interval: 50,
      });
      expect(readDroppedWrites()[0]).toMatchObject({
        key: 'almamesh-profiles',
        reason: 'discard-failed',
      });
      // The cap holds: no further re-writes once it gave up.
      const attempts = batches;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(batches).toBe(attempts);
      expect(readDroppedWrites()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith('[almamesh:warn:people.discard_failed]');
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Second Friend|Asha/);
      // The person really is still on disk: that is why the user must be told.
      expect((await storedState(repository)).names).toContain('Second Friend');
      sqlite.beforeBatch = undefined;
    });
    warn.mockRestore();
    resetDroppedWritesForTests();
  }, 15_000);

  it('is a no-op for an unknown id', () => {
    const before = useProfilesStore.getState().profiles;
    useProfilesStore.getState().discardUnsavedProfile('nobody', null);
    expect(useProfilesStore.getState().profiles).toBe(before);
  });
});
