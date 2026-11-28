/**
 * Public barrel for zero-knowledge cloud drive backup (`google-drive` at launch).
 */
import type { BackupDrive } from './backupDrive';
import { credentialStore } from './credentialStore';
import { createGoogleSession, type GoogleSession, isSilentRenewalActive } from './driveSession';
import { createGoogleDrive } from './googleDrive';
import { guardedDrive } from './guardedDrive';
import { isDriveBackupEnabled } from './providerConfig';

export * from './backupDrive';
export * from './backupName';
export * from './credentialStore';
export * from './deviceKey';
export * from './driveSafetyTarget';
export * from './driveSession';
export * from './googleDrive';
export * from './guardedDrive';
export * from './oauthRedirect';
export * from './providerConfig';
export * from './retention';

declare global {
  interface Window {
    __almameshExpireDriveToken?: () => Promise<void>;
  }
}

if (import.meta.env.VITE_EXIT_GATE_HOOKS === '1' && typeof window !== 'undefined') {
  window.__almameshExpireDriveToken = async () => {
    const existing = await credentialStore.read('google-drive');
    if (existing !== null) {
      await credentialStore.write('google-drive', { ...existing, expiresAt: Date.now() - 120_000 });
    }
  };
}

let singletonDrive: BackupDrive | null = null;
let singletonSession: GoogleSession | null = null;

export function createDriveForCurrentOrigin(): BackupDrive | null {
  if (!isDriveBackupEnabled()) return null;
  if (singletonDrive !== null) return singletonDrive;
  const session = createGoogleSession({ canSilentRenew: isSilentRenewalActive });
  const raw = createGoogleDrive({
    getAccessToken: () => session.getAccessToken(),
    startConnect: (returnTo) => session.startConnect(returnTo),
    isConnected: () => session.isConnected(),
    disconnect: () => session.disconnect(),
  });
  singletonSession = session;
  singletonDrive = guardedDrive(raw);
  return singletonDrive;
}

/** True when `drive` can make a non-interactive request right now without a token redirect. */
export async function canUseDriveWithoutRedirect(drive: BackupDrive): Promise<boolean> {
  if (drive === singletonDrive && singletonSession !== null) {
    return singletonSession.hasFreshToken();
  }
  return drive.isConnected();
}

export function resetSingletonDrive(): void {
  singletonDrive = null;
  singletonSession = null;
}

export const resetSingletonDriveForTests = resetSingletonDrive;
