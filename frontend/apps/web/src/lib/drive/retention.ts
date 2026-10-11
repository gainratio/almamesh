import type { DriveBackupEntry } from './backupDrive';

export const KEEP_PER_DEVICE = 10;

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Total order: newest createdAt first, then name, then id, so ties never depend on list order. */
function newestFirst(a: DriveBackupEntry, b: DriveBackupEntry): number {
  return (
    b.meta.createdAt.getTime() - a.meta.createdAt.getTime() ||
    compareText(a.name.value, b.name.value) ||
    compareText(a.id, b.id)
  );
}

/**
 * Ids to move to trash: this device's files beyond the newest KEEP_PER_DEVICE.
 * The just-uploaded file is never trashed, so under clock skew (it sorts
 * outside the newest KEEP_PER_DEVICE by name time) this keeps KEEP_PER_DEVICE + 1.
 *
 * "This device" means "names carrying this device code". The code is 24 bits
 * (6 hex), so two devices share one with probability about 1 in 16.7 million
 * per pair (2^-24). If that happens, retention treats the other device's files
 * as its own and may trash them once the shared set exceeds KEEP_PER_DEVICE.
 */
export function planPrune(
  entries: readonly DriveBackupEntry[],
  deviceCode: string,
  justUploadedId: string,
): readonly string[] {
  const mine = entries.filter((e) => e.meta.deviceCode === deviceCode).sort(newestFirst);
  return mine
    .slice(KEEP_PER_DEVICE)
    .filter((e) => e.id !== justUploadedId)
    .map((e) => e.id)
    .reverse();
}
