import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, get as idbGet, set as idbSet } from 'idb-keyval';
import type {
  SqliteStateImportStage,
  SqliteStateMutation,
  SqliteStateStore,
} from '@gainratio/browser/sqlite';
import { SqliteStateConflictError } from '@gainratio/browser/sqlite';

import {
  adoptLatestDatasetEpoch,
  mergeDeletionTombstones,
  abortBackupRestore,
  beginBackupRestore,
  beginDatasetMutation,
  clearMemoryRebuildPending,
  commitDatasetGeneration,
  deletionAwareIdbStorage,
  flushPortablePersistence,
  migrateLegacyPreferencesToRepository,
  portablePreferenceStorage,
  readCanonicalDatasetValue,
  readDeletionTombstones,
  refreshPortablePreferenceMirrors,
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
  beforeBatch:
    | ((mutations: readonly SqliteStateMutation[]) => Promise<void>)
    | undefined;

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
      await this.beforeBatch?.(mutations);
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

  it('deletes the stale vector index when committing a deletion generation', async () => {
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
        ['almamesh-chat-vectors'],
        { memoryRebuildPending: true },
      );

      expect(await idbGet('almamesh-chat-vectors', store)).toBeUndefined();
      const settled = await idbGet<DeletionTombstones>('almamesh-deletion-tombstones', store);
      expect(settled).toMatchObject({
        memoryRebuildPending: true,
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
        summaries: {
          'deleted-thread': { summary: 'deleted thread summary' },
          'profile-thread': { summary: 'deleted profile summary' },
          survivor: { summary: 'surviving summary' },
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
      'almamesh-mesh-readings': {
        byPair: {
          'deleted-profile|survivor': {
            profileIds: ['deleted-profile', 'survivor'],
            reading: { private: true },
          },
          'survivor|friend': {
            profileIds: ['survivor', 'friend'],
            reading: { safe: true },
          },
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
    expect(chat.summaries).toEqual({
      survivor: { summary: 'surviving summary' },
    });

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

    const meshReadings = stateOf(
      sanitizePersistedValue(
        'almamesh-mesh-readings',
        envelope(snapshots['almamesh-mesh-readings']),
        TOMBSTONES,
      ),
    );
    expect(meshReadings.byPair).toEqual({
      'survivor|friend': {
        profileIds: ['survivor', 'friend'],
        reading: { safe: true },
      },
    });
  });

  it('reassigns a deleted active profile to the earliest-created survivor', () => {
    const profiles = stateOf(
      sanitizePersistedValue(
        'almamesh-profiles',
        envelope({
          profiles: {
            'deleted-profile': {
              id: 'deleted-profile',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
            'inserted-first': {
              id: 'inserted-first',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            'created-first': {
              id: 'created-first',
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
          activeProfileId: 'deleted-profile',
        }),
        TOMBSTONES,
      ),
    );

    expect(profiles.activeProfileId).toBe('created-first');
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

  it('adopts a newer durable generation after this realm misses its broadcast', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    try {
      await repository.write(PORTABLE_LEDGER_KEY, JSON.stringify({
        version: 1,
        activeEpoch: 0,
        restoreEpoch: 0,
        restoreInProgress: false,
        memoryRebuildPending: false,
        profileIds: [],
        threadIds: [],
        chartIds: [],
      }));
      await readDeletionTombstones();
      await repository.write(PORTABLE_LEDGER_KEY, JSON.stringify({
        version: 1,
        activeEpoch: 1,
        restoreEpoch: 1,
        restoreInProgress: false,
        memoryRebuildPending: false,
        profileIds: [],
        threadIds: [],
        chartIds: [],
      }));

      await expect(adoptLatestDatasetEpoch()).resolves.toEqual({ changed: true, epoch: 1 });
      await expect(adoptLatestDatasetEpoch()).resolves.toEqual({ changed: false, epoch: 1 });
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('deletes from the latest canonical row without losing another tab\'s paid artifact', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    const canonical = envelope({
      byPair: {
        'victim|friend': { profileIds: ['victim', 'friend'], reading: { remove: true } },
        'survivor|friend': { profileIds: ['survivor', 'friend'], reading: { paid: true } },
      },
    });
    const staleTab = envelope({
      byPair: {
        'victim|friend': { profileIds: ['victim', 'friend'], reading: { remove: true } },
      },
    });
    try {
      await repository.write('almamesh-mesh-readings', tagPersistedValue(canonical, 0));
      const epoch = await beginDatasetMutation();
      await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
      await commitDatasetGeneration(
        epoch,
        [{ key: 'almamesh-mesh-readings', value: staleTab }],
        [],
        { sanitizeCanonicalKeys: ['almamesh-mesh-readings'] },
      );

      expect(stateOf((await repository.read('almamesh-mesh-readings')) as string).byPair).toEqual({
        'survivor|friend': {
          profileIds: ['survivor', 'friend'],
          reading: { paid: true },
        },
      });
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

  it('flushes an in-flight preference write before the export boundary proceeds', async () => {
    const sqlite = new PortableMemoryStore();
    sqlite.batchDelayMs = 20;
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      void portablePreferenceStorage.setItem(
        'almamesh-content-mode',
        JSON.stringify({ contentMode: 'technical' }),
      );

      await flushPortablePersistence();

      expect(await repository.read('almamesh-preferences')).toContain('technical');
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('verifies legacy preferences in SQLite before deleting every Web Storage copy', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const legacy = new Map<string, string>([
      ['almamesh-llm-settings', JSON.stringify({ apiKey: 'synthetic-migration-key' })],
      ['almamesh-content-mode', JSON.stringify({ contentMode: 'technical' })],
      ['almamesh-chart', '1'],
      ['almamesh-restore-epoch', '7'],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => legacy.get(key) ?? null,
        setItem: (key: string, value: string) => void legacy.set(key, value),
        removeItem: (key: string) => void legacy.delete(key),
      },
    });
    try {
      await migrateLegacyPreferencesToRepository(repository);

      expect(await repository.read('almamesh-preferences')).toContain(
        'synthetic-migration-key',
      );
      expect(await repository.read('almamesh-preferences')).toContain('technical');
      expect(legacy.size).toBe(0);
    } finally {
      if (originalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
    }
  });

  it('keeps legacy preferences when SQLite is only an in-memory session fallback', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const legacy = new Map<string, string>([
      ['almamesh-llm-settings', JSON.stringify({ apiKey: 'synthetic-memory-key' })],
      ['almamesh-content-mode', JSON.stringify({ contentMode: 'technical' })],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => legacy.get(key) ?? null,
        setItem: (key: string, value: string) => void legacy.set(key, value),
        removeItem: (key: string) => void legacy.delete(key),
      },
    });
    try {
      await migrateLegacyPreferencesToRepository(repository, false);

      expect(await repository.read('almamesh-preferences')).toContain('synthetic-memory-key');
      expect(legacy.has('almamesh-llm-settings')).toBe(true);
      expect(legacy.has('almamesh-content-mode')).toBe(true);
    } finally {
      if (originalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
    }
  });

  it('uses an existing SQLite preference row as the migration marker and cannot resurrect stale legacy values', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const canonical = JSON.stringify({
      version: 1,
      values: { 'almamesh-llm-settings': JSON.stringify({ apiKey: 'canonical-key' }) },
    });
    await repository.write('almamesh-preferences', canonical);
    const legacy = new Map<string, string>([
      ['almamesh-llm-settings', JSON.stringify({ apiKey: 'stale-key' })],
    ]);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => legacy.get(key) ?? null,
        setItem: (key: string, value: string) => void legacy.set(key, value),
        removeItem: (key: string) => void legacy.delete(key),
      },
    });
    try {
      await migrateLegacyPreferencesToRepository(repository);

      expect(await repository.read('almamesh-preferences')).toBe(canonical);
      expect(legacy.size).toBe(0);
    } finally {
      if (originalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
    }
  });

  it('fences a delayed preference write from a stale browser realm after Replace commits', async () => {
    const sqlite = new PortableMemoryStore();
    const repository = new PortableStateRepository(sqlite);
    const staleWriteEntered = Promise.withResolvers<void>();
    const releaseStaleWrite = Promise.withResolvers<void>();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const mirror = new Map<string, string>();
    let blockStaleWrite = true;
    let importingRealm:
      | typeof import('./deletionTombstones')
      | undefined;
    setPortableStateRepositoryForTests(repository);
    try {
      // Realm B has hydrated the old preference generation and begins a write,
      // but its SQLite CAS is delayed until after Realm A completes Replace.
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: (key: string) => mirror.get(key) ?? null,
          setItem: (key: string, value: string) => void mirror.set(key, value),
          removeItem: (key: string) => void mirror.delete(key),
        },
      });
      await portablePreferenceStorage.getItem('almamesh-llm-settings');
      sqlite.beforeBatch = async (mutations) => {
        const stalePreference = mutations.some(
          (mutation) =>
            mutation.type === 'put' &&
            mutation.key === 'almamesh-preferences' &&
            new TextDecoder().decode(mutation.value).includes('stale-key'),
        );
        if (!blockStaleWrite || !stalePreference) return;
        staleWriteEntered.resolve();
        await releaseStaleWrite.promise;
      };
      const staleSettings = JSON.stringify({ apiKey: 'stale-key' });
      // The existing synchronous LLM API updates its disposable mirror before
      // its configured SQLite writer settles.
      mirror.set('almamesh-llm-settings', staleSettings);
      const staleWrite = portablePreferenceStorage.setItem(
        'almamesh-llm-settings',
        staleSettings,
      );
      await staleWriteEntered.promise;

      vi.resetModules();
      importingRealm = await import('./deletionTombstones');
      importingRealm.setPortableStateRepositoryForTests(repository);
      const epoch = await importingRealm.beginBackupRestore({});
      await importingRealm.commitDatasetGeneration(epoch, [
        {
          key: 'almamesh-preferences',
          value: JSON.stringify({
            version: 1,
            values: {
              'almamesh-llm-settings': JSON.stringify({ apiKey: 'imported-key' }),
            },
          }),
        },
      ]);

      blockStaleWrite = false;
      releaseStaleWrite.resolve();
      await staleWrite;

      expect(await repository.read('almamesh-preferences')).toContain('imported-key');
      expect(await repository.read('almamesh-preferences')).not.toContain('stale-key');
      // The stale Web Storage copy is never repaired or trusted. Canonical
      // SQLite remains imported-key and boot hydration reconstructs memory.
      expect(mirror.get('almamesh-llm-settings')).toContain('stale-key');
    } finally {
      blockStaleWrite = false;
      releaseStaleWrite.resolve();
      importingRealm?.setPortableStateRepositoryForTests(undefined);
      setPortableStateRepositoryForTests(undefined);
      if (originalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
    }
  });

  it('adopts a replaced preference generation and permits a fresh canonical write', async () => {
    const sqlite = new PortableMemoryStore();
    const repository = new PortableStateRepository(sqlite);
    const importedSettings = JSON.stringify({ apiKey: 'imported-key' });
    sqlite.setPortableValue(
      PORTABLE_LEDGER_KEY,
      JSON.stringify({
        version: 1,
        activeEpoch: 1,
        restoreEpoch: 1,
        restoreInProgress: false,
        memoryRebuildPending: false,
        profileIds: [],
        threadIds: [],
        chartIds: [],
      }),
    );
    sqlite.setPortableValue(
      'almamesh-preferences',
      JSON.stringify({
        version: 1,
        values: { 'almamesh-llm-settings': importedSettings },
      }),
    );
    setPortableStateRepositoryForTests(repository);
    try {
      await refreshPortablePreferenceMirrors();

      await expect(portablePreferenceStorage.getItem('almamesh-llm-settings')).resolves.toBe(
        importedSettings,
      );
      await portablePreferenceStorage.setItem(
        'almamesh-llm-settings',
        JSON.stringify({ apiKey: 'fresh-key' }),
      );
      expect(await repository.read('almamesh-preferences')).toContain('fresh-key');
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('keeps canonical SQLite writable when Web Storage is blocked', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const canonical = JSON.stringify({
      version: 1,
      values: { 'almamesh-llm-settings': JSON.stringify({ apiKey: 'canonical-key' }) },
    });
    await repository.write('almamesh-preferences', canonical);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('Storage blocked', 'SecurityError');
        },
        removeItem: () => {
          throw new DOMException('Storage blocked', 'SecurityError');
        },
      },
    });
    setPortableStateRepositoryForTests(repository);
    try {
      await expect(refreshPortablePreferenceMirrors()).resolves.toBeUndefined();
      expect(await repository.read('almamesh-preferences')).toBe(canonical);
      await portablePreferenceStorage.setItem(
        'almamesh-llm-settings',
        JSON.stringify({ apiKey: 'stale-ui-key' }),
      );
      expect(await repository.read('almamesh-preferences')).toContain('stale-ui-key');
    } finally {
      setPortableStateRepositoryForTests(undefined);
      if (originalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
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
      await deletionAwareIdbStorage.getItem('almamesh-chat-history');
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

  it('merges independent same-generation additions from another tab', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    const initial = envelope({
      profiles: {
        original: { id: 'original', name: 'Original' },
      },
      activeProfileId: 'original',
    });
    try {
      await repository.write('almamesh-profiles', tagPersistedValue(initial, 0));
      await deletionAwareIdbStorage.getItem('almamesh-profiles');

      await repository.write(
        'almamesh-profiles',
        tagPersistedValue(
          envelope({
            profiles: {
              original: { id: 'original', name: 'Original' },
              'tab-a': { id: 'tab-a', name: 'From tab A' },
            },
            activeProfileId: 'original',
          }),
          0,
        ),
      );
      await deletionAwareIdbStorage.setItem(
        'almamesh-profiles',
        envelope({
          profiles: {
            original: { id: 'original', name: 'Original' },
            'tab-b': { id: 'tab-b', name: 'From tab B' },
          },
          activeProfileId: 'original',
        }),
      );

      expect(
        stateOf((await repository.read('almamesh-profiles')) as string).profiles,
      ).toEqual({
        original: { id: 'original', name: 'Original' },
        'tab-a': { id: 'tab-a', name: 'From tab A' },
        'tab-b': { id: 'tab-b', name: 'From tab B' },
      });
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('does not let an export read replace the live store merge base', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    const initial = envelope({ profiles: { original: { id: 'original' } } });
    try {
      await repository.write('almamesh-profiles', tagPersistedValue(initial, 0));
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      await repository.write(
        'almamesh-profiles',
        tagPersistedValue(
          envelope({
            profiles: { original: { id: 'original' }, remote: { id: 'remote' } },
          }),
          0,
        ),
      );

      await expect(readCanonicalDatasetValue('almamesh-profiles')).resolves.toContain('remote');
      await deletionAwareIdbStorage.setItem(
        'almamesh-profiles',
        envelope({ profiles: { original: { id: 'original' }, local: { id: 'local' } } }),
      );

      expect(
        stateOf((await repository.read('almamesh-profiles')) as string).profiles,
      ).toEqual({ original: { id: 'original' }, remote: { id: 'remote' }, local: { id: 'local' } });
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('keeps one anchor and one primary chart under conflicting tab changes', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    try {
      const profiles = envelope({
        profiles: {
          a: { id: 'a', name: 'A' },
          b: { id: 'b', name: 'B' },
        },
        activeProfileId: 'a',
      });
      await repository.write('almamesh-profiles', tagPersistedValue(profiles, 0));
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      await repository.write(
        'almamesh-profiles',
        tagPersistedValue(
          envelope({
            profiles: {
              a: { id: 'a', name: 'A', relationship: 'self' },
              b: { id: 'b', name: 'B' },
            },
            activeProfileId: 'a',
          }),
          0,
        ),
      );
      await deletionAwareIdbStorage.setItem(
        'almamesh-profiles',
        envelope({
          profiles: {
            a: { id: 'a', name: 'A' },
            b: { id: 'b', name: 'B', relationship: 'self' },
          },
          activeProfileId: 'a',
        }),
      );
      const mergedProfiles = stateOf((await repository.read('almamesh-profiles')) as string)
        .profiles as Record<string, Record<string, unknown>>;
      expect(Object.values(mergedProfiles).filter((profile) => profile.relationship === 'self'))
        .toHaveLength(1);
      expect(mergedProfiles.b.relationship).toBe('self');

      const charts = envelope({
        charts: {
          original: { chart_id: 'original', profile_id: 'a', is_primary: false },
        },
      });
      await repository.write('almamesh-chart-library', tagPersistedValue(charts, 0));
      await deletionAwareIdbStorage.getItem('almamesh-chart-library');
      await repository.write(
        'almamesh-chart-library',
        tagPersistedValue(
          envelope({
            charts: {
              original: { chart_id: 'original', profile_id: 'a', is_primary: false },
              remote: { chart_id: 'remote', profile_id: 'a', is_primary: true },
            },
          }),
          0,
        ),
      );
      await deletionAwareIdbStorage.setItem(
        'almamesh-chart-library',
        envelope({
          charts: {
            original: { chart_id: 'original', profile_id: 'a', is_primary: false },
            local: { chart_id: 'local', profile_id: 'a', is_primary: true },
          },
        }),
      );
      const mergedCharts = stateOf((await repository.read('almamesh-chart-library')) as string)
        .charts as Record<string, Record<string, unknown>>;
      expect(Object.values(mergedCharts).filter((chart) => chart.is_primary === true))
        .toHaveLength(1);
      expect(mergedCharts.local.is_primary).toBe(true);
      expect(mergedCharts.remote.is_primary).toBe(false);
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('allows the committing realm to persist immediately after a local deletion generation', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    try {
      const before = envelope({ threads: { deleted: { id: 'deleted' } }, messages: {}, summaries: {} });
      await repository.write('almamesh-chat-history', tagPersistedValue(before, 0));
      await deletionAwareIdbStorage.getItem('almamesh-chat-history');
      const epoch = await beginDatasetMutation();
      const after = envelope({ threads: {}, messages: {}, summaries: {} });
      await commitDatasetGeneration(
        epoch,
        [{ key: 'almamesh-chat-history', value: after }],
        [],
        { adoptLocalWrites: true },
      );

      await deletionAwareIdbStorage.setItem(
        'almamesh-chat-history',
        envelope({
          threads: { fresh: { id: 'fresh', title: null, updated_at: '2026-01-01T00:00:00Z' } },
          messages: { fresh: [] },
          summaries: {},
        }),
      );
      expect(
        stateOf((await repository.read('almamesh-chat-history')) as string).threads,
      ).toHaveProperty('fresh');
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('merges concurrent chat appends without reviving a remotely deleted thread', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    const thread = {
      id: 'thread',
      profile_id: 'profile',
      title: 'Original',
      updated_at: '2026-01-01T00:00:00.000Z',
      message_count: 1,
    };
    const first = {
      id: 'first',
      thread_id: 'thread',
      role: 'user',
      content: 'First',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const initial = envelope({
      threads: { thread },
      messages: { thread: [first] },
      summaries: {},
    });
    try {
      await repository.write('almamesh-chat-history', tagPersistedValue(initial, 0));
      await deletionAwareIdbStorage.getItem('almamesh-chat-history');

      const fromTabA = {
        id: 'tab-a',
        thread_id: 'thread',
        role: 'assistant',
        content: 'From A',
        created_at: '2026-01-01T00:00:01.000Z',
      };
      await repository.write(
        'almamesh-chat-history',
        tagPersistedValue(
          envelope({
            threads: {
              thread: {
                ...thread,
                updated_at: fromTabA.created_at,
                message_count: 2,
              },
            },
            messages: { thread: [first, fromTabA] },
            summaries: {},
          }),
          0,
        ),
      );
      const fromTabB = {
        id: 'tab-b',
        thread_id: 'thread',
        role: 'assistant',
        content: 'From B',
        created_at: '2026-01-01T00:00:02.000Z',
      };
      await deletionAwareIdbStorage.setItem(
        'almamesh-chat-history',
        envelope({
          threads: {
            thread: {
              ...thread,
              updated_at: fromTabB.created_at,
              message_count: 2,
            },
          },
          messages: { thread: [first, fromTabB] },
          summaries: {},
        }),
      );

      const merged = stateOf((await repository.read('almamesh-chat-history')) as string);
      expect((merged.messages as Record<string, Array<{ id: string }>>).thread.map(({ id }) => id))
        .toEqual(['first', 'tab-a', 'tab-b']);
      expect((merged.threads as Record<string, { message_count: number }>).thread.message_count)
        .toBe(3);

      await deletionAwareIdbStorage.getItem('almamesh-chat-history');
      await repository.write(
        'almamesh-chat-history',
        tagPersistedValue(envelope({ threads: {}, messages: {}, summaries: {} }), 0),
      );
      await deletionAwareIdbStorage.setItem(
        'almamesh-chat-history',
        envelope({
          threads: { thread },
          messages: { thread: [first, fromTabB] },
          summaries: {},
        }),
      );
      expect(stateOf((await repository.read('almamesh-chat-history')) as string)).toMatchObject({
        threads: {},
        messages: {},
      });
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

  it('keeps a rejected canonical preference write visible to the export flush until retried', async () => {
    const sqlite = new PortableMemoryStore();
    sqlite.failNext = new Error('simulated canonical settings failure');
    const repository = new PortableStateRepository(sqlite);
    setPortableStateRepositoryForTests(repository);
    try {
      await expect(
        portablePreferenceStorage.setItem(
          'almamesh-llm-settings',
          JSON.stringify({ apiKey: 'synthetic-key' }),
        ),
      ).rejects.toThrow('simulated canonical settings failure');

      await expect(flushPortablePersistence()).rejects.toThrow(
        'simulated canonical settings failure',
      );
      expect(await repository.read('almamesh-preferences')).toBeNull();

      await portablePreferenceStorage.setItem(
        'almamesh-llm-settings',
        JSON.stringify({ apiKey: 'synthetic-key' }),
      );
      await expect(flushPortablePersistence()).resolves.toBeUndefined();
      expect(await repository.read('almamesh-preferences')).toContain('synthetic-key');
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

  it('does not let stale same-realm Zustand state overwrite a completed backup import', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    const imported = envelope({
      profiles: { imported: { id: 'imported', name: 'Imported' } },
      activeProfileId: 'imported',
    });
    const stale = envelope({
      profiles: { stale: { id: 'stale', name: 'Pre-import state' } },
      activeProfileId: 'stale',
    });
    try {
      // Zustand hydrated this row before the user started the import.
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      await deletionAwareIdbStorage.setItem('almamesh-profiles', stale);
      await portablePreferenceStorage.getItem('almamesh-llm-settings');

      const epoch = await beginBackupRestore({ profileIds: ['imported'] });
      await commitDatasetGeneration(epoch, [
        { key: 'almamesh-profiles', value: imported },
        {
          key: 'almamesh-preferences',
          value: JSON.stringify({
            version: 1,
            values: {
              'almamesh-llm-settings': JSON.stringify({ apiKey: 'imported-key' }),
            },
          }),
        },
      ]);

      // A render/effect from the still-live pre-import tree must be fenced until
      // this store explicitly rehydrates the newly committed generation.
      await deletionAwareIdbStorage.setItem('almamesh-profiles', stale);
      expect(stateOf((await repository.read('almamesh-profiles')) as string).profiles).toEqual({
        imported: { id: 'imported', name: 'Imported' },
      });
      await portablePreferenceStorage.setItem(
        'almamesh-llm-settings',
        JSON.stringify({ apiKey: 'stale-key' }),
      );
      expect(await repository.read('almamesh-preferences')).toContain('imported-key');
      expect(await repository.read('almamesh-preferences')).not.toContain('stale-key');

      // Once this realm explicitly adopts the imported preference generation,
      // new user changes remain possible without requiring a process restart.
      expect(await portablePreferenceStorage.getItem('almamesh-llm-settings')).toContain(
        'imported-key',
      );
      await portablePreferenceStorage.setItem(
        'almamesh-llm-settings',
        JSON.stringify({ apiKey: 'fresh-key' }),
      );
      expect(await repository.read('almamesh-preferences')).toContain('fresh-key');
      await deletionAwareIdbStorage.removeItem('almamesh-profiles');
      expect(await repository.read('almamesh-profiles')).not.toBeNull();

      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      const fresh = envelope({
        profiles: { imported: { id: 'imported', name: 'Freshly edited' } },
        activeProfileId: 'imported',
      });
      await deletionAwareIdbStorage.setItem('almamesh-profiles', fresh);
      expect(stateOf((await repository.read('almamesh-profiles')) as string).profiles).toEqual({
        imported: { id: 'imported', name: 'Freshly edited' },
      });
    } finally {
      setPortableStateRepositoryForTests(undefined);
    }
  });

  it('commits a restore without reading or writing blocked Web Storage', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => {
          throw new Error('localStorage blocked');
        },
      },
    });
    setPortableStateRepositoryForTests(repository);
    try {
      const epoch = await beginBackupRestore({ profileIds: ['imported'] });
      await expect(
        commitDatasetGeneration(epoch, [
          { key: 'almamesh-profiles', value: envelope({ profiles: {} }) },
        ]),
      ).resolves.toBeUndefined();
      expect(JSON.parse((await repository.read(PORTABLE_LEDGER_KEY)) as string)).toMatchObject({
        activeEpoch: epoch,
        restoreEpoch: epoch,
        restoreInProgress: false,
      });
    } finally {
      setPortableStateRepositoryForTests(undefined);
      if (originalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
    }
  });

  it('does not report import failure when derived cache cleanup fails after the SQLite flip', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    const originalIndexedDb = globalThis.indexedDB;
    setPortableStateRepositoryForTests(repository);
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open: () => {
          throw new Error('derived IndexedDB is blocked');
        },
      },
    });
    try {
      const epoch = await beginBackupRestore({ profileIds: ['imported'] });
      await expect(
        commitDatasetGeneration(
          epoch,
          [{ key: 'almamesh-profiles', value: envelope({ profiles: { imported: {} } }) }],
          ['almamesh-chat-vectors'],
          { memoryRebuildPending: true },
        ),
      ).resolves.toBeUndefined();
      expect(stateOf((await repository.read('almamesh-profiles')) as string).profiles).toEqual({
        imported: {},
      });
      expect(JSON.parse((await repository.read(PORTABLE_LEDGER_KEY)) as string)).toMatchObject({
        activeEpoch: epoch,
        restoreInProgress: false,
        memoryRebuildPending: true,
      });
    } finally {
      setPortableStateRepositoryForTests(undefined);
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: originalIndexedDb,
      });
    }
  });
});

describe('derived IndexedDB caches beside the SQLite ledger', () => {
  // Production keeps the canonical ledger in SQLite; the IndexedDB keyval
  // store holds only derived caches (the predictive store) and has no ledger.
  // Reading such a cache used to publish the EMPTY IndexedDB ledger (epoch 0)
  // as this realm's observed restore epoch, so after any restore or deletion:
  // - every startup/visibility reconcile saw a "newer dataset" and replayed a
  //   full dataset replace (CI run 37098561922: a click on Generate waited
  //   behind it past the 30 s budget, 0 provider calls), and
  // - portable writes were refused as stale until the next ledger read.
  async function withSqliteAtEpochOne(run: (repository: PortableStateRepository) => Promise<void>) {
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), configurable: true });
    const repository = new PortableStateRepository(new PortableMemoryStore());
    setPortableStateRepositoryForTests(repository);
    try {
      const epoch = await beginDatasetMutation();
      await commitDatasetGeneration(epoch, []);
      expect(epoch).toBe(1);
      // idb-keyval binds its keyval store once per module, so clear the cache row.
      await deletionAwareIdbStorage.removeItem('almamesh-predictive');
      await run(repository);
    } finally {
      setPortableStateRepositoryForTests(undefined);
      Object.defineProperty(globalThis, 'indexedDB', { value: originalIndexedDb, configurable: true });
    }
  }

  it('reading a derived cache does not make the current dataset look newer', async () => {
    await withSqliteAtEpochOne(async () => {
      expect((await adoptLatestDatasetEpoch()).changed).toBe(false);
      await deletionAwareIdbStorage.getItem('almamesh-predictive');
      expect(await adoptLatestDatasetEpoch()).toEqual({ changed: false, epoch: 1 });
    });
  });

  it('a portable write after a derived-cache read is persisted, not refused as stale', async () => {
    await withSqliteAtEpochOne(async () => {
      await deletionAwareIdbStorage.getItem('almamesh-profiles');
      await deletionAwareIdbStorage.getItem('almamesh-predictive');
      await deletionAwareIdbStorage.setItem('almamesh-profiles', envelope({ kept: true }));
      expect(
        stateOf((await deletionAwareIdbStorage.getItem('almamesh-profiles')) as string),
      ).toMatchObject({ kept: true });
    });
  });

  it('a derived cache still round-trips after a restore', async () => {
    await withSqliteAtEpochOne(async () => {
      await deletionAwareIdbStorage.getItem('almamesh-predictive');
      await deletionAwareIdbStorage.setItem('almamesh-predictive', envelope({ cached: 1 }));
      expect(
        stateOf((await deletionAwareIdbStorage.getItem('almamesh-predictive')) as string),
      ).toEqual({ cached: 1 });
    });
  });

  it('a fresh realm adopting an untouched ledger does not replay a dataset replace', async () => {
    // A first visit has no restore-epoch mirror. Before any store read, the
    // startup reconcile adopts the ledger; generation 0 with no restore in
    // progress is the dataset this realm is already showing. Treating the
    // unset epoch as "changed" replays a full replace that rehydrates every
    // store mid-boot (Dagger pdf: the synthetic report lost its reading).
    // main hid this only because the predictive cache read happened to set 0.
    vi.resetModules();
    const fresh = await import('./deletionTombstones');
    fresh.setPortableStateRepositoryForTests(new PortableStateRepository(new PortableMemoryStore()));
    try {
      expect(await fresh.adoptLatestDatasetEpoch()).toEqual({ changed: false, epoch: 0 });
    } finally {
      fresh.setPortableStateRepositoryForTests(undefined);
    }
  });

  it('a fresh realm whose ledger already moved past generation 0 still reconciles', async () => {
    vi.resetModules();
    const fresh = await import('./deletionTombstones');
    const repository = new PortableStateRepository(new PortableMemoryStore());
    await repository.write(PORTABLE_LEDGER_KEY, JSON.stringify({ ...TOMBSTONES, profileIds: [] }));
    fresh.setPortableStateRepositoryForTests(repository);
    try {
      expect(await fresh.adoptLatestDatasetEpoch()).toEqual({ changed: true, epoch: 2 });
    } finally {
      fresh.setPortableStateRepositoryForTests(undefined);
    }
  });

  it.each([
    ['another tab committed a newer dataset', { restoreEpoch: 2, activeEpoch: 2, restoreInProgress: false }],
    ['a restore is in progress', { restoreEpoch: 1, activeEpoch: 1, restoreInProgress: true }],
  ])('refuses a derived-cache write when %s', async (_case, ledger) => {
    await withSqliteAtEpochOne(async (repository) => {
      await repository.write(PORTABLE_LEDGER_KEY, JSON.stringify({ ...TOMBSTONES, ...ledger }));
      await deletionAwareIdbStorage.setItem('almamesh-predictive', envelope({ stale: true }));
      expect(await deletionAwareIdbStorage.getItem('almamesh-predictive')).toBeNull();
    });
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
