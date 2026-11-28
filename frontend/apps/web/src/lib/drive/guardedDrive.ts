/**
 * The one place the upload and prune rules are enforced: uploads refuse anything
 * not structured as a binary age v1 file or neutral backup name, and `remove`
 * refuses any file id not verified as belonging to this device's own code.
 */
import { getDeviceCode } from '@almamesh/store';
import {
  type BackupDrive,
  type BackupFileName,
  type DriveBackupEntry,
  DriveError,
  type SealedBackup,
  sealedBackupOf,
} from './backupDrive';
import { backupNameOf, parseBackupName } from './backupName';

const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

/** Rebuilds an entry from its name alone; the adapter's meta is never trusted. */
function checkedEntry(entry: DriveBackupEntry): DriveBackupEntry | null {
  const meta = parseBackupName(entry.name.value);
  if (meta === null) return null;
  return { ...entry, name: backupNameOf(entry.name.value), meta };
}

async function listChecked(
  inner: BackupDrive,
  removable: Set<string>,
  deviceCode: () => Promise<string>,
): Promise<readonly DriveBackupEntry[]> {
  const [raw, ownCode] = await Promise.all([inner.list(), deviceCode()]);
  const valid = raw.map(checkedEntry).filter((entry): entry is DriveBackupEntry => entry !== null);
  for (const entry of valid) {
    if (entry.meta.deviceCode === ownCode) removable.add(entry.id);
  }
  return valid;
}

async function uploadChecked(
  inner: BackupDrive,
  removable: Set<string>,
  deviceCode: () => Promise<string>,
  name: BackupFileName,
  sealed: SealedBackup,
): Promise<DriveBackupEntry> {
  const checkedName = backupNameOf(name.value);
  const checkedSealed = sealedBackupOf(sealed.bytes);
  const [raw, ownCode] = await Promise.all([inner.upload(checkedName, checkedSealed), deviceCode()]);
  const entry = checkedEntry(raw);
  if (entry === null) throw new DriveError('provider_error');
  if (entry.meta.deviceCode === ownCode) removable.add(entry.id);
  return entry;
}

export function guardedDrive(
  inner: BackupDrive,
  isOnline: () => boolean = browserOnline,
  deviceCode: () => Promise<string> = () => getDeviceCode(),
): BackupDrive {
  const removable = new Set<string>();
  const online = (): void => {
    if (!isOnline()) throw new DriveError('offline');
  };
  return {
    provider: inner.provider,
    connect: async (returnTo) => {
      online();
      return inner.connect(returnTo);
    },
    isConnected: () => inner.isConnected(),
    list: async () => {
      online();
      return listChecked(inner, removable, deviceCode);
    },
    upload: async (name, sealed) => {
      online();
      return uploadChecked(inner, removable, deviceCode, name, sealed);
    },
    download: async (id) => {
      online();
      return inner.download(id);
    },
    remove: async (id) => {
      online();
      if (!removable.has(id)) throw new DriveError('not_found');
      await inner.remove(id);
      removable.delete(id);
    },
    disconnect: () => inner.disconnect(),
  };
}
