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
 * This panel is pure orchestration over the already-tested pieces:
 *  - `buildBackupExport` / `stageBackupImport` / `commitBackupImport` (backupService)
 *  - `saveBackupFile` / `pickBackupFile` (backupFile)
 * It reshapes the typed refusals (BackupError / BackupCryptoError) into i18n
 * messages and owns the confirm + passphrase-prompt dialogs.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  armPortableImportRevision,
  BackupCryptoError,
  BackupError,
  clearPortableImportRevisionFence,
  PortableStateUnavailableError,
  readPortableStateRevision,
} from '@almamesh/store';
import { Button, Card, Dialog, Input } from '../../components/ui';
import {
  buildBackupExport,
  commitBackupImport,
  exportBackupFilename,
  safetyBackupFilename,
  stageBackupImport,
  type StagedImport,
} from '../../lib/backupService';
import {
  openBackupSaveTarget,
  pickBackupFile,
  type BackupFileContent,
  type BackupSaveTarget,
} from '../../lib/backupFile';
import { suppressNextServiceWorkerHeal } from '../../lib/swSelfHeal';
import { repairNoteLines } from '../../lib/dataRepairNotice';
import { DataRepairNotice } from '../../components/features/settings/DataRepairNotice';
import { SetAsideRecords } from '../../components/features/settings/SetAsideRecords';

