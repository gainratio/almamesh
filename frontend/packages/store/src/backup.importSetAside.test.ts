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
    runtimeInfo: vi.fn(async () => ({ epoch: 2 })),
    holdSetAside: vi.fn(async (records: unknown) => {
      order.push(`hold ${JSON.stringify(records)}`);
    }),
  })),
  beginBackupRestore: vi.fn(async () => {
    order.push('begin');
    return 1;
  }),
  commitDatasetGeneration: vi.fn(async () => {
    order.push('commit');
    throw new Error('stop at commit');
  }),
  abortBackupRestore: vi.fn(async () => {
    order.push('abort');
  }),
}));

const { armPortableImportRevision, importPortableBrowserState, PortableImportRevisionConflictError } =
  await import('./backup');

describe('importing a .almamesh / SQLite backup with orphaned life events', () => {
  it('holds them in SQLite after the restore lease and fence, before commitDatasetGeneration replaces anything', async () => {
    order.length = 0;
    await expect(importPortableBrowserState(new Uint8Array([1]))).rejects.toThrow(/stop at commit/);

    expect(order).toEqual(['begin', `hold ${JSON.stringify([record])}`, 'commit', 'abort']);
  });

  it('never writes set-aside records if the armed safety-revision fence rejects', async () => {
    order.length = 0;
    // Safety revision 0 expects fenced epoch 1, while runtimeInfo reports epoch 2 (competing write).
    armPortableImportRevision(0);
    await expect(importPortableBrowserState(new Uint8Array([1]))).rejects.toBeInstanceOf(
      PortableImportRevisionConflictError,
    );

    expect(order).toEqual(['begin', 'abort']);
  });
});
