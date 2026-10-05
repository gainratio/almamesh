/**
 * The interpretation quarantine lives in SQLite (the `quarantine` namespace of
 * the portable state file), never in localStorage. These tests drive the real
 * PortableStateRepository over the in-memory SQLite stand-in.
 */
import { describe, expect, it } from 'vitest';

import {
  INTERPRETATION_QUARANTINE_KEY,
  INTERPRETATION_QUARANTINE_TTL_DAYS,
  holdUnreadableInterpretation,
  migrateLegacyInterpretationQuarantine,
  pruneExpiredInterpretationQuarantine,
  readInterpretationQuarantine,
  repositoryQuarantineRows,
} from './interpretationQuarantine';
import {
  PORTABLE_QUARANTINE_NAMESPACE,
  PortableStateRepository,
} from './portableState';
import { PortableMemoryStore } from './portableMemoryStore.testkit';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const now = () => NOW;

function legacyStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    failRemove: 0,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem(key: string) {
      if (this.failRemove > 0) {
        this.failRemove -= 1;
        throw new Error('simulated crash before the legacy key was retired');
      }
      map.delete(key);
    },
  };
}

function setup() {
  const sqlite = new PortableMemoryStore();
  const repository = new PortableStateRepository(sqlite);
  return { sqlite, rows: repositoryQuarantineRows(repository) };
}

function quarantineRowCount(sqlite: PortableMemoryStore): number {
  return [...sqlite.values.keys()].filter((key) =>
    key.startsWith(`${PORTABLE_QUARANTINE_NAMESPACE}/`),
  ).length;
}

const LEGACY_RECORDS = [
  { quarantinedAt: '2026-10-01T00:00:00.000Z', source: 'legacy-local-storage', raw: 'old-a' },
  { quarantinedAt: '2026-10-02T00:00:00.000Z', source: 'canonical-sqlite', raw: 'old-b' },
];

describe('legacy localStorage quarantine migrates into SQLite (copy, verify, retire)', () => {
  it('copies every record into SQLite, then removes the localStorage key', async () => {
    const { rows } = setup();
    const legacy = legacyStorage({
      [INTERPRETATION_QUARANTINE_KEY]: JSON.stringify(LEGACY_RECORDS),
    });

    await migrateLegacyInterpretationQuarantine(legacy, rows, now);

    const held = await readInterpretationQuarantine(rows);
    expect(held.map(({ source, raw, quarantinedAt }) => ({ quarantinedAt, source, raw }))).toEqual(
      LEGACY_RECORDS,
    );
    expect(legacy.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(false);
  });

  it('a crash after the SQLite commit resumes on the next boot without duplicating rows', async () => {
    const { sqlite, rows } = setup();
    const legacy = legacyStorage({
      [INTERPRETATION_QUARANTINE_KEY]: JSON.stringify(LEGACY_RECORDS),
    });
    legacy.failRemove = 1;

    await expect(migrateLegacyInterpretationQuarantine(legacy, rows, now)).rejects.toThrow(
      'simulated crash',
    );
    // SQLite already holds the copy; the source is still there too.
    expect(legacy.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(true);
    expect(quarantineRowCount(sqlite)).toBe(2);

    await migrateLegacyInterpretationQuarantine(legacy, rows, now);

    expect(quarantineRowCount(sqlite)).toBe(2);
    expect(legacy.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(false);
  });

  it('keeps the localStorage source when the SQLite commit fails (an older build still finds it)', async () => {
    const { sqlite, rows } = setup();
    const source = JSON.stringify(LEGACY_RECORDS);
    const legacy = legacyStorage({ [INTERPRETATION_QUARANTINE_KEY]: source });
    sqlite.failNext = new Error('disk full');

    await expect(migrateLegacyInterpretationQuarantine(legacy, rows, now)).rejects.toThrow(
      'disk full',
    );

    expect(legacy.map.get(INTERPRETATION_QUARANTINE_KEY)).toBe(source);
    expect(quarantineRowCount(sqlite)).toBe(0);
  });

  // Contract reversed (northstar review of #240): keeping the source while
  // SQLite was session-only re-copied it every boot and resurrected readings of
  // profiles deleted since. The key is retired once the session holds the copy.
  it('retires the localStorage source even while SQLite is session-only', async () => {
    const { rows } = setup();
    const legacy = legacyStorage({
      [INTERPRETATION_QUARANTINE_KEY]: JSON.stringify(LEGACY_RECORDS),
    });

    await migrateLegacyInterpretationQuarantine(legacy, rows, now);

    expect(await readInterpretationQuarantine(rows)).toHaveLength(2);
    expect(legacy.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(false);
  });

  it('copies an unparseable legacy value as one held record instead of dropping it', async () => {
    const { rows } = setup();
    const legacy = legacyStorage({ [INTERPRETATION_QUARANTINE_KEY]: 'not json' });

    await migrateLegacyInterpretationQuarantine(legacy, rows, now);

    const held = await readInterpretationQuarantine(rows);
    expect(held.map((record) => record.raw)).toEqual(['not json']);
    expect(legacy.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(false);
  });
});

describe('holding unreadable rows in SQLite', () => {
  it('keys a row by the profile that owns it, and de-duplicates by bytes', async () => {
    const { sqlite, rows } = setup();
    const raw = JSON.stringify({
      state: { byChart: { c1: { profileId: 'profile-a', status: 'complete' } } },
      version: 99,
    });

    expect(await holdUnreadableInterpretation({ source: 'canonical-sqlite', raw }, rows, now)).toBe(
      true,
    );
    expect(await holdUnreadableInterpretation({ source: 'canonical-sqlite', raw }, rows, now)).toBe(
      true,
    );

    const keys = [...sqlite.values.keys()].filter((key) =>
      key.startsWith(`${PORTABLE_QUARANTINE_NAMESPACE}/`),
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]?.startsWith(`${PORTABLE_QUARANTINE_NAMESPACE}/profile-a/`)).toBe(true);
    const [record] = await readInterpretationQuarantine(rows);
    expect(record).toMatchObject({ raw, profileIds: ['profile-a'], quarantinedAt: NOW.toISOString() });
  });

  it('reports false (not held) when SQLite refuses the write', async () => {
    const { sqlite, rows } = setup();
    sqlite.failNext = new Error('quota');
    expect(
      await holdUnreadableInterpretation({ source: 'canonical-sqlite', raw: 'x' }, rows, now),
    ).toBe(false);
  });

  it(`drops rows exactly ${INTERPRETATION_QUARANTINE_TTL_DAYS} days after they were set aside`, async () => {
    expect(INTERPRETATION_QUARANTINE_TTL_DAYS).toBe(30);
    const { rows } = setup();
    const day = 24 * 60 * 60 * 1000;
    await holdUnreadableInterpretation(
      { source: 'canonical-sqlite', raw: 'old' },
      rows,
      () => new Date(NOW.getTime() - 30 * day - 1),
    );
    await holdUnreadableInterpretation(
      { source: 'canonical-sqlite', raw: 'fresh' },
      rows,
      () => new Date(NOW.getTime() - 30 * day),
    );

    await pruneExpiredInterpretationQuarantine(rows, now);

    expect((await readInterpretationQuarantine(rows)).map((record) => record.raw)).toEqual([
      'fresh',
    ]);
  });
});
