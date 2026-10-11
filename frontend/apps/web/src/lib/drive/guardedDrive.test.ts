import { describe, expect, it, vi } from 'vitest';
import type { BackupDrive, SealedBackup } from './backupDrive';
import { backupNameOf } from './backupName';
import { guardedDrive } from './guardedDrive';
import { runBackupDriveContract } from './testing/backupDriveContract';
import { createFakeDrive } from './testing/fakeDrive';
import { sealedFixtureBytes } from './testing/sealedFixture';

const NAME = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
const AGE = await sealedFixtureBytes();

runBackupDriveContract('guarded fake drive', async () => guardedDrive(createFakeDrive(), () => true));

describe('guardedDrive', () => {
  it('passes isConnected through to the adapter', async () => {
    const inner = createFakeDrive();
    const isConnected = vi.spyOn(inner, 'isConnected').mockResolvedValue(false);
    expect(await guardedDrive(inner, () => true).isConnected()).toBe(false);
    expect(isConnected).toHaveBeenCalledOnce();
  });

  it('passes disconnect through to the adapter', async () => {
    const inner = createFakeDrive();
    const disconnect = vi.spyOn(inner, 'disconnect');
    await guardedDrive(inner, () => true).disconnect();
    expect(disconnect).toHaveBeenCalledOnce();
  });

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

  it('reports meta from the name on the upload return path', async () => {
    const inner = createFakeDrive();
    const lying: BackupDrive = {
      ...inner,
      upload: async (name, sealed) => {
        const real = await inner.upload(name, sealed);
        return { ...real, meta: { ...real.meta, deviceCode: 'bbbbbb' } };
      },
    };
    const entry = await guardedDrive(lying).upload(NAME, { bytes: AGE } as SealedBackup);
    expect(entry.meta.deviceCode).toBe('7f3a2c');
  });

  it('fails with provider_error when the adapter returns an entry with an unparseable name', async () => {
    const inner = createFakeDrive();
    const bad: BackupDrive = {
      ...inner,
      upload: async (name, sealed) => {
        const real = await inner.upload(name, sealed);
        return { ...real, name: { value: 'Copy of x.almamesh' } as typeof real.name };
      },
    };
    await expect(guardedDrive(bad).upload(NAME, { bytes: AGE } as SealedBackup)).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });

  it.each(['connect', 'list', 'upload', 'download', 'remove'] as const)(
    'refuses %s when offline and never calls the adapter',
    async (method) => {
      const inner = createFakeDrive();
      const spy = vi.spyOn(inner, method);
      const guarded = guardedDrive(inner, () => false);
      const calls = {
        connect: () => guarded.connect('/'),
        list: () => guarded.list(),
        upload: () => guarded.upload(NAME, { bytes: AGE } as SealedBackup),
        download: () => guarded.download('f1'),
        remove: () => guarded.remove('f1'),
      };
      await expect(calls[method]()).rejects.toMatchObject({ kind: 'offline' });
      expect(spy).not.toHaveBeenCalled();
    },
  );
});
