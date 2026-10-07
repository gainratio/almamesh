import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { useChartLibraryStore, type ChartLibraryStore, type StoredChart } from './chartLibrary';
import {
  migrateProfilesPersistedState,
  profilesStoreCreator,
  type ProfilesStore,
} from './profiles';

describe('migrateProfilesPersistedState (defensive hydration)', () => {
  it('passes a valid previous-shape blob through unchanged', () => {
    const blob = { profiles: { p1: { id: 'p1', name: 'Me' } }, activeProfileId: 'p1' };
    expect(migrateProfilesPersistedState(blob, 0)).toEqual(blob);
  });

  it('does NOT throw on a malformed / corrupt blob, returns clean defaults', () => {
    for (const corrupt of [null, undefined, 'oops', 42, [], {}, { profiles: 'x' }]) {
      expect(() => migrateProfilesPersistedState(corrupt, 0)).not.toThrow();
      expect(migrateProfilesPersistedState(corrupt, 0)).toEqual({
        profiles: {},
        activeProfileId: null,
      });
    }
  });

  it('drops a dangling activeProfileId that points at no profile', () => {
    const out = migrateProfilesPersistedState({ profiles: {}, activeProfileId: 'ghost' }, 0);
    expect(out.activeProfileId).toBeNull();
  });
});

/** Seed a minimal StoredChart owned by `profileId` into the chart library. */
function seedChart(lib: ChartLibraryStore, chartId: string, profileId: string): void {
  const chart = {
    chart_id: chartId,
    person_name: 'X',
    is_primary: true,
    profile_id: profileId,
  } as unknown as StoredChart;
  lib.saveChart(chart);
}

// Minimal localStorage shim so the routing-flag mirror has somewhere to write.
function installLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  return backing;
}

function newStore() {
  return createStore<ProfilesStore>(profilesStoreCreator);
}

describe('profilesStore', () => {
  beforeEach(() => {
    installLocalStorage();
    // The cascade test seeds the singleton chart library; reset it each run.
    useChartLibraryStore.setState({ charts: {} });
  });

  it('createProfile makes the first profile active', () => {
    const store = newStore();
    const id = store.getState().createProfile('Alice');
    expect(store.getState().activeProfileId).toBe(id);
    expect(store.getState().getActiveProfile()?.name).toBe('Alice');
  });

  it('creates unique ids and stable tints', () => {
    const store = newStore();
    const a = store.getState().createProfile('Alice');
    const b = store.getState().createProfile('Bob');
    expect(a).not.toBe(b);
    const tints = store.getState().listProfiles().map((p) => p.avatarTint);
    expect(tints.every((t) => /^#[0-9A-Fa-f]{6}$/.test(t))).toBe(true);
  });

  it('a second profile does NOT steal active focus', () => {
    const store = newStore();
    const a = store.getState().createProfile('Alice');
    store.getState().createProfile('Bob');
    expect(store.getState().activeProfileId).toBe(a);
  });

  it('renameProfile changes the name in place', () => {
    const store = newStore();
    const id = store.getState().createProfile('Alice');
    store.getState().renameProfile(id, 'Alicia');
    expect(store.getState().getActiveProfile()?.name).toBe('Alicia');
  });

  it("renameProfile renames that person's charts too, so the header and the chart agree", () => {
    const store = newStore();
    const alice = store.getState().createProfile('Alice');
    const bob = store.getState().createProfile('Bob');
    const lib = useChartLibraryStore.getState();
    seedChart(lib, 'c-alice', alice);
    seedChart(lib, 'c-bob', bob);

    store.getState().renameProfile(alice, '  Alicia ');

    expect(useChartLibraryStore.getState().getChart('c-alice')?.person_name).toBe('Alicia');
    expect(useChartLibraryStore.getState().getChart('c-bob')?.person_name).toBe('X');
  });

  it('a blank rename changes neither the person nor the chart', () => {
    const store = newStore();
    const alice = store.getState().createProfile('Alice');
    seedChart(useChartLibraryStore.getState(), 'c-alice', alice);

    store.getState().renameProfile(alice, '   ');

    expect(store.getState().getActiveProfile()?.name).toBe('Alice');
    expect(useChartLibraryStore.getState().getChart('c-alice')?.person_name).toBe('X');
  });

  it('setActiveProfile switches the active profile', () => {
    const store = newStore();
    store.getState().createProfile('Alice');
    const b = store.getState().createProfile('Bob');
    store.getState().setActiveProfile(b);
    expect(store.getState().getActiveProfile()?.name).toBe('Bob');
  });

  it('deleteProfile removes it and re-points active to another profile', () => {
    const store = newStore();
    const a = store.getState().createProfile('Alice');
    const b = store.getState().createProfile('Bob');
    store.getState().setActiveProfile(b);
    store.getState().deleteProfile(b);
    expect(store.getState().getActiveProfile()?.id).toBe(a);
    expect(store.getState().listProfiles()).toHaveLength(1);
  });

  it('deleteProfile cascade-deletes the profile\'s charts', () => {
    const lib = useChartLibraryStore.getState();
    const store = newStore();
    const a = store.getState().createProfile('Alice');
    const b = store.getState().createProfile('Bob');
    seedChart(lib, 'chart-b', b);
    seedChart(lib, 'chart-a', a);
    store.getState().deleteProfile(b);
    expect(useChartLibraryStore.getState().getChart('chart-b')).toBeUndefined();
    expect(useChartLibraryStore.getState().getChart('chart-a')).toBeDefined();
  });

  it('refuses to delete the last remaining profile', () => {
    const store = newStore();
    const a = store.getState().createProfile('Alice');
    expect(() => store.getState().deleteProfile(a)).toThrow(/last profile/i);
    expect(store.getState().listProfiles()).toHaveLength(1);
  });

  it('listProfiles returns profiles ordered by createdAt', () => {
    const store = newStore();
    store.getState().createProfile('Alice');
    store.getState().createProfile('Bob');
    const names = store.getState().listProfiles().map((p) => p.name);
    expect(names).toEqual(['Alice', 'Bob']);
  });
});
