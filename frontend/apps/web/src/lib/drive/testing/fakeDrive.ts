/** In-memory BackupDrive for tests. `files` is exposed so tests can seed or inspect it. */
import { type BackupDrive, type DriveBackupEntry, DriveError } from '../backupDrive';
import { parseBackupName } from '../backupName';

export interface FakeFile {
  name: string;
  bytes: Uint8Array;
  trashed: boolean;
}

export interface FakeDrive extends BackupDrive {
  readonly files: Map<string, FakeFile>;
}

export function createFakeDrive(): FakeDrive {
  const files = new Map<string, FakeFile>();
  let seq = 0;
  const toEntry = (id: string, f: FakeFile): DriveBackupEntry => ({
    id,
    name: { value: f.name } as DriveBackupEntry['name'],
    meta: parseBackupName(f.name) as DriveBackupEntry['meta'],
    sizeBytes: f.bytes.length,
  });
  return {
    provider: 'google-drive',
    files,
    connect: async () => 'connected',
    isConnected: async () => true,
    list: async () =>
      [...files]
        .filter(([, f]) => !f.trashed)
        .map(([id, f]) => toEntry(id, f)),
    upload: async (name, sealed) => {
      seq += 1;
      const id = `f${seq}`;
      const file: FakeFile = { name: name.value, bytes: sealed.bytes.slice(), trashed: false };
      files.set(id, file);
      return toEntry(id, file);
    },
    download: async (id) => {
      const f = files.get(id);
      if (f === undefined || f.trashed) throw new DriveError('not_found', 404);
      return f.bytes.slice();
    },
    remove: async (id) => {
      const f = files.get(id);
      if (f === undefined) throw new DriveError('not_found', 404);
      f.trashed = true;
    },
    disconnect: async () => undefined,
  };
}
