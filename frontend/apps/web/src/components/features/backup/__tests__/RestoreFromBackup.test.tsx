/**
 * First-run restore: a person on a new phone or browser restores their backup
 * BEFORE creating a chart, and lands on the dashboard.
 *
 * Same seam as the Settings panel tests: the backup service and file pickers
 * are mocked (the panel is orchestration over already-tested pieces) and the
 * typed errors come from the REAL `@almamesh/store` so `instanceof` matches.
 * Synthetic data only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  armPortableImportRevision,
  BackupCryptoError,
  BackupError,
  readPortableStateRevision,
} from '@almamesh/store';
import type { BackupEnvelopePlain } from '@almamesh/shared-types';

vi.mock('@almamesh/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@almamesh/store')>();
  return {
    ...actual,
    readPortableStateRevision: vi.fn(),
    armPortableImportRevision: vi.fn(),
    clearPortableImportRevisionFence: vi.fn(),
  };
});

import '../../../../i18n/config';

vi.mock('../../../../lib/backupService', () => ({
  buildBackupExport: vi.fn(),
  stageBackupImport: vi.fn(),
  commitBackupImport: vi.fn(),
  hasDataToProtect: vi.fn(),
  exportBackupFilename: vi.fn(() => 'almamesh-backup-2026-07-01T12-34-56-000Z.almamesh'),
  safetyBackupFilename: (name: string) =>
    name.replace('almamesh-backup-', 'almamesh-backup-before-import-'),
}));

vi.mock('../../../../lib/backupFile', () => ({
  pickBackupFile: vi.fn(),
  openBackupSaveTarget: vi.fn(),
}));

import {
  buildBackupExport,
  commitBackupImport,
  hasDataToProtect,
  stageBackupImport,
} from '../../../../lib/backupService';
import { openBackupSaveTarget, pickBackupFile } from '../../../../lib/backupFile';
import { RestoreFromBackup } from '../RestoreFromBackup';

const ENVELOPE: BackupEnvelopePlain = {
  format: 'almamesh-backup',
  formatVersion: 1,
  app: { version: 'test' },
  exportedAt: '2026-07-01T00:00:00.000Z',
  encryption: 'none',
  stores: {},
};
const BUNDLE_BYTES = new Uint8Array([7, 7, 7]);
const STAGED_BUNDLE = {
  kind: 'bundle' as const,
  envelope: ENVELOPE,
  wasEncrypted: true as const,
  bytes: new Uint8Array([1]),
};
const PASSWORD = 'correct horse battery';

let assignSpy: ReturnType<typeof vi.fn>;
let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(pickBackupFile).mockResolvedValue(BUNDLE_BYTES);
  // An encrypted bundle: the first stage asks for the password; the right one opens it.
  vi.mocked(stageBackupImport).mockImplementation(async (_content, passphrase) => {
    if (passphrase !== PASSWORD) throw new BackupCryptoError('bad_passphrase', 'locked');
    return STAGED_BUNDLE;
  });
  vi.mocked(commitBackupImport).mockResolvedValue(undefined);
  vi.mocked(hasDataToProtect).mockResolvedValue(false);
  vi.mocked(readPortableStateRevision).mockResolvedValue(3);
  assignSpy = vi.fn();
  reloadSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { assign: assignSpy, reload: reloadSpy },
  });
});

async function unlockWith(password: string) {
  fireEvent.change(await screen.findByTestId('backup-passphrase-prompt-input'), {
    target: { value: password },
  });
  fireEvent.click(screen.getByTestId('backup-passphrase-prompt-submit'));
}

describe('RestoreFromBackup (first run)', () => {
  it('offers "Restore from a backup"', () => {
    render(<RestoreFromBackup />);
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeTruthy();
  });

  it('on an empty browser: restores without a safety copy and opens the dashboard', async () => {
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await unlockWith(PASSWORD);

    const confirm = await screen.findByTestId('backup-confirm-import');
    // Nothing on this browser to protect: no safety password, no safety file.
    expect(screen.queryByTestId('backup-safety-passphrase-input')).toBeNull();
    expect(screen.getByText(/nothing on this browser yet/i)).toBeTruthy();
    fireEvent.click(confirm);

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith('/dashboard'));
    expect(vi.mocked(commitBackupImport)).toHaveBeenCalledWith(STAGED_BUNDLE);
    expect(vi.mocked(openBackupSaveTarget)).not.toHaveBeenCalled();
    expect(vi.mocked(buildBackupExport)).not.toHaveBeenCalled();
    // The emptiness re-check is fenced to the revision the commit must follow.
    expect(vi.mocked(armPortableImportRevision)).toHaveBeenCalledExactlyOnceWith(3);
    expect(sessionStorage.getItem('almamesh:restore-reload')).toBe('1');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('a wrong password says so and imports nothing', async () => {
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await unlockWith('not the password');

    expect(
      await screen.findByText('Wrong password, or the file was changed after export. Nothing was imported.'),
    ).toBeTruthy();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('a file that is not a backup is refused inline, and the button still works', async () => {
    vi.mocked(stageBackupImport).mockRejectedValue(new BackupError('bad_format', 'nope'));
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));

    const alert = await screen.findByTestId('first-run-restore-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe("That file isn't an AlmaMesh backup.");
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
    expect((screen.getByTestId('first-run-restore-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a corrupt bundle is refused with its reason', async () => {
    vi.mocked(stageBackupImport).mockRejectedValue(new BackupError('corrupt', 'holds no AlmaMesh database'));
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));

    expect((await screen.findByTestId('first-run-restore-error')).textContent).toBe(
      "Couldn't read that backup: holds no AlmaMesh database",
    );
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });

  it('a closed file picker does nothing', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue(null);
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));

    await waitFor(() => expect(vi.mocked(pickBackupFile)).toHaveBeenCalled());
    expect(vi.mocked(stageBackupImport)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('first-run-restore-error')).toBeNull();
  });

  it('if data appears before confirm (another tab), it refuses instead of replacing without a copy', async () => {
    vi.mocked(hasDataToProtect).mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await unlockWith(PASSWORD);
    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    expect(await screen.findByTestId('first-run-restore-error')).toBeTruthy();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
    expect(vi.mocked(armPortableImportRevision)).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('if the browser already holds data, the same flow takes the safety copy first', async () => {
    vi.mocked(hasDataToProtect).mockResolvedValue(true);
    vi.mocked(openBackupSaveTarget).mockReturnValue({
      choice: Promise.resolve('chosen'),
      write: vi.fn(async () => 'saved' as const),
      discard: vi.fn(async () => undefined),
    });
    vi.mocked(buildBackupExport).mockResolvedValue({
      filename: 'x.almamesh',
      content: new Uint8Array([9]),
      repairs: { unlinkedChatThreadIds: [], droppedReadingChartIds: [], droppedRecordKeys: [], setAside: [] },
    } as never);
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await unlockWith(PASSWORD);
    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith('/dashboard'));
    expect(vi.mocked(openBackupSaveTarget)).toHaveBeenCalledWith(
      'almamesh-backup-before-import-2026-07-01T12-34-56-000Z.almamesh',
    );
    expect(vi.mocked(buildBackupExport)).toHaveBeenCalledWith(PASSWORD);
  });

  it('a failed restore says so and stays on this page', async () => {
    vi.mocked(commitBackupImport).mockRejectedValue(new Error('disk full'));
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await unlockWith(PASSWORD);
    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    expect((await screen.findByTestId('first-run-restore-error')).textContent).toContain('disk full');
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('if the database revision moves during the emptiness re-check, it refuses', async () => {
    vi.mocked(readPortableStateRevision).mockResolvedValueOnce(3).mockResolvedValueOnce(4);
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await unlockWith(PASSWORD);
    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    expect((await screen.findByTestId('first-run-restore-error')).textContent).toContain(
      'Start the restore again',
    );
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });

  it('a file picker that fails says why', async () => {
    vi.mocked(pickBackupFile).mockRejectedValue(new Error('That backup is too large to open safely.'));
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));

    expect((await screen.findByTestId('first-run-restore-error')).textContent).toBe(
      "Couldn't read that backup: That backup is too large to open safely.",
    );
  });

  it('closing the password prompt imports nothing', async () => {
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await screen.findByTestId('backup-passphrase-prompt-input');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('backup-passphrase-prompt-input')).toBeNull());
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });

  it('when the safety-copy save picker cannot open, it explains and replaces nothing', async () => {
    vi.mocked(hasDataToProtect).mockResolvedValue(true);
    vi.mocked(openBackupSaveTarget).mockImplementation(() => {
      throw new Error('picker blocked');
    });
    render(<RestoreFromBackup />);

    fireEvent.click(screen.getByTestId('first-run-restore-button'));
    await unlockWith(PASSWORD);
    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    expect((await screen.findByTestId('backup-safety-failed')).textContent).toContain('picker blocked');
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });
});
