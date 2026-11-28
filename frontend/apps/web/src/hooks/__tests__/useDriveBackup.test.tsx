import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupRestore } from '../useBackupRestore';
import { resetDriveSessionPassphraseForTests, useDriveBackup } from '../useDriveBackup';
import { backupNameOf } from '../../lib/drive/backupName';
import { createDriveSafetyTarget } from '../../lib/drive/driveSafetyTarget';
import { createFakeDrive } from '../../lib/drive/testing/fakeDrive';
import { createMemoryDeviceRows } from '../../lib/drive/testing/memoryCredentials';
import { passphraseSealedFixtureBytes } from '../../lib/drive/testing/sealedFixture';

const SEALED = await passphraseSealedFixtureBytes('sqlite-bytes');

function stubRestore(): BackupRestore & { stagedCalls: unknown[] } {
  const stagedCalls: unknown[] = [];
  return {
    stagedCalls,
    stageContent: vi.fn(async (...args: unknown[]) => {
      stagedCalls.push(args);
    }),
  } as unknown as BackupRestore & { stagedCalls: unknown[] };
}

beforeEach(() => {
  resetDriveSessionPassphraseForTests();
});

describe('useDriveBackup', () => {
  it('verifies SHA-256 read-back BEFORE pruning older backups (never prunes on corrupt read-back)', async () => {
    const drive = createFakeDrive();
    const rows = createMemoryDeviceRows();
    rows.map.set('device-code', '7f3a2c');
    for (let i = 0; i < 11; i += 1) {
      const mm = String(i).padStart(2, '0');
      await drive.upload(
        backupNameOf(`almamesh-backup-2026-10-10T10-${mm}-00-000Z-chrome-macos-7f3a2c.almamesh`),
        { bytes: SEALED } as never,
      );
    }
    const removeSpy = vi.spyOn(drive, 'remove');
    vi.spyOn(drive, 'download').mockResolvedValueOnce(new Uint8Array([0, 1, 2, 3]));
    const restore = stubRestore();

    const { result } = renderHook(() =>
      useDriveBackup({
        drive,
        restore,
        rows,
        buildExport: async () => ({
          filename: 'x.almamesh',
          content: SEALED,
          repairs: { unlinkedChats: 0, droppedReadings: 0, droppedRecords: 0, setAsideRecords: 0 } as never,
        }),
        userAgent: 'Mozilla/5.0 Chrome/130.0 Macintosh',
        now: () => new Date('2026-10-10T12:00:00.000Z'),
      }),
    );

    await act(async () => {
      await result.current.backUpNow('correct horse battery staple');
    });

    // Read-back hash failed -> must NOT prune any existing backups and must report an error!
    expect(removeSpy).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('uploads, verifies SHA-256, prunes only own-device backups beyond 10, and reuses session passphrase', async () => {
    const drive = createFakeDrive();
    const rows = createMemoryDeviceRows();
    rows.map.set('device-code', '7f3a2c');
    await drive.upload(
      backupNameOf('almamesh-backup-2026-09-01T00-00-00-000Z-safari-ios-bbbbbb.almamesh'),
      { bytes: SEALED } as never,
    );
    for (let i = 0; i < 10; i += 1) {
      const mm = String(i).padStart(2, '0');
      await drive.upload(
        backupNameOf(`almamesh-backup-2026-10-10T10-${mm}-00-000Z-chrome-macos-7f3a2c.almamesh`),
        { bytes: SEALED } as never,
      );
    }
    const restore = stubRestore();
    let tick = 0;
    const { result } = renderHook(() =>
      useDriveBackup({
        drive,
        restore,
        rows,
        buildExport: async () => ({
          filename: 'x.almamesh',
          content: SEALED,
          repairs: { unlinkedChats: 0, droppedReadings: 0, droppedRecords: 0, setAsideRecords: 0 } as never,
        }),
        userAgent: 'Mozilla/5.0 Chrome/130.0 Macintosh',
        now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++)),
      }),
    );

    await act(async () => {
      await result.current.backUpNow('correct horse battery staple');
    });
    expect(result.current.error).toBeNull();
    expect(result.current.status).toMatch(/verified|drive\.status_backed_up/);

    const remaining = await drive.list();
    expect(remaining.filter((e) => e.meta.deviceCode === '7f3a2c')).toHaveLength(10);
    expect(remaining.filter((e) => e.meta.deviceCode === 'bbbbbb')).toHaveLength(1);

    // Second backup in the same session reuses sessionPassphrase without opening the setup dialog.
    await act(async () => {
      await result.current.backUpNow();
    });
    expect(result.current.passphraseOpen).toBe(false);
  });

  it('does not touch SQLite device rows on disconnected mount and does not list when autoList is false', async () => {
    const drive = createFakeDrive();
    drive.isConnected = async () => false;
    const listSpy = vi.spyOn(drive, 'list');
    const rows = createMemoryDeviceRows();
    const insertSpy = vi.spyOn(rows, 'insertIfAbsent');
    const restore = stubRestore();

    renderHook(() => useDriveBackup({ drive, restore, rows }));
    await act(async () => Promise.resolve());
    expect(insertSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();

    drive.isConnected = async () => true;
    renderHook(() => useDriveBackup({ drive, restore, rows, autoList: false }));
    await act(async () => Promise.resolve());
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('resolves deviceCode during createDriveSafetyTarget.choice before write() runs', async () => {
    const drive = createFakeDrive();
    const events: string[] = [];
    const target = createDriveSafetyTarget(drive, 'Chrome/130 Macintosh', async () => {
      events.push('mint-device-code');
      return '7f3a2c';
    });
    await target.choice;
    events.push('snapshot-revision');
    await target.write(SEALED);
    expect(events).toEqual(['mint-device-code', 'snapshot-revision']);
  });
});
