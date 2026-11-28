/**
 * In-memory Google Drive v3 + OAuth revoke HTTP responder and request recorder.
 * Drives both `googleDrive.test.ts` (contract + HTTP errors) and `driveEgress.test.ts`.
 */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyBytes: Uint8Array;
  readonly bodyText: string;
}

interface StoredGoogleObject {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  bytes: Uint8Array;
}

export interface FakeGoogleServer {
  readonly fetchImpl: typeof fetch;
  readonly requests: RecordedRequest[];
  readonly objects: Map<string, StoredGoogleObject>;
  readonly revokedTokens: string[];
  validToken: string;
  nextStatus: number | null;
  nextQuotaExceeded: boolean;
}

async function readBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  const res = new Response(body);
  return new Uint8Array(await res.arrayBuffer());
}

function jsonResponse(data: unknown, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function headerMap(raw?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  new Headers(raw).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function createFakeGoogleServer(initialToken: string = 'ya29.fake-token'): FakeGoogleServer {
  const requests: RecordedRequest[] = [];
  const objects = new Map<string, StoredGoogleObject>();
  const pendingUploads = new Map<string, { name: string; parents: string[]; mimeType: string }>();
  const revokedTokens: string[] = [];
  let seq = 0;

  const state: FakeGoogleServer = {
    requests,
    objects,
    revokedTokens,
    validToken: initialToken,
    nextStatus: null,
    nextQuotaExceeded: false,
    fetchImpl: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = headerMap(init.headers);
      const bodyBytes = await readBodyBytes(init.body);
      const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
      requests.push({ url, method, headers, bodyBytes, bodyText });

      if (url === 'https://oauth2.googleapis.com/revoke' && method === 'POST') {
        const token = new URLSearchParams(bodyText).get('token');
        if (token !== null) revokedTokens.push(token);
        return jsonResponse({});
      }

      if (headers.authorization !== `Bearer ${state.validToken}`) {
        return jsonResponse({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
      }
      if (state.nextQuotaExceeded) {
        state.nextQuotaExceeded = false;
        return jsonResponse({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, 403);
      }
      if (state.nextStatus !== null) {
        const forced = state.nextStatus;
        state.nextStatus = null;
        return jsonResponse({ error: { code: forced } }, forced);
      }

      const parsed = new URL(url);
      const sessionId = parsed.searchParams.get('upload_id');
      if (parsed.pathname === '/upload/drive/v3/files' && method === 'POST' && sessionId === null) {
        const meta = JSON.parse(bodyText) as { name: string; parents?: string[]; mimeType?: string };
        seq += 1;
        const uploadId = `up-${seq}`;
        pendingUploads.set(uploadId, {
          name: meta.name,
          parents: meta.parents ?? [],
          mimeType: meta.mimeType ?? 'application/octet-stream',
        });
        return new Response('', {
          status: 200,
          headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}` },
        });
      }
      if (parsed.pathname === '/upload/drive/v3/files' && method === 'PUT' && sessionId !== null) {
        const meta = pendingUploads.get(sessionId);
        if (meta === undefined) return jsonResponse({ error: { code: 404 } }, 404);
        pendingUploads.delete(sessionId);
        seq += 1;
        const id = `file-${seq}`;
        objects.set(id, { id, ...meta, trashed: false, bytes: bodyBytes });
        return jsonResponse({ id, name: meta.name, size: String(bodyBytes.byteLength) });
      }
      if (parsed.pathname === '/drive/v3/files' && method === 'POST') {
        const meta = JSON.parse(bodyText) as { name: string; mimeType: string; parents?: string[] };
        seq += 1;
        const id = `folder-${seq}`;
        objects.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? [], trashed: false, bytes: new Uint8Array(0) });
        return jsonResponse({ id, name: meta.name });
      }
      if (parsed.pathname === '/drive/v3/files' && method === 'GET') {
        const q = parsed.searchParams.get('q') ?? '';
        const folderQuery = q.includes("mimeType='application/vnd.google-apps.folder'");
        const parentMatch = /'([^']+)' in parents/.exec(q);
        const files = [...objects.values()]
          .filter((obj) => !obj.trashed)
          .filter((obj) => (folderQuery ? obj.mimeType === 'application/vnd.google-apps.folder' : true))
          .filter((obj) => (parentMatch ? obj.parents.includes(parentMatch[1]!) : true))
          .map((obj) => ({ id: obj.id, name: obj.name, size: String(obj.bytes.byteLength) }));
        return jsonResponse({ files });
      }
      const itemMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(parsed.pathname);
      if (itemMatch !== null) {
        const obj = objects.get(decodeURIComponent(itemMatch[1]!));
        if (obj === undefined || obj.trashed) return jsonResponse({ error: { code: 404 } }, 404);
        if (method === 'GET' && parsed.searchParams.get('alt') === 'media') {
          return new Response(new Uint8Array(obj.bytes), { status: 200 });
        }
        if (method === 'PATCH') {
          const patch = JSON.parse(bodyText) as { trashed?: boolean };
          if (patch.trashed === true) obj.trashed = true;
          return jsonResponse({ id: obj.id, trashed: obj.trashed });
        }
      }
      return jsonResponse({ error: { code: 404 } }, 404);
    },
  };
  return state;
}
