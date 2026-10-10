import { describe, expect, it } from 'vitest';
import type { BackupDrive, SealedBackup } from '../backupDrive';
import { backupNameOf } from '../backupName';

const NAME = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
const BYTES = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt c2FsdA 18\n--- mac\n\u0001\u0002binary');

/** Every adapter must pass this, against a fake or recorded provider. */
export function runBackupDriveContract(label: string, make: () => Promise<BackupDrive>): void {
  describe(`BackupDrive contract: ${label}`, () => {
    it('upload then list shows it, with the parsed meta', async () => {
      const drive = await make();
      const up = await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
      const listed = await drive.list();
      expect(listed.map((e) => e.id)).toContain(up.id);
      expect(listed.find((e) => e.id === up.id)?.meta.deviceCode).toBe('7f3a2c');
    });
    it('download is byte-equal', async () => {
      const drive = await make();
      const up = await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
      expect(await drive.download(up.id)).toEqual(BYTES);
    });
    it('remove hides it from list', async () => {
      const drive = await make();
      const up = await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
      await drive.remove(up.id);
      expect((await drive.list()).map((e) => e.id)).not.toContain(up.id);
    });
    it('download of a missing id is not_found', async () => {
      await expect((await make()).download('missing')).rejects.toMatchObject({ kind: 'not_found' });
    });
  });
}
