// A two-build static origin for the service-worker update gate.
//
// WHY this exists instead of `vite preview`: the gate has to simulate a DEPLOY
// while a browser is already running the previous build — same origin, same
// URLs, different bytes. `vite preview` serves one `dist` from one process and
// cannot do that. This server serves whichever build directory it currently
// points at, and the spec flips that pointer mid-test (`deploy()`).
//
// It mirrors the three Cloudflare Pages behaviours the update path depends on:
//   - `sw.js`, `version.json` and HTML are revalidated (`no-cache`), so the
//     browser really re-fetches them and can notice a new worker;
//   - `/assets/*` is immutable, exactly as production serves content-hashed
//     chunks — so a stale client keeps its old chunks unless the SW changes;
//   - documents carry the production CSP enforcement directives (minus the
//     HTTPS-only upgrade directive on this local HTTP origin), and every
//     response carries the production COOP/COEP pair, parsed out of
//     `public/_headers` (plain static servers omit these headers and cannot
//     exercise SharedArrayBuffer/OPFS).

import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  browserIsolationHeadersFromHeadersFile,
  cspForLocalHttpPreview,
} from '../src/lib/previewHeaders';

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
};

/** Content-hashed assets are immutable in production; everything else revalidates. */
function cacheControl(filePath: string): string {
  return /[/\\]assets[/\\]/.test(filePath)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

/**
 * Map a request path to a file the way Cloudflare Pages does for this site:
 * a real file wins, then the flat prerendered route (`/welcome` ->
 * `welcome.html`), then the SPA fallback shell.
 */
function resolveFile(root: string, pathname: string): string | null {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const direct = path.join(root, relative);
  if (!direct.startsWith(root)) {
    return null; // path traversal
  }
  if (existsSync(direct) && statSync(direct).isFile()) {
    return direct;
  }
  const flat = `${direct.replace(/[/\\]$/, '')}.html`;
  if (existsSync(flat) && statSync(flat).isFile()) {
    return flat;
  }
  return path.extname(relative) ? null : path.join(root, 'index.html');
}

const TRICKLE_TICK_MS = 500;

/** Write a small body in ticks so the response stays open for `durationMs`. */
function trickle(res: ServerResponse, headers: Record<string, string>, durationMs: number): void {
  res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'cache-control': 'no-cache' });
  const ticks = Math.max(1, Math.ceil(durationMs / TRICKLE_TICK_MS));
  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    res.write(Buffer.alloc(1024));
    if (sent >= ticks) {
      clearInterval(timer);
      res.end();
    }
  }, TRICKLE_TICK_MS);
  res.on('close', () => clearInterval(timer));
}

export interface TwoBuildServer {
  readonly origin: string;
  /** Point the origin at a different build directory — i.e. ship a deploy. */
  deploy(buildDir: string): void;
  /**
   * Simulate a deploy that differs only in response headers and service-worker
   * bytes (the returning-visitor COEP gate): `isolation: false` drops the
   * COOP/COEP pair, and `rewriteServiceWorker` rewrites the served sw.js so the
   * browser sees a distinct service worker without a second build (pass null
   * to serve the build's sw.js unchanged).
   */
  configure(options: {
    isolation?: boolean;
    rewriteServiceWorker?: ((source: string) => string) | null;
  }): void;
  /**
   * Serve `pathname` as a 200 body that trickles out over `durationMs`. Under
   * a CacheFirst route (`/pyodide/*`), the active worker's fetch event stays
   * alive until the whole body is cached: the busy engine download that
   * defers activation of a waiting worker on a slow link.
   */
  slowBody(pathname: string, durationMs: number): void;
  close(): Promise<void>;
}

/** Start the origin serving `initialBuildDir` on `port`. */
export async function startTwoBuildServer(
  initialBuildDir: string,
  port: number,
): Promise<TwoBuildServer> {
  let root = initialBuildDir;
  let isolation = true;
  let rewriteServiceWorker: ((source: string) => string) | null = null;
  const slowBodies = new Map<string, number>();
  const headersFile = await readFile(path.join(initialBuildDir, '_headers'), 'utf8');
  const csp = cspForLocalHttpPreview(headersFile);
  const isolationHeaders = browserIsolationHeadersFromHeadersFile(headersFile);
  const isolatedHeaders = {
    'cross-origin-opener-policy': isolationHeaders['Cross-Origin-Opener-Policy'],
    'cross-origin-embedder-policy': isolationHeaders['Cross-Origin-Embedder-Policy'],
  };

  const server: Server = createServer((req, res) => {
    const baseHeaders = isolation ? isolatedHeaders : {};
    const pathname = (req.url ?? '/').split('?')[0];
    const slowMs = slowBodies.get(pathname);
    if (slowMs !== undefined) {
      trickle(res, baseHeaders, slowMs);
      return;
    }
    const file = resolveFile(root, pathname);
    if (!file) {
      res.writeHead(404, { ...baseHeaders, 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    readFile(file).then(
      (body) => {
        const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        const headers: Record<string, string> = {
          ...baseHeaders,
          'content-type': type,
          'cache-control': cacheControl(file),
        };
        if (type.startsWith('text/html')) {
          headers['content-security-policy'] = csp;
        }
        res.writeHead(200, headers);
        res.end(path.basename(file) === 'sw.js' && rewriteServiceWorker
          ? rewriteServiceWorker(body.toString('utf8'))
          : body);
      },
      () => {
        res.writeHead(500, { ...baseHeaders, 'content-type': 'text/plain' });
        res.end('read error');
      },
    );
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    origin: `http://localhost:${port}`,
    deploy(buildDir: string) {
      root = buildDir;
    },
    configure(options) {
      isolation = options.isolation ?? isolation;
      if (options.rewriteServiceWorker !== undefined) rewriteServiceWorker = options.rewriteServiceWorker;
    },
    slowBody(pathname, durationMs) {
      slowBodies.set(pathname, durationMs);
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
