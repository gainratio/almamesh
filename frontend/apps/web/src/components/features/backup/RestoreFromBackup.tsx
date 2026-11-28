/**
 * "Restore from a backup" for a browser that has never set up AlmaMesh — the
 * landing hero and the first onboarding step. Keeps a single compact inline
 * line so mobile viewports (390x664) never push primary CTAs below the fold;
 * Google Drive restore opens inside a modal Dialog when enabled.
 */
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, cn, Dialog } from '../../ui';
import { type BackupDrive, createDriveForCurrentOrigin } from '../../../lib/drive';
import { useBackupRestore } from '../../../hooks/useBackupRestore';
import { useDriveBackup } from '../../../hooks/useDriveBackup';
import { RestoreBackupDialogs } from './RestoreBackupDialogs';
import { DriveBackupList } from './drive/DriveBackupList';

interface RestoreFromBackupProps {
  readonly className?: string;
  readonly driveOverride?: BackupDrive | null;
}

function buildDriveReturnTo(): string {
  if (typeof window === 'undefined' || typeof window.location?.href !== 'string') return '/?restore=drive';
  try {
    const url = new URL(window.location.href, 'https://almamesh.local');
    url.searchParams.set('restore', 'drive');
    return `${url.pathname}${url.search}`;
  } catch {
    return '/?restore=drive';
  }
}

export function RestoreFromBackup({ className, driveOverride }: RestoreFromBackupProps): ReactElement {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const drive = useMemo(
    () => (driveOverride !== undefined ? driveOverride : createDriveForCurrentOrigin()),
    [driveOverride],
  );
  const [driveOpen, setDriveOpen] = useState(() => {
    if (typeof window === 'undefined' || typeof window.location?.search !== 'string') return false;
    return new URLSearchParams(window.location.search).get('restore') === 'drive';
  });
  const restore = useBackupRestore({ afterRestoreHref: '/dashboard', navigateInApp: navigate });
  const driveController = useDriveBackup({
    drive,
    restore,
    returnTo: buildDriveReturnTo(),
    autoList: driveOpen,
  });

  useEffect(() => {
    if (!driveOpen || typeof window === 'undefined' || typeof window.location?.href !== 'string') return;
    try {
      const url = new URL(window.location.href, 'https://almamesh.local');
      if (!url.searchParams.has('restore')) return;
      url.searchParams.delete('restore');
      window.history?.replaceState?.(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Ignore synthetic test location objects without a parseable href.
    }
  }, [driveOpen]);

  return (
    <div data-testid="first-run-restore" className={cn('flex flex-col items-center gap-2 text-center', className)}>
      <p className="text-sm text-text-secondary">
        {t('backup.first_run_short')}{' '}
        <button
          type="button"
          onClick={() => void restore.chooseFile()}
          disabled={restore.importing}
          data-testid="first-run-restore-button"
          className="rounded-sm font-semibold text-accent-gold underline underline-offset-2 hover:text-accent-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60 disabled:opacity-50"
        >
          {t('backup.first_run_button')}
        </button>
        {driveController.enabled && !driveController.inMemoryOnly && (
          <>
            {' · '}
            <button
              type="button"
              onClick={() => setDriveOpen(true)}
              disabled={restore.importing}
              data-testid="first-run-drive-restore-button"
              className="rounded-sm font-semibold text-accent-gold underline underline-offset-2 hover:text-accent-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60 disabled:opacity-50"
            >
              {t('drive.from_google_drive')}
            </button>
          </>
        )}
      </p>
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
      <Dialog open={driveOpen} onClose={() => setDriveOpen(false)} title={t('drive.restore_dialog_title')}>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">{t('drive.disclosure')}</p>
          {driveController.error && (
            <p role="alert" className="text-sm text-status-error" data-testid="first-run-drive-error">
              {driveController.error}
            </p>
          )}
          {!driveController.connected ||
          driveController.needsReconnect ||
          (!driveController.listLoaded && !driveController.busy) ? (
            <Button
              type="button"
              onClick={() =>
                void (driveController.connected && !driveController.needsReconnect
                  ? driveController.refresh()
                  : driveController.connect())
              }
              disabled={driveController.busy || !driveController.online}
              data-testid="first-run-drive-connect-button"
            >
              {driveController.connected ? t('drive.reconnect_button') : t('drive.connect_google')}
            </Button>
          ) : (
            <DriveBackupList
              entries={driveController.entries}
              ownDeviceCode={driveController.ownDeviceCode}
              busy={driveController.busy}
              online={driveController.online}
              restoreOnly
              onRestore={(entry) => {
                setDriveOpen(false);
                void driveController.restoreEntry(entry);
              }}
            />
          )}
        </div>
      </Dialog>
      <RestoreBackupDialogs restore={restore} />
    </div>
  );
}
