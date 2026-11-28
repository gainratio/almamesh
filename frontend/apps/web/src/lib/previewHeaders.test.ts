// @vitest-environment node
//
// Locks the parser that lifts the production Content-Security-Policy out of
// `public/_headers` (the Cloudflare Pages header file) for `vite preview`.
//
// WHY THIS EXISTS: in production Cloudflare parses `_headers`; plain
// `vite preview` serves NO CSP, so every preview-driven e2e lane used to run
// with a materially looser policy than production. A CSP-blocked fetch (the
// yoga-layout data:-URI wasm fetch) sailed through CI green and only surfaced
// as console errors on almamesh.com. `previewProdBrowserHeadersPlugin` in
// vite.config.ts applies the REAL headers to preview responses; this test pins the parse
// against the real file so drift fails loudly.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  browserIsolationHeadersFromHeadersFile,
  cspForLocalHttpPreview,
  cspFromHeadersFile,
} from './previewHeaders';

const here = path.dirname(fileURLToPath(import.meta.url));
const headersPath = path.resolve(here, '../../public/_headers');

describe('cspFromHeadersFile', () => {
  it('extracts the production CSP from the real public/_headers', () => {
    const csp = cspFromHeadersFile(readFileSync(headersPath, 'utf-8'));
    expect(csp.startsWith("default-src 'self'")).toBe(true);
    // The clause whose absence of `data:` makes the yoga wasm regression
    // reproducible under preview — the whole point of applying CSP there.
    // (The exact allowlist is pinned in __tests__/securityHeaders.test.ts; here
    // we only assert the parser lifted a real, closed connect-src.)
    expect(csp).toContain("connect-src 'self' https://openrouter.ai");
    expect(csp).not.toContain('\n');
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1]?.trim().split(/\s+/);
    expect(connectSrc).toEqual([
      "'self'",
      'https://openrouter.ai',
      'https://geocoding-api.open-meteo.com',
      'https://www.googleapis.com',
      'https://oauth2.googleapis.com',
      'http://localhost:*',
      'http://127.0.0.1:*',
    ]);
  });

  it('ignores detach markers and unrelated headers inside the catch-all block', () => {
    const csp = cspFromHeadersFile(
      [
        '/*',
        '  ! Access-Control-Allow-Origin',
        '  X-Frame-Options: DENY',
        "  Content-Security-Policy: default-src 'self'",
        '',
      ].join('\n'),
    );
    expect(csp).toBe("default-src 'self'");
  });

  it('only reads the catch-all /* block, never a path-specific one', () => {
    expect(() =>
      cspFromHeadersFile(
        ['/assets/*', "  Content-Security-Policy: default-src 'none'", ''].join('\n'),
      ),
    ).toThrow(/\/\*/);
  });

  it('fails loudly when the catch-all block lacks a CSP', () => {
    expect(() => cspFromHeadersFile(['/*', '  X-Frame-Options: DENY', ''].join('\n'))).toThrow(
      /Content-Security-Policy/,
    );
  });

  it('removes only upgrade-insecure-requests for local HTTP preview', () => {
    const production = cspFromHeadersFile(readFileSync(headersPath, 'utf-8'));
    const localPreview = cspForLocalHttpPreview(readFileSync(headersPath, 'utf-8'));
    expect(production).toContain('upgrade-insecure-requests');
    expect(localPreview).not.toContain('upgrade-insecure-requests');
    expect(localPreview).toContain("connect-src 'self' https://openrouter.ai");
    expect(localPreview).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });
});

describe('browserIsolationHeadersFromHeadersFile', () => {
  it('extracts the production COOP/COEP pair from the real public/_headers', () => {
    expect(
      browserIsolationHeadersFromHeadersFile(readFileSync(headersPath, 'utf-8')),
    ).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
  });

  it('fails closed when either isolation header is missing or unsafe', () => {
    const base = [
      '/*',
      '  Cross-Origin-Opener-Policy: same-origin',
      '  Cross-Origin-Embedder-Policy: require-corp',
      '',
    ];
    expect(() => browserIsolationHeadersFromHeadersFile(base.slice(0, 2).join('\n'))).toThrow(
      /Cross-Origin-Embedder-Policy/,
    );
    expect(() =>
      browserIsolationHeadersFromHeadersFile(
        base.join('\n').replace('require-corp', 'unsafe-none'),
      ),
    ).toThrow(/require-corp/);
  });
});
