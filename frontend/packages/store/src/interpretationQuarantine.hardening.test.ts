/**
 * Northstar review of #240: the quarantine must never resurrect a deleted
 * profile's readings (memory-mode boots included), every refusal path is
 * witnessed, and failures surface as typed diagnostics instead of vanishing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginDatasetMutation,
  commitDatasetGeneration,
  interpretationQuarantineRows,
  recordDeletionTombstones,
  resetSessionStateForTests,
  sessionRowsForTests,
  setPortableStateRepositoryForTests,
} from './deletionTombstones';
import {
  INTERPRETATION_QUARANTINE_KEY,
  readInterpretationPersistedValue,
  quarantineUnreadableInterpretation,
} from './interpretation';
import {
  holdUnreadableInterpretation,
  migrateLegacyInterpretationQuarantine,
  pruneExpiredInterpretationQuarantine,
  readInterpretationQuarantine,
  retireExpiredLegacyQuarantine,
  type InterpretationQuarantineRows,
} from './interpretationQuarantine';
import {
  PORTABLE_QUARANTINE_NAMESPACE,
  PortableStateRepository,
} from './portableState';
import { PortableMemoryStore } from './portableMemoryStore.testkit';

const DAY = 24 * 60 * 60 * 1000;

function legacyStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    // Present only so the browser seam recognises a real Storage; never called.
    setItem: () => {
      throw new Error('app code must never write localStorage');
    },
    removeItem: (key: string) => void map.delete(key),
  };
}

function readingsOf(profileId: string): string {
  return JSON.stringify({
    state: { byChart: { [`chart-${profileId}`]: { profileId, status: 'complete' } } },
    version: 99,
  });
}

function legacyQuarantine(...raws: string[]): string {
  return JSON.stringify(
    raws.map((raw) => ({
      quarantinedAt: new Date().toISOString(),
      source: 'legacy-local-storage',
      raw,
    })),
  );
}

function durableDouble() {
  return { getItem: async () => null, setItem: async () => undefined };
}

async function heldRaw(): Promise<string[]> {
  return (await readInterpretationQuarantine(await interpretationQuarantineRows()))
    .map((record) => record.raw)
    .sort();
}

function withGlobalLocalStorage(storage: ReturnType<typeof legacyStorage>): () => void {
  const globals = globalThis as { localStorage?: unknown };
  const original = globals.localStorage;
  globals.localStorage = storage;
  return () => {
    globals.localStorage = original;
  };
}

function warnings(): { codes: () => string[]; restore: () => void } {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return {
    codes: () => spy.mock.calls.map((call) => String(call[0])),
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => setPortableStateRepositoryForTests(undefined));

describe('memory-mode boots never resurrect a deleted profile’s set-aside readings', () => {
  it('retires the legacy key once it is copied, even while SQLite is session-only', async () => {
    resetSessionStateForTests();
    const storage = legacyStorage({ [INTERPRETATION_QUARANTINE_KEY]: legacyQuarantine('x') });

    await readInterpretationPersistedValue(
      'almamesh-interpretations',
      durableDouble(),
      storage,
      () => false, // OPFS refused: persistence 'memory'
      async () => true,
    );

    expect(storage.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(false);
    expect(await heldRaw()).toEqual(['x']);
  });

  it('a deleted profile’s legacy readings do not come back on the next boot', async () => {
    resetSessionStateForTests();
    const storage = legacyStorage({
      [INTERPRETATION_QUARANTINE_KEY]: legacyQuarantine(readingsOf('victim'), readingsOf('survivor')),
    });
    const boot = () =>
      readInterpretationPersistedValue(
        'almamesh-interpretations',
        durableDouble(),
        storage,
        () => false,
        async () => true,
      );

    await boot();
    const epoch = await beginDatasetMutation();
    await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
    await commitDatasetGeneration(epoch, []);
    await boot();

    expect(await heldRaw()).toEqual([readingsOf('survivor')]);
  });
});

describe('profile delete and expiry clear a legacy source that could not be migrated', () => {
  function refusingRepository(): void {
    const sqlite = new PortableMemoryStore();
    sqlite.beforeBatch = async (mutations) => {
      if (mutations.some((m) => m.namespace === PORTABLE_QUARANTINE_NAMESPACE)) {
        throw new Error('quarantine write refused');
      }
    };
    setPortableStateRepositoryForTests(new PortableStateRepository(sqlite));
  }

  it('deleting a profile removes a legacy source holding its readings', async () => {
    refusingRepository();
    const storage = legacyStorage({
      [INTERPRETATION_QUARANTINE_KEY]: legacyQuarantine(readingsOf('victim')),
    });
    const restore = withGlobalLocalStorage(storage);
    const warned = warnings();
    try {
      const epoch = await beginDatasetMutation();
      await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
      await commitDatasetGeneration(epoch, []);
      expect(storage.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(false);
      expect(warned.codes()).toContain(
        '[almamesh:warn:storage.interpretation_quarantine_migration_failed]',
      );
    } finally {
      warned.restore();
      restore();
    }
  });

  it('deleting an unrelated profile keeps the unmigrated legacy source', async () => {
    refusingRepository();
    const source = legacyQuarantine(readingsOf('survivor'));
    const storage = legacyStorage({ [INTERPRETATION_QUARANTINE_KEY]: source });
    const restore = withGlobalLocalStorage(storage);
    const warned = warnings();
    try {
      const epoch = await beginDatasetMutation();
      await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
      await commitDatasetGeneration(epoch, []);
      expect(storage.map.get(INTERPRETATION_QUARANTINE_KEY)).toBe(source);
    } finally {
      warned.restore();
      restore();
    }
  });

  it('expiry removes a legacy source whose records are all past 30 days', () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    const old = new Date(now.getTime() - 30 * DAY - 1).toISOString();
    const fresh = new Date(now.getTime() - 30 * DAY).toISOString();
    const expired = legacyStorage({
      [INTERPRETATION_QUARANTINE_KEY]: JSON.stringify([
        { quarantinedAt: old, source: 'legacy-local-storage', raw: 'a' },
      ]),
    });
    const live = legacyStorage({
      [INTERPRETATION_QUARANTINE_KEY]: JSON.stringify([
        { quarantinedAt: old, source: 'legacy-local-storage', raw: 'a' },
        { quarantinedAt: fresh, source: 'legacy-local-storage', raw: 'b' },
      ]),
    });

    retireExpiredLegacyQuarantine(expired, () => now);
    retireExpiredLegacyQuarantine(live, () => now);

    expect(expired.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(false);
    expect(live.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(true);
  });
});

describe('the generation commit reads the quarantine inside its transaction', () => {
  it('purges a row for the deleted profile that lands between attempts', async () => {
    const sqlite = new PortableMemoryStore();
    setPortableStateRepositoryForTests(new PortableStateRepository(sqlite));
    const epoch = await beginDatasetMutation();
    await recordDeletionTombstones({ profileIds: ['victim'] }, epoch);
    const lateKey = `${PORTABLE_QUARANTINE_NAMESPACE}/victim/${'a'.repeat(64)}`;
    sqlite.conflictOnce = true;
    sqlite.onConflict = (store) => {
      store.values.set(lateKey, {
        value: new TextEncoder().encode(
          JSON.stringify({
            quarantinedAt: new Date().toISOString(),
            source: 'canonical-sqlite',
            raw: readingsOf('victim'),
            profileIds: ['victim'],
          }),
        ),
        revision: store.epoch,
      });
    };

    await commitDatasetGeneration(epoch, []);

    expect(sqlite.values.has(lateKey)).toBe(false);
  });
});

describe('refusal paths are witnessed', () => {
  it('refuses a quarantine table larger than one page', async () => {
    const sqlite = new PortableMemoryStore();
    sqlite.list = async (options) => ({ rows: [], nextKey: `${options.namespace}-more` });
    await expect(new PortableStateRepository(sqlite).listQuarantine()).rejects.toThrow(
      'exceeds the supported row count',
    );
  });

  it('refuses a quarantine key that is not <owner>/<sha256>', async () => {
    const repository = new PortableStateRepository(new PortableMemoryStore());
    await expect(
      repository.applyQuarantine([
        { type: 'put', namespace: PORTABLE_QUARANTINE_NAMESPACE, key: 'no-digest', value: '{}' },
      ]),
    ).rejects.toThrow('is not <owner>/<sha256>');
  });

  it('refuses to retire the legacy key when SQLite does not hold the copy', async () => {
    const forgetful: InterpretationQuarantineRows = {
      list: async () => new Map(),
      apply: async () => undefined,
    };
    const storage = legacyStorage({ [INTERPRETATION_QUARANTINE_KEY]: legacyQuarantine('x') });
    await expect(migrateLegacyInterpretationQuarantine(storage, forgetful)).rejects.toThrow(
      'did not verify in SQLite',
    );
    expect(storage.map.has(INTERPRETATION_QUARANTINE_KEY)).toBe(true);
  });

  it('refuses a generation write for a key that is not canonical SQLite data', async () => {
    resetSessionStateForTests();
    const epoch = await beginDatasetMutation();
    await expect(
      commitDatasetGeneration(epoch, [{ key: 'almamesh-chat-vectors', value: null }]),
    ).rejects.toThrow('is not canonical SQLite data');
  });

  it('refuses an in-memory generation commit without an active lease', async () => {
    resetSessionStateForTests();
    await expect(commitDatasetGeneration(7, [])).rejects.toThrow(
      'Dataset Replace generation is no longer active.',
    );
  });
});

describe('quarantine failures surface as typed diagnostics', () => {
  const broken: InterpretationQuarantineRows = {
    list: async () => {
      throw new Error('SQLite unavailable');
    },
    apply: async () => {
      throw new Error('SQLite unavailable');
    },
  };

  it('logs a failed hold and reports it as not held', async () => {
    const warned = warnings();
    try {
      expect(
        await holdUnreadableInterpretation({ source: 'canonical-sqlite', raw: 'x' }, broken),
      ).toBe(false);
      expect(warned.codes()).toContain('[almamesh:warn:storage.interpretation_quarantine_hold_failed]');
    } finally {
      warned.restore();
    }
  });

  it('logs a failed expiry pass instead of swallowing it', async () => {
    const warned = warnings();
    try {
      await pruneExpiredInterpretationQuarantine(broken);
      expect(warned.codes()).toContain('[almamesh:warn:storage.interpretation_quarantine_prune_failed]');
    } finally {
      warned.restore();
    }
  });

  it('logs a legacy key that cannot be read (blocked storage) and leaves it alone', async () => {
    const warned = warnings();
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('must not retire an unread key');
      },
    };
    try {
      await migrateLegacyInterpretationQuarantine(blocked, broken);
      expect(warned.codes()).toContain(
        '[almamesh:warn:storage.interpretation_quarantine_legacy_unreadable]',
      );
    } finally {
      warned.restore();
    }
  });

  it('logs when the quarantine store itself cannot be reached during a hold', async () => {
    const sqlite = new PortableMemoryStore();
    sqlite.list = async () => {
      throw new Error('SQLite unavailable');
    };
    setPortableStateRepositoryForTests(new PortableStateRepository(sqlite));
    const warned = warnings();
    try {
      expect(await quarantineUnreadableInterpretation({ source: 'canonical-sqlite', raw: 'y' })).toBe(
        false,
      );
      expect(warned.codes()).toContain('[almamesh:warn:storage.interpretation_quarantine_hold_failed]');
    } finally {
      warned.restore();
    }
  });
});

describe('session state is reset between tests', () => {
  it('clears the in-memory dataset rows and quarantine', async () => {
    resetSessionStateForTests();
    sessionRowsForTests().set('almamesh-profiles', 'stale');
    await holdUnreadableInterpretation(
      { source: 'canonical-sqlite', raw: 'stale' },
      await interpretationQuarantineRows(),
    );

    resetSessionStateForTests();

    expect(sessionRowsForTests().size).toBe(0);
    expect(await heldRaw()).toEqual([]);
  });
});
