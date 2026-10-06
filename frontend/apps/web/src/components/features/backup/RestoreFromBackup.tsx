/**
 * "Restore from a backup" for a browser that has never set up AlmaMesh — the
 * landing hero and the first onboarding step. A person moving to a new phone
 * restores their .almamesh file here instead of creating a chart first, and
 * lands on the dashboard. Same flow as Settings → Data (`useBackupRestore`).
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../ui';
import { useBackupRestore } from '../../../hooks/useBackupRestore';
import { RestoreBackupDialogs } from './RestoreBackupDialogs';

interface RestoreFromBackupProps {
  readonly className?: string;
}

export function RestoreFromBackup({ className }: RestoreFromBackupProps): ReactElement {
  const { t } = useTranslation('settings');
  const restore = useBackupRestore({ afterRestoreHref: '/dashboard' });

  return (
    <div data-testid="first-run-restore" className={cn('flex flex-col items-center gap-2 text-center', className)}>
      <p className="text-sm text-text-secondary">{t('backup.first_run_hint')}</p>
      <button
        type="button"
        onClick={() => void restore.chooseFile()}
        disabled={restore.importing}
        data-testid="first-run-restore-button"
        className="inline-flex items-center justify-center rounded-md border border-accent-gold/60 px-5 py-2 text-sm font-semibold text-accent-gold transition-colors hover:bg-accent-gold/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60 disabled:opacity-50"
      >
        {t('backup.first_run_button')}
      </button>
      {restore.status && (
        <p role="status" data-testid="first-run-restore-status" className="text-sm text-text-secondary">
          {restore.status}
        </p>
      )}
      {restore.error && (
        <p role="alert" data-testid="first-run-restore-error" className="max-w-md text-sm text-status-error">
          {restore.error}
        </p>
      )}
      <RestoreBackupDialogs restore={restore} />
    </div>
  );
}
