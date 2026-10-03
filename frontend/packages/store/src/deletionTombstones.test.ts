import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, get as idbGet, set as idbSet } from 'idb-keyval';
import type {
  SqliteStateImportStage,
  SqliteStateMutation,
  SqliteStateStore,
} from '@gainratio/browser/sqlite';
import { SqliteStateConflictError } from '@gainratio/browser/sqlite';

import {
  mergeDeletionTombstones,
  abortBackupRestore,
  beginBackupRestore,
  beginDatasetMutation,
  clearMemoryRebuildPending,
  commitDatasetGeneration,
  deletionAwareIdbStorage,
  portablePreferenceStorage,
  readDeletionTombstones,
  recordDeletionTombstones,
  sanitizePersistedValue,
  setPortableStateRepositoryForTests,
  whenPersistenceSettled,
  shouldAcceptRestoreEpoch,
  subtractRestoredTombstones,
  tagPersistedValue,
  type DeletionTombstones,
} from './deletionTombstones';
import {
  PORTABLE_LEDGER_KEY,
  PORTABLE_STATE_NAMESPACE,
  PortableStateRepository,
} from './portableState';
import {
  useChartLibraryStore,
  whenChartLibraryPersisted,
  type StoredChart,
} from './chartLibrary';

const TEST_INDEXED_DB = new IDBFactory();

class PortableMemoryStore implements SqliteStateStore {
  readonly name = 'portable-deletion-test';
  readonly values = new Map<string, { value: Uint8Array; revision: number }>();
  epoch = 0;
  conflictOnce = false;
  onConflict: ((store: PortableMemoryStore) => void) | undefined;
  batchDelayMs = 0;
  activeBatches = 0;
  maxActiveBatches = 0;
  failNext: Error | undefined;

  async get(namespace: string, key: string) {
    const row = this.values.get(`${namespace}/${key}`);
    return row === undefined ? undefined : { namespace, key, ...row };
  }
  async list(options: { namespace: string }) {
    const prefix = `${options.namespace}/`;
    return {
      rows: [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({
          namespace: options.namespace,
          key: key.slice(prefix.length),
          ...row,
        })),
    };
  }
  async batch(mutations: readonly SqliteStateMutation[], options = {}) {
    this.activeBatches += 1;
    this.maxActiveBatches = Math.max(this.maxActiveBatches, this.activeBatches);
    try {
      if (this.batchDelayMs > 0) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, this.batchDelayMs));
      }
      if (this.failNext !== undefined) {
        const error = this.failNext;
        this.failNext = undefined;
        throw error;
      }
      if (this.conflictOnce) {
        this.conflictOnce = false;
        this.epoch += 1;
        this.onConflict?.(this);
        throw new SqliteStateConflictError('simulated competing tab');
      }
      if (options.expectedEpoch !== undefined && options.expectedEpoch !== this.epoch) {
        throw new SqliteStateConflictError('stale');
      }
      this.epoch += 1;
      for (const mutation of mutations) {
        const key = `${mutation.namespace}/${mutation.key}`;
        if (mutation.type === 'delete') this.values.delete(key);
        else
          this.values.set(key, {
            value: mutation.value.slice(),
            revision: this.epoch,
          });
      }
      return { changed: mutations.length, epoch: this.epoch };
    } finally {
      this.activeBatches -= 1;
    }
  }
  put(namespace: string, key: string, value: Uint8Array, options = {}) {
    return this.batch([{ type: 'put', namespace, key, value }], options);
  }
  delete(namespace: string, key: string, options = {}) {
    return this.batch([{ type: 'delete', namespace, key }], options);
  }
  async runtimeInfo() {
    return {
      name: this.name,
      sqliteVersion: '3.53.4',
      persistence: 'memory' as const,
      ownership: 'isolated-worker' as const,
      schemaVersion: 1,
      epoch: this.epoch,
      rowCount: this.values.size,
    };
  }
  async checkIntegrity() {
    return { ok: true as const, message: 'ok' as const };
  }
  async exportBytes() {
    return new Uint8Array([1]);
  }
  async stageImport(): Promise<SqliteStateImportStage> {
    return {
      stageId: 'stage',
      schemaVersion: 1,
      epoch: 0,
      rowCount: 0,
      byteLength: 1,
    };
  }
  async discardImport() {}
  async commitImport() {
    return { changed: 0, epoch: this.epoch, schemaVersion: 1 };
  }
  async reset() {
    this.values.clear();
    return { changed: 0, epoch: ++this.epoch };
  }
  async migrate() {
    return { changed: 0, epoch: this.epoch, schemaVersion: 1 };
  }
  async dispose() {}

  setPortableValue(key: string, value: string): void {
    this.values.set(`${PORTABLE_STATE_NAMESPACE}/${key}`, {
      value: new TextEncoder().encode(value),
      revision: this.epoch,
    });
  }
}

