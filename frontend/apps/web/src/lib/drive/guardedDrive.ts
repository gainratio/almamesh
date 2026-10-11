/**
 * The one place the upload rule is enforced: uploads refuse anything not
 * structured as a binary age v1 file, and any name that is not a neutral backup name.
 */
import { type BackupDrive, type DriveBackupEntry, DriveError, sealedBackupOf } from './backupDrive';
import { backupNameOf, parseBackupName } from './backupName';

const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

/** Rebuilds an entry from its name alone; the adapter's meta is never trusted. */
function checkedEntry(entry: DriveBackupEntry): DriveBackupEntry | null {
  const meta = parseBackupName(entry.name.value);
  if (meta === null) return null;
  return { ...entry, name: backupNameOf(entry.name.value), meta };
}

export function guardedDrive(inner: BackupDrive, isOnline: () => boolean = browserOnline): BackupDrive {
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
      const checked = (await inner.list()).map(checkedEntry);
      return checked.filter((e): e is DriveBackupEntry => e !== null);
    },
    upload: async (name, sealed) => {
      online();
      const checkedName = backupNameOf(name.value);
      const checkedSealed = sealedBackupOf(sealed.bytes);
      const entry = checkedEntry(await inner.upload(checkedName, checkedSealed));
      if (entry === null) throw new DriveError('provider_error');
      return entry;
    },
    download: async (id) => {
      online();
      return inner.download(id);
    },
    remove: async (id) => {
      online();
      return inner.remove(id);
    },
    disconnect: () => inner.disconnect(),
  };
}
