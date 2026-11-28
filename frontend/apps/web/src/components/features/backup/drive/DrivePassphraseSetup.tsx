/**
 * Dialog asking once per tab session for the passphrase that locks cloud backups
 * on this device before upload.
 */
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { checkBackupPassphrase } from '@almamesh/store';
import { Button, Dialog, Input } from '../../../ui';
import { ConfirmPasswordField } from '../ConfirmPasswordField';

export interface DrivePassphraseSetupProps {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (passphrase: string) => void;
}

export function DrivePassphraseSetup({
  open,
  busy,
  onClose,
  onSubmit,
}: DrivePassphraseSetupProps): ReactElement {
  const { t } = useTranslation('settings');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [touched, setTouched] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const problem = checkBackupPassphrase(passphrase, confirmation);
  const showMismatch = touched && problem === 'mismatch';

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (problem === 'mismatch') {
      setTouched(true);
      return;
    }
    if (problem !== null) {
      setLocalError(
        t(problem === 'empty' ? 'backup.error_passphrase_empty' : 'backup.error_passphrase_too_short'),
      );
      return;
    }
    const chosen = passphrase;
    setPassphrase('');
    setConfirmation('');
    setTouched(false);
    setLocalError(null);
    onSubmit(chosen);
  }

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} title={t('drive.passphrase_title')}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-text-secondary">{t('drive.passphrase_body')}</p>
        <div className="space-y-2">
          <label htmlFor="drive-passphrase-input" className="block text-sm font-medium text-text-primary">
            {t('backup.passphrase_label')}
          </label>
          <Input
            id="drive-passphrase-input"
            type="password"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setLocalError(null);
            }}
            placeholder={t('backup.passphrase_placeholder')}
            data-testid="drive-passphrase-input"
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <ConfirmPasswordField
          id="drive-passphrase-confirm"
          testId="drive-passphrase-confirm-input"
          mismatchTestId="drive-passphrase-mismatch"
          value={confirmation}
          onChange={(val) => {
            setConfirmation(val);
            setTouched(true);
          }}
          showMismatch={showMismatch}
        />
        {localError && (
          <p role="alert" className="text-sm text-status-error" data-testid="drive-passphrase-error">
            {localError}
          </p>
        )}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md text-sm font-medium"
          >
            {t('backup.cancel')}
          </button>
          <Button type="submit" className="flex-1" disabled={busy} data-testid="drive-passphrase-submit">
            {t('drive.passphrase_submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