const TOMBSTONES: DeletionTombstones = {
  version: 1,
  activeEpoch: 2,
  restoreEpoch: 2,
  restoreInProgress: false,
  profileIds: ['deleted-profile'],
  threadIds: ['deleted-thread'],
  chartIds: ['deleted-chart'],
};

function envelope(state: Record<string, unknown>): string {
  return JSON.stringify({ state, version: 1 });
}

function stateOf(value: string): Record<string, unknown> {
  return (JSON.parse(value) as { state: Record<string, unknown> }).state;
}

describe('deletion tombstones', () => {
  it('does not revive pending deletion IDs until a Replace commit succeeds', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: TEST_INDEXED_DB,
      configurable: true,
    });
    try {
      await recordDeletionTombstones({ profileIds: ['pending-victim'] });
      const deletionEpoch = (await readDeletionTombstones()).restoreEpoch;
      await abortBackupRestore(deletionEpoch);

      const restoreEpoch = await beginBackupRestore({
        profileIds: ['pending-victim'],
      });
      expect(await readDeletionTombstones()).toMatchObject({
        profileIds: ['pending-victim'],
        restoreInProgress: true,
      });
      await abortBackupRestore(restoreEpoch);
      expect(await readDeletionTombstones()).toMatchObject({
        profileIds: ['pending-victim'],
        restoreInProgress: false,
      });

      const cleanupEpoch = await beginDatasetMutation();
      await commitDatasetGeneration(cleanupEpoch, []);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDb,
        configurable: true,
      });
    }
  });

  it('serializes a reset behind an in-flight deletion without reviving either dataset', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: TEST_INDEXED_DB,
      configurable: true,
    });
    const store = createStore('keyval-store', 'keyval');
    try {
      const activeEpoch = (await readDeletionTombstones()).activeEpoch;
      const snapshot = envelope({
        profiles: { victim: { id: 'victim' }, survivor: { id: 'survivor' } },
      });
      await idbSet('almamesh-profiles', tagPersistedValue(snapshot, activeEpoch), store);

      const deleteEpoch = await beginDatasetMutation();
      await recordDeletionTombstones({ profileIds: ['victim'] }, deleteEpoch);
      let resetResolved = false;
      const resetEpochPromise = beginDatasetMutation().then((epoch) => {
        resetResolved = true;
        return epoch;
      });
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
      expect(resetResolved).toBe(false);

      await commitDatasetGeneration(deleteEpoch, [{ key: 'almamesh-profiles', value: snapshot }]);
      const resetEpoch = await resetEpochPromise;
      await commitDatasetGeneration(
        resetEpoch,
        [{ key: 'almamesh-profiles', value: null }],
        ['almamesh-chat-vectors'],
        { memoryRebuildPending: false },
      );

      expect(await deletionAwareIdbStorage.getItem('almamesh-profiles')).toBeNull();
      expect(await readDeletionTombstones()).toMatchObject({
        activeEpoch: resetEpoch,
        restoreInProgress: false,
        memoryRebuildPending: false,
        profileIds: [],
      });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDb,
        configurable: true,
      });
    }
  });

  it('serializes two realms and prevents the second stale snapshot from resurrecting the first victim', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: TEST_INDEXED_DB,
      configurable: true,
    });
    const store = createStore('keyval-store', 'keyval');
    try {
      const activeEpoch = (await readDeletionTombstones()).activeEpoch;
      const staleSnapshot = envelope({
        profiles: {
          a: { id: 'a' },
          b: { id: 'b' },
          survivor: { id: 'survivor' },
        },
      });
      await idbSet('almamesh-profiles', tagPersistedValue(staleSnapshot, activeEpoch), store);

      const firstEpoch = await beginDatasetMutation();
      await recordDeletionTombstones({ profileIds: ['a'] }, firstEpoch);
      let secondResolved = false;
      const secondEpochPromise = beginDatasetMutation().then((epoch) => {
        secondResolved = true;
        return epoch;
      });
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
      expect(secondResolved).toBe(false);

      await commitDatasetGeneration(firstEpoch, [
        { key: 'almamesh-profiles', value: staleSnapshot },
      ]);
      const secondEpoch = await secondEpochPromise;
      const synchronized = await deletionAwareIdbStorage.getItem('almamesh-profiles');
      await recordDeletionTombstones({ profileIds: ['b'] }, secondEpoch);
      await commitDatasetGeneration(secondEpoch, [
        { key: 'almamesh-profiles', value: synchronized },
      ]);

      const final = await deletionAwareIdbStorage.getItem('almamesh-profiles');
      expect(stateOf(final as string).profiles).toEqual({
        survivor: { id: 'survivor' },
      });
      expect(await readDeletionTombstones()).toMatchObject({
        restoreInProgress: false,
        profileIds: [],
        threadIds: [],
        chartIds: [],
      });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDb,
        configurable: true,
      });
    }
  });

  it('does not let a second destructive operation preempt an active generation lease', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: TEST_INDEXED_DB,
      configurable: true,
    });
    try {
      const firstEpoch = await beginBackupRestore({ profileIds: ['first'] });
      let secondResolved = false;
      const secondEpochPromise = beginBackupRestore({
        profileIds: ['second'],
      }).then((epoch) => {
        secondResolved = true;
        return epoch;
      });

      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
      expect(secondResolved).toBe(false);

      await abortBackupRestore(firstEpoch);
      const secondEpoch = await secondEpochPromise;
      expect(secondEpoch).toBeGreaterThan(firstEpoch);
      await abortBackupRestore(secondEpoch);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDb,
        configurable: true,
      });
    }
  });

  it('marks a derived-memory rebuild pending in the same commit that deletes vectors', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: TEST_INDEXED_DB,
      configurable: true,
    });
    const store = createStore('keyval-store', 'keyval');
    try {
      await idbSet('almamesh-chat-vectors', [{ id: 'old#0' }], store);
      const epoch = await beginBackupRestore({});

      await commitDatasetGeneration(epoch, [], ['almamesh-chat-vectors'], {
        memoryRebuildPending: true,
      });

      const ledger = await readDeletionTombstones();
      expect(ledger).toMatchObject({
        activeEpoch: epoch,
        restoreInProgress: false,
        memoryRebuildPending: true,
      });
      await clearMemoryRebuildPending(epoch - 1);
      expect(await readDeletionTombstones()).toMatchObject({
        memoryRebuildPending: true,
      });
      await clearMemoryRebuildPending(epoch);
      expect(await readDeletionTombstones()).toMatchObject({
        memoryRebuildPending: false,
      });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDb,
        configurable: true,
      });
    }
  });

  it('filters a victim vector before promoting a stale cached index into the new generation', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: TEST_INDEXED_DB,
      configurable: true,
    });
    const store = createStore('keyval-store', 'keyval');
    try {
      await idbSet(
        'almamesh-chat-vectors',
        {
          generation: 0,
          records: [
            {
              id: 'victim#0',
              profile_id: 'victim',
              thread_id: 'victim-thread',
            },
            {
              id: 'survivor#0',
              profile_id: 'survivor',
              thread_id: 'survivor-thread',
            },
          ],
        },
        store,
      );
      await recordDeletionTombstones({
        profileIds: ['victim'],
        threadIds: ['victim-thread'],
      });
      const ledger = await idbGet<DeletionTombstones>('almamesh-deletion-tombstones', store);

      await commitDatasetGeneration(
        ledger!.restoreEpoch,
        [
          {
            key: 'almamesh-profiles',
            value: envelope({ profiles: { survivor: { id: 'survivor' } } }),
          },
        ],
        [],
        { retagGenerationKeys: ['almamesh-chat-vectors'] },
      );

      const vectors = await idbGet<{
        generation: number;
        records: { id: string }[];
      }>('almamesh-chat-vectors', store);
      expect(vectors).toEqual({
        generation: ledger!.restoreEpoch,
        records: [
          {
            id: 'survivor#0',
            profile_id: 'survivor',
            thread_id: 'survivor-thread',
          },
        ],
      });
      const settled = await idbGet<DeletionTombstones>('almamesh-deletion-tombstones', store);
      expect(settled).toMatchObject({
        profileIds: [],
        threadIds: [],
        chartIds: [],
      });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDb,
        configurable: true,
      });
    }
  });

  it('keeps the old active generation readable after a crash mid-transaction', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: TEST_INDEXED_DB,
      configurable: true,
    });
    const store = createStore('keyval-store', 'keyval');
    try {
      const previousEpoch = (await readDeletionTombstones()).activeEpoch;
      const oldValue = JSON.stringify({
        state: { profiles: { old: { id: 'old' } } },
        version: 1,
        datasetEpoch: previousEpoch,
      });
      await idbSet('almamesh-profiles', oldValue, store);
      const epoch = await beginBackupRestore({});

      await expect(
        commitDatasetGeneration(
          epoch,
          [
            {
              key: 'almamesh-profiles',
              value: envelope({
                profiles: { replacement: { id: 'replacement' } },
              }),
            },
            {
              key: 'almamesh-chart-library',
              value: envelope({ charts: { replacement: {} } }),
            },
          ],
          [],
          {
            afterWrite: (index) => {
              if (index === 0) throw new Error('simulated tab crash');
            },
          },
        ),
      ).rejects.toThrow(/simulated tab crash/);

      expect(await idbGet('almamesh-profiles', store)).toBe(oldValue);
      expect(
        stateOf((await deletionAwareIdbStorage.getItem('almamesh-profiles')) as string).profiles,
      ).toEqual({
        old: { id: 'old' },
      });
      const crashedLedger = await idbGet<DeletionTombstones>('almamesh-deletion-tombstones', store);
      expect(crashedLedger).toMatchObject({
        activeEpoch: previousEpoch,
        restoreEpoch: epoch,
        restoreInProgress: true,
      });

      await abortBackupRestore(epoch);
      const recoveredLedger = await idbGet<DeletionTombstones>(
        'almamesh-deletion-tombstones',
        store,
      );
      expect(recoveredLedger).toMatchObject({
        activeEpoch: previousEpoch,
        restoreEpoch: epoch,
        restoreInProgress: false,
      });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: originalIndexedDb,
        configurable: true,
      });
    }
  });

  it('atomically mergeable ledger updates retain concurrent deletions', () => {
    const merged = mergeDeletionTombstones(
      {
        version: 1,
        activeEpoch: 3,
        restoreEpoch: 3,
        restoreInProgress: false,
        profileIds: ['first-profile'],
        threadIds: ['first-thread'],
        chartIds: [],
      },
      {
        profileIds: ['second-profile', 'first-profile'],
        threadIds: ['second-thread'],
        chartIds: ['second-chart'],
      },
    );

    expect(merged).toEqual({
      version: 1,
      activeEpoch: 3,
      restoreEpoch: 3,
      restoreInProgress: false,
      memoryRebuildPending: false,
      profileIds: ['first-profile', 'second-profile'],
      threadIds: ['first-thread', 'second-thread'],
      chartIds: ['second-chart'],
    });
  });

  it('a deliberate restore clears only tombstones for IDs present in that backup', () => {
    const restored = subtractRestoredTombstones(
      {
        version: 1,
        activeEpoch: 4,
        restoreEpoch: 4,
        restoreInProgress: false,
        profileIds: ['restored-profile', 'still-deleted-profile'],
        threadIds: ['restored-thread', 'still-deleted-thread'],
        chartIds: ['restored-chart', 'still-deleted-chart'],
      },
      {
        profileIds: ['restored-profile'],
        threadIds: ['restored-thread'],
        chartIds: ['restored-chart'],
      },
    );

    expect(restored).toEqual({
      version: 1,
      activeEpoch: 4,
      restoreEpoch: 4,
      restoreInProgress: false,
      memoryRebuildPending: false,
      profileIds: ['still-deleted-profile'],
      threadIds: ['still-deleted-thread'],
      chartIds: ['still-deleted-chart'],
    });
  });

  it('fences a realm that hydrated before a confirmed backup Replace', () => {
    expect(shouldAcceptRestoreEpoch(7, 8)).toBe(false);
    expect(shouldAcceptRestoreEpoch(8, 8)).toBe(true);
    expect(shouldAcceptRestoreEpoch(undefined, 8)).toBe(false);
    expect(shouldAcceptRestoreEpoch(undefined, 0)).toBe(true);
  });

  it('filters a stale realm snapshot across every profile-owned persistence key', () => {
    const snapshots = {
      'almamesh-profiles': {
        profiles: {
          'deleted-profile': { id: 'deleted-profile' },
          survivor: {
            id: 'survivor',
            relationship: 'spouse',
            relatedTo: 'deleted-profile',
          },
        },
        activeProfileId: 'deleted-profile',
      },
      'almamesh-chart-library': {
        charts: {
          'deleted-chart': { chart_id: 'deleted-chart' },
          'profile-chart': {
            chart_id: 'profile-chart',
            profile_id: 'deleted-profile',
          },
          survivor: { chart_id: 'survivor', profile_id: 'survivor' },
        },
      },
      'almamesh-life-events': {
        eventsByProfile: { 'deleted-profile': [{}], survivor: [{}] },
      },
      'almamesh-rectification-records': {
        recordsByProfile: { 'deleted-profile': {}, survivor: {} },
      },
      'almamesh-chat-history': {
        threads: {
          'deleted-thread': { id: 'deleted-thread', profile_id: 'survivor' },
          'profile-thread': {
            id: 'profile-thread',
            profile_id: 'deleted-profile',
          },
          survivor: { id: 'survivor', profile_id: 'survivor' },
        },
        messages: {
          'deleted-thread': [{}],
          'profile-thread': [{}],
          survivor: [{}],
        },
      },
      'almamesh-predictive': {
        status: 'ready',
        profileKey: 'deleted-profile',
        requestKey: 'private-request',
        rawContexts: { private: true },
      },
      'almamesh-interpretations': {
        byChart: {
          'deleted-chart': { status: 'complete', sections: {} },
          historical: {
            status: 'complete',
            sections: {},
            profileId: 'deleted-profile',
          },
          survivor: { status: 'complete', sections: {}, profileId: 'survivor' },
        },
      },
    } as const;

    const profiles = stateOf(
      sanitizePersistedValue(
        'almamesh-profiles',
        envelope(snapshots['almamesh-profiles']),
        TOMBSTONES,
      ),
    );
    expect(profiles.profiles).toEqual({ survivor: { id: 'survivor' } });
    expect(profiles.activeProfileId).toBe('survivor');

    const charts = stateOf(
      sanitizePersistedValue(
        'almamesh-chart-library',
        envelope(snapshots['almamesh-chart-library']),
        TOMBSTONES,
      ),
    );
    expect(charts.charts).toEqual({
      survivor: { chart_id: 'survivor', profile_id: 'survivor' },
    });

    const events = stateOf(
      sanitizePersistedValue(
        'almamesh-life-events',
        envelope(snapshots['almamesh-life-events']),
        TOMBSTONES,
      ),
    );
    expect(events.eventsByProfile).toEqual({ survivor: [{}] });

    const records = stateOf(
      sanitizePersistedValue(
        'almamesh-rectification-records',
        envelope(snapshots['almamesh-rectification-records']),
        TOMBSTONES,
      ),
    );
    expect(records.recordsByProfile).toEqual({ survivor: {} });

    const chat = stateOf(
      sanitizePersistedValue(
        'almamesh-chat-history',
        envelope(snapshots['almamesh-chat-history']),
        TOMBSTONES,
      ),
    );
    expect(chat.threads).toEqual({
      survivor: { id: 'survivor', profile_id: 'survivor' },
    });
    expect(chat.messages).toEqual({ survivor: [{}] });

    const predictive = stateOf(
      sanitizePersistedValue(
        'almamesh-predictive',
        envelope(snapshots['almamesh-predictive']),
        TOMBSTONES,
      ),
    );
    expect(predictive).toEqual({ status: 'idle' });

    const interpretations = stateOf(
      sanitizePersistedValue(
        'almamesh-interpretations',
        envelope(snapshots['almamesh-interpretations']),
        TOMBSTONES,
      ),
    );
    expect(interpretations.byChart).toEqual({
      survivor: { status: 'complete', sections: {}, profileId: 'survivor' },
    });
  });

  it('commits the canonical snapshot and generation ledger atomically through SQLite', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    const stale = envelope({
      profiles: { victim: { id: 'victim' }, survivor: { id: 'survivor' } },
    });
    try {
      await repository.write('almamesh-profiles', tagPersistedValue(stale, 0));
      const epoch = await beginDatasetMutation();
      await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
      const language = JSON.stringify({
        state: { language: 'es' },
        version: 1,
      });
      await commitDatasetGeneration(epoch, [
        { key: 'almamesh-profiles', value: stale },
        { key: 'almamesh-language', value: language },
      ]);

      const stored = await repository.read('almamesh-profiles');
      expect(stateOf(stored as string).profiles).toEqual({
        survivor: { id: 'survivor' },
      });
      expect(JSON.parse(stored as string)).toMatchObject({
        datasetEpoch: epoch,
      });
      expect(JSON.parse((await repository.read(PORTABLE_LEDGER_KEY)) as string)).toMatchObject({
        activeEpoch: epoch,
        restoreEpoch: epoch,
        restoreInProgress: false,
        profileIds: [],
      });
      expect(await repository.read('almamesh-language')).toBe(language);
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('stores language portably without mixing it into dataset generations', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    const language = JSON.stringify({ state: { language: 'pt' }, version: 1 });
    try {
      await portablePreferenceStorage.setItem('almamesh-language', language);
      expect(await repository.read('almamesh-language')).toBe(language);
      expect(JSON.parse((await repository.read('almamesh-language')) as string)).not.toHaveProperty(
        'datasetEpoch',
      );
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('commits a same-key persistence burst in invocation order without exhausting CAS retries', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    try {
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      const writes = Array.from({ length: 12 }, (_, sequence) =>
        sequence % 3 === 1
          ? deletionAwareIdbStorage.removeItem('almamesh-profiles')
          : deletionAwareIdbStorage.setItem('almamesh-profiles', envelope({ sequence })),
      );

      const settled = await Promise.allSettled(writes);
      expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(
        stateOf((await deletionAwareIdbStorage.getItem('almamesh-profiles')) as string),
      ).toMatchObject({ sequence: 11 });
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('keeps different SQLite store keys concurrent', async () => {
    const sqlite = new PortableMemoryStore();
    sqlite.batchDelayMs = 5;
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      await Promise.all([
        deletionAwareIdbStorage.setItem('almamesh-profiles', envelope({ profiles: {} })),
        deletionAwareIdbStorage.setItem(
          'almamesh-chat-history',
          envelope({ threads: {}, messages: {} }),
        ),
      ]);

      expect(sqlite.maxActiveBatches).toBe(2);
      expect(await repository.read('almamesh-profiles')).not.toBeNull();
      expect(await repository.read('almamesh-chat-history')).not.toBeNull();
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('continues a same-key queue after one persistence mutation fails', async () => {
    const sqlite = new PortableMemoryStore();
    sqlite.failNext = new Error('simulated write failure');
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      const settled = await Promise.allSettled([
        deletionAwareIdbStorage.setItem('almamesh-profiles', envelope({ sequence: 1 })),
        deletionAwareIdbStorage.setItem('almamesh-profiles', envelope({ sequence: 2 })),
      ]);

      expect(settled.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
      expect(
        stateOf((await deletionAwareIdbStorage.getItem('almamesh-profiles')) as string),
      ).toMatchObject({ sequence: 2 });
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('recomputes a dataset lease after a competing SQLite CAS write', async () => {
    const sqlite = new PortableMemoryStore();
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    sqlite.conflictOnce = true;
    sqlite.onConflict = (store) => {
      store.setPortableValue(
        PORTABLE_LEDGER_KEY,
        JSON.stringify({
          ...TOMBSTONES,
          activeEpoch: 5,
          restoreEpoch: 5,
          restoreInProgress: false,
          profileIds: [],
          threadIds: [],
          chartIds: [],
        }),
      );
    };
    try {
      const epoch = await beginDatasetMutation();
      expect(epoch).toBe(6);
      await abortBackupRestore(epoch);
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('does not report a tombstone append after its SQLite lease loses a CAS race', async () => {
    const sqlite = new PortableMemoryStore();
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      const epoch = await beginDatasetMutation();
      sqlite.conflictOnce = true;
      sqlite.onConflict = (store) => {
        store.setPortableValue(
          PORTABLE_LEDGER_KEY,
          JSON.stringify({
            ...TOMBSTONES,
            activeEpoch: epoch,
            restoreEpoch: epoch + 1,
            restoreInProgress: true,
            restoreStartedAt: Date.now(),
          }),
        );
      };

      await expect(recordDeletionTombstones({ profileIds: ['victim'] }, epoch)).rejects.toThrow(
        /lease is no longer active/,
      );
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('refuses a generation commit when a competing SQLite CAS replaces its lease', async () => {
    const sqlite = new PortableMemoryStore();
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      const epoch = await beginDatasetMutation();
      sqlite.conflictOnce = true;
      sqlite.onConflict = (store) => {
        store.setPortableValue(
          PORTABLE_LEDGER_KEY,
          JSON.stringify({
            ...TOMBSTONES,
            activeEpoch: epoch,
            restoreEpoch: epoch + 1,
            restoreInProgress: true,
            restoreStartedAt: Date.now(),
          }),
        );
      };

      await expect(
        commitDatasetGeneration(epoch, [{ key: 'almamesh-profiles', value: envelope({}) }]),
      ).rejects.toThrow(/generation is no longer active/);
      expect(await repository.read('almamesh-profiles')).toBeNull();
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });
});

describe('whenPersistenceSettled (durable-write barrier)', () => {
  const chart = (id: string): StoredChart =>
    ({
      chart_id: id,
      person_name: id,
      is_primary: true,
      astronomical_calculations: {
        sidereal_ctx: {
          julian_day: 0,
          ayanamsa_value: 24,
          ayanamsa_type: 'lahiri',
          house_system: 'whole_sign',
          sidereal_time: 0,
          lagna: {},
          planets: {},
        },
        calculation_timestamp: '1970-01-01T00:00:00.000Z',
        software_version: 'test',
      },
    }) as StoredChart;

  const storedChartIds = async (repository: PortableStateRepository): Promise<string[]> => {
    const stored = await repository.read('almamesh-chart-library');
    if (stored === null) return [];
    return Object.keys((stateOf(stored) as { charts: Record<string, unknown> }).charts);
  };

  it('resolves only after a rectified chart swap has committed to SQLite', async () => {
    const sqlite = new PortableMemoryStore();
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      // A fresh document load: hydrate from this repository, as the app does.
      await useChartLibraryStore.persist.rehydrate();
      useChartLibraryStore.getState().saveChart(chart('entered-0644'));
      await whenChartLibraryPersisted();
      sqlite.batchDelayMs = 25;

      // The regenerate sequence: save the new primary, then delete the orphan.
      useChartLibraryStore.getState().saveChart(chart('rectified-0614'));
      useChartLibraryStore.getState().deleteChart('entered-0644');
      // The in-memory store already shows the new chart; SQLite does not yet.
      expect(await storedChartIds(repository)).toEqual(['entered-0644']);

      await whenChartLibraryPersisted();
      expect(await storedChartIds(repository)).toEqual(['rectified-0614']);
    } finally {
      useChartLibraryStore.getState().clearAll();
      await whenChartLibraryPersisted();
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('resolves immediately when nothing is queued for the key', async () => {
    await expect(whenPersistenceSettled('almamesh-nothing-queued')).resolves.toBeUndefined();
  });

  it('settles rather than rejects when the queued write fails', async () => {
    const sqlite = new PortableMemoryStore();
    sqlite.failNext = new Error('disk full');
    setPortableStateRepositoryForTests(new PortableStateRepository(sqlite));
    try {
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      const write = deletionAwareIdbStorage.setItem('almamesh-profiles', envelope({}));
      await expect(whenPersistenceSettled('almamesh-profiles')).resolves.toBeUndefined();
      await expect(write).rejects.toThrow('disk full');
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });
});
