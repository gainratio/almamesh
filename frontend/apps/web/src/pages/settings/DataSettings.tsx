/**
 * DataSettings — the "Backup & Restore" settings panel (Spec 061).
 *
 * Lets a user move ALL their on-device data to another browser with a single
 * file. There is no server: Export seals canonical SQLite into an encrypted
 * `.almamesh` file; Import picks a
 * backup file, stages it in memory, downloads a safety-net copy of the CURRENT
 * data (so Replace is undoable), then — on confirm — replaces this browser's data
 * and reloads. Nothing is uploaded; the only bytes that leave the device are the
 * file the user chooses to save.
 *
 * Export is orchestrated here (`buildBackupExport` + `openBackupSaveTarget`).
 * Restore is the shared `useBackupRestore` flow + `RestoreBackupDialogs`, the
 * same one the first-run surfaces (landing, onboarding) use. The safety copy is
 * skipped only when this browser holds nothing to protect.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PortableStateUnavailableError } from '@almamesh/store';
import { Button, Card, Input } from '../../components/ui';
import { buildBackupExport, exportBackupFilename } from '../../lib/backupService';
import { openBackupSaveTarget, type BackupSaveTarget } from '../../lib/backupFile';
import { repairNoteLines } from '../../lib/dataRepairNotice';
import { useBackupRestore } from '../../hooks/useBackupRestore';
import { DataRepairNotice } from '../../components/features/settings/DataRepairNotice';
import { SetAsideRecords } from '../../components/features/settings/SetAsideRecords';
import { RestoreBackupDialogs } from '../../components/features/backup/RestoreBackupDialogs';
import { ConfirmPasswordField } from '../../components/features/backup/ConfirmPasswordField';
import { passwordsMatch } from '../../lib/backupPassword';

/** Minimum export password length; the file carries the AI key, so it is required. */
const MIN_PASSPHRASE_LENGTH = 8;

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function DataSettingsPanel() {
  const { t } = useTranslation('settings');
  // The one restore flow, shared with the first-run surfaces.
  const restore = useBackupRestore();

  // Export
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  // The mismatch shows once the user has typed in the confirm field, or on submit.
  const [confirmationTouched, setConfirmationTouched] = useState(false);
  const showMismatch = confirmationTouched && !passwordsMatch(password, confirmation);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // One status/error banner for the panel: the latest action's message.
  const status = exportStatus ?? restore.status;
  const error = exportError ?? restore.error;

  const clearBanners = () => {
    setExportStatus(null);
    setExportError(null);
    restore.clearMessages();
  };

  // Synchronous on purpose: the save picker must open inside the click
  // (Chrome's user activation lasts ~5 s; building the backup can take longer).
  function handleExport() {
    clearBanners();
    if (password.length < MIN_PASSPHRASE_LENGTH) {
      setExportError(t('backup.error_passphrase_required'));
      return;
    }
    if (!passwordsMatch(password, confirmation)) {
      setConfirmationTouched(true);
      return;
    }
    let target: BackupSaveTarget;
    try {
      target = openBackupSaveTarget(exportBackupFilename());
    } catch (err) {
      setExportError(t('backup.error_export_failed', { reason: reasonOf(err) }));
      return;
    }
    void finishExport(target, password);
  }

  function clearPasswords() {
    setPassword('');
    setConfirmation('');
    setConfirmationTouched(false);
  }

  async function finishExport(target: BackupSaveTarget, passphrase: string) {
    setExporting(true);
    try {
      if ((await target.choice) === 'cancelled') return;
      let built: Awaited<ReturnType<typeof buildBackupExport>>;
      try {
        built = await buildBackupExport(passphrase);
      } catch (err) {
        await target.discard();
        throw err;
      }
      const result = await target.write(built.content);
      // Honest about what the export repaired: a chat whose chart is gone is
      // kept in full; readings whose chart is gone are left out; records of a
      // person who is gone stay set aside on this device, out of the file.
      const note = repairNoteLines(t, built.repairs).map((line) => ` ${line}`).join('');
      if (result === 'saved') {
        setExportStatus(`${t('backup.status_exported')}${note}`);
        clearPasswords(); // don't leave the passphrase lingering in the fields
      } else if (result === 'unverified') {
        setExportStatus(`${t('backup.status_export_started')}${note}`);
        clearPasswords();
      }
    } catch (err) {
      setExportError(
        err instanceof PortableStateUnavailableError
          ? t('backup.error_storage_unavailable')
          : t('backup.error_export_failed', { reason: reasonOf(err) }),
      );
    } finally {
      setExporting(false);
    }
  }

  function handleImport() {
    setExportStatus(null);
    setExportError(null);
    void restore.chooseFile();
  }

  return (
    <div className="space-y-8" data-testid="settings-data-panel">
      {/* Section header */}
      <div className="border-b border-ui-border pb-4">
        <h2 className="text-xl font-semibold text-text-primary">{t('backup.title')}</h2>
        <p className="text-text-secondary text-sm mt-1">{t('backup.subtitle')}</p>
      </div>

      <DataRepairNotice />

      {/* Status / error banners */}
      {status && (
        <p data-testid="backup-status" role="status" className="text-sm text-status-success">
          {status}
        </p>
      )}
      {error && (
        <p data-testid="backup-error" role="alert" className="text-sm text-status-error">
          {error}
        </p>
      )}

      {/* Export */}
      <Card title={t('backup.export_heading')}>
        <div className="space-y-4">
          <p className="text-text-secondary text-sm">{t('backup.export_hint')}</p>
          <div className="space-y-2">
            <label
              htmlFor="backup-passphrase"
              className="block text-sm font-medium text-text-primary"
            >
              {t('backup.passphrase_label')}
            </label>
            <Input
              id="backup-passphrase"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('backup.passphrase_placeholder')}
              data-testid="backup-passphrase-input"
              autoComplete="new-password"
            />
          </div>
          <ConfirmPasswordField
            id="backup-passphrase-confirm"
            testId="backup-passphrase-confirm-input"
            mismatchTestId="backup-passphrase-mismatch"
            value={confirmation}
            onChange={(value) => {
              setConfirmation(value);
              setConfirmationTouched(true);
            }}
            showMismatch={showMismatch}
          />
          <Button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            data-testid="backup-export-button"
          >
            {t('backup.export_button')}
          </Button>
          <p className="text-text-muted text-xs">{t('backup.sensitivity_note')}</p>
        </div>
      </Card>

      {/* Restore */}
      <Card title={t('backup.import_heading')}>
        <div className="space-y-4">
          <p className="text-text-secondary text-sm">{t('backup.import_hint')}</p>
          <Button
            type="button"
            variant="outline"
            onClick={handleImport}
            data-testid="backup-import-button"
          >
            {t('backup.import_button')}
          </Button>
        </div>
      </Card>

      <SetAsideRecords />

      <RestoreBackupDialogs restore={restore} />
    </div>
  );
}

export default function DataSettings() {
  return <DataSettingsPanel />;
}
