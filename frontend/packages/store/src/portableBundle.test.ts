/**
 * Encrypted portable bundle (backup format v2): the whole export — canonical
 * SQLite bytes plus device settings and secrets — sealed with a passphrase.
 * All fixtures are synthetic.
 */
import { describe, expect, it, vi } from 'vitest';
import { BackupError } from './backup';
import { BackupCryptoError } from './backupCrypto';
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_PBKDF2_ITERATIONS,
  isPortableBundle,
  openPortableBundle,
  sealPortableBundle,
} from './portableBundle';

const SECRET = 'sk-or-v1-synthetic-secret-never-plaintext';
const PASSPHRASE = 'correct horse battery';
const DATABASE = new Uint8Array([...new TextEncoder().encode('SQLite format 3\0'), 1, 2, 3, 250]);
const SETTINGS = {
  'almamesh-llm-settings': JSON.stringify({
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey: SECRET,
    interpretationModel: 'synthetic/model-a',
    chatModel: 'synthetic/model-b',
  }),
};
const META = { appVersion: 'test-1.0.0', now: '2026-10-01T00:00:00.000Z' };

async function sealed(): Promise<Record<string, unknown>> {
  const text = await sealPortableBundle({ database: DATABASE, settings: SETTINGS }, PASSPHRASE, META);
  return JSON.parse(text) as Record<string, unknown>;
}

describe('sealPortableBundle / openPortableBundle', () => {
  it('round-trips the database bytes and settings, including the API key', async () => {
    const opened = await openPortableBundle(await sealed(), PASSPHRASE);

    expect([...opened.database]).toEqual([...DATABASE]);
    expect(opened.settings).toEqual(SETTINGS);
  });

  it('never writes the plaintext key, settings, or SQLite header into the file', async () => {
    const text = await sealPortableBundle({ database: DATABASE, settings: SETTINGS }, PASSPHRASE, META);

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('openrouter');
    expect(text).not.toContain('SQLite format');
  });

  it('writes a versioned header with a 600k-iteration PBKDF2 and random salt and IV', async () => {
    const first = await sealed();
    const second = await sealed();

    expect(BUNDLE_FORMAT_VERSION).toBe(2);
    expect(BUNDLE_PBKDF2_ITERATIONS).toBe(600_000);
    expect(first).toMatchObject({
      format: 'almamesh-backup',
      formatVersion: 2,
      encryption: 'aes-gcm',
      app: { version: 'test-1.0.0' },
      exportedAt: META.now,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 },
    });
    expect((first.kdf as { salt: string }).salt).not.toBe((second.kdf as { salt: string }).salt);
    expect(first.iv).not.toBe(second.iv);
    expect(isPortableBundle(first)).toBe(true);
  });

  it('rejects a wrong passphrase as bad_passphrase', async () => {
    const bundle = await sealed();

    await expect(openPortableBundle(bundle, 'wrong passphrase')).rejects.toMatchObject({
      name: 'BackupCryptoError',
      code: 'bad_passphrase',
    });
  });

  it('rejects a missing passphrase as bad_passphrase so the UI prompts', async () => {
    await expect(openPortableBundle(await sealed(), '')).rejects.toBeInstanceOf(BackupCryptoError);
  });

  it('rejects tampered ciphertext through GCM authentication', async () => {
    const bundle = await sealed();
    const bytes = Uint8Array.from(atob(bundle.ciphertext as string), (c) => c.charCodeAt(0));
    bytes[5] ^= 0x01;
    const tampered = { ...bundle, ciphertext: btoa(String.fromCharCode(...bytes)) };

    await expect(openPortableBundle(tampered, PASSPHRASE)).rejects.toMatchObject({
      code: 'bad_passphrase',
    });
  });

  it('rejects a tampered header because the header is authenticated data', async () => {
    const bundle = await sealed();
    const tampered = { ...bundle, exportedAt: '2020-01-01T00:00:00.000Z' };

    await expect(openPortableBundle(tampered, PASSPHRASE)).rejects.toMatchObject({
      code: 'bad_passphrase',
    });
  });

  it('refuses a downgraded KDF work factor before deriving any key', async () => {
    const bundle = await sealed();
    const weak = { ...bundle, kdf: { ...(bundle.kdf as object), iterations: 1_000 } };

    await expect(openPortableBundle(weak, PASSPHRASE)).rejects.toBeInstanceOf(BackupError);
    await expect(openPortableBundle(weak, PASSPHRASE)).rejects.toMatchObject({ code: 'bad_format' });
  });

  it('refuses a malformed header as bad_format', async () => {
    await expect(openPortableBundle({ format: 'almamesh-backup', formatVersion: 2 }, PASSPHRASE))
      .rejects.toMatchObject({ code: 'bad_format' });
  });

  it('drops settings keys outside the portable allowlist when opening', async () => {
    const text = await sealPortableBundle(
      { database: DATABASE, settings: { ...SETTINGS, 'evil-key': 'x' } },
      PASSPHRASE,
      META,
    );

    const opened = await openPortableBundle(JSON.parse(text), PASSPHRASE);

    expect(Object.keys(opened.settings)).toEqual(['almamesh-llm-settings']);
  });

  it('refuses to seal without a passphrase', async () => {
    await expect(
      sealPortableBundle({ database: DATABASE, settings: SETTINGS }, '', META),
    ).rejects.toMatchObject({ code: 'bad_passphrase' });
  });

  it('reports an authentic but unreadable payload as corrupt', async () => {
    const subtle = globalThis.crypto.subtle;
    const realEncrypt = subtle.encrypt.bind(subtle);
    const spy = vi
      .spyOn(subtle, 'encrypt')
      .mockImplementationOnce((algorithm, key) =>
        realEncrypt(algorithm, key, new TextEncoder().encode('{"not":"a payload"}')),
      );
    try {
      const bundle = await sealed();
      await expect(openPortableBundle(bundle, PASSPHRASE)).rejects.toMatchObject({
        name: 'BackupError',
        code: 'corrupt',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('fails closed with unsupported when Web Crypto is missing', async () => {
    const bundle = await sealed();
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    try {
      await expect(openPortableBundle(bundle, PASSPHRASE)).rejects.toMatchObject({
        code: 'unsupported',
      });
      await expect(
        sealPortableBundle({ database: DATABASE, settings: SETTINGS }, PASSPHRASE, META),
      ).rejects.toMatchObject({ name: 'BackupCryptoError', code: 'unsupported' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not treat a v1 envelope as a bundle', () => {
    expect(isPortableBundle({ format: 'almamesh-backup', formatVersion: 1 })).toBe(false);
    expect(isPortableBundle(null)).toBe(false);
  });
});
