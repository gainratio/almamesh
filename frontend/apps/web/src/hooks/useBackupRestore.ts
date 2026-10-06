/**
 * useBackupRestore — the ONE restore flow, shared by Settings → Data and the
 * first-run surfaces (landing + onboarding).
 *
 * pick a file → stage it (validate, decrypt, repair portable references) →
 * ask for the password when the file is encrypted → confirm → safety copy of
 * the current data FIRST when there is any → Replace → reload (or open
 * `afterRestoreHref`). Nothing is uploaded.
 *
 * Safety copy rule: it protects what Replace would destroy. On a browser that
 * holds nothing (`hasDataToProtect` is false) there is nothing to protect, so
 * the copy, its password and its download are skipped. That emptiness is
 * re-checked at a fixed SQLite revision right before Replace, and the revision
 * fence makes Replace refuse if anything is written after that check.
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
import {
  buildBackupExport,
  commitBackupImport,
  exportBackupFilename,
  hasDataToProtect,
  safetyBackupFilename,
  stageBackupImport,
  type StagedImport,
} from '../lib/backupService';
import {
  openBackupSaveTarget,
  pickBackupFile,
  type BackupFileContent,
  type BackupSaveTarget,
} from '../lib/backupFile';
import { suppressNextServiceWorkerHeal } from '../lib/swSelfHeal';
import { passwordsMatch } from '../lib/backupPassword';

/** Minimum password length for a safety copy (matches the export rule). */
const MIN_RESTORE_PASSPHRASE_LENGTH = 8;

export interface BackupRestoreOptions {
  /** Where to go after a successful restore. Omitted: reload the current page. */
  readonly afterRestoreHref?: string;
}

export interface BackupRestore {
  readonly status: string | null;
  readonly error: string | null;
  clearMessages(): void;
  chooseFile(): Promise<void>;
  /** Encrypted backup awaiting its password. */
  readonly promptOpen: boolean;
  readonly promptPassphrase: string;
  setPromptPassphrase(value: string): void;
  readonly promptError: string | null;
  unlock(): Promise<void>;
  cancelPrompt(): void;
  /** Staged backup awaiting confirmation. */
  readonly staged: StagedImport | null;
  readonly confirmOpen: boolean;
  readonly importing: boolean;
  /** False when this browser holds nothing a restore could destroy. */
  readonly needsSafetyCopy: boolean;
  /** The staged file had no reusable password, so the safety copy needs one. */
  readonly needsSafetyPassphrase: boolean;
  readonly safetyPassphrase: string;
  setSafetyPassphrase(value: string): void;
  readonly safetyPassphraseError: string | null;
  /** The safety password typed a second time; must match before Replace. */
  readonly safetyPassphraseConfirmation: string;
  setSafetyPassphraseConfirmation(value: string): void;
  /** Show "Passwords don't match" (after typing in the confirm field, or on Replace). */
  readonly safetyPassphraseMismatch: boolean;
  readonly safetyDownloadUnverified: boolean;
  readonly safetyFailure: string | null;
  /** Synchronous on purpose: the safety copy's save picker opens inside the click. */
  confirm(): void;
  skipSafety(): void;
  closeConfirm(): void;
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function useBackupRestore(options: BackupRestoreOptions = {}): BackupRestore {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedImport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [needsSafetyCopy, setNeedsSafetyCopy] = useState(true);
  /** The revision a fallback safety download captured; non-null = awaiting an explicit second confirm. */
  const [unverifiedSafetyRevision, setUnverifiedSafetyRevision] = useState<number | null>(null);
  const safetyDownloadUnverified = unverifiedSafetyRevision !== null;
  const [safetyFailure, setSafetyFailure] = useState<string | null>(null);
  const [pendingContent, setPendingContent] = useState<BackupFileContent | null>(null);
  // The password that unlocked the staged file; reused to seal the safety net.
  const [stagedPassphrase, setStagedPassphrase] = useState<string | undefined>(undefined);
  const [promptPassphrase, setPromptPassphrase] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);
  const [safetyPassphrase, setSafetyPassphraseValue] = useState('');
  const [safetyPassphraseError, setSafetyPassphraseError] = useState<string | null>(null);
  const [safetyConfirmation, setSafetyConfirmation] = useState('');
  const [safetyConfirmationTouched, setSafetyConfirmationTouched] = useState(false);

  function clearMessages() {
    setStatus(null);
    setError(null);
  }

  function resetConfirmState(passphrase: string | undefined) {
    setStagedPassphrase(
      passphrase !== undefined && passphrase.length >= MIN_RESTORE_PASSPHRASE_LENGTH
        ? passphrase
        : undefined,
    );
    setPendingContent(null);
    setPromptPassphrase('');
    setPromptError(null);
    setSafetyPassphraseValue('');
    setSafetyPassphraseError(null);
    setSafetyConfirmation('');
    setSafetyConfirmationTouched(false);
    setUnverifiedSafetyRevision(null);
    setSafetyFailure(null);
  }

  function stageErrorMessage(err: unknown): string {
    if (err instanceof BackupError && err.code === 'too_new') return t('backup.error_too_new');
    if (err instanceof BackupError && err.code === 'bad_format') return t('backup.error_bad_format');
    if (err instanceof PortableStateUnavailableError) return t('backup.error_storage_unavailable');
    return t('backup.error_stage_failed', { reason: reasonOf(err) });
  }

  /** Stage a picked file; open the passphrase prompt on encryption, else confirm. */
  async function stageFile(content: BackupFileContent, passphrase?: string) {
    setStatus(t('backup.status_checking'));
    try {
      const result = await stageBackupImport(content, passphrase);
      const protect = await hasDataToProtect();
      setStatus(null);
      resetConfirmState(passphrase);
      setNeedsSafetyCopy(protect);
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
      setError(stageErrorMessage(err));
    }
  }

