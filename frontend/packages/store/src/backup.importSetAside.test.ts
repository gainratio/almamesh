import { describe, expect, it, vi } from 'vitest';

import { EMPTY_PORTABLE_REPAIR_REPORT } from './portableRepair';

const order: string[] = [];
const record = { row: 'almamesh-life-events', personId: 'gone', value: '[{"id":"e1"}]' } as const;

vi.mock('./portableState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./portableState')>()),
  // The file's life events belong to a person the file no longer holds.
  readPortableStateDatabase: vi.fn(async () => ({
    epoch: 1,
    values: new Map(),
    quarantine: new Map(),
    repairs: { ...EMPTY_PORTABLE_REPAIR_REPORT, setAside: [record] },
  })),
}));

vi.mock('./deletionTombstones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deletionTombstones')>()),
  requirePortableStateRepository: vi.fn(async () => ({
    holdSetAside: vi.fn(async (records: unknown) => {
      order.push(`hold ${JSON.stringify(records)}`);
    }),
  })),
  beginBackupRestore: vi.fn(async () => {
    order.push('begin');
    throw new Error('stop after begin');
  }),
}));

const { importPortableBrowserState } = await import('./backup');

describe('importing a .almamesh / SQLite backup with orphaned life events', () => {
  it('holds them in SQLite before the import replaces anything', async () => {
    await expect(importPortableBrowserState(new Uint8Array([1]))).rejects.toThrow(/stop after begin/);

    expect(order).toEqual([`hold ${JSON.stringify([record])}`, 'begin']);
  });
});
