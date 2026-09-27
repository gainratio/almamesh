import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRECACHE_HEADER_SOURCES,
  keyPrecacheByResponseHeaders,
  readPrecacheHeaderSources,
  responseHeadersKey,
} from '../precacheHeadersKey';

const WEB_ROOT = resolve(__dirname, '../../..');
const ISOLATED = '/*\n  Cross-Origin-Embedder-Policy: require-corp\n';

describe('responseHeadersKey', () => {
  it('pins the algorithm: sha256 of the JSON [path, content] list, first 16 hex', () => {
    // Computed independently: python3 hashlib.sha256(json.dumps(..., separators=(",",":")))
    expect(responseHeadersKey([{ path: 'public/_headers', content: ISOLATED }])).toBe('527fd22861a36689');
  });

  it('is stable for the same headers', () => {
    const a = responseHeadersKey([{ path: 'public/_headers', content: ISOLATED }]);
    const b = responseHeadersKey([{ path: 'public/_headers', content: `${ISOLATED}` }]);
    expect(a).toBe(b);
  });

  it('changes when any header source changes', () => {
    const before = responseHeadersKey([{ path: 'public/_headers', content: '/*\n  X-Frame-Options: DENY\n' }]);
    expect(responseHeadersKey([{ path: 'public/_headers', content: ISOLATED }])).not.toBe(before);
  });
});

describe('keyPrecacheByResponseHeaders', () => {
  it('salts EVERY entry, including content-hashed ones Workbox leaves unrevisioned', () => {
    const salted = keyPrecacheByResponseHeaders(
      [
        { url: 'assets/chartWorker-CFKr72v0.js', revision: null, size: 1 },
        { url: '/', revision: 'abc123', size: 2 },
      ],
      '527fd22861a36689',
    );
    expect(salted).toEqual([
      { url: 'assets/chartWorker-CFKr72v0.js', revision: 'headers-527fd22861a36689', size: 1 },
      { url: '/', revision: 'abc123.headers-527fd22861a36689', size: 2 },
    ]);
  });
});

describe('the real header sources', () => {
  it('hashes public/_headers, the only file that sets response headers today', () => {
    expect(PRECACHE_HEADER_SOURCES).toEqual(['public/_headers']);
    const sources = readPrecacheHeaderSources(WEB_ROOT);
    expect(sources.map((s) => s.path)).toEqual(['public/_headers']);
    expect(sources[0].content).toContain('Cross-Origin-Embedder-Policy: require-corp');
  });

  it('has no Pages middleware or advanced-mode worker that could also rewrite headers', () => {
    // If one of these appears it changes response headers too: add it to
    // PRECACHE_HEADER_SOURCES so a change to it re-keys the precache.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(resolve(dir, e.name)) : [e.name],
      );
    expect(walk(resolve(WEB_ROOT, 'functions')).filter((name) => name.startsWith('_middleware'))).toEqual([]);
    expect(existsSync(resolve(WEB_ROOT, 'public/_worker.js'))).toBe(false);
  });
});
