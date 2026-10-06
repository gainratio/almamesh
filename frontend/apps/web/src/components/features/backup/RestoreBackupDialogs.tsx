/**
 * The restore flow's two dialogs — "Password required" for an encrypted
 * backup and the confirm step (with the safety copy when there is data to
 * protect). Pure view over {@link useBackupRestore}; every surface that offers
 * restore renders this, so the flow looks and behaves the same everywhere.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Input } from '../../ui';
import { repairNoteLines } from '../../../lib/dataRepairNotice';
import type { BackupRestore } from '../../../hooks/useBackupRestore';
import { ConfirmPasswordField } from './ConfirmPasswordField';

interface RestoreBackupDialogsProps {
  readonly restore: BackupRestore;
}

function RepairNotes({ restore }: RestoreBackupDialogsProps): ReactElement | null {
  const { t } = useTranslation('settings');
  const repairs = restore.staged?.repairs;
  if (repairs === undefined) return null;
  const lines = repairNoteLines(t, repairs);
  if (lines.length === 0) return null;
  return (
    <div data-testid="backup-import-repairs" className="text-sm text-status-warning space-y-1">
      <p className="font-semibold">{t('backup.import_repaired_title')}</p>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function SafetyFailure({ restore }: RestoreBackupDialogsProps): ReactElement | null {
  const { t } = useTranslation('settings');
  if (restore.safetyFailure === null) return null;
  return (
    <div
      role="alert"
      data-testid="backup-safety-failed"
      className="space-y-2 rounded-md border border-status-warning/50 p-3 text-sm"
    >
      <p className="font-semibold text-status-warning">{t('backup.safety_failed_title')}</p>
      <p className="text-text-secondary">{t('backup.safety_failed_body', { reason: restore.safetyFailure })}</p>
      <p className="text-text-secondary">{t('backup.safety_failed_choice')}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={restore.confirm}
          disabled={restore.importing}
          data-testid="backup-safety-retry"
        >
          {t('backup.safety_retry')}
        </Button>
        <button
          type="button"
          onClick={restore.skipSafety}
          disabled={restore.importing}
          data-testid="backup-skip-safety"
          className="px-3 h-8 rounded-md border border-status-error/60 text-status-error text-sm font-medium hover:bg-status-error/10 disabled:opacity-50"
        >
          {t('backup.safety_skip')}
        </button>
      </div>
    </div>
  );
}

function SafetyPassphrase({ restore }: RestoreBackupDialogsProps): ReactElement | null {
  const { t } = useTranslation('settings');
  if (!restore.needsSafetyPassphrase) return null;
  return (
    <div className="space-y-2">
      <label htmlFor="backup-safety-passphrase" className="block text-sm font-medium text-text-primary">
        {t('backup.safety_passphrase_label')}
      </label>
      <Input
        id="backup-safety-passphrase"
        type="password"
        value={restore.safetyPassphrase}
        onChange={(event) => restore.setSafetyPassphrase(event.target.value)}
        placeholder={t('backup.passphrase_placeholder')}
        data-testid="backup-safety-passphrase-input"
        autoComplete="new-password"
      />
      <ConfirmPasswordField
        id="backup-safety-passphrase-confirm"
        testId="backup-safety-passphrase-confirm-input"
        mismatchTestId="backup-safety-passphrase-mismatch"
        value={restore.safetyPassphraseConfirmation}
        onChange={restore.setSafetyPassphraseConfirmation}
        showMismatch={restore.safetyPassphraseMismatch}
      />
      <p className="text-text-muted text-xs">{t('backup.safety_passphrase_hint')}</p>
      {restore.safetyPassphraseError && (
        <p role="alert" className="text-sm text-status-error">
          {restore.safetyPassphraseError}
        </p>
      )}
    </div>
  );
}

function confirmLabel(restore: BackupRestore): string {
  if (!restore.needsSafetyCopy) return 'backup.confirm_ok_empty';
  return restore.safetyDownloadUnverified ? 'backup.confirm_safety_ok' : 'backup.confirm_ok';
}

function ConfirmDialog({ restore }: RestoreBackupDialogsProps): ReactElement {
  const { t } = useTranslation('settings');
  const empty = !restore.needsSafetyCopy;
  return (
    <Dialog
      open={restore.confirmOpen}
      onClose={() => {
        if (!restore.importing) restore.closeConfirm();
      }}
      title={t(empty ? 'backup.confirm_title_empty' : 'backup.confirm_title')}
    >
      <div className="space-y-4">
        <p className="text-text-secondary text-sm">
          {t(empty ? 'backup.confirm_body_empty' : 'backup.confirm_body')}
        </p>
        <RepairNotes restore={restore} />
        {restore.staged?.kind !== 'bundle' && (
          <p data-testid="backup-legacy-note" className="text-sm text-status-warning">
            {t('backup.confirm_legacy_note')}
          </p>
        )}
        {restore.safetyDownloadUnverified && (
          <p role="status" className="text-sm text-accent-gold" data-testid="backup-safety-confirmation">
            {t('backup.confirm_safety_download')}
          </p>
        )}
        <SafetyFailure restore={restore} />
        <SafetyPassphrase restore={restore} />
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={restore.closeConfirm}
            disabled={restore.importing}
            className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md hover:bg-ui-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            {t('backup.cancel')}
          </button>
          <button
            type="button"
            data-testid="backup-confirm-import"
            onClick={restore.confirm}
            disabled={restore.importing || restore.safetyFailure !== null}
            className={
              empty
                ? 'flex-1 px-4 py-2.5 bg-accent-gold text-background-primary rounded-md hover:bg-accent-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-bold'
                : 'flex-1 px-4 py-2.5 bg-status-error text-background-primary rounded-md hover:bg-status-error/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-bold'
            }
          >
            {t(confirmLabel(restore))}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function PassphraseDialog({ restore }: RestoreBackupDialogsProps): ReactElement {
  const { t } = useTranslation('settings');
  return (
    <Dialog open={restore.promptOpen} onClose={restore.cancelPrompt} title={t('backup.passphrase_prompt_title')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void restore.unlock();
        }}
        className="space-y-4"
      >
        <p className="text-text-secondary text-sm">{t('backup.passphrase_prompt_body')}</p>
        <Input
          type="password"
          value={restore.promptPassphrase}
          onChange={(e) => restore.setPromptPassphrase(e.target.value)}
          aria-label={t('backup.passphrase_prompt_title')}
          data-testid="backup-passphrase-prompt-input"
          autoComplete="off"
          autoFocus
        />
        {restore.promptError && (
          <p role="alert" className="text-sm text-status-error">
            {restore.promptError}
          </p>
        )}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={restore.cancelPrompt}
            className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md hover:bg-ui-border transition-colors text-sm font-medium"
          >
            {t('backup.cancel')}
          </button>
          <Button type="submit" className="flex-1" data-testid="backup-passphrase-prompt-submit">
            {t('backup.passphrase_prompt_submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RestoreBackupDialogs({ restore }: RestoreBackupDialogsProps): ReactElement {
  return (
    <>
      <ConfirmDialog restore={restore} />
      <PassphraseDialog restore={restore} />
    </>
  );
}
