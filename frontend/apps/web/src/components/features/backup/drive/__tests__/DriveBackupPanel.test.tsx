import { useMemo } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backupNameOf } from '../../../../../lib/drive/backupName';
import { createFakeDrive } from '../../../../../lib/drive/testing/fakeDrive';
import { createMemoryDeviceRows } from '../../../../../lib/drive/testing/memoryCredentials';
import { passphraseSealedFixtureBytes } from '../../../../../lib/drive/testing/sealedFixture';
import { resetDriveSessionPassphraseForTests, useDriveBackup } from '../../../../../hooks/useDriveBackup';
import type { BackupRestore } from '../../../../../hooks/useBackupRestore';
import { RestoreFromBackup } from '../../RestoreFromBackup';
import { DriveBackupPanel } from '../DriveBackupPanel';

const SEALED = await passphraseSealedFixtureBytes('panel-fixture');

function FakeHost({
  connected = true,
  enabled = true,
  lastBackupAt = null as string | null,
}: {
  readonly connected?: boolean;
  readonly enabled?: boolean;
  readonly lastBackupAt?: string | null;
}) {
  const drive = useMemo(() => {
    if (!enabled) return null;
    const d = createFakeDrive();
    d.isConnected = async () => connected;
    d.files.set('own-1', {
      name: 'almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh',
      bytes: SEALED,
      trashed: false,
    });
    d.files.set('other-1', {
      name: 'almamesh-backup-2026-10-10T17-00-00-000Z-safari-ios-bbbbbb.almamesh',
      bytes: SEALED,
      trashed: false,
    });
    return d;
  }, [connected, enabled]);

  const rows = useMemo(() => {
    const r = createMemoryDeviceRows();
    r.map.set('device-code', '7f3a2c');
    if (lastBackupAt) r.map.set('drive-last-backup/google-drive', lastBackupAt);
    return r;
  }, [lastBackupAt]);

  const restore = useMemo(() => ({ stageContent: vi.fn(async () => undefined) }) as unknown as BackupRestore, []);
  const controller = useDriveBackup({
    drive,
    restore,
    rows,
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  });
  return <DriveBackupPanel controller={controller} />;
}

beforeEach(() => {
  resetDriveSessionPassphraseForTests();
});

describe('DriveBackupPanel & RestoreFromBackup', () => {
  it('renders nothing when drive backup is disabled for the origin', () => {
    const { container } = render(<FakeHost enabled={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows Connect Google Drive when disconnected', async () => {
    render(<FakeHost connected={false} />);
    expect(await screen.findByTestId('drive-connect-button')).toBeTruthy();
  });

  it('lists own and cross-device backups, shows Trash only for own device, and shows 14-day nudge', async () => {
    render(<FakeHost connected lastBackupAt="2026-10-01T00:00:00.000Z" />);
    await waitFor(() => expect(screen.getAllByTestId('drive-backup-row')).toHaveLength(2));
    expect(screen.getAllByTestId('drive-restore-entry')).toHaveLength(2);
    expect(screen.getAllByTestId('drive-trash-entry')).toHaveLength(1);
    expect(screen.getByTestId('drive-stale-nudge')).toBeTruthy();

    fireEvent.click(screen.getByTestId('drive-backup-now-button'));
    expect(await screen.findByTestId('drive-passphrase-input')).toBeTruthy();
  });

  it('does not list Drive on RestoreFromBackup mount until the user opens From Google Drive', async () => {
    const drive = createFakeDrive();
    await drive.upload(
      backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh'),
      { bytes: SEALED } as never,
    );
    const listSpy = vi.spyOn(drive, 'list');
    render(
      <MemoryRouter>
        <RestoreFromBackup driveOverride={drive} />
      </MemoryRouter>,
    );
    expect(listSpy).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId('first-run-drive-restore-button'));
    await waitFor(() => expect(screen.getByTestId('drive-backup-list')).toBeTruthy());
    expect(listSpy).toHaveBeenCalled();
    expect(screen.queryByTestId('drive-trash-entry')).toBeNull();
  });

  it('never claims Drive has zero backups before listLoaded is true (e.g. after 1h token expiry)', () => {
    const controller = {
      enabled: true,
      inMemoryOnly: false,
      connected: true,
      hasFreshToken: false,
      listLoaded: false,
      online: true,
      busy: false,
      entries: [],
      ownDeviceCode: '7f3a2c',
      lastBackupAt: '2026-10-29T12:00:00.000Z',
      showStaleNudge: false,
      needsReconnect: false,
      status: null,
      error: null,
      passphraseOpen: false,
      openPassphraseSetup: vi.fn(),
      closePassphraseSetup: vi.fn(),
      connect: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      backUpNow: vi.fn(async () => undefined),
      restoreEntry: vi.fn(async () => undefined),
      trashEntry: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
    render(<DriveBackupPanel controller={controller} />);
    expect(screen.getByTestId('drive-list-paused')).toBeTruthy();
    expect(screen.queryByTestId('drive-backup-empty')).toBeNull();
  });
});
