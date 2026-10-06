import { afterEach, describe, expect, it } from 'vitest';

import {
  abortBackupRestore,
  beginDatasetMutation,
  commitDatasetGeneration,
  deletionAwareIdbStorage,
  flushPortablePersistence,
  setPortableStateRepositoryForTests,
  tagPersistedValue,
} from './deletionTombstones';
import { setDatasetLeaseLocksForTests, type DatasetLeaseLocks } from './datasetLease';
import { readDroppedWrites, resetDroppedWritesForTests } from './droppedWrites';
import { PortableMemoryStore } from './portableMemoryStore.testkit';
import { PORTABLE_LEDGER_KEY, PortableStateRepository } from './portableState';

const TEN_MINUTES_AGO = (): number => Date.now() - 10 * 60_000;

interface Harness {
  readonly sqlite: PortableMemoryStore;
  readonly repository: PortableStateRepository;
}

/** A realm over the in-memory SQLite twin; export bytes are the canonical rows as JSON. */
function harness(): Harness {
  const sqlite = new PortableMemoryStore();
  const repository = new PortableStateRepository(
    sqlite,
    async () => sqlite.epoch,
    async (canonical) => new TextEncoder().encode(JSON.stringify([...canonical])),
  );
  setPortableStateRepositoryForTests(repository);
  return { sqlite, repository };
}

function seedLedger(sqlite: PortableMemoryStore, ledger: Record<string, unknown>): void {
  sqlite.setPortableValue(
    PORTABLE_LEDGER_KEY,
    JSON.stringify({
      version: 1,
      activeEpoch: 1,
      restoreEpoch: 2,
      restoreInProgress: true,
      memoryRebuildPending: false,
      profileIds: [],
      threadIds: [],
      chartIds: [],
      ...ledger,
    }),
  );
}

function profilesEnvelope(ids: readonly string[]): string {
  const profiles = Object.fromEntries(ids.map((id) => [id, { id, name: id }]));
  return JSON.stringify({ state: { profiles, activeProfileId: ids[0] ?? null }, version: 0 });
}

function chatEnvelope(threads: Record<string, string>): string {
  return JSON.stringify({
    state: {
      threads: Object.fromEntries(
        Object.entries(threads).map(([id, owner]) => [id, { id, profile_id: owner, title: null }]),
      ),
      messages: Object.fromEntries(Object.keys(threads).map((id) => [id, []])),
      summaries: {},
    },
    version: 0,
  });
}

function seedRow(sqlite: PortableMemoryStore, key: string, value: string, epoch: number): void {
  sqlite.setPortableValue(key, tagPersistedValue(value, epoch));
}

async function exportedText(repository: PortableStateRepository): Promise<string> {
  const exported = await repository.exportWithReport();
  return new TextDecoder().decode(exported.bytes);
}

async function ledgerOf(repository: PortableStateRepository): Promise<Record<string, unknown>> {
  return JSON.parse((await repository.read(PORTABLE_LEDGER_KEY)) as string) as Record<
    string,
    unknown
  >;
}

function profileIdsIn(raw: string | null): readonly string[] {
  const parsed = JSON.parse(raw as string) as { state: { profiles: Record<string, unknown> } };
  return Object.keys(parsed.state.profiles);
}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      globalThis.setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
    }),
  ]);
}

/** Web Locks whose held set is fixed: the named owners are alive, every other owner is dead. */
function locksHolding(...owners: readonly string[]): DatasetLeaseLocks {
  return {
    request: async (_name, callback) => callback(),
    query: async () => ({
      held: owners.map((owner) => ({ name: `almamesh-dataset-lease:${owner}` })),
    }),
  };
}

afterEach(() => {
  setPortableStateRepositoryForTests(undefined);
  setDatasetLeaseLocksForTests(undefined);
  resetDroppedWritesForTests();
});

