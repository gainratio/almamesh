import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setPortableStateRepositoryForTests, whenPersistenceSettled } from './deletionTombstones';
import { useInterpretationStore, whenInterpretationHydrated } from './interpretation';
import {
  readInterpretationQuarantine,
  repositoryQuarantineRows,
} from './interpretationQuarantine';
import { PORTABLE_QUARANTINE_NAMESPACE, PortableStateRepository } from './portableState';
import { PortableMemoryStore } from './portableMemoryStore.testkit';

// Own file: the set-aside state is page-load (module) state, and these tests
// drive the real persisted store against a real SQLite repository row.
const NAME = 'almamesh-interpretations';

// A row an older build wrote: a valid persist envelope whose pre-v6 entry has a
// timing field but no `sections`, so the v6 merge throws while hydrating.
const POISONED = JSON.stringify({
  state: { byChart: { c1: { status: 'complete', interpretation: { current_sky: 'kept' } } } },
  version: 6,
});

const sqlite = new PortableMemoryStore();
const repository = new PortableStateRepository(sqlite);
const quarantine = repositoryQuarantineRows(repository);
let quarantineRefusesWrites = false;

beforeAll(() => {
  setPortableStateRepositoryForTests(repository);
  sqlite.beforeBatch = async (mutations) => {
    if (
      quarantineRefusesWrites &&
      mutations.some((m) => m.namespace === PORTABLE_QUARANTINE_NAMESPACE)
    ) {
      throw new Error('QuotaExceededError');
    }
  };
});

afterAll(() => setPortableStateRepositoryForTests(undefined));

async function seedAndRehydrate(raw: string, refuseQuarantine = false) {
  quarantineRefusesWrites = refuseQuarantine;
  await repository.write(NAME, raw);
  // Await this hydration itself: a failure stays reported for the page load,
  // so the barrier alone would settle before a later hydration finishes.
  await Promise.race([
    useInterpretationStore.persist.rehydrate(),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  return whenInterpretationHydrated();
}

async function durableRow(): Promise<unknown> {
  await whenPersistenceSettled(NAME);
  return repository.read(NAME);
}

async function heldRaw(): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const held = await readInterpretationQuarantine(quarantine);
    if (held.length > 0) return held.map((record) => record.raw);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

describe('an unreadable saved row is actually held, never overwritten', () => {
  // Runs first: a failed hydration stays reported as failed for the page load.
  it('control: a readable row is overwritten by the next save (the harness sees writes)', async () => {
    const healthy = JSON.stringify({ state: { byChart: {} }, version: 6 });
    expect(await seedAndRehydrate(healthy)).toEqual({ status: 'hydrated' });
    useInterpretationStore.getState().startInterpretation('c2', 'p2');
    expect(String(await durableRow())).toContain('"c2"');
  });

  it('does not let a save made while hydration is pending overwrite the saved row', async () => {
    const saved = JSON.stringify({
      state: { byChart: { c1: { status: 'complete', sections: {} } } },
      version: 6,
    });
    await repository.write(NAME, saved);
    const hydrating = useInterpretationStore.persist.rehydrate();
    useInterpretationStore.getState().startInterpretation('c9', 'p9');
    await hydrating;
    expect(String(await durableRow())).toContain('"c1"');
    expect(useInterpretationStore.getState().byChart.c1).toBeDefined();
  });

  it('fails closed and refuses writes when an unparseable row cannot be set aside', async () => {
    const outcome = await seedAndRehydrate('reset-proof', true);
    expect(outcome).toMatchObject({ status: 'failed' });
    useInterpretationStore.getState().startInterpretation('c2', 'p2');
    expect(await durableRow()).toBe('reset-proof');
  });

  it('stores the raw row in the SQLite quarantine when hydration cannot read it', async () => {
    await seedAndRehydrate(POISONED);
    expect(await heldRaw()).toContain(POISONED);
    const [record] = await readInterpretationQuarantine(quarantine);
    expect(Number.isNaN(Date.parse(record?.quarantinedAt ?? ''))).toBe(false);
  });

  it('refuses to overwrite the saved row while the set-aside failed', async () => {
    const outcome = await seedAndRehydrate(POISONED, true);
    expect(outcome).toMatchObject({ status: 'failed' });
    useInterpretationStore.getState().startInterpretation('c2', 'p2');
    expect(await durableRow()).toBe(POISONED);
  });
});
