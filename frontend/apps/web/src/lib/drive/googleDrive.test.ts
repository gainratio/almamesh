import { describe, expect, it } from 'vitest';
import type { SealedBackup } from './backupDrive';
import { backupNameOf } from './backupName';
import { createGoogleDrive, DRIVE_FOLDER_NAME } from './googleDrive';
import { runBackupDriveContract } from './testing/backupDriveContract';
import { createFakeGoogleServer } from './testing/fakeGoogleFetch';
import { sealedFixtureBytes } from './testing/sealedFixture';

const NAME = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
const BYTES = await sealedFixtureBytes();

function makeSut() {
  const server = createFakeGoogleServer('ya29.unit-test');
  const drive = createGoogleDrive({
    getAccessToken: async () => 'ya29.unit-test',
    startConnect: async () => 'connected',
    isConnected: async () => true,
    disconnect: async () => undefined,
    fetchImpl: server.fetchImpl,
    sleep: async () => undefined,
  });
  return { server, drive };
}

runBackupDriveContract('googleDrive over recorded Google REST v3', async () => makeSut().drive);

describe('googleDrive', () => {
  it('creates AlmaMesh backups folder once and reuses it across uploads, using PATCH trashed:true on remove', async () => {
    const { server, drive } = makeSut();
    const first = await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
    await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
    const folderCreates = server.requests.filter(
      (r) => r.method === 'POST' && r.url.startsWith('https://www.googleapis.com/drive/v3/files'),
    );
    expect(folderCreates).toHaveLength(1);
    expect(JSON.parse(folderCreates[0]!.bodyText)).toEqual({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    });

    await drive.remove(first.id);
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
    const patch = server.requests.find((r) => r.method === 'PATCH');
    expect(JSON.parse(patch?.bodyText ?? '{}')).toEqual({ trashed: true });
  });

  it('maps 401 -> token_expired, 403 storageQuotaExceeded -> quota_exceeded, and retries GET once on 500/429', async () => {
    const { server, drive } = makeSut();
    server.validToken = 'rotated';
    await expect(drive.list()).rejects.toMatchObject({ kind: 'token_expired', status: 401 });

    server.validToken = 'ya29.unit-test';
    server.nextQuotaExceeded = true;
    await expect(drive.upload(NAME, { bytes: BYTES } as SealedBackup)).rejects.toMatchObject({
      kind: 'quota_exceeded',
      status: 403,
    });

    server.nextStatus = 500;
    await expect(drive.list()).resolves.toEqual([]);
  });

  it('refuses a resumable upload Location header pointing outside www.googleapis.com', async () => {
    const rogueFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/drive/v3/files')) {
        return new Response(JSON.stringify({ files: [{ id: 'f1', name: DRIVE_FOLDER_NAME }] }), { status: 200 });
      }
      return new Response('', { status: 200, headers: { Location: 'https://evil.example/upload' } });
    };
    const drive = createGoogleDrive({
      getAccessToken: async () => 'tok',
      startConnect: async () => 'connected',
      isConnected: async () => true,
      disconnect: async () => undefined,
      fetchImpl: rogueFetch,
    });
    await expect(drive.upload(NAME, { bytes: BYTES } as SealedBackup)).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });

  it('refuses oversized downloads exceeding maxDownloadBytes before unbounded allocation', async () => {
    const { server, drive: uploader } = makeSut();
    const entry = await uploader.upload(NAME, { bytes: BYTES } as SealedBackup);
    const boundedDrive = createGoogleDrive({
      getAccessToken: async () => 'ya29.unit-test',
      startConnect: async () => 'connected',
      isConnected: async () => true,
      disconnect: async () => undefined,
      fetchImpl: server.fetchImpl,
      maxDownloadBytes: 16,
    });
    await expect(boundedDrive.download(entry.id)).rejects.toMatchObject({ kind: 'too_large' });
  });
});
