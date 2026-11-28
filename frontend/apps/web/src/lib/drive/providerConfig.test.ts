import { describe, expect, it } from 'vitest';
import { effectiveGoogleClientId, isDriveBackupEnabled, isRegisteredDriveOrigin } from './providerConfig';

const PROD_ENV = {
  VITE_DRIVE_BACKUP: '1',
  VITE_EXIT_GATE_HOOKS: '1',
  VITE_GOOGLE_CLIENT_ID_OVERRIDE: '12345-test.apps.googleusercontent.com',
};

describe('providerConfig', () => {
  it('is disabled when VITE_DRIVE_BACKUP is unset or client ID is empty', () => {
    expect(isDriveBackupEnabled('https://almamesh.com', {})).toBe(false);
    expect(isDriveBackupEnabled('https://almamesh.com', { VITE_DRIVE_BACKUP: '1' })).toBe(false);
  });

  it('ignores VITE_GOOGLE_CLIENT_ID_OVERRIDE unless VITE_EXIT_GATE_HOOKS === 1', () => {
    expect(
      effectiveGoogleClientId({
        VITE_DRIVE_BACKUP: '1',
        VITE_GOOGLE_CLIENT_ID_OVERRIDE: 'spoof.apps.googleusercontent.com',
      }),
    ).toBe('');
    expect(effectiveGoogleClientId(PROD_ENV)).toBe('12345-test.apps.googleusercontent.com');
  });

  it('blocks Pages preview origins and allows loopback ports only in hooks builds', () => {
    expect(isRegisteredDriveOrigin('https://almamesh.com', {})).toBe(true);
    expect(isRegisteredDriveOrigin('https://www.almamesh.com', {})).toBe(true);
    expect(isRegisteredDriveOrigin('http://localhost:4173', {})).toBe(true);
    expect(isRegisteredDriveOrigin('https://pr-99.almamesh.pages.dev', PROD_ENV)).toBe(false);
    expect(isRegisteredDriveOrigin('http://127.0.0.1:4199', {})).toBe(false);
    expect(isRegisteredDriveOrigin('http://127.0.0.1:4199', PROD_ENV)).toBe(true);
    expect(isDriveBackupEnabled('http://127.0.0.1:4199', PROD_ENV)).toBe(true);
    expect(isDriveBackupEnabled('https://www.almamesh.com', PROD_ENV)).toBe(true);
  });
});
