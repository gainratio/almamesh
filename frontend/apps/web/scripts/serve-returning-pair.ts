#!/usr/bin/env bun
/**
 * Two local production origins for the returning-visitor live smoke, so the
 * old -> new upgrade path can be driven BEFORE a deploy instead of discovered
 * by the post-deploy smoke (which rolls production back when it fails).
 *
 *   PREVIOUS  http://localhost:4311  <- OLD_DIST  (the build that is live now)
 *   LIVE      http://localhost:4310  <- NEW_DIST  (the build about to deploy)
 *
 * Same headers, caching and SPA fallback as e2e/swUpdateServer.ts (COOP/COEP
 * from `_headers`, immutable `/assets/*`, revalidated everything else). Two
 * knobs reproduce a slow CI runner link, where the deploy of fe5b447c failed
 * on 2026-10-01 while the same upgrade settled in 20 s on a fast one:
 *
 *   SLOW_PATH_PREFIXES=/pyodide/v314.0.7/pyodide.asm.wasm SLOW_BPS=60000 SLOW_ORIGINS=live
 *       stream matching responses at SLOW_BPS bytes/s (per stream; SLOW_SHARED=1
 *       shares one link; SLOW_ORIGINS picks `live`, `previous` or `both`).
 *       Pyodide's wasm has no app-side fetch timeout, so a worker's CacheFirst
 *       fetch of it stays in flight for the whole transfer -- the in-flight
 *       work that defers activation of the new worker. Throttle the live
 *       origin only: a previous build that cannot finish booting (its boot
 *       deadline restarts the download) fails the pass at its precondition,
 *       which is a different, explicit failure.
 *   DELAY_PATH_PREFIXES=/assets/ DELAY_MS=1000
 *       LIVE origin only: a round-trip per precache entry, so the new worker's
 *       install takes seconds (as over the CDN) instead of milliseconds.
 *
 * Run (from apps/web, both dists built with hooks off and ONE public.key):
 *
 *   OLD_DIST=/path/to/old/dist NEW_DIST=$PWD/dist bun scripts/serve-returning-pair.ts &
 *   LIVE_SMOKE_ORIGIN=http://localhost:4310 LIVE_SMOKE_PREVIOUS_URL=http://localhost:4311 \
 *     bun run test:e2e:live-smoke --grep @returning
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { browserIsolationHeadersFromHeadersFile, cspForLocalHttpPreview } from '../src/lib/previewHeaders';

const OLD_DIST = process.env.OLD_DIST;
const NEW_DIST = process.env.NEW_DIST;
if (!OLD_DIST || !NEW_DIST) {
  console.error('OLD_DIST and NEW_DIST (two production build directories) are required');
  process.exit(2);
}
// Both builds must be signed with ONE public key, as every production deploy
// is. The key's hash names `engine-trust-config-<hash>.js`, which each sw.js
// pulls in with importScripts. Chromium's register()-time update check fetches
// the NEW sw.js outside the Playwright proxy during the previous visit, and
// its imports then go through the proxy to the OLD build: a different key
// 404s the import, the worker still reaches `installed` without its module
// body (no fetch handler, no SKIP_WAITING listener), and the upgrade hangs on
// a worker production never produces. Refuse the pair rather than measure it.
if (!readFileSync(path.join(OLD_DIST, 'public.key')).equals(readFileSync(path.join(NEW_DIST, 'public.key')))) {
  console.error('OLD_DIST and NEW_DIST must share public.key (copy public/public.key + public/bundle before building the newer one)');
  process.exit(2);
}
const PREV_PORT = Number(process.env.PREV_PORT ?? 4311);
const LIVE_PORT = Number(process.env.LIVE_PORT ?? 4310);
const SLOW_PREFIXES = (process.env.SLOW_PATH_PREFIXES ?? '').split(',').filter(Boolean);
const SLOW_BPS = Number(process.env.SLOW_BPS ?? 0);
const SLOW_SHARED = process.env.SLOW_SHARED === '1';
/** Which origin(s) the throttle applies to: `both` (default), `live` or `previous`. */
const SLOW_ORIGINS = process.env.SLOW_ORIGINS ?? 'both';
const DELAY_PREFIXES = (process.env.DELAY_PATH_PREFIXES ?? '').split(',').filter(Boolean);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const TICK_MS = 100;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.whl': 'application/octet-stream',
  '.zip': 'application/zip',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

