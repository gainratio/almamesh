import type { DriveBackupEntry } from './backupDrive';

export const KEEP_PER_DEVICE = 10;

/** Ids to move to trash: this device's files beyond the newest KEEP_PER_DEVICE. */
export function planPrune(
  entries: readonly DriveBackupEntry[],
  deviceCode: string,
  justUploadedId: string,
): readonly string[] {
  const mine = entries
    .filter((e) => e.meta.deviceCode === deviceCode)
    .sort((a, b) => b.meta.createdAt.getTime() - a.meta.createdAt.getTime());
  return mine
    .slice(KEEP_PER_DEVICE)
    .filter((e) => e.id !== justUploadedId)
    .map((e) => e.id)
    .reverse();
}
