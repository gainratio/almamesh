/**
 * The "Confirm password" half of every place that CREATES a backup password
 * (export, and the safety backup chosen during a restore). Nothing can recover
 * a forgotten or mistyped password, so a typo would make the file permanently
 * unopenable; asking twice catches it before the file is sealed.
 *
 * Pure view: the caller owns both values and decides when the mismatch is
 * shown (after the user has typed here, or on submit).
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../ui';

interface ConfirmPasswordFieldProps {
  readonly id: string;
  readonly testId: string;
  readonly mismatchTestId: string;
  readonly value: string;
  onChange(value: string): void;
  /** Show the "Passwords don't match" message (already known to mismatch). */
  readonly showMismatch: boolean;
}

export function ConfirmPasswordField({
  id,
  testId,
  mismatchTestId,
  value,
  onChange,
  showMismatch,
}: ConfirmPasswordFieldProps): ReactElement {
  const { t } = useTranslation('settings');
  const messageId = `${id}-mismatch`;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-text-primary">
        {t('backup.passphrase_confirm_label')}
      </label>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('backup.passphrase_confirm_placeholder')}
        data-testid={testId}
        autoComplete="new-password"
        aria-invalid={showMismatch || undefined}
        aria-describedby={showMismatch ? messageId : undefined}
      />
      {showMismatch && (
        <p
          id={messageId}
          role="alert"
          data-testid={mismatchTestId}
          className="text-sm text-status-error"
        >
          {t('backup.error_passphrase_mismatch')}
        </p>
      )}
    </div>
  );
}
