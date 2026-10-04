import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, get as idbGet, set as idbSet } from 'idb-keyval';

import { whenPersistenceSettled } from './deletionTombstones';
import {
  INTERPRETATION_QUARANTINE_KEY,
  useInterpretationStore,
  whenInterpretationHydrated,
} from './interpretation';

// Own file: the set-aside state is page-load (module) state, and these tests
// drive the real persisted store against a real (fake) IndexedDB row.
const NAME = 'almamesh-interpretations';

// A row an older build wrote: a valid persist envelope whose pre-v6 entry has a
// timing field but no `sections`, so the v6 merge throws while hydrating.
const POISONED = JSON.stringify({
  state: { byChart: { c1: { status: 'complete', interpretation: { current_sky: 'kept' } } } },
  version: 6,
});

function memoryStorage(failWrites = false) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (name: string) => map.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (failWrites) throw new Error('QuotaExceededError');
      map.set(name, value);
    },
    removeItem: (name: string) => void map.delete(name),
  };
}

const globals = globalThis as { indexedDB?: unknown; localStorage?: unknown };
let originalIdb: unknown;
let originalLocal: unknown;

// One IndexedDB for the file: the durable adapter caches its connection.
beforeAll(() => {
  originalIdb = globals.indexedDB;
  originalLocal = globals.localStorage;
  globals.indexedDB = new IDBFactory();
});

afterAll(() => {
  globals.indexedDB = originalIdb;
  globals.localStorage = originalLocal;
});

async function seedAndRehydrate(raw: string, local: ReturnType<typeof memoryStorage>) {
  globals.localStorage = local;
  await idbSet(NAME, raw, createStore('keyval-store', 'keyval'));
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
  return idbGet(NAME, createStore('keyval-store', 'keyval'));
}

describe('an unreadable saved row is actually held, never overwritten', () => {
  // Runs first: a failed hydration stays reported as failed for the page load.
  it('control: a readable row is overwritten by the next save (the harness sees writes)', async () => {
    const healthy = JSON.stringify({ state: { byChart: {} }, version: 6 });
    expect(await seedAndRehydrate(healthy, memoryStorage())).toEqual({ status: 'hydrated' });
    useInterpretationStore.getState().startInterpretation('c2', 'p2');
    expect(String(await durableRow())).toContain('"c2"');
  });

  it('does not let a save made while hydration is pending overwrite the saved row', async () => {
    const saved = JSON.stringify({
      state: { byChart: { c1: { status: 'complete', sections: {} } } },
      version: 6,
    });
    globals.localStorage = memoryStorage();
    await idbSet(NAME, saved, createStore('keyval-store', 'keyval'));
    const hydrating = useInterpretationStore.persist.rehydrate();
    useInterpretationStore.getState().startInterpretation('c9', 'p9');
    await hydrating;
    expect(String(await durableRow())).toContain('"c1"');
    expect(useInterpretationStore.getState().byChart.c1).toBeDefined();
  });

  it('fails closed and refuses writes when an unparseable row cannot be set aside', async () => {
    const outcome = await seedAndRehydrate('reset-proof', memoryStorage(true));
    expect(outcome).toMatchObject({ status: 'failed' });
    useInterpretationStore.getState().startInterpretation('c2', 'p2');
    expect(await durableRow()).toBe('reset-proof');
  });

  it('stores the raw row in the quarantine when hydration cannot read it', async () => {
    const local = memoryStorage();
    await seedAndRehydrate(POISONED, local);
    const held = JSON.parse(local.map.get(INTERPRETATION_QUARANTINE_KEY) ?? '[]') as {
      raw: string;
      quarantinedAt: string;
    }[];
    expect(held.map((r) => r.raw)).toContain(POISONED);
    expect(Number.isNaN(Date.parse(held[0]?.quarantinedAt ?? ''))).toBe(false);
  });

  it('refuses to overwrite the saved row while the set-aside failed', async () => {
    const outcome = await seedAndRehydrate(POISONED, memoryStorage(true));
    expect(outcome).toMatchObject({ status: 'failed' });
    useInterpretationStore.getState().startInterpretation('c2', 'p2');
    expect(await durableRow()).toBe(POISONED);
  });
});
