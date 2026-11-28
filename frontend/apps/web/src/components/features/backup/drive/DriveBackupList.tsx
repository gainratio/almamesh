/**
 * Renders neutral-named Google Drive backups with device labels, timestamps,
 * Restore action, and own-device Trash action.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button } from '../../../ui';
import type { BrowserFamily, DriveBackupEntry, OsFamily } from '../../../../lib/drive';

const BROWSER_LABELS: Record<BrowserFamily, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  samsung: 'Samsung Internet',
  other: 'Browser',
};

const OS_LABELS: Record<OsFamily, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
  chromeos: 'ChromeOS',
  other: 'Device',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface DriveBackupListProps {
  readonly entries: readonly DriveBackupEntry[];
  readonly ownDeviceCode: string | null;
  readonly busy: boolean;
  readonly online: boolean;
  readonly restoreOnly?: boolean;
  readonly onRestore: (entry: DriveBackupEntry) => void;
  readonly onTrash?: (entry: DriveBackupEntry) => void;
}

export function DriveBackupList({
  entries,
  ownDeviceCode,
  busy,
  online,
  restoreOnly = false,
  onRestore,
  onTrash,
}: DriveBackupListProps): ReactElement {
  const { t } = useTranslation('settings');
  if (entries.length === 0) {
    return (
      <p className="text-sm text-text-muted" data-testid="drive-backup-empty">
        {t('drive.empty_list')}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ui-border rounded-md border border-ui-border" data-testid="drive-backup-list">
      {entries.map((entry) => {
        const isOwn = ownDeviceCode !== null && entry.meta.deviceCode === ownDeviceCode;
        const deviceLabel = `${BROWSER_LABELS[entry.meta.browser]} · ${OS_LABELS[entry.meta.os]} (${entry.meta.deviceCode})`;
        return (
          <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm" data-testid="drive-backup-row">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 font-medium text-text-primary">
                <span>{entry.meta.createdAt.toLocaleString()}</span>
                {isOwn && <Badge variant="brass">{t('drive.this_device')}</Badge>}
              </div>
              <p className="text-xs text-text-muted">
                {deviceLabel} · {formatSize(entry.sizeBytes)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !online}
                onClick={() => onRestore(entry)}
                data-testid="drive-restore-entry"
              >
                {t('drive.restore_button')}
              </Button>
              {!restoreOnly && isOwn && onTrash !== undefined && (
                <button
                  type="button"
                  disabled={busy || !online}
                  onClick={() => onTrash(entry)}
                  data-testid="drive-trash-entry"
                  className="px-2.5 h-8 rounded-md border border-ui-border text-xs text-text-secondary hover:text-status-error hover:border-status-error/60 disabled:opacity-50"
                >
                  {t('drive.trash_button')}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
