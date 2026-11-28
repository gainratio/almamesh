/**
 * Public OAuth client identifiers and origin allowlist for cloud drive backup.
 * Client IDs are public identifiers (no client secret is ever created or stored).
 */
export const REDIRECT_PATH = '/oauth/callback';
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Public Google OAuth 2.0 Web Client ID (`*.apps.googleusercontent.com`) registered
 * strictly to `https://almamesh.com` and `http://localhost:4173`.
 */
export const GOOGLE_CLIENT_ID = '';

const REGISTERED_ORIGINS = new Set(['https://almamesh.com', 'http://localhost:4173']);
const HOOKS_LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/;

export interface DriveEnvShape {
  readonly VITE_DRIVE_BACKUP?: string;
  readonly VITE_EXIT_GATE_HOOKS?: string;
  readonly VITE_GOOGLE_CLIENT_ID_OVERRIDE?: string;
}

export function effectiveGoogleClientId(env: DriveEnvShape = import.meta.env): string {
  if (env.VITE_EXIT_GATE_HOOKS === '1' && typeof env.VITE_GOOGLE_CLIENT_ID_OVERRIDE === 'string') {
    const override = env.VITE_GOOGLE_CLIENT_ID_OVERRIDE.trim();
    if (override.length > 0) return override;
  }
  return GOOGLE_CLIENT_ID;
}

export function isRegisteredDriveOrigin(origin: string, env: DriveEnvShape = import.meta.env): boolean {
  if (REGISTERED_ORIGINS.has(origin)) return true;
  return env.VITE_EXIT_GATE_HOOKS === '1' && HOOKS_LOOPBACK_ORIGIN.test(origin);
}

export function isDriveBackupEnabled(
  origin: string = typeof window === 'undefined' ? '' : window.location.origin,
  env: DriveEnvShape = import.meta.env,
): boolean {
  if (env.VITE_DRIVE_BACKUP !== '1') return false;
  if (!isRegisteredDriveOrigin(origin, env)) return false;
  return effectiveGoogleClientId(env).length > 0;
}
