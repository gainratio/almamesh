/**
 * Private / memory mode promises "Export a backup to keep it". With OPFS
 * refused, the production wiring (`portableRepository()` in
 * deletionTombstones.ts) opens SQLite in memory and skips the legacy migration.
 * That skip must not also skip seeding the generation ledger, or export and
 * import both fail with "Portable state is missing its generation ledger."
 *
 * The transport here is the canonical rows as JSON (the same stand-in
 * datasetLeaseRecovery.test.ts uses); the real SQLite file round trip is
 * driven in e2e/private-mode.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openRepository, readTransport, readLegacy, deleteLegacy } = vi.hoisted(() => ({
  openRepository: vi.fn(),
  readTransport: vi.fn(),
  readLegacy: vi.fn(async (): Promise<unknown> => undefined),
  deleteLegacy: vi.fn(async () => undefined),
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
  readLegacyKeyval: readLegacy,
  deleteLegacyKeyval: deleteLegacy,
}));

const PROFILES = 'almamesh-profiles';
const LEGACY_ROW = '{"state":{"legacy":true}}';

function profilesEnvelope(id: string): string {
  return JSON.stringify({ state: { profiles: { [id]: { id, name: 'Ada' } }, activeProfileId: id }, version: 0 });
}

/** What a persisted Zustand store does: hydrate (read) first, then write. */
async function saveProfile(storage: { getItem: (n: string) => unknown; setItem: (n: string, v: string) => unknown }, id: string) {
  await storage.getItem(PROFILES);
  await storage.setItem(PROFILES, profilesEnvelope(id));
}

/** One browser tab in private mode: a fresh module graph over a fresh in-memory SQLite twin. */
async function privateTab() {
  vi.resetModules();
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: () =>
        Promise.reject(new DOMException('The operation failed for an unknown transient reason.', 'UnknownError')),
    },
  });
  const tombstones = await import('./deletionTombstones');
  const backup = await import('./backup');
  const { portableStatePersistence } = await import('./portablePersistence');
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
  return { ...tombstones, ...backup, portableStatePersistence, repository };
}

afterEach(() => {
  vi.unstubAllGlobals();
  openRepository.mockReset();
  readTransport.mockReset();
  readLegacy.mockClear();
  deleteLegacy.mockClear();
});

describe('private mode (SQLite in memory) backup', () => {
  it('exports a valid backup from a fresh in-memory session', async () => {
    const tab = await privateTab();
    await saveProfile(tab.deletionAwareIdbStorage, 'p1');

    const exported = await tab.exportPortableBrowserState();

    expect(tab.portableStatePersistence()).toBe('memory');
    const rows = new Map(JSON.parse(new TextDecoder().decode(exported.bytes)) as [string, string][]);
    expect(rows.has('almamesh-deletion-tombstones')).toBe(true);
    expect(JSON.parse(rows.get(PROFILES) as string).state.profiles.p1.name).toBe('Ada');
  });

  it('still leaves legacy rows untouched while seeding the ledger', async () => {
    readLegacy.mockResolvedValue(LEGACY_ROW);
    const tab = await privateTab();

    await tab.exportPortableBrowserState();

    expect(readLegacy).not.toHaveBeenCalled();
    expect(deleteLegacy).not.toHaveBeenCalled();
  });

  it('round-trips: a private-mode export imports into a fresh private-mode session', async () => {
    const source = await privateTab();
    await saveProfile(source.deletionAwareIdbStorage, 'p1');
    const { bytes } = await source.exportPortableBrowserState();

    const target = await privateTab();
    await target.importPortableBrowserState(bytes);

    const restored = await target.deletionAwareIdbStorage.getItem(PROFILES);
    expect(JSON.parse(restored as string).state.profiles.p1.name).toBe('Ada');
  });
});
