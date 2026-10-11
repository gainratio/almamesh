/** Neutral backup names: time, browser family, OS family, device code. No free text. */
import {
  type BackupFileName,
  type BackupNameMeta,
  type BrowserFamily,
  DriveError,
  type OsFamily,
} from './backupDrive';

const BROWSERS: readonly BrowserFamily[] = ['chrome', 'edge', 'firefox', 'safari', 'samsung', 'other'];
const SYSTEMS: readonly OsFamily[] = ['macos', 'windows', 'linux', 'ios', 'android', 'chromeos', 'other'];

export const BACKUP_NAME_PATTERN = new RegExp(
  `^almamesh-backup-(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z-(${BROWSERS.join('|')})-(${SYSTEMS.join('|')})-([0-9a-f]{6})\\.almamesh$`,
);
const DEVICE_CODE = /^[0-9a-f]{6}$/;

export function browserFamilyOf(ua: string): BrowserFamily {
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  if (/Edg(A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}

export function osFamilyOf(ua: string): OsFamily {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

function stamp(at: Date): string {
  return at.toISOString().replace(/:/g, '-').replace('.', '-');
}

export function buildBackupName(now: Date, ua: string, deviceCode: string): BackupFileName {
  if (!DEVICE_CODE.test(deviceCode)) throw new DriveError('bad_name');
  return backupNameOf(`almamesh-backup-${stamp(now)}-${browserFamilyOf(ua)}-${osFamilyOf(ua)}-${deviceCode}.almamesh`);
}

export function parseBackupName(raw: string): BackupNameMeta | null {
  const m = BACKUP_NAME_PATTERN.exec(raw);
  if (m === null) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
  return { createdAt, browser: m[8] as BrowserFamily, os: m[9] as OsFamily, deviceCode: m[10] as string };
}

export function backupNameOf(raw: string): BackupFileName {
  if (parseBackupName(raw) === null) throw new DriveError('bad_name');
  return { value: raw } as BackupFileName;
}
