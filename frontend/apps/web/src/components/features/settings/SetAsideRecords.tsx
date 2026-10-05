/**
 * Set-aside records (Settings → Backup & Restore).
 *
 * When a person is gone but their life events or birth-time check are still
 * here, the data repair keeps those records on this device instead of deleting
 * them. This panel lets the user see them, put one back on a person who is
 * here, or delete it. There is no automatic expiry (see SET_ASIDE_EXPIRY_POLICY).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deleteSetAsideRecord,
  listSetAsideRecords,
  restoreSetAsideRecord,
  SetAsideRestoreError,
  useProfilesStore,
  type HeldSetAsideRecord,
} from '@almamesh/store';

import { Button, Card } from '../../ui';

/** The store operations this panel drives; injectable for tests. */
export interface SetAsideApi {
  list: () => Promise<readonly HeldSetAsideRecord[]>;
  restore: (key: string, targetProfileId: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

const STORE_API: SetAsideApi = {
  list: () => listSetAsideRecords(),
  restore: (key, target) => restoreSetAsideRecord(key, target),
  remove: (key) => deleteSetAsideRecord(key),
};

interface SetAsideRecordsProps {
  readonly api?: SetAsideApi;
}

interface RowProps {
  readonly record: HeldSetAsideRecord;
  readonly busy: boolean;
  readonly onRestore: (record: HeldSetAsideRecord, target: string) => void;
  readonly onDelete: (record: HeldSetAsideRecord) => void;
}

function SetAsideRow({ record, busy, onRestore, onDelete }: RowProps) {
  const { t, i18n } = useTranslation('settings');
  const profiles = useProfilesStore((state) => state.profiles);
  const people = Object.values(profiles);
  const [target, setTarget] = useState(people[0]?.id ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const chosen = profiles[target] !== undefined ? target : (people[0]?.id ?? '');
  const date = record.setAsideAt === '' ? '' : new Date(record.setAsideAt).toLocaleDateString(i18n.language);
  const label =
    record.row === 'almamesh-life-events'
      ? t('backup.set_aside_events', { count: record.itemCount })
      : t('backup.set_aside_check');

  return (
    <li className="rounded-lg border border-ui-border p-3 space-y-2" data-testid={`set-aside-row-${record.key}`}>
      <p className="text-sm font-medium text-text-primary">
        {label}
        {date !== '' && <span className="text-text-muted font-normal"> · {t('backup.set_aside_on', { date })}</span>}
      </p>
      {record.preview.length > 0 && (
        <ul className="text-xs text-text-secondary list-disc pl-5">
          {record.preview.slice(0, 3).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-text-secondary" htmlFor={`set-aside-target-${record.key}`}>
          {t('backup.set_aside_restore_to')}
        </label>
        <select
          id={`set-aside-target-${record.key}`}
          data-testid={`set-aside-target-${record.key}`}
          value={chosen}
          onChange={(event) => setTarget(event.target.value)}
          className="rounded-md border border-ui-border bg-background-tertiary px-2 py-1 text-sm text-text-primary"
        >
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || chosen === ''}
          onClick={() => onRestore(record, chosen)}
          data-testid={`set-aside-restore-${record.key}`}
        >
          {t('backup.set_aside_restore')}
        </Button>
        {confirmDelete ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onDelete(record)}
            data-testid={`set-aside-delete-confirm-${record.key}`}
            className="text-status-error"
          >
            {t('backup.set_aside_delete_confirm')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            data-testid={`set-aside-delete-${record.key}`}
          >
            {t('backup.set_aside_delete')}
          </Button>
        )}
      </div>
    </li>
  );
}

function restoreErrorKey(error: unknown): string {
  if (!(error instanceof SetAsideRestoreError)) return 'backup.set_aside_error_generic';
  if (error.code === 'has_record') return 'backup.set_aside_error_has_record';
  if (error.code === 'unknown_person') return 'backup.set_aside_error_unknown_person';
  return 'backup.set_aside_error_generic';
}

export function SetAsideRecords({ api = STORE_API }: SetAsideRecordsProps) {
  const { t } = useTranslation('settings');
  const profiles = useProfilesStore((state) => state.profiles);
  const [records, setRecords] = useState<readonly HeldSetAsideRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRecords(await api.list());
    } catch {
      // Unavailable storage is reported by the rest of this page; nothing to list.
      setRecords([]);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await action();
      setStatus(success);
      await refresh();
    } catch (err) {
      setError(t(restoreErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  const statusLine = status && (
    <p data-testid="set-aside-status" role="status" className="text-sm text-status-success">
      {status}
    </p>
  );
  if (records.length === 0) return statusLine || null;

  return (
    <Card title={t('backup.set_aside_heading')}>
      <div className="space-y-3" data-testid="set-aside-records">
        <p className="text-text-secondary text-sm">{t('backup.set_aside_hint')}</p>
        {statusLine}
        {error && (
          <p data-testid="set-aside-error" role="alert" className="text-sm text-status-error">
            {error}
          </p>
        )}
        <ul className="space-y-3">
          {records.map((record) => (
            <SetAsideRow
              key={record.key}
              record={record}
              busy={busy}
              onRestore={(held, target) =>
                void run(
                  () => api.restore(held.key, target),
                  t('backup.set_aside_restored', { name: profiles[target]?.name ?? '' }),
                )
              }
              onDelete={(held) => void run(() => api.remove(held.key), t('backup.set_aside_deleted'))}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}
