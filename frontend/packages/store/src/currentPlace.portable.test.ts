/**
 * "Where do you live now?" is portable state: it travels in the user's own
 * export and comes back on import. The real profiles store writes it through
 * its real persist path into the canonical SQLite rows; the transport is the
 * rows as JSON (the stand-in portableMemoryMode.backup.test.ts uses).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openRepository, readTransport } = vi.hoisted(() => ({
  openRepository: vi.fn(),
  readTransport: vi.fn(),
}));

vi.mock('./portableState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portableState')>();
  return {
    ...actual,
    resolvePortableStateMode: () => 'portable' as const,
    openPortableStateRepository: openRepository,
    readPortableStateDatabase: readTransport,
  };
});

vi.mock('./legacyKeyval', () => ({
  readLegacyKeyval: vi.fn(async (): Promise<unknown> => undefined),
  deleteLegacyKeyval: vi.fn(async () => undefined),
}));

const NOVATO = {
  label: 'Novato, California, United States',
  timezone: 'America/Los_Angeles',
  latitude: 38.10742,
  longitude: -122.5697,
};

/** One tab: a fresh module graph over a fresh in-memory SQLite twin. */
async function tab() {
  vi.resetModules();
  vi.stubGlobal('navigator', {
    storage: { getDirectory: () => Promise.reject(new DOMException('refused', 'UnknownError')) },
  });
  const backup = await import('./backup');
  const { PortableMemoryStore } = await import('./portableMemoryStore.testkit');
  const { PortableStateRepository } = await import('./portableState');
  const { repairPortableReferences } = await import('./portableRepair');
  const sqlite = new PortableMemoryStore();
  const repository = new PortableStateRepository(
    sqlite,
    async () => sqlite.epoch,
    async (canonical) => new TextEncoder().encode(JSON.stringify([...canonical])),
  );
  openRepository.mockResolvedValue(repository);
  readTransport.mockImplementation(async (bytes: Uint8Array) => {
    const rows = new Map(JSON.parse(new TextDecoder().decode(bytes)) as [string, string][]);
    const repaired = repairPortableReferences(rows);
    return { epoch: 1, values: repaired.values, quarantine: new Map(), repairs: repaired.repairs };
  });
  return backup;
}

async function profilesStore() {
  const profiles = await import('./profiles');
  const { getCurrentPlace } = await import('./currentPlace');
  expect((await profiles.whenProfilesHydrated()).status).not.toBe('failed');
  return { ...profiles, getCurrentPlace };
}

afterEach(() => {
  vi.unstubAllGlobals();
  openRepository.mockReset();
  readTransport.mockReset();
});

describe('current place in export/import', () => {
  it('round-trips: set in one browser, exported, imported into a fresh one', async () => {
    const source = await tab();
    const before = await profilesStore();
    const id = before.useProfilesStore.getState().createProfile('Ada');
    expect(before.useProfilesStore.getState().setCurrentPlace(id, NOVATO)).toEqual({ ok: true });
    await before.whenProfilesCommitted();
    const { bytes } = await source.exportPortableBrowserState();

    const target = await tab();
    await target.importPortableBrowserState(bytes);
    const after = await profilesStore();

    expect(after.getCurrentPlace(after.useProfilesStore.getState().profiles[id])).toEqual(NOVATO);
  });

  it('a person who never set one imports without one (no birthplace stand-in)', async () => {
    const source = await tab();
    const before = await profilesStore();
    const id = before.useProfilesStore.getState().createProfile('Bo');
    await before.whenProfilesCommitted();
    const { bytes } = await source.exportPortableBrowserState();

    const target = await tab();
    await target.importPortableBrowserState(bytes);
    const after = await profilesStore();

    expect(after.useProfilesStore.getState().profiles[id]?.name).toBe('Bo');
    expect(after.getCurrentPlace(after.useProfilesStore.getState().profiles[id])).toBeUndefined();
  });
});
