/**
 * Pure helpers and session-passphrase holder for `useDriveBackup`.
 */
import { type DeviceRows, deviceRows, getDeviceCode, supportsPortableState } from '@almamesh/store';
import type { BackupExport } from '../lib/backupService';
import {
  type BackupDrive,
  buildBackupName,
  canUseDriveWithoutRedirect,
  type DriveBackupEntry,
  DriveError,
  planPrune,
  sealedBackupOf,
  sha256Hex,
} from '../lib/drive';

export const LAST_BACKUP_ROW_KEY = 'drive-last-backup/google-drive';
export const STALE_BACKUP_NUDGE_MS = 14 * 24 * 60 * 60_000;

let sessionPassphrase: string | null = null;

export const getSessionPassphrase = (): string | null => sessionPassphrase;
export const setSessionPassphrase = (value: string | null): void => {
  sessionPassphrase = value;
};
export const resetDriveSessionPassphraseForTests = (): void => {
  sessionPassphrase = null;
};

export function defaultDriveRows(): DeviceRows | null {
  return supportsPortableState() ? deviceRows : null;
}

export function sortDriveEntries(listed: readonly DriveBackupEntry[]): DriveBackupEntry[] {
  return [...listed].sort((a, b) => b.meta.createdAt.getTime() - a.meta.createdAt.getTime());
}

export function mapDriveFailure(err: unknown, t: (key: string) => string): { text: string; reconnect: boolean } {
  if (err instanceof DriveError) {
    if (err.kind === 'offline') return { text: t('drive.error_offline'), reconnect: false };
    if (err.kind === 'token_expired' || err.kind === 'not_connected') {
      return { text: t('drive.error_reconnect'), reconnect: true };
    }
    if (err.kind === 'consent_denied') return { text: t('drive.error_consent_denied'), reconnect: false };
    if (err.kind === 'quota_exceeded') return { text: t('drive.error_quota_exceeded'), reconnect: false };
    if (err.kind === 'rate_limited') return { text: t('drive.error_rate_limited'), reconnect: false };
    if (err.kind === 'not_found') return { text: t('drive.error_not_found'), reconnect: false };
    if (err.kind === 'too_large') return { text: t('drive.error_too_large'), reconnect: false };
  }
  return { text: t('drive.error_upload_failed'), reconnect: false };
}

export function consumeDriveCallbackNotice(): string | null {
  if (typeof window === 'undefined' || typeof window.location?.href !== 'string') return null;
  try {
    const url = new URL(window.location.href, 'https://almamesh.local');
    const status = url.searchParams.get('drive');
    if (status === null) return null;
    url.searchParams.delete('drive');
    window.history?.replaceState?.(null, '', `${url.pathname}${url.search}${url.hash}`);
    return status;
  } catch {
    return null;
  }
}

export async function uploadVerifyAndPrune(params: {
  drive: BackupDrive;
  built: BackupExport;
  code: string;
  now: Date;
  userAgent: string;
}): Promise<DriveBackupEntry[]> {
  if (!(params.built.content instanceof Uint8Array)) throw new DriveError('not_sealed');
  const name = buildBackupName(params.now, params.userAgent, params.code);
  const uploaded = await params.drive.upload(name, sealedBackupOf(params.built.content));
  const readBack = await params.drive.download(uploaded.id);
  if ((await sha256Hex(readBack)) !== (await sha256Hex(params.built.content))) {
    throw new DriveError('provider_error');
  }
  const current = sortDriveEntries(await params.drive.list());
  const toPrune = planPrune(current, params.code, uploaded.id);
  for (const staleId of toPrune) await params.drive.remove(staleId);
  return toPrune.length > 0 ? sortDriveEntries(await params.drive.list()) : current;
}

export async function resolveOwnCode(existing: string | null, rows: DeviceRows | null): Promise<string> {
  if (existing !== null) return existing;
  return rows !== null ? getDeviceCode(rows) : getDeviceCode();
}

export async function loadInitialDriveSnapshot(drive: BackupDrive, rows: DeviceRows | null) {
  const isConn = await drive.isConnected();
  // Never mint `device-code` or touch SQLite epochs on mount when Drive is disconnected.
  if (!isConn) return { code: null, last: null, isConn: false, freshToken: false };
  const [code, last, freshToken] = await Promise.all([
    rows ? getDeviceCode(rows) : Promise.resolve(null),
    rows ? rows.read(LAST_BACKUP_ROW_KEY) : Promise.resolve(null),
    canUseDriveWithoutRedirect(drive),
  ]);
  return { code, last, isConn: true, freshToken };
}

export function isStaleBackup(connected: boolean, lastBackupAt: string | null, nowMs: number): boolean {
  if (!connected || lastBackupAt === null) return false;
  return nowMs - new Date(lastBackupAt).getTime() > STALE_BACKUP_NUDGE_MS;
}
