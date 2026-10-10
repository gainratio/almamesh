import { describe, expect, it } from 'vitest';
import { DriveError, sealedBackupOf } from './backupDrive';

const AGE = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt abc 18\n');
const SQLITE = new TextEncoder().encode('SQLite format 3\0rest');
const ARMORED = new TextEncoder().encode('-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n');
const AGE_NO_NEWLINE = new TextEncoder().encode('age-encryption.org/v1 -> scrypt');

describe('sealedBackupOf', () => {
  it('accepts age bytes', () => {
    expect(sealedBackupOf(AGE).bytes).toBe(AGE);
  });
  it.each([
    ['plain SQLite', SQLITE],
    ['ASCII-armored age', ARMORED],
    ['age header without newline', AGE_NO_NEWLINE],
    ['JSON', new TextEncoder().encode('{"format":"almamesh-backup"}')],
    ['empty', new Uint8Array()],
  ])('refuses %s', (_label, bytes) => {
    expect(() => sealedBackupOf(bytes)).toThrow(DriveError);
    try {
      sealedBackupOf(bytes);
    } catch (error) {
      expect((error as DriveError).kind).toBe('not_sealed');
    }
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
