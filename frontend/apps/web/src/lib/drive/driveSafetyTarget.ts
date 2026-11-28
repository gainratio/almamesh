/**
 * `BackupSaveTarget` adapter that writes pre-restore safety copies to a
 * connected `BackupDrive` and verifies read-back SHA-256 before confirming.
 * Resolves `deviceCode()` during `choice` BEFORE `buildSafetyCopy` reads the
 * SQLite revision so `write()` never increments the portable state epoch.
 */
import { getDeviceCode } from '@almamesh/store';
import type { BackupFileContent, BackupSaveTarget } from '../backupFile';
import { type BackupDrive, DriveError, sealedBackupOf } from './backupDrive';
import { buildBackupName } from './backupName';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createDriveSafetyTarget(
  drive: BackupDrive,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  deviceCode: () => Promise<string> = () => getDeviceCode(),
): BackupSaveTarget {
  // Eagerly resolve (and persist if missing) `device-code` inside `choice` so
  // `useBackupRestore`'s subsequent `buildSafetyCopy()` captures the post-insert revision.
  const codeReady = Promise.resolve().then(() => deviceCode());
  return {
    choice: codeReady.then(() => 'chosen' as const),
    write: async (content: BackupFileContent) => {
      if (!(content instanceof Uint8Array)) throw new DriveError('not_sealed');
      const code = await codeReady;
      const sealed = sealedBackupOf(content);
      const name = buildBackupName(new Date(), userAgent, code);
      const uploaded = await drive.upload(name, sealed);
      const readBack = await drive.download(uploaded.id);
      if ((await sha256Hex(readBack)) !== (await sha256Hex(content))) {
        throw new DriveError('provider_error');
      }
      return 'saved';
    },
    discard: async () => undefined,
  };
}
