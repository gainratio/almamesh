import { describe, expect, it, vi } from 'vitest';
import { BackupError } from './backup';
import { BackupCryptoError, bytesToB64 } from './backupCrypto';
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_PBKDF2_ITERATIONS,
  isPortableBundle,
  openPortableBundle,
  sealPortableBundle,
} from './portableBundle';

const PASSPHRASE = 'correct horse battery';
const DATABASE = new Uint8Array([...new TextEncoder().encode('SQLite format 3\0'), 1, 2, 3, 250]);
const META = { appVersion: 'test-1.0.0', now: '2026-10-01T00:00:00.000Z' };

async function sealed(): Promise<Uint8Array> {
  return sealPortableBundle(DATABASE, PASSPHRASE, META);
}

describe('binary portable bundle', () => {
  it('round-trips the exact SQLite bytes without JSON or base64', async () => {
    const file = await sealed();
    const opened = await openPortableBundle(file, PASSPHRASE);

    expect(opened.database).toEqual(DATABASE);
    expect(opened.settings).toEqual({});
    expect(file).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(file)).not.toContain('SQLite format');
    expect(new TextDecoder().decode(file)).not.toContain('database');
  });

  it('uses a compact v3 header, the exact work factor, and random salt and IV', async () => {
    const first = await sealed();
    const second = await sealed();

    expect(BUNDLE_FORMAT_VERSION).toBe(3);
    expect(BUNDLE_PBKDF2_ITERATIONS).toBe(600_000);
    expect(isPortableBundle(first)).toBe(true);
    expect(first.slice(0, 8)).toEqual(new TextEncoder().encode('ALMAMESH'));
    expect(first[8]).toBe(3);
    expect(first).not.toEqual(second);
  });

  it('rejects missing and short passphrases at the crypto boundary', async () => {
    await expect(sealPortableBundle(DATABASE, '', META)).rejects.toMatchObject({ code: 'bad_passphrase' });
    await expect(sealPortableBundle(DATABASE, 'short', META)).rejects.toMatchObject({ code: 'bad_passphrase' });
    await expect(openPortableBundle(await sealed(), 'short')).rejects.toMatchObject({ code: 'bad_passphrase' });
  });

  it('rejects wrong passwords and tampering without yielding bytes', async () => {
    const file = await sealed();
    await expect(openPortableBundle(file, 'wrong password')).rejects.toMatchObject({
      name: 'BackupCryptoError',
      code: 'bad_passphrase',
    });
    const ciphertextTamper = file.slice();
    ciphertextTamper[ciphertextTamper.length - 1] ^= 1;
    await expect(openPortableBundle(ciphertextTamper, PASSPHRASE)).rejects.toMatchObject({ code: 'bad_passphrase' });
    const headerTamper = file.slice();
    headerTamper[24] ^= 1;
    await expect(openPortableBundle(headerTamper, PASSPHRASE)).rejects.toMatchObject({ code: 'bad_passphrase' });
  });

  it('rejects malformed lengths, non-exact work factors, oversized declarations, and trailing bytes', async () => {
    const file = await sealed();
    for (const mutate of [
      (value: Uint8Array) => { value[11] = 15; },
      (value: Uint8Array) => { new DataView(value.buffer).setUint32(16, 599_999, false); },
      (value: Uint8Array) => { new DataView(value.buffer).setUint32(32, 0xffff_ffff, false); },
    ]) {
      const malformed = file.slice();
      mutate(malformed);
      await expect(openPortableBundle(malformed, PASSPHRASE)).rejects.toMatchObject({ code: 'bad_format' });
    }
    const trailing = new Uint8Array(file.length + 1);
    trailing.set(file);
    await expect(openPortableBundle(trailing, PASSPHRASE)).rejects.toMatchObject({ code: 'bad_format' });
  });

  it('fails closed with unsupported when Web Crypto is missing', async () => {
    const file = await sealed();
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    try {
      await expect(openPortableBundle(file, PASSPHRASE)).rejects.toMatchObject({ code: 'unsupported' });
      await expect(sealPortableBundle(DATABASE, PASSPHRASE, META)).rejects.toMatchObject({ code: 'unsupported' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('legacy v2 compatibility', () => {
  async function legacyV2(passphrase = PASSPHRASE): Promise<Record<string, unknown>> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = {
      format: 'almamesh-backup' as const,
      formatVersion: 2 as const,
      app: { version: 'legacy' },
      exportedAt: META.now,
      encryption: 'aes-gcm' as const,
      kdf: { name: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: 600_000, salt: bytesToB64(salt) },
      iv: bytesToB64(iv),
    };
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    const aad = new TextEncoder().encode(JSON.stringify([
      header.format, header.formatVersion, header.app.version, header.exportedAt,
      header.encryption, header.kdf.name, header.kdf.hash, header.kdf.iterations,
      header.kdf.salt, header.iv,
    ]));
    const plaintext = new TextEncoder().encode(JSON.stringify({
      database: bytesToB64(DATABASE),
      settings: { 'almamesh-llm-settings': '{"apiKey":"legacy-secret"}', evil: 'drop-me' },
    }));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
    return { ...header, ciphertext: bytesToB64(new Uint8Array(ciphertext)) };
  }

  it('still recognizes and opens old JSON/base64 bundles with allowlisted settings', async () => {
    const legacy = await legacyV2();
    expect(isPortableBundle(legacy)).toBe(true);
    await expect(openPortableBundle(legacy, PASSPHRASE)).resolves.toEqual({
      database: DATABASE,
      settings: { 'almamesh-llm-settings': '{"apiKey":"legacy-secret"}' },
    });
  });

  it('opens a valid legacy v2 backup made with a pre-v3 short passphrase', async () => {
    const legacyPassphrase = 'short';
    const legacy = await legacyV2(legacyPassphrase);

    await expect(openPortableBundle(legacy, legacyPassphrase)).resolves.toMatchObject({
      database: DATABASE,
    });
  });

  it('does not mistake v1 JSON or arbitrary bytes for a bundle', () => {
    expect(isPortableBundle({ format: 'almamesh-backup', formatVersion: 1 })).toBe(false);
    expect(isPortableBundle(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isPortableBundle(null)).toBe(false);
  });

  it('refuses malformed legacy headers', async () => {
    await expect(openPortableBundle({ format: 'almamesh-backup', formatVersion: 2 }, PASSPHRASE))
      .rejects.toBeInstanceOf(BackupError);
    await expect(openPortableBundle({ format: 'almamesh-backup', formatVersion: 2 }, PASSPHRASE))
      .rejects.not.toBeInstanceOf(BackupCryptoError);
    const oversizedHeader = {
      format: 'almamesh-backup',
      formatVersion: 2,
      app: { version: 'x'.repeat(257) },
      exportedAt: META.now,
      encryption: 'aes-gcm',
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: 'AA==' },
      iv: 'AA==',
      ciphertext: 'AA==',
    };
    await expect(openPortableBundle(oversizedHeader, PASSPHRASE)).rejects.toMatchObject({
      code: 'bad_format',
    });
  });
});
