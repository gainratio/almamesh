/**
 * `useDriveBackup` — orchestrates Google Drive connection, session-only passphrase
 * sealing (`buildBackupExport`), SHA-256 read-back verification, per-device keep-10
 * retention (`planPrune`), and staging downloaded backups into `useBackupRestore`.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  checkBackupPassphrase,
  type DeviceRows,
  portableStatePersistence,
  subscribePortableStatePersistence,
} from '@almamesh/store';
import { MAX_BACKUP_FILE_BYTES } from '../lib/backupFile';
import { buildBackupExport } from '../lib/backupService';
import { type BackupDrive, type DriveBackupEntry, DriveError, withSilentRenewalAllowed } from '../lib/drive';
import {
  consumeDriveCallbackNotice,
  defaultDriveRows,
  getSessionPassphrase,
  isStaleBackup,
  LAST_BACKUP_ROW_KEY,
  loadInitialDriveSnapshot,
  mapDriveFailure,
  resetDriveSessionPassphraseForTests,
  resolveOwnCode,
  setSessionPassphrase,
  sortDriveEntries,
  uploadVerifyAndPrune,
} from './driveBackupHelpers';
import type { BackupRestore } from './useBackupRestore';

export { LAST_BACKUP_ROW_KEY, resetDriveSessionPassphraseForTests };

export interface UseDriveBackupOptions {
  readonly drive: BackupDrive | null;
  readonly restore: BackupRestore;
  readonly returnTo?: string;
  readonly rows?: DeviceRows;
  readonly buildExport?: typeof buildBackupExport;
  readonly userAgent?: string;
  readonly now?: () => Date;
  /** False on closed modal surfaces (`/`, `/onboarding`) so mount makes zero network calls. */
  readonly autoList?: boolean;
}

export interface DriveBackupController {
  readonly enabled: boolean;
  readonly inMemoryOnly: boolean;
  readonly connected: boolean;
  readonly hasFreshToken: boolean;
  readonly listLoaded: boolean;
  readonly online: boolean;
  readonly busy: boolean;
  readonly entries: readonly DriveBackupEntry[];
  readonly ownDeviceCode: string | null;
  readonly lastBackupAt: string | null;
  readonly showStaleNudge: boolean;
  readonly needsReconnect: boolean;
  readonly status: string | null;
  readonly error: string | null;
  readonly passphraseOpen: boolean;
  openPassphraseSetup(): void;
  closePassphraseSetup(): void;
  connect(): Promise<void>;
  refresh(): Promise<void>;
  backUpNow(explicitPassphrase?: string): Promise<void>;
  restoreEntry(entry: DriveBackupEntry): Promise<void>;
  trashEntry(entry: DriveBackupEntry): Promise<void>;
  disconnect(): Promise<void>;
}

function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  return online;
}

