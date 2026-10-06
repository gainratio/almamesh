/**
 * The passphrase seam: the one module that talks to `@gainratio/browser/seal`.
 * Old files are golden fixtures written by the pre-age code (see
 * __fixtures__/legacy-backups/manifest.json), so "every old backup still opens"
 * is pinned against real bytes, not against a re-implementation.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkBackupPassphrase,
  isSealedBackup,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  openLegacyBackup,
  openSealedInThread,
  sealInThread,
} from './passphraseSeal';

const FIXTURES = new URL('./__fixtures__/legacy-backups/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIXTURES), 'utf8')) as Record<
  string,
  { passphrase: string; plaintextSha256?: string; databaseSha256?: string; storesJsonSha256?: string }
>;
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));
const fixtureText = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('checkBackupPassphrase', () => {
  it('requires at least 12 characters', () => {
    expect(MIN_BACKUP_PASSPHRASE_LENGTH).toBe(12);
    expect(checkBackupPassphrase('a'.repeat(11), 'a'.repeat(11))).toBe('too_short');
    expect(checkBackupPassphrase('a'.repeat(12), 'a'.repeat(12))).toBeNull();
  });

  it('reports empty, then too short, then a mismatch', () => {
    expect(checkBackupPassphrase('', '')).toBe('empty');
    expect(checkBackupPassphrase('   ', '   ')).toBe('empty');
    expect(checkBackupPassphrase('short', 'other')).toBe('too_short');
    expect(checkBackupPassphrase('a long passphrase', 'a long passphrasE')).toBe('mismatch');
  });
});

describe('age sealing (new exports)', () => {
  const plaintext = new TextEncoder().encode('SQLite format 3\0 canonical bytes');
  const passphrase = 'correct horse battery';

  it('seals into an age file that opens only with its passphrase', async () => {
    const sealed = await sealInThread(plaintext, passphrase);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(isSealedBackup(sealed.bytes)).toBe(true);
    expect(decode(sealed.bytes.slice(0, 22))).toBe('age-encryption.org/v1\n');
    expect(decode(sealed.bytes)).not.toContain('canonical bytes');

    const opened = await openSealedInThread(sealed.bytes, passphrase);
    expect(opened).toEqual({ ok: true, bytes: plaintext });
    expect(await openSealedInThread(sealed.bytes, 'wrong horse battery')).toEqual({
      ok: false,
      reason: 'wrong_passphrase_or_tampered',
    });
    const tampered = sealed.bytes.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(await openSealedInThread(tampered, passphrase)).toEqual({
      ok: false,
      reason: 'wrong_passphrase_or_tampered',
    });
  });

  it('does not mistake old files or SQLite for age files', () => {
    expect(isSealedBackup(fixtureBytes('legacy-v3.almamesh'))).toBe(false);
    expect(isSealedBackup(new TextEncoder().encode('SQLite format 3\0'))).toBe(false);
    expect(isSealedBackup(fixtureBytes('legacy-v2.json'))).toBe(false);
  });
});

describe('legacy backups (golden fixtures from the pre-age code)', () => {
  it('opens a real v3 .almamesh export to its exact SQLite bytes', async () => {
    const entry = manifest['legacy-v3.almamesh'];
    const opened = await openLegacyBackup(fixtureBytes('legacy-v3.almamesh'), entry.passphrase);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.format).toBe('almamesh-portable-v3');
    expect(decode(opened.bytes.slice(0, 16))).toBe('SQLite format 3\0');
    expect(sha256(opened.bytes)).toBe(entry.plaintextSha256);
  });

  it('opens a v2 JSON bundle made with a pre-v3 short passphrase', async () => {
    const entry = manifest['legacy-v2.json'];
    const opened = await openLegacyBackup(fixtureText('legacy-v2.json'), entry.passphrase);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.format).toBe('almamesh-backup-v2');
    const payload = JSON.parse(decode(opened.bytes)) as { database: string };
    expect(sha256(Buffer.from(payload.database, 'base64'))).toBe(entry.databaseSha256);
  });

  it('opens a v1 JSON store backup', async () => {
    const entry = manifest['legacy-v1.json'];
    const opened = await openLegacyBackup(fixtureText('legacy-v1.json'), entry.passphrase);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.format).toBe('almamesh-backup-v1');
    expect(sha256(decode(opened.bytes))).toBe(entry.storesJsonSha256);
  });

  it('refuses a wrong password for every old format', async () => {
    for (const file of [fixtureBytes('legacy-v3.almamesh'), fixtureText('legacy-v2.json'), fixtureText('legacy-v1.json')]) {
      expect(await openLegacyBackup(file, 'not the password')).toEqual({
        ok: false,
        reason: 'wrong_passphrase_or_tampered',
      });
    }
  });
});

describe('inject, do not entangle', () => {
  it('imports @gainratio/browser/seal from this seam and nowhere else', () => {
    const frontend = fileURLToPath(new URL('../../../', import.meta.url));
    const sources = ['packages', 'apps/web/src', 'apps/web/scripts', 'apps/web/e2e'].flatMap((dir) =>
      (readdirSync(join(frontend, dir), { recursive: true }) as string[])
        .filter((file) => /\.(?:m?[jt]sx?)$/.test(file) && !file.includes('node_modules') && !file.includes('dist/'))
        .map((file) => join(frontend, dir, file)),
    );
    const importers = sources
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => readFileSync(file, 'utf8').includes("'@gainratio/browser/seal'"))
      .map((file) => relative(frontend, file));
    expect(importers).toEqual(['packages/store/src/passphraseSeal.ts']);
  });
});
