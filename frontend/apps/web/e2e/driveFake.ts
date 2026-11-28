/**
 * Playwright `BrowserContext.route` responder for Google OAuth + Google Drive v3.
 * Shares one in-memory Drive across browser contexts so Browser A can back up
 * and Browser B (a brand-new device) can restore from the same Google account.
 */
import type { BrowserContext, Route } from '@playwright/test';

export interface E2eDriveLogEntry {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly bodyBytes: Buffer;
}

interface E2eDriveObject {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parents: string[];
  trashed: boolean;
  readonly bytes: Buffer;
}

interface PendingUploadMeta {
  readonly name: string;
  readonly parents: string[];
  readonly mimeType: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers':
    'authorization, content-type, accept, x-upload-content-type, x-upload-content-length',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
  'access-control-expose-headers': 'location',
  'cross-origin-resource-policy': 'cross-origin',
};

const jsonOk = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });

export interface SharedFakeGoogleDrive {
  readonly log: E2eDriveLogEntry[];
  readonly objects: Map<string, E2eDriveObject>;
  silentAuthCount: number;
  attach(context: BrowserContext): Promise<void>;
}

export function createSharedFakeGoogleDrive(): SharedFakeGoogleDrive {
  const log: E2eDriveLogEntry[] = [];
  const objects = new Map<string, E2eDriveObject>();
  const pendingUploads = new Map<string, PendingUploadMeta>();
  let nextSeq = 0;
  const mintId = (prefix: string) => `${prefix}-${(nextSeq += 1)}`;

  const handleUploadRoutes = async (route: Route, parsed: URL, method: string, buf: Buffer, bodyText: string) => {
    const uploadId = parsed.searchParams.get('upload_id');
    if (method === 'POST' && uploadId === null) {
      const meta = JSON.parse(bodyText) as { name: string; parents?: string[]; mimeType?: string };
      const id = mintId('session');
      pendingUploads.set(id, {
        name: meta.name,
        parents: meta.parents ?? [],
        mimeType: meta.mimeType ?? 'application/octet-stream',
      });
      const location = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`;
      await route.fulfill({ status: 200, headers: { ...CORS, location }, body: '' });
      return true;
    }
    if (method === 'PUT' && uploadId !== null) {
      const meta = pendingUploads.get(uploadId);
      if (!meta) {
        await route.fulfill({ status: 404, headers: CORS, body: '{}' });
        return true;
      }
      pendingUploads.delete(uploadId);
      const fileId = mintId('drive-file');
      objects.set(fileId, { id: fileId, ...meta, trashed: false, bytes: buf });
      await jsonOk(route, { id: fileId, name: meta.name, size: String(buf.byteLength) });
      return true;
    }
    return false;
  };

  const handleCollectionRoutes = async (route: Route, parsed: URL, method: string, bodyText: string) => {
    if (method === 'POST') {
      const meta = JSON.parse(bodyText) as { name: string; mimeType: string; parents?: string[] };
      const folderId = mintId('drive-folder');
      objects.set(folderId, {
        id: folderId,
        name: meta.name,
        mimeType: meta.mimeType,
        parents: meta.parents ?? [],
        trashed: false,
        bytes: Buffer.alloc(0),
      });
      await jsonOk(route, { id: folderId, name: meta.name });
      return true;
    }
    if (method === 'GET') {
      const q = parsed.searchParams.get('q') ?? '';
      const folderQuery = q.includes("mimeType='application/vnd.google-apps.folder'");
      const parentMatch = /'([^']+)' in parents/.exec(q);
      const files = [...objects.values()]
        .filter((o) => !o.trashed && (folderQuery ? o.mimeType === 'application/vnd.google-apps.folder' : true))
        .filter((o) => (parentMatch ? o.parents.includes(parentMatch[1]!) : true))
        .map((o) => ({ id: o.id, name: o.name, size: String(o.bytes.byteLength) }));
      await jsonOk(route, { files });
      return true;
    }
    return false;
  };

  const handleItemRoutes = async (route: Route, parsed: URL, method: string, id: string, bodyText: string) => {
    const obj = objects.get(id);
    if (!obj || obj.trashed) {
      await route.fulfill({ status: 404, headers: CORS, body: '{}' });
      return;
    }
    if (method === 'GET' && parsed.searchParams.get('alt') === 'media') {
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/octet-stream', body: obj.bytes });
      return;
    }
    if (method === 'PATCH') {
      if ((JSON.parse(bodyText) as { trashed?: boolean }).trashed === true) obj.trashed = true;
      await jsonOk(route, { id: obj.id, trashed: obj.trashed });
      return;
    }
    await route.fulfill({ status: 404, headers: CORS, body: '{}' });
  };

  const state: SharedFakeGoogleDrive = {
    log,
    objects,
    silentAuthCount: 0,
    async attach(context: BrowserContext) {
      await context.route('https://accounts.google.com/o/oauth2/v2/auth**', async (route: Route) => {
        const authUrl = new URL(route.request().url());
        if (authUrl.searchParams.get('prompt') === 'none') state.silentAuthCount += 1;
        const redirectUri = authUrl.searchParams.get('redirect_uri')!;
        const oauthState = authUrl.searchParams.get('state') ?? '';
        const token = mintId('ya29.e2e-token');
        const location = `${redirectUri}#access_token=${token}&token_type=Bearer&expires_in=3600&state=${encodeURIComponent(oauthState)}`;
        const html = `<!doctype html><script>window.location.replace(${JSON.stringify(location)});</script>`;
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      });

      await context.route('https://oauth2.googleapis.com/revoke**', async (route: Route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const buf = req.postDataBuffer() ?? Buffer.alloc(0);
        log.push({ method: req.method(), url: req.url(), headers: req.headers(), bodyText: buf.toString('utf8'), bodyBytes: buf });
        await jsonOk(route, {});
      });

      await context.route('https://www.googleapis.com/**', async (route: Route) => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const buf = req.postDataBuffer() ?? Buffer.alloc(0);
        const bodyText = buf.toString('utf8');
        log.push({ method: req.method(), url: req.url(), headers: req.headers(), bodyText, bodyBytes: buf });
        const parsed = new URL(req.url());
        if (parsed.pathname === '/upload/drive/v3/files' && (await handleUploadRoutes(route, parsed, req.method(), buf, bodyText))) return;
        if (parsed.pathname === '/drive/v3/files' && (await handleCollectionRoutes(route, parsed, req.method(), bodyText))) return;
        const itemMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(parsed.pathname);
        if (itemMatch !== null) return handleItemRoutes(route, parsed, req.method(), decodeURIComponent(itemMatch[1]!), bodyText);
        await route.fulfill({ status: 404, headers: CORS, body: '{}' });
      });
    },
  };
  return state;
}