export function useDriveBackup(options: UseDriveBackupOptions): DriveBackupController {
  const { t } = useTranslation('settings');
  const { drive, restore, returnTo, autoList = true } = options;
  const rows = options.rows ?? defaultDriveRows();
  const buildExport = options.buildExport ?? buildBackupExport;
  const now = options.now ?? (() => new Date());
  const userAgent = options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const online = useBrowserOnline();
  const persistence = useSyncExternalStore(
    subscribePortableStatePersistence,
    portableStatePersistence,
    portableStatePersistence,
  );
  const inMemoryOnly = persistence === 'memory';
  const [connected, setConnected] = useState(false);
  const [hasFreshToken, setHasFreshToken] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<readonly DriveBackupEntry[]>([]);
  const [ownDeviceCode, setOwnDeviceCode] = useState<string | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passphraseOpen, setPassphraseOpen] = useState(false);

  const reportError = useCallback(
    (err: unknown) => {
      const mapped = mapDriveFailure(err, t);
      if (mapped.reconnect) setHasFreshToken(false);
      setNeedsReconnect(mapped.reconnect);
      setError(mapped.text);
    },
    [t],
  );

  const loadList = useCallback(async (active: BackupDrive) => {
    const sorted = sortDriveEntries(await active.list());
    setEntries(sorted);
    setHasFreshToken(true);
    setListLoaded(true);
    return sorted;
  }, []);

  useEffect(() => {
    if (drive === null || inMemoryOnly) return undefined;
    let active = true;
    const notice = consumeDriveCallbackNotice();
    if (notice === 'consent_denied') setError(t('drive.error_consent_denied'));
    if (notice === 'reconnect') {
      setNeedsReconnect(true);
      setError(t('drive.error_reconnect'));
    }
    if (notice === 'connected') setStatus(t('drive.status_connected'));
    if (!autoList) return () => { active = false; };
    void loadInitialDriveSnapshot(drive, rows).then(async ({ code, last, isConn, freshToken }) => {
      if (!active) return;
      setOwnDeviceCode(code);
      setLastBackupAt(last);
      setConnected(isConn);
      setHasFreshToken(freshToken);
      if (isConn && freshToken && (typeof navigator === 'undefined' || navigator.onLine)) {
        await loadList(drive).catch((err) => {
          if (active) reportError(err);
        });
      }
    });
    return () => { active = false; };
  }, [autoList, drive, inMemoryOnly, loadList, reportError, rows, t]);

  const runAction = async (fn: (active: BackupDrive) => Promise<void>) => {
    if (drive === null || inMemoryOnly) return;
    setError(null);
    setBusy(true);
    try {
      await withSilentRenewalAllowed(() => fn(drive), returnTo);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const backUpNow = async (explicitPassphrase?: string) => {
    const chosen = explicitPassphrase ?? getSessionPassphrase();
    if (chosen === null || checkBackupPassphrase(chosen, chosen) !== null) {
      setPassphraseOpen(true);
      return;
    }
    setPassphraseOpen(false);
    setStatus(null);
    await runAction(async (active) => {
      const built = await buildExport(chosen);
      setSessionPassphrase(chosen);
      const code = await resolveOwnCode(ownDeviceCode, rows);
      setOwnDeviceCode(code);
      const current = now();
      setEntries(await uploadVerifyAndPrune({ drive: active, built, code, now: current, userAgent }));
      const stamp = current.toISOString();
      await rows?.write(LAST_BACKUP_ROW_KEY, stamp);
      setLastBackupAt(stamp);
      setHasFreshToken(true);
      setListLoaded(true);
      setNeedsReconnect(false);
      setStatus(t('drive.status_backed_up'));
    });
  };

  return {
    enabled: drive !== null,
    inMemoryOnly,
    connected,
    hasFreshToken,
    listLoaded,
    online,
    busy,
    entries,
    ownDeviceCode,
    lastBackupAt,
    showStaleNudge: isStaleBackup(connected, lastBackupAt, now().getTime()),
    needsReconnect,
    status,
    error,
    passphraseOpen,
    openPassphraseSetup: () => setPassphraseOpen(true),
    closePassphraseSetup: () => setPassphraseOpen(false),
    connect: () =>
      runAction(async (active) => {
        setStatus(null);
        if ((await active.connect(returnTo ?? `${window.location.pathname}${window.location.search}`)) === 'connected') {
          setConnected(true);
          setNeedsReconnect(false);
          await loadList(active);
        }
      }),
    refresh: () => runAction(async (active) => { await loadList(active); setNeedsReconnect(false); }),
    backUpNow,
    restoreEntry: (entry) =>
      runAction(async (active) => {
        setStatus(null);
        if (entry.sizeBytes > MAX_BACKUP_FILE_BYTES) throw new DriveError('too_large');
        const olderThanLocal = lastBackupAt !== null && entry.meta.createdAt.getTime() < new Date(lastBackupAt).getTime();
        await restore.stageContent(await active.download(entry.id), getSessionPassphrase() ?? undefined, { olderThanLocal });
      }),
    trashEntry: (entry) =>
      runAction(async (active) => { await active.remove(entry.id); await loadList(active); setStatus(t('drive.status_trashed')); }),
    disconnect: () =>
      runAction(async (active) => {
        await active.disconnect();
        await rows?.remove([LAST_BACKUP_ROW_KEY]);
        setSessionPassphrase(null);
        setConnected(false);
        setHasFreshToken(false);
        setListLoaded(false);
        setNeedsReconnect(false);
        setEntries([]);
        setLastBackupAt(null);
        setStatus(t('drive.status_disconnected'));
      }),
  };
}
