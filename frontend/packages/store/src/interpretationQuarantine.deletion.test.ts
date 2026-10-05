/**
 * Deleting a profile removes that profile's quarantined interpretation rows,
 * and Start fresh removes them all — inside the same SQLite batch that commits
 * the deletion generation, so a crash can never leave one without the other.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqliteStateMutation } from '@gainratio/browser/sqlite';

import {
  beginDatasetMutation,
  commitDatasetGeneration,
  interpretationQuarantineRows,
  recordDeletionTombstones,
  setPortableStateRepositoryForTests,
} from './deletionTombstones';
import {
  holdUnreadableInterpretation,
  readInterpretationQuarantine,
} from './interpretationQuarantine';
import {
  PORTABLE_LEDGER_KEY,
  PORTABLE_QUARANTINE_NAMESPACE,
  PortableStateRepository,
} from './portableState';
import { PortableMemoryStore } from './portableMemoryStore.testkit';

function readingsOf(profileId: string): string {
  return JSON.stringify({
    state: { byChart: { [`chart-${profileId}`]: { profileId, status: 'complete' } } },
    version: 99,
  });
}

async function seedQuarantine(): Promise<void> {
  const rows = await interpretationQuarantineRows();
  for (const raw of [readingsOf('victim'), readingsOf('survivor'), 'unparseable']) {
    expect(await holdUnreadableInterpretation({ source: 'canonical-sqlite', raw }, rows)).toBe(true);
  }
}

async function heldRaw(): Promise<string[]> {
  return (await readInterpretationQuarantine(await interpretationQuarantineRows()))
    .map((record) => record.raw)
    .sort();
}

function setupRepository(): PortableMemoryStore {
  const sqlite = new PortableMemoryStore();
  setPortableStateRepositoryForTests(new PortableStateRepository(sqlite));
  return sqlite;
}

afterEach(() => setPortableStateRepositoryForTests(undefined));

describe('profile delete removes that profile’s quarantine', () => {
  it('drops the deleted profile’s rows in the generation batch and keeps everyone else’s', async () => {
    const sqlite = setupRepository();
    await seedQuarantine();
    const batches: (readonly SqliteStateMutation[])[] = [];
    sqlite.beforeBatch = async (mutations) => {
      batches.push(mutations);
    };

    const epoch = await beginDatasetMutation();
    await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
    await commitDatasetGeneration(epoch, []);

    expect(await heldRaw()).toEqual([readingsOf('survivor'), 'unparseable'].sort());
    const generationBatch = batches.find((mutations) =>
      mutations.some((m) => m.key === PORTABLE_LEDGER_KEY && m.type === 'put' &&
        new TextDecoder().decode(m.value).includes('"restoreInProgress":false')),
    );
    expect(
      generationBatch?.some(
        (m) => m.type === 'delete' && m.namespace === PORTABLE_QUARANTINE_NAMESPACE,
      ),
    ).toBe(true);
  });

  it('also purges in the in-memory runtime (no SQLite repository)', async () => {
    setPortableStateRepositoryForTests(null);
    await seedQuarantine();

    const epoch = await beginDatasetMutation();
    await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
    await commitDatasetGeneration(epoch, []);

    expect(await heldRaw()).not.toContain(readingsOf('victim'));
  });
});

describe('reset clears the quarantine', () => {
  it('Start fresh removes every quarantined row, attributed or not', async () => {
    setupRepository();
    await seedQuarantine();

    const epoch = await beginDatasetMutation();
    await commitDatasetGeneration(epoch, [{ key: 'almamesh-interpretations', value: null }], {
      clearInterpretationQuarantine: true,
    });

    expect(await heldRaw()).toEqual([]);
  });

  it('a plain generation commit (e.g. a restore) leaves the quarantine alone', async () => {
    setupRepository();
    await seedQuarantine();

    const epoch = await beginDatasetMutation();
    await commitDatasetGeneration(epoch, []);

    expect(await heldRaw()).toHaveLength(3);
  });
});