  async function chooseFile() {
    clearMessages();
    try {
      const content = await pickBackupFile();
      if (content == null) return;
      await stageFile(content);
    } catch (err) {
      setError(t('backup.error_stage_failed', { reason: reasonOf(err) }));
    }
  }

  async function unlock() {
    if (pendingContent == null) return;
    await stageFile(pendingContent, promptPassphrase);
  }

  function closeConfirm() {
    setConfirmOpen(false);
    setUnverifiedSafetyRevision(null);
    setSafetyFailure(null);
  }

  /**
   * The revision Replace must directly follow, proven to hold nothing to
   * protect. Throws when data appeared since staging (another tab), so the
   * user starts again and gets a safety copy.
   */
  async function emptyRevision(): Promise<number> {
    const before = await readPortableStateRevision();
    if (await hasDataToProtect()) throw new Error(t('backup.error_data_appeared'));
    const after = await readPortableStateRevision();
    if (after !== before) throw new Error(t('backup.error_data_appeared'));
    return after;
  }

  function finishRestore() {
    closeConfirm();
    setStatus(t('backup.status_imported'));
    // The restore owns the next load. Prevent the SW self-heal check from
    // stacking a second reload while the fresh realm hydrates its stores.
    suppressNextServiceWorkerHeal();
    if (options.afterRestoreHref === undefined) window.location.reload();
    else window.location.assign(options.afterRestoreHref);
  }

  /**
   * Replace this browser's data with the staged backup. The revision fence
   * refuses the commit if another tab changed SQLite after `protect` read it.
   */
  async function replaceData(toImport: StagedImport, protect: () => Promise<number>) {
    setImporting(true);
    try {
      const protectedRevision = await protect();
      armPortableImportRevision(protectedRevision);
      try {
        await commitBackupImport(toImport);
      } finally {
        clearPortableImportRevisionFence();
      }
      finishRestore();
    } catch (err) {
      closeConfirm();
      const key = needsSafetyCopy ? 'backup.error_import_failed' : 'backup.error_restore_failed_empty';
      setError(t(key, { reason: reasonOf(err) }));
    } finally {
      setImporting(false);
    }
  }

  function confirm() {
    if (staged == null) return;
    if (!needsSafetyCopy) {
      void replaceData(staged, emptyRevision);
      return;
    }
    const safetyPassword = stagedPassphrase ?? safetyPassphrase;
    if (safetyPassword.length < MIN_RESTORE_PASSPHRASE_LENGTH) {
      setSafetyPassphraseError(t('backup.error_safety_passphrase_required'));
      return;
    }
    // A password the user just chose must be typed twice: a typo would seal a
    // safety copy nobody can open. (A reused import password was already proven.)
    if (stagedPassphrase === undefined && !passwordsMatch(safetyPassphrase, safetyConfirmation)) {
      setSafetyConfirmationTouched(true);
      return;
    }
    if (unverifiedSafetyRevision !== null) {
      const revision = unverifiedSafetyRevision;
      void replaceData(staged, async () => revision);
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

  /** Build the safety copy at a stable revision; returns that revision. */
  async function buildSafetyCopy(
    safetyPassword: string,
  ): Promise<{ readonly content: BackupFileContent; readonly revision: number }> {
    const revisionBeforeExport = await readPortableStateRevision();
    const content = (await buildBackupExport(safetyPassword)).content;
    const revision = await readPortableStateRevision();
    if (revision !== revisionBeforeExport) {
      throw new Error(
        'Your AlmaMesh data changed while the safety backup was being prepared. Try again.',
      );
    }
    return { content, revision };
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
      let built: Awaited<ReturnType<typeof buildSafetyCopy>>;
      try {
        built = await buildSafetyCopy(safetyPassword);
      } catch (err) {
        await target.discard();
        setSafetyFailure(reasonOf(err));
        return;
      }
      await writeSafetyCopyThenReplace(toImport, target, built);
    } finally {
      setImporting(false);
    }
  }

  async function writeSafetyCopyThenReplace(
    toImport: StagedImport,
    target: BackupSaveTarget,
    built: { readonly content: BackupFileContent; readonly revision: number },
  ) {
    let saved: Awaited<ReturnType<BackupSaveTarget['write']>>;
    try {
      saved = await target.write(built.content);
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
      setUnverifiedSafetyRevision(built.revision);
      return;
    }
    await replaceData(toImport, async () => built.revision);
  }

  /** The user explicitly chose to replace this browser's data without a copy. */
  function skipSafety() {
    if (staged == null) return;
    void replaceData(staged, readPortableStateRevision);
  }

  return {
    status,
    error,
    clearMessages,
    chooseFile,
    promptOpen: pendingContent != null,
    promptPassphrase,
    setPromptPassphrase,
    promptError,
    unlock,
    cancelPrompt: () => setPendingContent(null),
    staged,
    confirmOpen,
    importing,
    needsSafetyCopy,
    needsSafetyPassphrase: needsSafetyCopy && stagedPassphrase === undefined,
    safetyPassphrase,
    setSafetyPassphrase: (value: string) => {
      setSafetyPassphraseValue(value);
      setSafetyPassphraseError(null);
    },
    safetyPassphraseError,
    safetyPassphraseConfirmation: safetyConfirmation,
    setSafetyPassphraseConfirmation: (value: string) => {
      setSafetyConfirmation(value);
      setSafetyConfirmationTouched(true);
    },
    safetyPassphraseMismatch:
      safetyConfirmationTouched && !passwordsMatch(safetyPassphrase, safetyConfirmation),
    safetyDownloadUnverified,
    safetyFailure,
    confirm,
    skipSafety,
    closeConfirm,
  };
}
