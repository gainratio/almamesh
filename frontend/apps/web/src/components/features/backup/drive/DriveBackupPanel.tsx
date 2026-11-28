/**
 * Settings -> Data Google Drive backup card: connect, one-click encrypted backup,
 * restore from any device's backup, trash this device's backups, and disconnect.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../../../ui';
import type { DriveBackupController } from '../../../../hooks/useDriveBackup';
import { DriveBackupList } from './DriveBackupList';
import { DrivePassphraseSetup } from './DrivePassphraseSetup';

export interface DriveBackupPanelProps {
  readonly controller: DriveBackupController;
}

export function DriveBackupPanel({ controller }: DriveBackupPanelProps): ReactElement | null {
  const { t } = useTranslation('settings');
  if (!controller.enabled) return null;

  return (
    <Card title={t('drive.heading')}>
      <div className="space-y-4" data-testid="drive-backup-panel">
        <p className="text-sm text-text-secondary">{t('drive.disclosure')}</p>

        {controller.inMemoryOnly && (
          <p role="status" className="text-xs text-status-warning" data-testid="drive-in-memory-note">
            {t('drive.in_memory_disabled')}
          </p>
        )}
        {!controller.online && (
          <p role="status" className="text-xs text-status-warning" data-testid="drive-offline-note">
            {t('drive.error_offline')}
          </p>
        )}
        {controller.status && (
          <p role="status" className="text-sm text-status-success" data-testid="drive-status">
            {controller.status}
          </p>
        )}
        {controller.error && (
          <p role="alert" className="text-sm text-status-error" data-testid="drive-error">
            {controller.error}
          </p>
        )}
        {controller.showStaleNudge && (
          <p className="text-xs text-accent-gold" data-testid="drive-stale-nudge">
            {t('drive.stale_nudge')}
          </p>
        )}

        {!controller.connected ? (
          <Button
            type="button"
            onClick={() => void controller.connect()}
            disabled={controller.busy || !controller.online || controller.inMemoryOnly}
            data-testid="drive-connect-button"
          >
            {t('drive.connect_google')}
          </Button>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {controller.needsReconnect ? (
                <Button
                  type="button"
                  onClick={() => void controller.connect()}
                  disabled={controller.busy || !controller.online || controller.inMemoryOnly}
                  data-testid="drive-reconnect-button"
                >
                  {t('drive.reconnect_button')}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void controller.backUpNow()}
                  disabled={controller.busy || !controller.online || controller.inMemoryOnly}
                  data-testid="drive-backup-now-button"
                >
                  {t('drive.backup_now')}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void controller.refresh()}
                disabled={controller.busy || !controller.online}
                data-testid="drive-refresh-button"
              >
                {t('drive.refresh_button')}
              </Button>
              <button
                type="button"
                onClick={() => void controller.disconnect()}
                disabled={controller.busy}
                data-testid="drive-disconnect-button"
                className="px-3 h-9 rounded-md border border-ui-border text-xs text-text-secondary hover:text-status-error hover:border-status-error/60 disabled:opacity-50"
              >
                {t('drive.disconnect_button')}
              </button>
            </div>

            {controller.lastBackupAt && (
              <p className="text-xs text-text-muted" data-testid="drive-last-backup">
                {t('drive.last_backup', { date: new Date(controller.lastBackupAt).toLocaleString() })}
              </p>
            )}

            {controller.listLoaded ? (
              <DriveBackupList
                entries={controller.entries}
                ownDeviceCode={controller.ownDeviceCode}
                busy={controller.busy}
                online={controller.online}
                onRestore={(entry) => void controller.restoreEntry(entry)}
                onTrash={(entry) => void controller.trashEntry(entry)}
              />
            ) : (
              !controller.busy &&
              !controller.error && (
                <p className="text-sm text-text-secondary" data-testid="drive-list-paused">
                  {t('drive.session_paused_hint')}
                </p>
              )
            )}
            <p className="text-xs text-text-muted">{t('drive.retention_note')}</p>
          </div>
        )}

        <DrivePassphraseSetup
          open={controller.passphraseOpen}
          busy={controller.busy}
          onClose={controller.closePassphraseSetup}
          onSubmit={(passphrase) => void controller.backUpNow(passphrase)}
        />
      </div>
    </Card>
  );
}
