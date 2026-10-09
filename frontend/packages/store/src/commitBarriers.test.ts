/**
 * Every user-data store updates memory synchronously and writes SQLite later.
 * A surface that says "saved" (or moves on as if it were) must await its
 * store's commit barrier, or a full page load in that window loses the write.
 *
 * One barrier per store, same contract: resolve only once the row is in
 * SQLite; reject with the write error when the last write failed.
 */
import { describe, expect, it } from 'vitest';

import { useChatStore, whenChatCommitted } from './chat';
import { setPortableStateRepositoryForTests } from './deletionTombstones';
import { useLifeEventsStore, whenLifeEventsCommitted } from './lifeEvents';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import { PortableStateRepository } from './portableState';
import { useProfilesStore, whenProfilesCommitted } from './profiles';

interface BarrierCase {
  readonly label: string;
  readonly row: string;
  readonly rehydrate: () => Promise<void>;
  readonly commit: () => Promise<void>;
  /** Make one user-visible write; return a marker that must reach SQLite. */
  readonly write: () => string;
  readonly reset: () => void;
}

const CASES: readonly BarrierCase[] = [
  {
    label: 'profiles: a newly added person',
    row: 'almamesh-profiles',
    rehydrate: () => useProfilesStore.persist.rehydrate(),
    commit: whenProfilesCommitted,
    write: () => {
      useProfilesStore.getState().createProfile('Second Friend');
      return 'Second Friend';
    },
    reset: () => useProfilesStore.getState().clearAll(),
  },
  {
    label: 'life events: a note captured during onboarding',
    row: 'almamesh-life-events',
    rehydrate: () => useLifeEventsStore.persist.rehydrate(),
    commit: whenLifeEventsCommitted,
    write: () => {
      useLifeEventsStore
        .getState()
        .setEvents('p-1', [{ description: 'Moved to Pune', date: '2015-06-01' }]);
      return 'Moved to Pune';
    },
    reset: () => useLifeEventsStore.getState().clearAll(),
  },
  {
    label: 'chat: the final answer of a turn',
    row: 'almamesh-chat-history',
    rehydrate: () => useChatStore.persist.rehydrate(),
    commit: whenChatCommitted,
    write: () => {
      const store = useChatStore.getState();
      const thread = store.ensureThread('p-1');
      store.appendMessage(thread, 'assistant', 'Saturn is strong this year.');
      return 'Saturn is strong this year.';
    },
    reset: () => useChatStore.getState().clearAll(),
  },
];

async function withRepository(
  c: BarrierCase,
  run: (sqlite: PortableMemoryStore, repository: PortableStateRepository) => Promise<void>,
): Promise<void> {
  const sqlite = new PortableMemoryStore();
  const repository = new PortableStateRepository(sqlite);
  setPortableStateRepositoryForTests(repository);
  try {
    await c.rehydrate();
    // Hydrating an empty row may write the initial state; let it land first.
    await c.commit();
    await run(sqlite, repository);
  } finally {
    c.reset();
    await c.commit().catch(() => undefined);
    setPortableStateRepositoryForTests(undefined);
  }
}

async function rowContains(
  repository: PortableStateRepository,
  row: string,
  marker: string,
): Promise<boolean> {
  return ((await repository.read(row)) ?? '').includes(marker);
}

describe.each(CASES)('commit barrier — $label', (c) => {
  it('resolves only after the write is in SQLite', async () => {
    await withRepository(c, async (sqlite, repository) => {
      sqlite.batchDelayMs = 25;
      const marker = c.write();
      // Memory already has it; SQLite does not yet. A reload now loses it.
      expect(await rowContains(repository, c.row, marker)).toBe(false);

      await c.commit();
      expect(await rowContains(repository, c.row, marker)).toBe(true);
    });
  });

  it('rejects with the write error when the write failed', async () => {
    await withRepository(c, async (sqlite) => {
      // Every write fails (a chat turn makes two: the thread, then the message).
      sqlite.beforeBatch = () => Promise.reject(new Error('disk full'));
      c.write();
      await expect(c.commit()).rejects.toThrow('disk full');
      sqlite.beforeBatch = undefined;
    });
  });
});
