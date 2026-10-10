import { describe, expect, it, vi } from 'vitest';
import type { BackupDrive, SealedBackup } from './backupDrive';
import { backupNameOf } from './backupName';
import { guardedDrive } from './guardedDrive';
import { createFakeDrive } from './testing/fakeDrive';

const NAME = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
const AGE = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt x 18\n---\n');

describe('guardedDrive', () => {
  it('refuses forged sealed bytes before the adapter is called', async () => {
    const inner = createFakeDrive();
    const upload = vi.spyOn(inner, 'upload');
    const forged = { bytes: new TextEncoder().encode('SQLite format 3\0') } as unknown as SealedBackup;
    await expect(guardedDrive(inner).upload(NAME, forged)).rejects.toMatchObject({ kind: 'not_sealed' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses a forged name', async () => {
    const inner = createFakeDrive();
    const upload = vi.spyOn(inner, 'upload');
    const bad = { value: 'Priya-backup.almamesh' } as never;
    await expect(guardedDrive(inner).upload(bad, { bytes: AGE } as SealedBackup)).rejects.toMatchObject({
      kind: 'bad_name',
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('drops entries whose names do not parse', async () => {
    const inner = createFakeDrive();
    inner.files.set('x', { name: 'Copy of something.almamesh', bytes: AGE, trashed: false });
    await guardedDrive(inner).upload(NAME, { bytes: AGE } as SealedBackup);
    expect((await guardedDrive(inner).list()).map((e) => e.name.value)).toEqual([NAME.value]);
  });

  it('reports meta from the name, not from a lying adapter', async () => {
    const inner = createFakeDrive();
    const real = await inner.upload(NAME, { bytes: AGE } as SealedBackup);
    const lying: BackupDrive = {
      ...inner,
      list: async () => [{ ...real, meta: { ...real.meta, deviceCode: 'bbbbbb', browser: 'firefox' } }],
    };
    const [entry] = await guardedDrive(lying).list();
    expect(entry?.meta.deviceCode).toBe('7f3a2c');
    expect(entry?.meta.browser).toBe('chrome');
  });

  it('maps offline before any call', async () => {
    const inner = createFakeDrive();
    const list = vi.spyOn(inner, 'list');
    await expect(guardedDrive(inner, () => false).list()).rejects.toMatchObject({ kind: 'offline' });
    expect(list).not.toHaveBeenCalled();
  });
});
