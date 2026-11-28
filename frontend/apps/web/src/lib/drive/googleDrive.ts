/**
 * Google Drive v3 adapter (`drive.file` scope, `AlmaMesh backups` folder,
 * 2-step resumable upload, bounded `alt=media` download, and `trashed: true` removal).
 */
import { MAX_BACKUP_FILE_BYTES } from '../backupFile';
import {
  type BackupDrive,
  type BackupFileName,
  type DriveBackupEntry,
  DriveError,
  type SealedBackup,
} from './backupDrive';
import { backupNameOf, parseBackupName } from './backupName';

export const DRIVE_FOLDER_NAME = 'AlmaMesh backups';
const DRIVE_API_ORIGIN = 'https://www.googleapis.com';
const FILES_URL = `${DRIVE_API_ORIGIN}/drive/v3/files`;
const UPLOAD_URL = `${DRIVE_API_ORIGIN}/upload/drive/v3/files?uploadType=resumable&fields=id,name,size`;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const JSON_UTF8 = { 'Content-Type': 'application/json; charset=UTF-8' };
const READ_BACKOFF_MS = 250;

export interface GoogleDriveDeps {
  readonly getAccessToken: () => Promise<string>;
  readonly startConnect: (returnTo: string) => Promise<'connected' | 'redirecting'>;
  readonly isConnected: () => Promise<boolean>;
  readonly disconnect: () => Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxDownloadBytes?: number;
}

interface GoogleFileRecord {
  readonly id?: string;
  readonly name?: string;
  readonly size?: string | number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isOfflineNow = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

async function classifyGoogleError(res: Response): Promise<DriveError> {
  if (res.status === 401) return new DriveError('token_expired', 401);
  if (res.status === 404) return new DriveError('not_found', 404);
  if (res.status === 429) return new DriveError('rate_limited', 429);
  if (res.status === 403) {
    const text = await res.text().catch(() => '');
    if (/storageQuotaExceeded|quotaExceeded/i.test(text)) return new DriveError('quota_exceeded', 403);
    if (/rateLimitExceeded|userRateLimitExceeded/i.test(text)) return new DriveError('rate_limited', 403);
  }
  return new DriveError('provider_error', res.status);
}

function toDriveEntry(file: GoogleFileRecord): DriveBackupEntry | null {
  if (typeof file.id !== 'string' || typeof file.name !== 'string') return null;
  const meta = parseBackupName(file.name);
  if (meta === null) return null;
  const size = Number(file.size ?? 0);
  return { id: file.id, name: backupNameOf(file.name), meta, sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0 };
}

function assertGoogleUploadUrl(location: string | null): string {
  if (!location) throw new DriveError('provider_error');
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    throw new DriveError('provider_error');
  }
  if (parsed.origin !== DRIVE_API_ORIGIN) throw new DriveError('provider_error');
  return parsed.toString();
}

async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new DriveError('too_large');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new DriveError('too_large');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DriveError('too_large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

type AuthedFetch = (url: string, init: RequestInit, retryableRead: boolean) => Promise<Response>;

function createAuthedFetch(deps: GoogleDriveDeps): AuthedFetch {
  const fetchFn = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? defaultSleep;
  return async (url, init, retryableRead) => {
    const token = await deps.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    const send = () =>
      fetchFn(url, { ...init, headers }).catch(() => {
        throw new DriveError(isOfflineNow() ? 'offline' : 'provider_error');
      });
    let res = await send();
    if (retryableRead && (res.status === 429 || res.status >= 500)) {
      await sleep(READ_BACKOFF_MS);
      res = await send();
    }
    if (!res.ok) throw await classifyGoogleError(res);
    return res;
  };
}

async function resolveOrCreateFolder(authedFetch: AuthedFetch): Promise<string> {
  const q = `name='${DRIVE_FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const res = await authedFetch(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`, { method: 'GET' }, true);
  const existingId = ((await res.json()) as { files?: GoogleFileRecord[] }).files?.[0]?.id;
  if (typeof existingId === 'string' && existingId.length > 0) return existingId;
  const createRes = await authedFetch(
    `${FILES_URL}?fields=id`,
    { method: 'POST', headers: JSON_UTF8, body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME }) },
    false,
  );
  const createdId = ((await createRes.json()) as GoogleFileRecord).id;
  if (typeof createdId !== 'string' || createdId.length === 0) throw new DriveError('provider_error');
  return createdId;
}

async function runResumableUpload(
  authedFetch: AuthedFetch,
  folderId: string,
  name: BackupFileName,
  sealed: SealedBackup,
): Promise<DriveBackupEntry> {
  const headers = { ...JSON_UTF8, 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(sealed.bytes.byteLength) };
  const body = JSON.stringify({ name: name.value, parents: [folderId], mimeType: 'application/octet-stream' });
  const startRes = await authedFetch(UPLOAD_URL, { method: 'POST', headers, body }, false);
  const sessionUrl = assertGoogleUploadUrl(startRes.headers.get('Location'));
  const putRes = await authedFetch(sessionUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(sealed.bytes) }, false);
  const entry = toDriveEntry((await putRes.json()) as GoogleFileRecord);
  if (entry === null) throw new DriveError('provider_error');
  return entry;
}

export function createGoogleDrive(deps: GoogleDriveDeps): BackupDrive {
  const authedFetch = createAuthedFetch(deps);
  const maxBytes = deps.maxDownloadBytes ?? MAX_BACKUP_FILE_BYTES;
  let cachedFolderId: string | null = null;
  const folderId = async () => (cachedFolderId ??= await resolveOrCreateFolder(authedFetch));

  return {
    provider: 'google-drive',
    connect: (returnTo) => deps.startConnect(returnTo),
    isConnected: () => deps.isConnected(),
    list: async () => {
      const q = `'${await folderId()}' in parents and trashed=false`;
      const res = await authedFetch(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime)&pageSize=1000&spaces=drive`, { method: 'GET' }, true);
      const files = ((await res.json()) as { files?: GoogleFileRecord[] }).files ?? [];
      return files.map(toDriveEntry).filter((entry): entry is DriveBackupEntry => entry !== null);
    },
    upload: async (name, sealed) => runResumableUpload(authedFetch, await folderId(), name, sealed),
    download: async (id) => {
      const res = await authedFetch(`${FILES_URL}/${encodeURIComponent(id)}?alt=media`, { method: 'GET' }, true);
      return readBoundedBytes(res, maxBytes);
    },
    remove: async (id) => {
      await authedFetch(`${FILES_URL}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: JSON_UTF8, body: JSON.stringify({ trashed: true }) }, false);
    },
    disconnect: async () => {
      cachedFolderId = null;
      await deps.disconnect();
    },
  };
}