/** A real file wins, then the flat prerendered route, then the SPA shell (as Pages does). */
function resolveFile(root: string, pathname: string): string | null {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const direct = path.join(root, relative);
  if (!direct.startsWith(root)) return null;
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const flat = `${direct.replace(/[/\\]$/, '')}.html`;
  if (existsSync(flat) && statSync(flat).isFile()) return flat;
  return path.extname(relative) ? null : path.join(root, 'index.html');
}

interface SlowStream {
  label: string;
  pathname: string;
  body: Buffer;
  offset: number;
  res: import('node:http').ServerResponse;
  startedAt: number;
}
const streams = new Set<SlowStream>();
const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(0)}s`;

setInterval(() => {
  if (streams.size === 0) return;
  const perStream = Math.max(1, Math.floor(SLOW_BPS / (1000 / TICK_MS) / (SLOW_SHARED ? streams.size : 1)));
  for (const stream of streams) {
    if (stream.res.destroyed) {
      streams.delete(stream);
      console.log(`[${stream.label}] slow ${stream.pathname} aborted at ${stream.offset}/${stream.body.length}B (${elapsed()})`);
      continue;
    }
    const end = Math.min(stream.offset + perStream, stream.body.length);
    stream.res.write(stream.body.subarray(stream.offset, end));
    stream.offset = end;
    if (stream.offset >= stream.body.length) {
      stream.res.end();
      streams.delete(stream);
      console.log(`[${stream.label}] slow ${stream.pathname} ${stream.body.length}B done in ${Date.now() - stream.startedAt}ms (${elapsed()})`);
    }
  }
}, TICK_MS).unref();

async function serve(root: string, port: number, label: 'previous' | 'live'): Promise<void> {
  const headersFile = await readFile(path.join(root, '_headers'), 'utf8');
  const csp = cspForLocalHttpPreview(headersFile);
  const isolation = browserIsolationHeadersFromHeadersFile(headersFile);
  const base = {
    'cross-origin-opener-policy': isolation['Cross-Origin-Opener-Policy'],
    'cross-origin-embedder-policy': isolation['Cross-Origin-Embedder-Policy'],
  };
  const server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    const file = resolveFile(root, pathname);
    if (!file) {
      res.writeHead(404, { ...base, 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    readFile(file).then(
      (body) => {
        const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const headers: Record<string, string> = {
          ...base,
          'content-type': type,
          'cache-control': /[/\\]assets[/\\]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
          'content-length': String(body.length),
        };
        if (type.startsWith('text/html')) headers['content-security-policy'] = csp;
        const slow =
          SLOW_BPS > 0 &&
          (SLOW_ORIGINS === 'both' || SLOW_ORIGINS === label) &&
          SLOW_PREFIXES.some((prefix) => pathname.startsWith(prefix));
        const delayed = label === 'live' && DELAY_MS > 0 && DELAY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
        if (slow) {
          res.writeHead(200, headers);
          console.log(`[${label}] slow ${pathname} ${body.length}B started (${elapsed()}, ${streams.size + 1} in flight)`);
          streams.add({ label, pathname, body, offset: 0, res, startedAt: Date.now() });
          return;
        }
        const send = () => {
          res.writeHead(200, headers);
          res.end(body);
        };
        if (delayed) setTimeout(send, DELAY_MS);
        else send();
      },
      () => {
        res.writeHead(500, { ...base, 'content-type': 'text/plain' });
        res.end('read error');
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`[${label}] http://localhost:${port} <- ${root}`);
}

await serve(OLD_DIST, PREV_PORT, 'previous');
await serve(NEW_DIST, LIVE_PORT, 'live');
console.log(
  `READY${SLOW_BPS ? ` slow ${SLOW_PREFIXES.join(',')} @ ${SLOW_BPS} B/s${SLOW_SHARED ? ' shared' : ''}` : ''}${
    DELAY_MS ? ` live-delay ${DELAY_PREFIXES.join(',')} ${DELAY_MS} ms` : ''
  }`,
);
setInterval(() => undefined, 1 << 30);
