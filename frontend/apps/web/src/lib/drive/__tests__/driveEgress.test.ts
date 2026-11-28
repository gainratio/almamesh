/**
 * Ciphertext-only egress proof (Spec §Privacy "The ciphertext-only test"):
 * seeds unmistakable user-data, AI-key, and passphrase canaries, drives upload,
 * list, download, remove, and disconnect against the Google adapter, and proves
 * zero user/passphrase canaries ever appear in any URL, header, JSON metadata,
 * UTF-8 body, or UTF-16LE body.
 */
import { describe, expect, it } from 'vitest';
import { sealBackup } from '@almamesh/store';
import { buildBackupName, parseBackupName } from '../backupName';
import { createGoogleSession } from '../driveSession';
import { createGoogleDrive, DRIVE_FOLDER_NAME } from '../googleDrive';
import { guardedDrive } from '../guardedDrive';
import { sealedBackupOf } from '../backupDrive';
import { createFakeGoogleServer } from '../testing/fakeGoogleFetch';
import { createMemoryCredentials } from '../testing/memoryCredentials';

const DATA_CANARIES = [
  'Zyxwv Canary',
  '1987-03-14',
  'Qwertyville',
  'canary-llm-setting',
  'canary-passphrase-value',
] as const;
const BEARER_CANARY = 'bearer-canary-value';
const ALLOWED_HOSTS = new Set(['www.googleapis.com', 'oauth2.googleapis.com']);
const ALLOWED_JSON_KEYS = new Set(['name', 'parents', 'mimeType', 'trashed']);

function utf16LeBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = code >> 8;
  }
  return out;
}

function containsSubarray(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe('driveEgress: ciphertext-only invariant', () => {
  it('sends zero requests before user action, and sends only age ciphertext + neutral metadata afterwards', async () => {
    const server = createFakeGoogleServer(BEARER_CANARY);
    const creds = createMemoryCredentials();
    await creds.write('google-drive', { accessToken: BEARER_CANARY, expiresAt: Date.now() + 3_600_000 });
    const session = createGoogleSession({ credentials: creds, fetchImpl: server.fetchImpl });
    const drive = guardedDrive(
      createGoogleDrive({
        getAccessToken: () => session.getAccessToken(),
        startConnect: async () => 'connected',
        isConnected: () => session.isConnected(),
        disconnect: () => session.disconnect(),
        fetchImpl: server.fetchImpl,
      }),
      () => true,
      async () => '7f3a2c',
    );

    // 0 requests before a drive operation is invoked.
    expect(server.requests).toHaveLength(0);

    const fakeSqlitePayload = new TextEncoder().encode(
      `SQLite format 3\0${JSON.stringify({
        name: 'Zyxwv Canary',
        birthDate: '1987-03-14',
        city: 'Qwertyville',
        llmSetting: 'canary-llm-setting',
      })}`,
    );
    const ciphertext = await sealBackup(fakeSqlitePayload, 'canary-passphrase-value');
    const backupName = buildBackupName(
      new Date('2026-10-10T18:04:05.123Z'),
      'Mozilla/5.0 Chrome/130.0 Macintosh',
      '7f3a2c',
    );

    const uploaded = await drive.upload(backupName, sealedBackupOf(ciphertext));
    expect(await drive.list()).toHaveLength(1);
    expect(await drive.download(uploaded.id)).toEqual(ciphertext);
    await drive.remove(uploaded.id);
    await drive.disconnect();

    expect(server.requests.length).toBeGreaterThan(0);

    for (const req of server.requests) {
      const parsedUrl = new URL(req.url);
      expect(ALLOWED_HOSTS.has(parsedUrl.hostname), req.url).toBe(true);

      // Bearer token canary never appears in any URL, only Authorization header or revoke body.
      expect(req.url).not.toContain(BEARER_CANARY);
      if (parsedUrl.hostname !== 'oauth2.googleapis.com') {
        expect(req.bodyText).not.toContain(BEARER_CANARY);
      }

      for (const canary of DATA_CANARIES) {
        expect(req.url).not.toContain(canary);
        expect(JSON.stringify(req.headers)).not.toContain(canary);
        expect(req.bodyText).not.toContain(canary);
        expect(containsSubarray(req.bodyBytes, new TextEncoder().encode(canary))).toBe(false);
        expect(containsSubarray(req.bodyBytes, utf16LeBytes(canary))).toBe(false);
      }

      if (req.bodyBytes.length === 0 || parsedUrl.hostname === 'oauth2.googleapis.com') continue;

      if (req.headers['content-type']?.includes('application/json')) {
        const json = JSON.parse(req.bodyText) as Record<string, unknown>;
        for (const key of Object.keys(json)) {
          expect(ALLOWED_JSON_KEYS.has(key), `unexpected JSON key: ${key}`).toBe(true);
        }
        if (typeof json.name === 'string' && json.name !== DRIVE_FOLDER_NAME) {
          expect(parseBackupName(json.name)).not.toBeNull();
        }
      } else {
        // Binary upload body: must be age v1, never raw SQLite.
        const headerSlice = new TextDecoder('latin1').decode(req.bodyBytes.subarray(0, 22));
        expect(headerSlice).toBe('age-encryption.org/v1\n');
        expect(headerSlice.startsWith('SQLite format 3\0')).toBe(false);
      }
    }
  });
});
