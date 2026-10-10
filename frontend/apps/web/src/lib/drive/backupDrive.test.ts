import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { describe, expect, it } from 'vitest';
import { DriveError, sealedBackupOf } from './backupDrive';
import { passphraseSealedFixtureBytes, sealedFixtureBytes } from './testing/sealedFixture';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** Binary payload bytes with no '\n', so they can never be read as a header line. */
const payload = (n: number): Uint8Array => new Uint8Array(n).fill(0xaa);

const PREFIX = 'age-encryption.org/v1\n';
const STANZA = '-> X25519 TEiF0ypqr+bpvcqXNyCVJpL7OuwPdVwPL7KQEbFDOCc\nEmECAEcKN+n/Vs9SbWiV+Hu0r+E8R77DdWYyd83nw7U\n';
const MAC = `--- ${'A'.repeat(43)}\n`;

const SQLITE = enc('SQLite format 3\0rest');
const ARMORED = enc('-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n');
const AGE_NO_NEWLINE = enc('age-encryption.org/v1 -> scrypt');

function expectNotSealed(bytes: Uint8Array): void {
  let caught: unknown;
  try {
    sealedBackupOf(bytes);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DriveError);
  expect((caught as DriveError).kind).toBe('not_sealed');
}

describe('sealedBackupOf', () => {
  it('accepts a real age file sealed to an X25519 recipient', async () => {
    const bytes = await sealedFixtureBytes();
    expect(sealedBackupOf(bytes).bytes).toBe(bytes);
  });

  it('accepts a real age file sealed with a passphrase (the local export format)', async () => {
    const bytes = await passphraseSealedFixtureBytes();
    expect(sealedBackupOf(bytes).bytes).toBe(bytes);
  });

  it('accepts a real age file of an empty plaintext (payload is exactly the 32-byte floor)', async () => {
    const identity = await generateX25519Identity();
    const encrypter = new Encrypter();
    encrypter.addRecipient(await identityToRecipient(identity));
    const bytes = await encrypter.encrypt(new Uint8Array());
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    expect(await decrypter.decrypt(bytes)).toEqual(new Uint8Array());
    expect(sealedBackupOf(bytes).bytes).toBe(bytes);
  });

  it('accepts a structurally valid header with a multi-line stanza body', () => {
    const body = `${'Q'.repeat(64)}\nQUJD\n`;
    expect(() => sealedBackupOf(join(enc(`${PREFIX}-> scrypt c2FsdA 18\n${body}${MAC}`), payload(32)))).not.toThrow();
  });

  it.each([
    ['plain SQLite', SQLITE],
    ['ASCII-armored age', ARMORED],
    ['age header without newline', AGE_NO_NEWLINE],
    ['JSON', enc('{"format":"almamesh-backup"}')],
    ['empty', new Uint8Array()],
  ])('refuses %s', (_label, bytes) => {
    expectNotSealed(bytes);
  });

  it.each([
    ['plaintext JSON after the age prefix', join(enc(`${PREFIX}{"format":"almamesh-backup","profiles":[]}\n`), payload(64))],
    ['a SQLite database after the age prefix', join(enc(`${PREFIX}SQLite format 3\0`), new Uint8Array(4096))],
    ['a header with no MAC line', join(enc(`${PREFIX}${STANZA}`), payload(64))],
    ['a bare --- line with no MAC', join(enc(`${PREFIX}${STANZA}---\n`), payload(64))],
    ['a short (42-char) MAC', join(enc(`${PREFIX}${STANZA}--- ${'A'.repeat(42)}\n`), payload(64))],
    ['a MAC line not ending in a newline', join(enc(`${PREFIX}${STANZA}--- ${'A'.repeat(43)}`), payload(64))],
    ['a header with no recipient stanza', join(enc(`${PREFIX}${MAC}`), payload(64))],
    ['a payload under 32 bytes', join(enc(`${PREFIX}${STANZA}${MAC}`), payload(31))],
    ['a stanza line with an empty argument', join(enc(`${PREFIX}->  X25519\nQUJD\n${MAC}`), payload(64))],
    ['a stanza body line longer than 64 columns', join(enc(`${PREFIX}-> X25519 a\n${'Q'.repeat(68)}\n${MAC}`), payload(64))],
    ['a stanza body line of impossible base64 length (4n+1)', join(enc(`${PREFIX}-> X25519 a\nQUJDR\n${MAC}`), payload(64))],
    ['a non-ASCII byte in a header line', join(enc(`${PREFIX}-> X25519 caf`), Uint8Array.of(0xe9), enc(`\nQUJD\n${MAC}`), payload(64))],
    ['a 2 MB single line after the age prefix', join(enc(PREFIX), new Uint8Array(2 * 1024 * 1024).fill(0x41), enc('\n'), payload(64))],
  ])('refuses forged age: %s', (_label, bytes) => {
    expectNotSealed(bytes);
  });

  it('refuses a real age file whose payload was truncated under 32 bytes', async () => {
    const real = await sealedFixtureBytes(new Uint8Array());
    expectNotSealed(real.slice(0, real.length - 1));
  });
});

describe('DriveError', () => {
  it('carries kind and status, never a body', () => {
    const error = new DriveError('quota_exceeded', 403);
    expect(error.kind).toBe('quota_exceeded');
    expect(error.status).toBe(403);
    expect(error.message).toBe('drive:quota_exceeded:403');
    expect(error.name).toBe('DriveError');
  });
  it('omits the status when none is given', () => {
    expect(new DriveError('offline').message).toBe('drive:offline');
  });
});
