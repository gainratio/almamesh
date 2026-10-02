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
import { BackupCryptoError, BackupError, PortableStateUnavailableError } from '@almamesh/store';
import type { BackupEnvelopePlain } from '@almamesh/shared-types';

import '../../../i18n/config';

// --- Service + file-IO layers mocked (the panel is pure orchestration) -------

vi.mock('../../../lib/backupService', () => ({
  buildBackupExport: vi.fn(),
  stageBackupImport: vi.fn(),
  commitBackupImport: vi.fn(),
}));

vi.mock('../../../lib/backupFile', () => ({
  saveBackupFile: vi.fn(),
  pickBackupFile: vi.fn(),
}));

import {
  buildBackupExport,
  stageBackupImport,
  commitBackupImport,
} from '../../../lib/backupService';
import { saveBackupFile, pickBackupFile } from '../../../lib/backupFile';
import DataSettings from '../DataSettings';

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
    filename: 'almamesh-backup-2026-07-01.sqlite3',
    content: new Uint8Array([1, 2, 3]),
  });
  vi.mocked(saveBackupFile).mockResolvedValue('saved');
  vi.mocked(pickBackupFile).mockResolvedValue(null);
  vi.mocked(stageBackupImport).mockResolvedValue({
    kind: 'json',
    envelope: SAMPLE_ENVELOPE,
    wasEncrypted: false,
  });
  vi.mocked(commitBackupImport).mockResolvedValue(undefined);

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
    });
    render(<DataSettings />);

    fireEvent.change(screen.getByTestId('backup-passphrase-input'), {
      target: { value: 'hunter2-long' },
    });
    fireEvent.click(screen.getByTestId('backup-export-button'));

    await waitFor(() =>
      expect(vi.mocked(buildBackupExport)).toHaveBeenCalledWith('hunter2-long'),
    );
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledWith(
      'almamesh-backup-2026-07-01.json',
      '{"formatVersion":2}',
    );
    expect(await screen.findByText('Backup downloaded.')).toBeTruthy();
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

    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(vi.mocked(commitBackupImport)).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'json', envelope: SAMPLE_ENVELOPE }),
      ),
    );
    // Safety-net export happened first (no passphrase), using the service's
    // filename and byte content without forcing a legacy JSON extension.
    expect(vi.mocked(buildBackupExport)).toHaveBeenCalledWith();
    expect(vi.mocked(saveBackupFile)).toHaveBeenCalledWith(
      'almamesh-backup-before-import-2026-07-01.sqlite3',
      new Uint8Array([1, 2, 3]),
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

  // ITEM 1 — if the user cancels the safety-net save, the import must ABORT: no
  // commit, no reload, and a clear "nothing was changed" message.
  it('aborts the import when the safety-net save is cancelled', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('FILE_TEXT');
    // The safety-net save (the only saveBackupFile call in this flow) is cancelled.
    vi.mocked(saveBackupFile).mockResolvedValue('cancelled');
    render(<DataSettings />);

    fireEvent.click(screen.getByTestId('backup-import-button'));
    const confirmBtn = await screen.findByTestId('backup-confirm-import');
    fireEvent.click(confirmBtn);

    // The safety net was attempted, then the import bailed out entirely.
    await waitFor(() =>
      expect(vi.mocked(saveBackupFile)).toHaveBeenCalledWith(
        'almamesh-backup-before-import-2026-07-01.sqlite3',
        new Uint8Array([1, 2, 3]),
      ),
    );
    expect(
      await screen.findByText(
        "Import cancelled — we couldn't save a backup of your current data first, so nothing was changed.",
      ),
    ).toBeTruthy();
    expect(vi.mocked(commitBackupImport)).not.toHaveBeenCalled();
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

  it('a v2 bundle: unlock with the password, then the safety net is sealed with it too', async () => {
    vi.mocked(pickBackupFile).mockResolvedValue('BUNDLE_TEXT');
    vi.mocked(buildBackupExport).mockResolvedValue({
      filename: 'almamesh-backup-2026-07-01.json',
      content: 'SEALED',
    });
    vi.mocked(stageBackupImport)
      .mockRejectedValueOnce(new BackupCryptoError('bad_passphrase', 'encrypted'))
      .mockResolvedValueOnce({
        kind: 'bundle',
        envelope: SAMPLE_ENVELOPE,
        wasEncrypted: true,
        bytes: new Uint8Array([1]),
        settings: {},
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
      'almamesh-backup-before-import-2026-07-01.json',
      'SEALED',
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
});