describe('abandoned dataset lease recovery at boot', () => {
  // Found as 100%-CPU vitest workers that never exited: lease acquisition
  // looped on a repository while recovery looked up a different one, made no
  // progress, and retried with no pause. Recovery must settle the lease on the
  // repository the acquisition is using, and a loop must never spin.
  it('settles an abandoned lease on the repository the acquisition holds, without spinning', async () => {
    const { sqlite } = harness();
    seedLedger(sqlite, { leaseOwner: 'dead-tab' });
    let reads = 0;
    const list = sqlite.list.bind(sqlite);
    sqlite.list = async (options) => {
      reads += 1;
      if (reads === 1) setPortableStateRepositoryForTests(null);
      if (reads > 200) throw new Error('lease acquisition is spinning');
      return list(options);
    };

    const epoch = await beginDatasetMutation();

    expect(epoch).toBeGreaterThan(2);
    expect(reads).toBeLessThan(20);
  });

  it('accepts writes after hydrating over an abandoned lease that holds no tombstones', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { restoreStartedAt: TEN_MINUTES_AGO(), leaseOwner: 'crashed-tab' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    const hydrated = await deletionAwareIdbStorage.getItem('almamesh-profiles');
    expect(profileIdsIn(hydrated as string)).toEqual(['a']);

    await deletionAwareIdbStorage.setItem('almamesh-profiles', profilesEnvelope(['a', 'b']));
    await flushPortablePersistence();

    expect(profileIdsIn(await repository.read('almamesh-profiles'))).toEqual(['a', 'b']);
    expect(await ledgerOf(repository)).toMatchObject({ restoreInProgress: false, activeEpoch: 1 });
    const exported = new Map(JSON.parse(await exportedText(repository)) as [string, string][]);
    expect(profileIdsIn(exported.get('almamesh-profiles') ?? null)).toEqual(['a', 'b']);
  });

  it('rolls a crashed deletion forward so the victim never comes back through export', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, {
      restoreStartedAt: TEN_MINUTES_AGO(),
      leaseOwner: 'crashed-tab',
      profileIds: ['victim'],
    });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['survivor', 'victim']), 1);
    seedRow(
      sqlite,
      'almamesh-chat-history',
      chatEnvelope({ kept: 'survivor', secret: 'victim' }),
      1,
    );

    await deletionAwareIdbStorage.getItem('almamesh-profiles');

    expect(profileIdsIn(await repository.read('almamesh-profiles'))).toEqual(['survivor']);
    expect(await repository.read('almamesh-chat-history')).not.toContain('secret');
    expect(await ledgerOf(repository)).toMatchObject({
      restoreInProgress: false,
      activeEpoch: 3,
      restoreEpoch: 3,
      memoryRebuildPending: true,
      profileIds: [],
    });
    const exported = await exportedText(repository);
    expect(exported).not.toContain('victim');
    expect(exported).toContain('survivor');
  });

  it('recovers a lease that never recorded when it started instead of waiting forever', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { leaseOwner: 'crashed-tab' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');

    expect(await ledgerOf(repository)).toMatchObject({ restoreInProgress: false });
    const epoch = await settleWithin(beginDatasetMutation(), 1_000);
    expect(epoch).toBeGreaterThan(2);
    await abortBackupRestore(epoch);
  });

  it('aborts a crashed import back to the last active generation with data intact', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, {
      restoreStartedAt: TEN_MINUTES_AGO(),
      leaseOwner: 'crashed-tab',
      reviveProfileIds: ['imported'],
    });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['original']), 1);
    seedRow(sqlite, 'almamesh-chat-history', chatEnvelope({ half: 'imported' }), 2);

    const hydrated = await deletionAwareIdbStorage.getItem('almamesh-profiles');

    expect(profileIdsIn(hydrated as string)).toEqual(['original']);
    expect(await ledgerOf(repository)).toMatchObject({ restoreInProgress: false, activeEpoch: 1 });
    expect(await repository.read('almamesh-chat-history')).toBeNull();
    const exported = await exportedText(repository);
    expect(exported).toContain('original');
    expect(exported).not.toContain('imported');
  });
});

describe('a lease that is live at boot', () => {
  it('re-enables writes once the other realm aborts its lease', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { restoreStartedAt: Date.now(), leaseOwner: 'other-tab' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');
    expect(await ledgerOf(repository)).toMatchObject({ restoreInProgress: true });
    await abortBackupRestore(2);

    await deletionAwareIdbStorage.setItem('almamesh-profiles', profilesEnvelope(['a', 'b']));
    await flushPortablePersistence();

    expect(profileIdsIn(await repository.read('almamesh-profiles'))).toEqual(['a', 'b']);
  });

  it('keeps refusing a write based on data the other realm has since replaced', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { restoreStartedAt: Date.now(), leaseOwner: 'other-tab' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');
    await commitDatasetGeneration(2, [
      { key: 'almamesh-profiles', value: profilesEnvelope(['replaced']) },
    ]);

    await deletionAwareIdbStorage.setItem('almamesh-profiles', profilesEnvelope(['a', 'stale']));
    await flushPortablePersistence();

    expect(profileIdsIn(await repository.read('almamesh-profiles'))).toEqual(['replaced']);
  });
});

