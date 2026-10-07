/**
 * The app-side backup crypto: seal new files with age, open age files and every
 * old format, and turn each library failure into an honest, typed error.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupError } from './backup';
import {
  BackupCryptoError,
  defaultSealRunner,
  openBackup,
  sealBackup,
  type SealRunner,
} from './backupSealing';
import { handleSealRequest, type SealReply, type SealRequest } from './passphraseSeal';

// Real age scrypt at the production work factor (128 MiB). ~0.5 s on a laptop, but the
// shared CI runner has taken over 5 s, Vitest's default limit.
const REAL_SCRYPT_MS = 60_000;

const FIXTURES = new URL('./__fixtures__/legacy-backups/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIXTURES), 'utf8')) as Record<
  string,
  { passphrase: string; plaintextSha256?: string; databaseSha256?: string }
>;
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));
const fixtureText = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const DATABASE = new TextEncoder().encode('SQLite format 3\0 sealed database bytes');
const PASSPHRASE = 'twelve chars or more';
const inThread: SealRunner = handleSealRequest;

function replying(reply: SealReply): SealRunner {
  return vi.fn<SealRunner>().mockResolvedValue(reply);
}

describe('sealBackup / openBackup (age)', () => {
  it('round-trips the exact database bytes and refuses any other password', async () => {
    const sealed = await sealBackup(DATABASE, PASSPHRASE, inThread);
    const opened = await openBackup(sealed, PASSPHRASE, inThread);
    expect(opened).toEqual({ kind: 'database', format: 'age', database: DATABASE, settings: {} });
    await expect(openBackup(sealed, 'twelve chars or less', inThread)).rejects.toMatchObject({
      name: 'BackupCryptoError',
      code: 'bad_passphrase',
    });
  }, REAL_SCRYPT_MS);

  it('refuses a passphrase under 12 characters before any sealing work', async () => {
    const runner = vi.fn<SealRunner>();
    await expect(sealBackup(DATABASE, 'eleven char', runner)).rejects.toMatchObject({
      code: 'bad_passphrase',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('asks for a passphrase before opening an encrypted file without one', async () => {
    const sealed = await sealBackup(DATABASE, PASSPHRASE, inThread);
    const runner = vi.fn<SealRunner>();
    await expect(openBackup(sealed, '', runner)).rejects.toMatchObject({ code: 'bad_passphrase' });
    await expect(openBackup(fixtureText('legacy-v1.json'), undefined, runner)).rejects.toMatchObject({
      code: 'bad_passphrase',
    });
    expect(runner).not.toHaveBeenCalled();
  }, REAL_SCRYPT_MS);

  it('opens an ASCII-armored age file read as text', async () => {
    const { armor, Encrypter } = await import('age-encryption');
    const encrypter = new Encrypter();
    encrypter.setScryptWorkFactor(10);
    encrypter.setPassphrase(PASSPHRASE);
    const armored = armor.encode(await encrypter.encrypt(DATABASE));
    await expect(openBackup(armored, PASSPHRASE, inThread)).resolves.toMatchObject({
      format: 'age',
      database: DATABASE,
    });
  });
});

describe('openBackup (golden files from the pre-age code)', () => {
  it('opens a real v3 .almamesh export', async () => {
    const entry = manifest['legacy-v3.almamesh'];
    const opened = await openBackup(fixtureBytes('legacy-v3.almamesh'), entry.passphrase, vi.fn());
    expect(opened.kind).toBe('database');
    if (opened.kind !== 'database') return;
    expect(opened.format).toBe('almamesh-portable-v3');
    expect(sha256(opened.database)).toBe(entry.plaintextSha256);
    expect(opened.settings).toEqual({});
  });

  it('opens a v2 JSON bundle and keeps only allowlisted settings', async () => {
    const entry = manifest['legacy-v2.json'];
    const opened = await openBackup(fixtureText('legacy-v2.json'), entry.passphrase, vi.fn());
    expect(opened.kind).toBe('database');
    if (opened.kind !== 'database') return;
    expect(opened.format).toBe('almamesh-backup-v2');
    expect(sha256(opened.database)).toBe(entry.databaseSha256);
    expect(opened.settings).toEqual({
      'almamesh-llm-settings': '{"apiBase":"https://openrouter.ai/api/v1","apiKey":"test-key-not-a-secret","interpretationModel":"synthetic/frontier","chatModel":"synthetic/fast","privacyMode":"standard"}',
    });
  });

  it('opens a v1 JSON store backup', async () => {
    const entry = manifest['legacy-v1.json'];
    const opened = await openBackup(fixtureText('legacy-v1.json'), entry.passphrase, vi.fn());
    expect(opened.kind).toBe('stores');
    if (opened.kind !== 'stores') return;
    expect(opened.stores['almamesh-language']).toEqual({ version: 1, state: { language: 'pt' } });
  });

  it('refuses a wrong password on an old file as bad_passphrase', async () => {
    await expect(openBackup(fixtureBytes('legacy-v3.almamesh'), 'not the password', vi.fn())).rejects
      .toMatchObject({ name: 'BackupCryptoError', code: 'bad_passphrase' });
  });

  it('refuses bytes that are no backup at all as bad_format', async () => {
    await expect(openBackup(new Uint8Array([1, 2, 3]), PASSPHRASE, vi.fn())).rejects.toMatchObject({
      name: 'BackupError',
      code: 'bad_format',
    });
  });
});

describe('every library failure becomes an honest error', () => {
  const sealed = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt x 17\n');

  it.each([
    ['wrong_passphrase_or_tampered', BackupCryptoError, 'bad_passphrase'],
    ['out_of_memory', BackupCryptoError, 'out_of_memory'],
    ['unavailable', BackupCryptoError, 'unavailable'],
    ['unsupported', BackupCryptoError, 'unsupported'],
    ['not_sealed', BackupError, 'bad_format'],
    ['malformed', BackupError, 'bad_format'],
    ['too_large', BackupError, 'bad_format'],
  ] as const)('open %s → %s %s', async (reason, type, code) => {
    const failure = openBackup(sealed, PASSPHRASE, replying({ ok: false, reason }));
    await expect(failure).rejects.toBeInstanceOf(type);
    await expect(failure).rejects.toMatchObject({ code });
  });

  it('carries the work factor of a file that asks for too much memory', async () => {
    const failure = openBackup(sealed, PASSPHRASE, replying({ ok: false, reason: 'too_costly', workFactor: 22 }));
    await expect(failure).rejects.toMatchObject({ code: 'too_costly', workFactor: 22 });
  });

  it.each([
    ['out_of_memory', 'out_of_memory'],
    ['unavailable', 'unavailable'],
    ['invalid_work_factor', 'unavailable'],
    ['empty_passphrase', 'bad_passphrase'],
  ] as const)('seal %s → %s', async (reason, code) => {
    await expect(sealBackup(DATABASE, PASSPHRASE, replying({ ok: false, reason }))).rejects.toMatchObject({
      name: 'BackupCryptoError',
      code,
    });
  });
});

describe('defaultSealRunner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs on the current thread where there is no Worker (Node, tests)', async () => {
    vi.stubGlobal('Worker', undefined);
    const reply = await defaultSealRunner()({ op: 'seal', bytes: DATABASE, passphrase: PASSPHRASE });
    expect(reply.ok).toBe(true);
  });

  it('posts each request to a fresh module worker and terminates it after the reply', async () => {
    const created: FakeWorker[] = [];
    class FakeWorker extends EventTarget {
      readonly url: string;
      readonly options: WorkerOptions | undefined;
      terminated = false;
      constructor(url: URL, options?: WorkerOptions) {
        super();
        this.url = url.href;
        this.options = options;
        created.push(this);
      }
      postMessage(request: SealRequest, transfer: Transferable[]): void {
        expect(transfer).toEqual([request.bytes.buffer]);
        void handleSealRequest(request).then((data) => {
          this.dispatchEvent(new MessageEvent('message', { data }));
        });
      }
      terminate(): void {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', FakeWorker);

    const sealed = await sealBackup(DATABASE.slice(), PASSPHRASE);
    expect(created).toHaveLength(1);
    expect(created[0].url).toMatch(/passphraseSeal\.worker\.ts$/);
    expect(created[0].options).toEqual({ type: 'module' });
    expect(created[0].terminated).toBe(true);
    await expect(openBackup(sealed, PASSPHRASE)).resolves.toMatchObject({ database: DATABASE });
    expect(created).toHaveLength(2);
  });

  it('reports a worker that fails to start as unavailable, and terminates it', async () => {
    let worker: { terminated: boolean } | undefined;
    class BrokenWorker extends EventTarget {
      terminated = false;
      constructor() {
        super();
        worker = this;
      }
      postMessage(): void {
        queueMicrotask(() => this.dispatchEvent(new Event('error')));
      }
      terminate(): void {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', BrokenWorker);
    await expect(sealBackup(DATABASE.slice(), PASSPHRASE)).rejects.toMatchObject({ code: 'unavailable' });
    expect(worker?.terminated).toBe(true);
  });
});
