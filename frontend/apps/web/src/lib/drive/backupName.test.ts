import { describe, expect, it } from 'vitest';
import { exportBackupFilename } from '../backupService';
import { DriveError } from './backupDrive';
import { BACKUP_NAME_PATTERN, backupNameOf, buildBackupName, parseBackupName } from './backupName';

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const WIN_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const AT = new Date('2026-10-10T18:04:05.123Z');
// The global constraint, written out here so the module cannot loosen it.
const CONSTRAINT_NAME =
  /^almamesh-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(chrome|edge|firefox|safari|samsung|other)-(macos|windows|linux|ios|android|chromeos|other)-[0-9a-f]{6}\.almamesh$/;
const PINNED_PATTERN_SOURCE =
  '^almamesh-backup-(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z-(chrome|edge|firefox|safari|samsung|other)-(macos|windows|linux|ios|android|chromeos|other)-([0-9a-f]{6})\\.almamesh$';

describe('buildBackupName', () => {
  it('builds the documented shape', () => {
    expect(buildBackupName(AT, MAC_CHROME, '7f3a2c').value).toBe(
      'almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh',
    );
  });
  it.each([
    [IPHONE_SAFARI, 'safari-ios'],
    [WIN_EDGE, 'edge-windows'],
    ['curl/8', 'other-other'],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      'samsung-android',
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 'firefox-windows'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
      'firefox-ios',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0',
      'edge-android',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'chrome-android',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 15917.71.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'chrome-chromeos',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'firefox-linux'],
  ])('maps %s', (ua, pair) => {
    expect(buildBackupName(AT, ua, '000000').value).toContain(`-${pair}-000000.`);
  });
  it('refuses a device code that is not 6 lowercase hex', () => {
    expect(() => buildBackupName(AT, MAC_CHROME, 'Alice!')).toThrow(DriveError);
  });
  it('pins the name pattern to the global constraint', () => {
    expect(BACKUP_NAME_PATTERN.source).toBe(PINNED_PATTERN_SOURCE);
  });
  it('never carries free text from the UA, whatever the UA says', () => {
    for (const ua of ['Priya Sharma 1987-03-14 Pune', '../../etc', 'x'.repeat(5000)]) {
      const name = buildBackupName(AT, ua, 'abcdef').value;
      expect(name).toMatch(CONSTRAINT_NAME);
      for (const freeText of ['Priya', 'Sharma', '1987', 'Pune', '..', 'xx']) {
        expect(name).not.toContain(freeText);
      }
    }
  });
  it('starts with the same timestamp text the local export filename uses', () => {
    const local = exportBackupFilename(AT.toISOString()).replace(/^almamesh-backup-/, '').replace(/\.almamesh$/, '');
    expect(local).toBe('2026-10-10T18-04-05-123Z');
    expect(buildBackupName(AT, MAC_CHROME, 'abcdef').value.startsWith(`almamesh-backup-${local}-`)).toBe(true);
  });
});

describe('parseBackupName', () => {
  it('round-trips', () => {
    const meta = parseBackupName(buildBackupName(AT, MAC_CHROME, '7f3a2c').value);
    expect(meta).toEqual({ createdAt: AT, browser: 'chrome', os: 'macos', deviceCode: '7f3a2c' });
  });
  it.each([
    'almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh.txt',
    'Copy of almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh',
    'almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7F3A2C.almamesh',
    'almamesh-backup-2026-10-10T18-04-05-123Z-netscape-macos-7f3a2c.almamesh',
    'almamesh-backup-2026-13-40T18-04-05-123Z-chrome-macos-7f3a2c.almamesh',
    'almamesh-backup-2026-10-10T18-04-05Z.almamesh',
  ])('rejects %s', (raw) => {
    expect(parseBackupName(raw)).toBeNull();
    expect(() => backupNameOf(raw)).toThrow(DriveError);
  });
});