describe('Web Lock liveness for the dataset lease', () => {
  it('recovers a fresh lease at once when its owner no longer holds its lock', async () => {
    setDatasetLeaseLocksForTests(locksHolding());
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { restoreStartedAt: Date.now(), leaseOwner: 'wl-crashed' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');

    expect(await ledgerOf(repository)).toMatchObject({ restoreInProgress: false });
  });

  it('never steals an old lease whose owner still holds its lock', async () => {
    setDatasetLeaseLocksForTests(locksHolding('wl-slow'));
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { restoreStartedAt: TEN_MINUTES_AGO(), leaseOwner: 'wl-slow' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');

    expect(await ledgerOf(repository)).toMatchObject({
      restoreInProgress: true,
      leaseOwner: 'wl-slow',
    });
    await expect(settleWithin(beginDatasetMutation(), 200)).rejects.toThrow('still waiting');
  });

  // #246 grade: a live owner (say a frozen tab) made every other tab re-read
  // SQLite every 25 ms for as long as it held the lease. Waiting is now on the
  // owner's Web Lock, with a coarse backstop, not a tight poll.
  it('waits on a live owner\'s Web Lock instead of polling SQLite, and proceeds once it is released', async () => {
    let frozenWaits = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDatasetLeaseLocksForTests({
      request: async (name, callback) => {
        // The frozen owner holds its lock until released; any other lock is free.
        if (name === 'almamesh-dataset-lease:wl-frozen') {
          frozenWaits += 1;
          await released;
        }
        return callback();
      },
      query: async () => ({ held: [{ name: 'almamesh-dataset-lease:wl-frozen' }] }),
    });
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { restoreStartedAt: Date.now(), leaseOwner: 'wl-frozen' });
    let reads = 0;
    const transact = repository.transactWithResult.bind(repository);
    repository.transactWithResult = ((...args: Parameters<typeof transact>) => {
      reads += 1;
      return transact(...args);
    }) as typeof repository.transactWithResult;

    const acquiring = beginDatasetMutation();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2_300));
    // A 25 ms poll re-reads ~90 times in 2.3 s; waiting on the lock reads once,
    // plus one re-check per 1 s backstop, and queues ONE lock request.
    expect(reads).toBeLessThanOrEqual(4);
    expect(frozenWaits).toBe(1);

    // The owner settles its lease, then drops its lock: the waiter proceeds.
    seedLedger(sqlite, { restoreInProgress: false, leaseOwner: undefined });
    release();
    await expect(settleWithin(acquiring, 300)).resolves.toBeGreaterThan(2);
  });

  it('runs one recovery for every store that hydrates at boot', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, {
      restoreStartedAt: TEN_MINUTES_AGO(),
      leaseOwner: 'crashed-tab',
      profileIds: ['victim'],
    });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['survivor', 'victim']), 1);
    const before = sqlite.epoch;
    const read = sqlite.get.bind(sqlite);
    let ledgerReads = 0;
    sqlite.get = async (namespace, key) => {
      if (key === PORTABLE_LEDGER_KEY) ledgerReads += 1;
      return read(namespace, key);
    };

    const keys = [
      'almamesh-profiles',
      'almamesh-chart-library',
      'almamesh-life-events',
      'almamesh-rectification-records',
      'almamesh-chat-history',
      'almamesh-interpretations',
      'almamesh-mesh-readings',
      'almamesh-predictive',
    ];
    await Promise.all(keys.map((key) => deletionAwareIdbStorage.getItem(key)));

    expect(sqlite.epoch - before).toBe(1);
    // One recovery reads the ledger to decide, then once more to observe the result.
    expect(ledgerReads).toBe(2);
    expect(await ledgerOf(repository)).toMatchObject({ activeEpoch: 3, restoreInProgress: false });
  });
});

describe('dropped writes are visible', () => {
  it('reports a write refused because another realm holds the dataset lease', async () => {
    const { sqlite } = harness();
    seedLedger(sqlite, { restoreStartedAt: Date.now(), leaseOwner: 'other-tab' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');
    await deletionAwareIdbStorage.setItem('almamesh-profiles', profilesEnvelope(['a', 'b']));
    await flushPortablePersistence();

    expect(readDroppedWrites()).toEqual([
      expect.objectContaining({ key: 'almamesh-profiles', reason: 'dataset-busy' }),
    ]);
  });

  it('reports a write based on a generation another realm has replaced', async () => {
    const { sqlite } = harness();
    seedLedger(sqlite, { restoreStartedAt: Date.now(), leaseOwner: 'other-tab' });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');
    await commitDatasetGeneration(2, [
      { key: 'almamesh-profiles', value: profilesEnvelope(['replaced']) },
    ]);
    await deletionAwareIdbStorage.removeItem('almamesh-profiles');
    await flushPortablePersistence();

    expect(readDroppedWrites()).toEqual([
      expect.objectContaining({ key: 'almamesh-profiles', reason: 'stale-generation' }),
    ]);
  });

  it('does not report writes this realm\'s own lease refuses and then commits', async () => {
    const { sqlite, repository } = harness();
    seedLedger(sqlite, { restoreEpoch: 1, restoreInProgress: false });
    seedRow(sqlite, 'almamesh-profiles', profilesEnvelope(['a', 'victim']), 1);

    await deletionAwareIdbStorage.getItem('almamesh-profiles');
    const epoch = await beginDatasetMutation();
    const cascade = deletionAwareIdbStorage.setItem('almamesh-profiles', profilesEnvelope(['a']));
    await commitDatasetGeneration(
      epoch,
      [{ key: 'almamesh-profiles', value: profilesEnvelope(['a']) }],
      { adoptLocalWrites: true },
    );
    await cascade;
    await flushPortablePersistence();

    expect(readDroppedWrites()).toEqual([]);
    expect(profileIdsIn(await repository.read('almamesh-profiles'))).toEqual(['a']);
  });
});