/** Minimum export password length; the file carries the AI key, so it is required. */
const MIN_PASSPHRASE_LENGTH = 8;

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function DataSettingsPanel() {
  const { t } = useTranslation('settings');

  // Export
  const [password, setPassword] = useState('');
  const [exporting, setExporting] = useState(false);

  // Shared status / error banners
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Import staging + confirm
  const [staged, setStaged] = useState<StagedImport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [safetyDownloadUnverified, setSafetyDownloadUnverified] = useState(false);
  const [safetyRevision, setSafetyRevision] = useState<number | null>(null);
  // Why the safety copy could not be made; the user then chooses retry or skip.
  const [safetyFailure, setSafetyFailure] = useState<string | null>(null);

  // Passphrase prompt (encrypted backups)
  const [pendingContent, setPendingContent] = useState<BackupFileContent | null>(null);
  // The password that unlocked the staged file; reused to seal the safety net.
  const [stagedPassphrase, setStagedPassphrase] = useState<string | undefined>(undefined);
  const [promptPassphrase, setPromptPassphrase] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);
  // Raw SQLite and unencrypted legacy imports have no password to reuse. The
  // user supplies one here so the mandatory pre-import safety copy is encrypted.
  const [safetyPassphrase, setSafetyPassphrase] = useState('');
  const [safetyPassphraseError, setSafetyPassphraseError] = useState<string | null>(null);

  const clearBanners = () => {
    setStatus(null);
    setError(null);
  };

  // Synchronous on purpose: the save picker must open inside the click
  // (Chrome's user activation lasts ~5 s; building the backup can take longer).
  function handleExport() {
    clearBanners();
    if (password.length < MIN_PASSPHRASE_LENGTH) {
      setError(t('backup.error_passphrase_required'));
      return;
    }
    let target: BackupSaveTarget;
    try {
      target = openBackupSaveTarget(exportBackupFilename());
    } catch (err) {
      setError(t('backup.error_export_failed', { reason: reasonOf(err) }));
      return;
    }
    void finishExport(target, password);
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
        setStatus(`${t('backup.status_exported')}${note}`);
        setPassword(''); // don't leave the passphrase lingering in the field
      } else if (result === 'unverified') {
        setStatus(`${t('backup.status_export_started')}${note}`);
        setPassword('');
      }
    } catch (err) {
      setError(
        err instanceof PortableStateUnavailableError
          ? t('backup.error_storage_unavailable')
          : t('backup.error_export_failed', { reason: reasonOf(err) }),
      );
    } finally {
      setExporting(false);
    }
  }

  /** Stage a picked file; open the passphrase prompt on encryption, else confirm. */
  async function stageFile(content: BackupFileContent, passphrase?: string) {
    setStatus(t('backup.status_checking'));
    try {
      const result = await stageBackupImport(content, passphrase);
      setStatus(null);
      setStagedPassphrase(
        passphrase !== undefined && passphrase.length >= MIN_PASSPHRASE_LENGTH
          ? passphrase
          : undefined,
      );
      setPendingContent(null);
      setPromptPassphrase('');
      setPromptError(null);
      setSafetyPassphrase('');
      setSafetyPassphraseError(null);
      setSafetyDownloadUnverified(false);
      setSafetyRevision(null);
      setSafetyFailure(null);
      setStaged(result);
      setConfirmOpen(true);
    } catch (err) {
      setStatus(null);
      if (err instanceof BackupCryptoError && err.code === 'bad_passphrase') {
        // Encrypted (or a wrong passphrase): (re)open the prompt to collect one.
        setPendingContent(content);
        setPromptError(passphrase ? t('backup.error_bad_passphrase') : null);
        return;
      }
      if (err instanceof BackupError && err.code === 'too_new') {
        setError(t('backup.error_too_new'));
        return;
      }
      if (err instanceof BackupError && err.code === 'bad_format') {
        setError(t('backup.error_bad_format'));
        return;
      }
      if (err instanceof PortableStateUnavailableError) {
        setError(t('backup.error_storage_unavailable'));
        return;
      }
      setError(t('backup.error_stage_failed', { reason: reasonOf(err) }));
    }
  }

  async function handleImport() {
    clearBanners();
    try {
      const content = await pickBackupFile();
      if (content == null) return;
      await stageFile(content);
    } catch (err) {
      setError(t('backup.error_stage_failed', { reason: reasonOf(err) }));
    }
  }

  async function handleUnlock() {
    if (pendingContent == null) {
      return;
    }
    await stageFile(pendingContent, promptPassphrase);
  }

  function closeConfirm() {
    setConfirmOpen(false);
    setSafetyDownloadUnverified(false);
    setSafetyRevision(null);
    setSafetyFailure(null);
  }

  // Synchronous on purpose: the safety copy's save picker opens inside the click.
  function handleConfirmImport() {
    if (staged == null) {
      return;
    }
    const safetyPassword = stagedPassphrase ?? safetyPassphrase;
    if (safetyPassword.length < MIN_PASSPHRASE_LENGTH) {
      setSafetyPassphraseError(t('backup.error_safety_passphrase_required'));
      return;
    }
    if (safetyDownloadUnverified) {
      void replaceData(staged, async () => safetyRevision);
      return;
    }
    let target: BackupSaveTarget;
    try {
      target = openBackupSaveTarget(safetyBackupFilename(exportBackupFilename()));
    } catch (err) {
      setSafetyFailure(reasonOf(err));
      return;
    }
    void saveSafetyCopyThenReplace(staged, target, safetyPassword);
  }

  /**
   * Safety net FIRST: always encrypted, with the imported file's password when
   * available or the explicit safety password. If the copy cannot be made, the
   * import is neither blocked nor silently continued: the user is told why and
   * chooses to retry or to replace without a copy.
   */
  async function saveSafetyCopyThenReplace(
    toImport: StagedImport,
    target: BackupSaveTarget,
    safetyPassword: string,
  ) {
    setImporting(true);
    setSafetyFailure(null);
    try {
      if ((await target.choice) === 'cancelled') {
        setSafetyFailure(t('backup.safety_failed_cancelled'));
        return;
      }
      let revisionAfterExport: number;
      let content: BackupFileContent;
      try {
        const revisionBeforeExport = await readPortableStateRevision();
        content = (await buildBackupExport(safetyPassword)).content;
        revisionAfterExport = await readPortableStateRevision();
        if (revisionAfterExport !== revisionBeforeExport) {
          throw new Error(
            'Your AlmaMesh data changed while the safety backup was being prepared. Try again.',
          );
        }
      } catch (err) {
        await target.discard();
        setSafetyFailure(reasonOf(err));
        return;
      }
      let saved: Awaited<ReturnType<BackupSaveTarget['write']>>;
      try {
        saved = await target.write(content);
      } catch (err) {
        setSafetyFailure(reasonOf(err));
        return;
      }
      if (saved === 'cancelled') {
        setSafetyFailure(t('backup.safety_failed_cancelled'));
        return;
      }
      if (saved === 'unverified') {
        // The <a download> fallback cannot prove completion. Keep the staged
        // import untouched and require a second, explicit confirmation.
        setSafetyDownloadUnverified(true);
        setSafetyRevision(revisionAfterExport);
        return;
      }
      await replaceData(toImport, async () => revisionAfterExport);
    } finally {
      setImporting(false);
    }
  }

  /** The user explicitly chose to replace this browser's data without a copy. */
  function handleSkipSafety() {
    if (staged == null) return;
    void replaceData(staged, readPortableStateRevision);
  }

  /**
   * Replace this browser's data with the staged backup. The revision fence
   * refuses the commit if another tab changed SQLite after `protect` read it.
   */
  async function replaceData(toImport: StagedImport, protect: () => Promise<number | null>) {
    setImporting(true);
    try {
      const protectedRevision = await protect();
      if (protectedRevision === null) {
        throw new Error('The safety backup revision is unavailable. Start the import again.');
      }
      armPortableImportRevision(protectedRevision);
      try {
        await commitBackupImport(toImport);
      } finally {
        clearPortableImportRevisionFence();
      }
      closeConfirm();
      setStatus(t('backup.status_imported'));
      // The restore owns the next reload. Prevent the SW self-heal check from
      // stacking a second reload while the fresh realm hydrates its stores.
      suppressNextServiceWorkerHeal();
      window.location.reload();
    } catch (err) {
      closeConfirm();
      setError(t('backup.error_import_failed', { reason: reasonOf(err) }));
    } finally {
      setImporting(false);
    }
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
            onClick={() => void handleImport()}
            data-testid="backup-import-button"
          >
            {t('backup.import_button')}
          </Button>
        </div>
      </Card>

      <SetAsideRecords />

      {/* Confirm "replace all data" dialog */}
      <Dialog
        open={confirmOpen}
        onClose={() => {
          if (!importing) closeConfirm();
        }}
        title={t('backup.confirm_title')}
      >
        <div className="space-y-4">
          <p className="text-text-secondary text-sm">{t('backup.confirm_body')}</p>
          {staged?.repairs !== undefined && repairNoteLines(t, staged.repairs).length > 0 && (
            <div data-testid="backup-import-repairs" className="text-sm text-status-warning space-y-1">
              <p className="font-semibold">{t('backup.import_repaired_title')}</p>
              {repairNoteLines(t, staged.repairs).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
          {staged?.kind !== 'bundle' && (
            <p data-testid="backup-legacy-note" className="text-sm text-status-warning">
              {t('backup.confirm_legacy_note')}
            </p>
          )}
          {safetyDownloadUnverified && (
            <p
              role="status"
              className="text-sm text-accent-gold"
              data-testid="backup-safety-confirmation"
            >
              {t('backup.confirm_safety_download')}
            </p>
          )}
          {safetyFailure !== null && (
            <div
              role="alert"
              data-testid="backup-safety-failed"
              className="space-y-2 rounded-md border border-status-warning/50 p-3 text-sm"
            >
              <p className="font-semibold text-status-warning">{t('backup.safety_failed_title')}</p>
              <p className="text-text-secondary">{t('backup.safety_failed_body', { reason: safetyFailure })}</p>
              <p className="text-text-secondary">{t('backup.safety_failed_choice')}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleConfirmImport}
                  disabled={importing}
                  data-testid="backup-safety-retry"
                >
                  {t('backup.safety_retry')}
                </Button>
                <button
                  type="button"
                  onClick={handleSkipSafety}
                  disabled={importing}
                  data-testid="backup-skip-safety"
                  className="px-3 h-8 rounded-md border border-status-error/60 text-status-error text-sm font-medium hover:bg-status-error/10 disabled:opacity-50"
                >
                  {t('backup.safety_skip')}
                </button>
              </div>
            </div>
          )}
          {stagedPassphrase === undefined && (
            <div className="space-y-2">
              <label
                htmlFor="backup-safety-passphrase"
                className="block text-sm font-medium text-text-primary"
              >
                {t('backup.safety_passphrase_label')}
              </label>
              <Input
                id="backup-safety-passphrase"
                type="password"
                value={safetyPassphrase}
                onChange={(event) => {
                  setSafetyPassphrase(event.target.value);
                  setSafetyPassphraseError(null);
                }}
                placeholder={t('backup.passphrase_placeholder')}
                data-testid="backup-safety-passphrase-input"
                autoComplete="new-password"
              />
              <p className="text-text-muted text-xs">{t('backup.safety_passphrase_hint')}</p>
              {safetyPassphraseError && (
                <p role="alert" className="text-sm text-status-error">
                  {safetyPassphraseError}
                </p>
              )}
            </div>
          )}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={closeConfirm}
              disabled={importing}
              className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md hover:bg-ui-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
            >
              {t('backup.cancel')}
            </button>
            <button
              type="button"
              data-testid="backup-confirm-import"
              onClick={handleConfirmImport}
              disabled={importing || safetyFailure !== null}
              className="flex-1 px-4 py-2.5 bg-status-error text-background-primary rounded-md hover:bg-status-error/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-bold"
            >
              {safetyDownloadUnverified
                ? t('backup.confirm_safety_ok')
                : t('backup.confirm_ok')}
            </button>
          </div>
        </div>
      </Dialog>

      {/* Passphrase prompt dialog (encrypted backups) */}
      <Dialog
        open={pendingContent != null}
        onClose={() => setPendingContent(null)}
        title={t('backup.passphrase_prompt_title')}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleUnlock();
          }}
          className="space-y-4"
        >
          <p className="text-text-secondary text-sm">{t('backup.passphrase_prompt_body')}</p>
          <Input
            type="password"
            value={promptPassphrase}
            onChange={(e) => setPromptPassphrase(e.target.value)}
            aria-label={t('backup.passphrase_prompt_title')}
            data-testid="backup-passphrase-prompt-input"
            autoComplete="off"
            autoFocus
          />
          {promptError && (
            <p role="alert" className="text-sm text-status-error">
              {promptError}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setPendingContent(null)}
              className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md hover:bg-ui-border transition-colors text-sm font-medium"
            >
              {t('backup.cancel')}
            </button>
            <Button
              type="submit"
              className="flex-1"
              data-testid="backup-passphrase-prompt-submit"
            >
              {t('backup.passphrase_prompt_submit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

export default function DataSettings() {
  return <DataSettingsPanel />;
}
