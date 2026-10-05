/**
 * DataSettings — the "Backup & Restore" settings panel (Spec 061).
 *
 * Proves the panel orchestrates the already-tested backup service + file I/O:
 *  - Export: collect → save, surfacing the "downloaded" status; passphrase threaded.
 *  - Import: pick → stage → confirm, with a safety-net export FIRST, then commit
 *    and reload.
 *  - Encrypted backups prompt for a passphrase and retry staging with it.
 *  - Typed refusals (too_new / bad_format) map to their user-facing messages.
 *  - A cancelled file picker does nothing.
 *
 * The service + file layers are mocked (vi.mock) so no real storage/crypto/DOM
 * file dialogs are needed. The typed error classes come from the REAL
 * `@almamesh/store` so the panel's `instanceof` checks match. Synthetic data only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  EMPTY_PORTABLE_REPAIR_REPORT,
  armPortableImportRevision,
  BackupCryptoError,
  BackupError,
  clearPortableImportRevisionFence,
  PortableImportRevisionConflictError,
  PortableStateUnavailableError,
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
    listSetAsideRecords: vi.fn(async () => []),
  };
});

import '../../../i18n/config';

// --- Service + file-IO layers mocked (the panel is pure orchestration) -------

vi.mock('../../../lib/backupService', () => ({
  buildBackupExport: vi.fn(),
  stageBackupImport: vi.fn(),
  commitBackupImport: vi.fn(),
  exportBackupFilename: vi.fn(() => 'almamesh-backup-2026-07-01T12-34-56-000Z.almamesh'),
  safetyBackupFilename: (name: string) =>
    name.replace('almamesh-backup-', 'almamesh-backup-before-import-'),
}));

// The picker opens first (inside the click) and the bytes are written later;
// `saveBackupFile` stands in for "the user picked a place, then we wrote it".
vi.mock('../../../lib/backupFile', () => ({
  saveBackupFile: vi.fn(),
  pickBackupFile: vi.fn(),
  openBackupSaveTarget: vi.fn(),
}));

import {
  buildBackupExport,
  stageBackupImport,
  commitBackupImport,
} from '../../../lib/backupService';
import { saveBackupFile, pickBackupFile, openBackupSaveTarget } from '../../../lib/backupFile';
import { listSetAsideRecords } from '@almamesh/store';
import DataSettings, { DataSettingsPanel } from '../DataSettings';

const SAMPLE_ENVELOPE: BackupEnvelopePlain = {
  format: 'almamesh-backup',
  formatVersion: 1,
  app: { version: 'test' },
  exportedAt: '2026-07-01T00:00:00.000Z',
  encryption: 'none',
  stores: {},
};

let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // clearAllMocks (not reset) so the global matchMedia mock from setup.ts keeps
  // its implementation — framer-motion reads it when a dialog opens.
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(buildBackupExport).mockResolvedValue({
    filename: 'almamesh-backup-2026-07-01T12-34-56-000Z.almamesh',
    content: new Uint8Array([1, 2, 3]),
    repairs: EMPTY_PORTABLE_REPAIR_REPORT,
  });
  vi.mocked(saveBackupFile).mockResolvedValue('saved');
  vi.mocked(openBackupSaveTarget).mockImplementation((name: string) => ({
    choice: Promise.resolve('chosen'),
    write: (content) => saveBackupFile(name, content),
    discard: vi.fn(async () => undefined),
  }));
  vi.mocked(pickBackupFile).mockResolvedValue(null);
  vi.mocked(stageBackupImport).mockResolvedValue({
    kind: 'json',
    envelope: SAMPLE_ENVELOPE,
    wasEncrypted: false,
  });
  vi.mocked(commitBackupImport).mockResolvedValue(undefined);
  vi.mocked(readPortableStateRevision).mockResolvedValue(17);

  // Stub reload — the panel reloads after a commit; happy-dom's is a no-op we spy.
  reloadSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { reload: reloadSpy },
  });
});

describe('DataSettings — Backup & Restore panel', () => {
  it('renders the panel and both actions', () => {
    render(<DataSettings />);
    expect(screen.getByTestId('settings-data-panel')).toBeTruthy();
    expect(screen.getByTestId('backup-export-button')).toBeTruthy();
    expect(screen.getByTestId('backup-import-button')).toBeTruthy();
    expect(screen.getByText('Import / Restore')).toBeTruthy();
    expect(screen.getByText('Import a backup')).toBeTruthy();
  });

  it('disables restore when SQLite is session-only because reload would erase it', () => {
    render(<DataSettingsPanel persistence="memory" />);

    expect((screen.getByTestId('backup-import-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('backup-import-memory-warning').textContent).toContain(
      'Import needs durable browser storage',
    );
  });

  // CONTRACT REVERSAL: export used to work with no password and silently left
  // out settings and the AI key. The file now carries them, so a password is
  // required to seal it.
  it('refuses to export without a password and says why', async () => {
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-export-button'));

    expect(
      await screen.findByText(
        'Choose a password of at least 8 characters. It encrypts the file, including your AI key.',
      ),
    ).toBeTruthy();
    expect(vi.mocked(buildBackupExport)).not.toHaveBeenCalled();
  });

  it('refuses a password shorter than 8 characters', async () => {
    render(<DataSettings />);

    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'short' },
    });
    fireEvent.click(screen.getByTestId('backup-export-button'));

    expect(await screen.findByTestId('backup-error')).toBeTruthy();
    expect(vi.mocked(buildBackupExport)).not.toHaveBeenCalled();
  });

  it('passes the entered passphrase to the export and shows the downloaded status', async () => {
    vi.mocked(buildBackupExport).mockResolvedValue({
      filename: 'almamesh-backup-2026-07-01.json',
      content: '{"formatVersion":2}',
      repairs: EMPTY_PORTABLE_REPAIR_REPORT,
    });
    render(<DataSettings />);

    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });
    fireEvent.click(screen.getByTestId('backup-export-button'));

    await waitFor(() =>
      expect(vi.mocked(buildBackupExport)).toHaveBeenCalledWith('hunter2-long'),
    );
    // The file name is chosen before the export is built (the picker opens
    // inside the click), so it is the export name, not the builder's.
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledWith(
      'almamesh-backup-2026-07-01T12-34-56-000Z.almamesh',
      '{"formatVersion":2}',
    );
    expect(await screen.findByText('Backup downloaded.')).toBeTruthy();
  });

  it('says plainly what the export repaired: chats kept without their chart, readings left out, records set aside', async () => {
    vi.mocked(buildBackupExport).mockResolvedValue({
      filename: 'almamesh-backup-2026-10-05.almamesh',
      content: new Uint8Array([1]),
      repairs: {
        ...EMPTY_PORTABLE_REPAIR_REPORT,
        unlinkedChatThreadIds: ['t1'],
        droppedReadingChartIds: ['c1', 'c3'],
        setAside: [{ row: 'almamesh-life-events', personId: 'gone', value: '[]' }],
      },
    });
    render(<DataSettings />);

    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });
    fireEvent.click(screen.getByTestId('backup-export-button'));

    expect(
      await screen.findByText(
        'Backup downloaded. 1 chat conversation was started on a chart that no longer exists. It is kept in full, just no longer linked to that chart. '
          + '2 AI readings belonged to charts that no longer exist, so they were not kept. You can generate new readings anytime. '
          + '1 saved record (life events or a birth-time check) belongs to a person who is no longer on this device. '
          + 'It is set aside on this device, not deleted, and not included in backups. Restore or delete them in Settings → Data.',
      ),
    ).toBeTruthy();
  });

  it('says before Replace what the import will repair', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    vi.mocked(stageBackupImport).mockResolvedValueOnce({
      kind: 'json',
      envelope: { format: 'almamesh-backup', formatVersion: 1, app: { version: 't' }, exportedAt: 'x', encryption: 'none', stores: {} },
      wasEncrypted: false,
      repairs: { ...EMPTY_PORTABLE_REPAIR_REPORT, droppedReadingChartIds: ['c1'] },
    });
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));

    const note = await screen.findByTestId('backup-import-repairs');
    expect(note.textContent).toContain('This backup needs a small repair');
    expect(note.textContent).toContain('1 AI reading belonged to a chart that no longer exists, so it was not kept.');
  });

  it('shows the export failure reason instead of a generic error', async () => {
    vi.mocked(buildBackupExport).mockRejectedValueOnce(new PortableStateUnavailableError());
    render(<DataSettings />);

    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });
    fireEvent.click(screen.getByTestId('backup-export-button'));

    expect(
      await screen.findByText(/This browser can't open AlmaMesh's local database/),
    ).toBeTruthy();
  });

  // ITEM 5a — the passphrase must not linger in the field after a saved export.
  it('clears the passphrase field after a successful export', async () => {
    render(<DataSettings />);
    const input = screen.getByTestId('backup-passphrase-input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'hunter2-long' } });
    expect(input.value).toBe('hunter2-long');

    fireEvent.click(screen.getByTestId('backup-export-button'));

    await waitFor(() => expect(input.value).toBe(''));
  });

  it('imports: pick → stage → confirm downloads a safety-net, commits, and reloads', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));

    // The confirm dialog appears once the file is staged.
    const confirmBtn = await screen.findByTestId('backup-confirm-import');
    expect(vi.mocked(stageBackupImport)).toHaveBeenCalledWith('FILE_TEXT', undefined);

    fireEvent.change(screen.getByTestId('backup-safety-passphrase-input'), {
      target: { value: 'safety-password' },
    });
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(vi.mocked(commitBackupImport)).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'json', envelope: SAMPLE_ENVELOPE }),
      ),
    );
    expect(vi.mocked(buildBackupExport)).toHaveBeenCalledWith('safety-password');
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledWith(
      'almamesh-backup-before-import-2026-07-01T12-34-56-000Z.almamesh',
      new Uint8Array([1, 2, 3]),
    );
    expect(vi.mocked(readPortableStateRevision)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(armPortableImportRevision)).toHaveBeenCalledExactlyOnceWith(17);
    expect(vi.mocked(clearPortableImportRevisionFence)).toHaveBeenCalledOnce();
    expect(vi.mocked(saveBackupFile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(armPortableImportRevision).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(armPortableImportRevision).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(commitBackupImport).mock.invocationCallOrder[0]!,
    );
    expect(sessionStorage.getItem('almamesh:restore-reload')).toBe('1');
    expect(reloadSpy).toHaveBeenCalled();
  });

  it('passes a picked SQLite backup to staging as bytes', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('SQLite format 3\0'), 1]);
    vi.mocked(pickBackupFile).mockResolvedValue(bytes);
    vi.mocked(stageBackupImport).mockResolvedValue({
      kind: 'sqlite',
      envelope: SAMPLE_ENVELOPE,
      wasEncrypted: false,
      bytes,
    });
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));

    await screen.findByTestId('backup-confirm-import');
    expect(vi.mocked(stageBackupImport)).toHaveBeenCalledWith(bytes, undefined);
  });

  it('refuses a raw or unencrypted legacy import until its safety backup has a password', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('LEGACY_TEXT');
    render(<DataSettings />);
    fireEvent.click(screen.getByTestId('backup-import-button'));

    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    expect(await screen.findByText(
      'Choose a password of at least 8 characters for the encrypted safety backup.',
    )).toBeTruthy();
    expect(vi.mocked(buildBackupExport)).not.toHaveBeenCalled();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });

  // CONTRACT REVERSAL (export/import robustness, item 2): a cancelled safety
  // save used to close the dialog with "Import cancelled" and block the import.
  // It now keeps the dialog open and offers an explicit choice: try the copy
  // again, or replace without one. Nothing is replaced until the user picks.
  it('offers an explicit choice when the safety-net save is cancelled, and changes nothing', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    // The safety-net save (the only saveBackupFile call in this flow) is cancelled.
    vi.mocked(saveBackupFile).mockResolvedValue('cancelled');
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));
    const confirmBtn = await screen.findByTestId('backup-confirm-import');
    fireEvent.change(screen.getByTestId('backup-safety-passphrase-input'), {
      target: { value: 'safety-password' },
    });
    fireEvent.click(confirmBtn);

    // The safety net was attempted, then the import bailed out entirely.
    await waitFor(() =>
      expect(vi.mocked(saveBackupFile)).toHaveBeenCalledWith(
        'almamesh-backup-before-import-2026-07-01T12-34-56-000Z.almamesh',
        new Uint8Array([1, 2, 3]),
      ),
    );
    const failed = await screen.findByTestId('backup-safety-failed');
    expect(failed.textContent).toContain("We couldn't save a copy of your current data first");
    expect(failed.textContent).toContain('the save dialog was closed');
    expect(screen.getByTestId('backup-safety-retry')).toBeTruthy();
    expect(screen.getByTestId('backup-skip-safety')).toBeTruthy();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation after an unverified fallback safety download', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    vi.mocked(saveBackupFile).mockResolvedValue('unverified');
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));
    const confirmBtn = await screen.findByTestId('backup-confirm-import');
    fireEvent.change(screen.getByTestId('backup-safety-passphrase-input'), {
      target: { value: 'safety-password' },
    });
    fireEvent.click(confirmBtn);

    expect(
      await screen.findByText(
        'Confirm that the encrypted safety backup appears in Downloads, then continue.',
      ),
    ).toBeTruthy();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('backup-confirm-import'));

    await waitFor(() => expect(vi.mocked(commitBackupImport)).toHaveBeenCalledOnce());
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledOnce();
    expect(vi.mocked(readPortableStateRevision)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(armPortableImportRevision)).toHaveBeenCalledExactlyOnceWith(17);
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('does not save or replace when canonical SQLite changes during the safety snapshot', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    vi.mocked(readPortableStateRevision)
      .mockResolvedValueOnce(17)
      .mockResolvedValueOnce(18);
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));
    fireEvent.change(await screen.findByTestId('backup-safety-passphrase-input'), {
      target: { value: 'safety-password' },
    });
    fireEvent.click(screen.getByTestId('backup-confirm-import'));

    expect((await screen.findByTestId('backup-safety-failed')).textContent).toContain(
      'Your AlmaMesh data changed while the safety backup was being prepared',
    );
    expect(vi.mocked(saveBackupFile)).not.toHaveBeenCalled();
    expect(vi.mocked(armPortableImportRevision)).not.toHaveBeenCalled();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('refuses the second-confirm Replace when another tab changed SQLite after download', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    vi.mocked(saveBackupFile).mockResolvedValue('unverified');
    vi.mocked(commitBackupImport).mockRejectedValueOnce(
      new PortableImportRevisionConflictError(17, 19),
    );
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));
    fireEvent.change(await screen.findByTestId('backup-safety-passphrase-input'), {
      target: { value: 'safety-password' },
    });
    fireEvent.click(screen.getByTestId('backup-confirm-import'));
    await screen.findByTestId('backup-safety-confirmation');

    fireEvent.click(screen.getByTestId('backup-confirm-import'));

    expect((await screen.findByTestId('backup-error')).textContent).toContain(
      'Your AlmaMesh data changed after the safety backup',
    );
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledOnce();
    expect(vi.mocked(armPortableImportRevision)).toHaveBeenCalledExactlyOnceWith(17);
    expect(vi.mocked(clearPortableImportRevisionFence)).toHaveBeenCalledOnce();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('prompts for a passphrase on an encrypted backup and retries staging with it', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('ENC_TEXT');
    vi.mocked(stageBackupImport)
      .mockRejectedValueOnce(new BackupCryptoError('bad_passphrase', 'encrypted'))
      .mockResolvedValueOnce({ kind: 'json', envelope: SAMPLE_ENVELOPE, wasEncrypted: true });

    render(<DataSettings />);
    fireEvent.click(screen.getByTestId('backup-import-button'));

    // The passphrase prompt appears instead of the confirm dialog.
    expect(await screen.findByText('Password required')).toBeTruthy();

    fireEvent.change(screen.getByTestId('backup-passphrase-prompt-input'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByTestId('backup-passphrase-prompt-submit'));

    await waitFor(() =>
      expect(vi.mocked(stageBackupImport)).toHaveBeenNthCalledWith(2, 'ENC_TEXT', 'secret'),
    );
  });

  it('maps a too-new backup to the too-new message and never commits', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    vi.mocked(stageBackupImport).mockRejectedValueOnce(
      new BackupError('too_new', 'newer'),
    );

    render(<DataSettings />);
    fireEvent.click(screen.getByTestId('backup-import-button'));

    expect(
      await screen.findByText(
        'This backup is from a newer version of AlmaMesh. Update the app first.',
      ),
    ).toBeTruthy();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });

  it('maps an unrecognized file to the bad-format message', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('NOT_A_BACKUP');
    vi.mocked(stageBackupImport).mockRejectedValueOnce(
      new BackupError('bad_format', 'nope'),
    );

    render(<DataSettings />);
    fireEvent.click(screen.getByTestId('backup-import-button'));

    expect(
      await screen.findByText("That file isn't an AlmaMesh backup."),
    ).toBeTruthy();
  });

  it('an encrypted bundle reuses its password to seal the safety backup', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('BUNDLE_TEXT');
    vi.mocked(buildBackupExport).mockResolvedValue({
      filename: 'almamesh-backup-2026-07-01T12-34-56-000Z.almamesh',
      content: new Uint8Array([9]),
      repairs: EMPTY_PORTABLE_REPAIR_REPORT,
    });
    vi.mocked(stageBackupImport)
      .mockRejectedValueOnce(new BackupCryptoError('bad_passphrase', 'encrypted'))
      .mockResolvedValueOnce({
        kind: 'bundle',
        envelope: SAMPLE_ENVELOPE,
        wasEncrypted: true,
        bytes: new Uint8Array([1]),
      });
    render(<DataSettings />);
    fireEvent.click(screen.getByTestId('backup-import-button'));
    fireEvent.change(await screen.findByTestId('backup-passphrase-prompt-input'), {
      target: { value: 'bundle-pass' },
    });
    fireEvent.click(screen.getByTestId('backup-passphrase-prompt-submit'));

    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    await waitFor(() => expect(vi.mocked(commitBackupImport)).toHaveBeenCalled());
    expect(vi.mocked(buildBackupExport)).toHaveBeenCalledWith('bundle-pass');
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledWith(
      'almamesh-backup-before-import-2026-07-01T12-34-56-000Z.almamesh',
      new Uint8Array([9]),
    );
  });

  it('a wrong password keeps the prompt open with a specific message and commits nothing', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('BUNDLE_TEXT');
    vi.mocked(stageBackupImport)
      .mockRejectedValueOnce(new BackupCryptoError('bad_passphrase', 'encrypted'))
      .mockRejectedValueOnce(new BackupCryptoError('bad_passphrase', 'wrong'));
    render(<DataSettings />);
    fireEvent.click(screen.getByTestId('backup-import-button'));
    fireEvent.change(await screen.findByTestId('backup-passphrase-prompt-input'), {
      target: { value: 'wrong-pass' },
    });
    fireEvent.click(screen.getByTestId('backup-passphrase-prompt-submit'));

    expect(
      await screen.findByText(
        "Wrong password, or the file was changed after export. Nothing was imported.",
      ),
    ).toBeTruthy();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });

  it('warns before restoring an older backup that carries no AI settings', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(stageBackupImport).mockResolvedValue({
      kind: 'sqlite',
      envelope: SAMPLE_ENVELOPE,
      wasEncrypted: false,
      bytes: new Uint8Array([1]),
    });
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));

    expect(await screen.findByTestId('backup-legacy-note')).toBeTruthy();
  });

  it('maps an unavailable local database to an actionable message', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(stageBackupImport).mockRejectedValueOnce(new PortableStateUnavailableError());
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));

    expect(
      await screen.findByText(/This browser can't open AlmaMesh's local database/),
    ).toBeTruthy();
  });

  it('shows the reason when a backup cannot be read for an unexpected cause', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    vi.mocked(stageBackupImport).mockRejectedValueOnce(new Error('worker crashed'));
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));

    expect(await screen.findByText("Couldn't read that backup: worker crashed")).toBeTruthy();
  });

  it('shows the reason when the restore itself fails', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    vi.mocked(commitBackupImport).mockRejectedValueOnce(new Error('disk full'));
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));
    fireEvent.change(await screen.findByTestId('backup-safety-passphrase-input'), {
      target: { value: 'safety-password' },
    });
    fireEvent.click(await screen.findByTestId('backup-confirm-import'));

    expect(await screen.findByText(/Restore failed: disk full/)).toBeTruthy();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('does nothing when the file picker is cancelled', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue(null);
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));

    await waitFor(() => expect(vi.mocked(pickBackupFile)).toHaveBeenCalled());
    expect(vi.mocked(stageBackupImport)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('backup-confirm-import')).toBeNull();
  });

  async function stageAndConfirm(): Promise<void> {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    render(<DataSettings />);
    fireEvent.click(screen.getByTestId('backup-import-button'));
    fireEvent.change(await screen.findByTestId('backup-safety-passphrase-input'), {
      target: { value: 'safety-password' },
    });
    fireEvent.click(screen.getByTestId('backup-confirm-import'));
  }

  // Item 5: Chrome's save picker needs the click's user activation (~5 s).
  it('opens the export save picker inside the click, before building the export', async () => {
    render(<DataSettings />);
    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });

    fireEvent.click(screen.getByTestId('backup-export-button'));

    // Synchronously, in the click itself:
    expect(vi.mocked(openBackupSaveTarget)).toHaveBeenCalledWith(
      'almamesh-backup-2026-07-01T12-34-56-000Z.almamesh',
    );
    await waitFor(() => expect(vi.mocked(saveBackupFile)).toHaveBeenCalled());
    expect(vi.mocked(openBackupSaveTarget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(buildBackupExport).mock.invocationCallOrder[0]!,
    );
  });

  it('builds nothing when the export save picker is dismissed', async () => {
    vi.mocked(openBackupSaveTarget).mockReturnValue({
      choice: Promise.resolve('cancelled'),
      write: vi.fn(),
      discard: vi.fn(),
    });
    render(<DataSettings />);
    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });

    fireEvent.click(screen.getByTestId('backup-export-button'));

    await waitFor(() =>
      expect((screen.getByTestId('backup-export-button') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(vi.mocked(buildBackupExport)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('backup-error')).toBeNull();
  });

  it('removes the empty picked file when the export itself fails', async () => {
    const discard = vi.fn(async () => undefined);
    vi.mocked(openBackupSaveTarget).mockReturnValue({
      choice: Promise.resolve('chosen'),
      write: vi.fn(),
      discard,
    });
    vi.mocked(buildBackupExport).mockRejectedValueOnce(new Error('validator refused'));
    render(<DataSettings />);
    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });

    fireEvent.click(screen.getByTestId('backup-export-button'));

    expect((await screen.findByTestId('backup-error')).textContent).toContain('validator refused');
    expect(discard).toHaveBeenCalledOnce();
  });

  it('opens the safety-copy save picker inside the confirm click, before building it', async () => {
    await stageAndConfirm();

    expect(vi.mocked(openBackupSaveTarget)).toHaveBeenCalledWith(
      'almamesh-backup-before-import-2026-07-01T12-34-56-000Z.almamesh',
    );
    await waitFor(() => expect(vi.mocked(commitBackupImport)).toHaveBeenCalledOnce());
    expect(vi.mocked(openBackupSaveTarget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(buildBackupExport).mock.invocationCallOrder[0]!,
    );
  });

  // Item 2: a safety copy that cannot be made must never block the import, and
  // must never be skipped silently either.
  it('offers a choice when the safety export is refused, and replaces only on the explicit skip', async () => {
    vi.mocked(buildBackupExport).mockRejectedValueOnce(
      new Error('"almamesh-chat-history" references missing chart "c1"'),
    );
    await stageAndConfirm();

    const failed = await screen.findByTestId('backup-safety-failed');
    expect(failed.textContent).toContain('references missing chart');
    expect(failed.textContent).toContain('cannot be brought back');
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
    expect(vi.mocked(saveBackupFile)).not.toHaveBeenCalled();

    vi.mocked(readPortableStateRevision).mockResolvedValue(23);
    fireEvent.click(screen.getByTestId('backup-skip-safety'));

    await waitFor(() => expect(vi.mocked(commitBackupImport)).toHaveBeenCalledOnce());
    expect(vi.mocked(armPortableImportRevision)).toHaveBeenCalledExactlyOnceWith(23);
    expect(vi.mocked(saveBackupFile)).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledOnce();
  });

  it('offers a choice when the safety file cannot be written (storage full)', async () => {
    vi.mocked(saveBackupFile).mockRejectedValueOnce(
      new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
    );
    await stageAndConfirm();

    expect((await screen.findByTestId('backup-safety-failed')).textContent).toContain(
      'quota has been exceeded',
    );
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
  });

  it('retries the safety copy from the choice, then imports with it', async () => {
    vi.mocked(buildBackupExport).mockRejectedValueOnce(new Error('busy'));
    await stageAndConfirm();
    await screen.findByTestId('backup-safety-failed');

    fireEvent.click(screen.getByTestId('backup-safety-retry'));

    await waitFor(() => expect(vi.mocked(commitBackupImport)).toHaveBeenCalledOnce());
    expect(vi.mocked(openBackupSaveTarget)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('backup-safety-failed')).toBeNull();
  });

  // Item 1: set-aside records are reachable from Backup & Restore.
  it('shows set-aside records on the Backup & Restore screen', async () => {
    vi.mocked(listSetAsideRecords).mockResolvedValueOnce([
      {
        key: 'gone/almamesh-life-events/abc',
        row: 'almamesh-life-events',
        personId: 'gone',
        setAsideAt: '2026-10-05T12:00:00.000Z',
        itemCount: 2,
        preview: ['Married Ana'],
      },
    ]);
    render(<DataSettings />);

    expect((await screen.findByTestId('set-aside-records')).textContent).toContain('2 life events');
  });
});
