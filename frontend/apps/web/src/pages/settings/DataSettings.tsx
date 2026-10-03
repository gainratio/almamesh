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
import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  armPortableImportRevision,
  BackupCryptoError,
  BackupError,
  clearPortableImportRevisionFence,
  PortableStateUnavailableError,
  portableStatePersistence,
  readPortableStateRevision,
  subscribePortableStatePersistence,
  type PortableStatePersistence,
} from '@almamesh/store';
import { Button, Card, Dialog, Input } from '../../components/ui';
import {
  buildBackupExport,
  commitBackupImport,
  stageBackupImport,
  type StagedImport,
} from '../../lib/backupService';
import {
  pickBackupFile,
  saveBackupFile,
  type BackupFileContent,
} from '../../lib/backupFile';
import { suppressNextServiceWorkerHeal } from '../../lib/swSelfHeal';

/** Minimum export password length; the file carries the AI key, so it is required. */
const MIN_PASSPHRASE_LENGTH = 8;

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export interface DataSettingsProps {
  readonly persistence: PortableStatePersistence;
}

export function DataSettingsPanel({ persistence }: DataSettingsProps) {
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

  async function handleExport() {
    clearBanners();
    if (password.length < MIN_PASSPHRASE_LENGTH) {
      setError(t('backup.error_passphrase_required'));
      return;
    }
    setExporting(true);
    try {
      const { filename, content } = await buildBackupExport(password);
      const result = await saveBackupFile(filename, content);
      if (result === 'saved') {
        setStatus(t('backup.status_exported'));
        setPassword(''); // don't leave the passphrase lingering in the field
      } else if (result === 'unverified') {
        setStatus(t('backup.status_export_started'));
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
    if (persistence === 'memory') {
      setError(t('backup.error_import_requires_durable_storage'));
      return;
    }
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

  async function handleConfirmImport() {
    if (staged == null) {
      return;
    }
    const safetyPassword = stagedPassphrase ?? safetyPassphrase;
    if (safetyPassword.length < MIN_PASSPHRASE_LENGTH) {
      setSafetyPassphraseError(t('backup.error_safety_passphrase_required'));
      return;
    }
    setImporting(true);
    try {
      let protectedRevision = safetyRevision;
      if (!safetyDownloadUnverified) {
        // Safety net FIRST: always encrypted, using the imported file's password
        // when available or the explicit safety password entered below.
        const revisionBeforeExport = await readPortableStateRevision();
        const current = await buildBackupExport(safetyPassword);
        const revisionAfterExport = await readPortableStateRevision();
        if (revisionAfterExport !== revisionBeforeExport) {
          throw new Error(
            'Your AlmaMesh data changed while the safety backup was being prepared. Start the import again.',
          );
        }
        const safetyFilename = current.filename.startsWith('almamesh-backup-')
          ? current.filename.replace('almamesh-backup-', 'almamesh-backup-before-import-')
          : `almamesh-backup-before-import-${current.filename}`;
        const saved = await saveBackupFile(safetyFilename, current.content);
        if (saved === 'unverified') {
          // The <a download> fallback cannot prove completion. Keep the staged
          // import untouched and require a second, explicit confirmation.
          setSafetyDownloadUnverified(true);
          setSafetyRevision(revisionAfterExport);
          return;
        }
        if (saved === 'cancelled') {
          // The user cancelled the safety-net save — abort WITHOUT touching any
          // data (no commit, no reload), so the promised undo backup is never skipped.
          setConfirmOpen(false);
          setSafetyRevision(null);
          setError(t('backup.error_safety_cancelled'));
          return;
        }
        protectedRevision = revisionAfterExport;
      }
      if (protectedRevision === null) {
        throw new Error('The safety backup revision is unavailable. Start the import again.');
      }
      armPortableImportRevision(protectedRevision);
      try {
        await commitBackupImport(staged);
      } finally {
        clearPortableImportRevisionFence();
      }
      setConfirmOpen(false);
      setSafetyRevision(null);
      setStatus(t('backup.status_imported'));
      // The restore owns the next reload. Prevent the SW self-heal check from
      // stacking a second reload while the fresh realm hydrates its stores.
      suppressNextServiceWorkerHeal();
      window.location.reload();
    } catch (err) {
      setConfirmOpen(false);
      setSafetyDownloadUnverified(false);
      setSafetyRevision(null);
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
            onClick={() => void handleExport()}
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
            disabled={persistence === 'memory'}
            data-testid="backup-import-button"
          >
            {t('backup.import_button')}
          </Button>
          {persistence === 'memory' && (
            <p
              role="note"
              data-testid="backup-import-memory-warning"
              className="text-sm text-status-warning"
            >
              {t('backup.error_import_requires_durable_storage')}
            </p>
          )}
        </div>
      </Card>

      {/* Confirm "replace all data" dialog */}
      <Dialog
        open={confirmOpen}
        onClose={() => {
          if (!importing) {
            setConfirmOpen(false);
            setSafetyDownloadUnverified(false);
            setSafetyRevision(null);
          }
        }}
        title={t('backup.confirm_title')}
      >
        <div className="space-y-4">
          <p className="text-text-secondary text-sm">{t('backup.confirm_body')}</p>
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
              onClick={() => {
                setConfirmOpen(false);
                setSafetyDownloadUnverified(false);
                setSafetyRevision(null);
              }}
              disabled={importing}
              className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md hover:bg-ui-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
            >
              {t('backup.cancel')}
            </button>
            <button
              type="button"
              data-testid="backup-confirm-import"
              onClick={() => void handleConfirmImport()}
              disabled={importing}
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
  const persistence = useSyncExternalStore(
    subscribePortableStatePersistence,
    portableStatePersistence,
    portableStatePersistence,
  );
  return <DataSettingsPanel persistence={persistence} />;
}
