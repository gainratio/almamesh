// @vitest-environment node
//
// Locks the deploy-facing SEO files to the typed route source (routeHead.ts):
//   - public/sitemap.xml lists exactly the public canonicals
//   - public/robots.txt allows crawling, disallows every private prefix,
//     and points at the sitemap
//   - the IndexNow key file exists and matches the key the deploy workflow pings
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { cspFromHeadersFile } from '../lib/previewHeaders';
import { PUBLIC_ROUTE_HEADS, PRIVATE_ROUTE_PREFIXES, SITE_ORIGIN } from './routeHead';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../public');
const repoRoot = path.resolve(here, '../../../../..');
const appShellRoutes = [
  '/onboarding',
  '/dashboard',
  '/predictive',
  '/life/career',
  '/life/finances',
  '/life/health',
  '/life/relationships',
  '/life/spiritual',
  '/life/education',
  '/life/family',
  '/mesh',
  '/mesh/:memberId',
  '/rectify/:profileId',
  '/report',
  '/edit-birth-details',
  '/settings',
  '/settings/profile',
  '/settings/people',
  '/settings/ai',
  '/settings/preferences',
  '/settings/data',
] as const;

describe('public/sitemap.xml', () => {
  const xml = readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf-8');

  it('is a urlset with exactly the public canonicals', () => {
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.sort()).toEqual(PUBLIC_ROUTE_HEADS.map((h) => h.canonical).sort());
  });

  it('is well-formed XML (tags balance, single root)', () => {
    expect(xml.trimStart().startsWith('<?xml')).toBe(true);
    const opens = (xml.match(/<url>/g) ?? []).length;
    const closes = (xml.match(/<\/url>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(opens).toBe(PUBLIC_ROUTE_HEADS.length);
    expect((xml.match(/<urlset/g) ?? []).length).toBe(1);
  });
});

describe('public/robots.txt', () => {
  const robots = readFileSync(path.join(publicDir, 'robots.txt'), 'utf-8');

  it('has a wildcard group that allows crawling', () => {
    expect(robots).toMatch(/User-agent: \*\nAllow: \//);
  });

  it('disallows every private app prefix', () => {
    for (const prefix of PRIVATE_ROUTE_PREFIXES) {
      expect(robots, prefix).toContain(`Disallow: ${prefix}`);
    }
  });

  it('never disallows a public route', () => {
    for (const head of PUBLIC_ROUTE_HEADS) {
      if (head.path === '/') continue;
      expect(robots).not.toContain(`Disallow: ${head.path}`);
    }
  });

  it('points at the sitemap', () => {
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  it.each(['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot'])(
    'explicitly allows %s',
    (crawler) => {
      expect(robots).toMatch(new RegExp(`User-agent: ${crawler}\\nAllow: /(?:\\n|$)`));
    },
  );
});

describe('public/llms.txt', () => {
  it('provides factual product, privacy, source, and public-page context', () => {
    const llms = readFileSync(path.join(publicDir, 'llms.txt'), 'utf-8');
    expect(llms).toContain('# AlmaMesh');
    expect(llms).toContain('https://github.com/gainratio/almamesh');
    expect(llms).toContain('https://almamesh.com/privacy');
    expect(llms).toContain('browser');
    expect(llms).toContain('optional AI');
    expect(llms).not.toMatch(/guaranteed|scientifically proven|medical advice/i);
  });
});

// The repository lives at github.com/gainratio/almamesh since the 2026-10-07
// org transfer. Every public surface that names it must say so.
describe('public repository URL', () => {
  const publicSurfaces = [
    path.join(publicDir, '../index.html'),
    path.join(publicDir, 'llms.txt'),
    path.join(publicDir, '.well-known/security.txt'),
    path.join(here, '../components/features/landing/LandingFooter.tsx'),
    path.join(repoRoot, 'README.md'),
  ];

  it.each(publicSurfaces)('%s names gainratio/almamesh, never hseshadr/almamesh', (file) => {
    const text = readFileSync(file, 'utf-8');
    expect(text).toContain('github.com/gainratio/almamesh');
    expect(text).not.toContain('hseshadr/almamesh');
  });
});

describe('Cloudflare Pages route delivery', () => {
  const redirects = readFileSync(path.join(publicDir, '_redirects'), 'utf-8');

  it('rewrites every real client route without a blanket soft-404 fallback', () => {
    expect(redirects).not.toContain('/* /index.html 200');
    for (const route of appShellRoutes) {
      expect(redirects, route).toContain(`${route} / 200`);
    }
  });

  it('ships a branded noindex 404 document with one h1', () => {
    const notFound = readFileSync(path.join(publicDir, '404.html'), 'utf-8');
    expect(notFound).toMatch(/<meta[^>]+name=["']robots["'][^>]+content=["']noindex, nofollow["']/i);
    expect(notFound.match(/<h1(?:\s|>)/gi)).toHaveLength(1);
    expect(notFound).toContain('AlmaMesh');
    expect(notFound).toContain('href="/"');
  });

  it('limits the offline app-shell fallback to real routes', () => {
    const viteConfig = readFileSync(path.join(publicDir, '../vite.config.ts'), 'utf-8');
    expect(viteConfig).toContain('navigateFallbackAllowlist');
    expect(viteConfig).not.toContain('navigateFallbackDenylist');
  });
});

describe('Cloudflare Pages security headers', () => {
  const headers = readFileSync(path.join(publicDir, '_headers'), 'utf-8');

  const catchAllBlock = headers.match(/^\/\*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m)?.[1] ?? '';
  // The catch-all policy, parsed with the SAME helper `vite preview` uses, so a
  // policy these assertions accept is exactly the policy the browser is served.
  const csp = cspFromHeadersFile(headers);

  it('enforces a Pyodide, worker, Turnstile, and BYO-endpoint compatible CSP', () => {
    expect(headers).toContain('Content-Security-Policy:');
    expect(headers).toContain("script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com");
    expect(headers).toContain("worker-src 'self' blob:");
    expect(headers).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(headers).not.toMatch(/connect-src[^\n]*\b(?:ws|wss):/);
    expect(headers).toContain("font-src 'self' data:");
  });

  // --- connect-src IS the privacy claim ---------------------------------------
  // "Your data never leaves the device" is only true if the browser refuses to
  // send it anywhere else. `connect-src` was `'self' https: http:`, which allows
  // a fetch to ANY origin (cleartext included) — present, but measuring nothing.
  // These assertions pin the CLOSED allowlist so a future edit cannot quietly
  // reopen it. Adding a destination is a deliberate act: extend `allowed` here,
  // extend the rationale block in public/_headers, and extend the README egress
  // table (repositoryTruth.test.ts holds that end).
  it('confines connect-src to a closed allowlist of declared destinations', () => {
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1].trim();
    expect(connectSrc, 'the catch-all CSP must declare connect-src').toBeDefined();

    const allowed = [
      "'self'", //                              own origin: engine assets, /api/feedback
      'https://openrouter.ai', //               opt-in BYO-key cloud LLM
      'https://geocoding-api.open-meteo.com', // declared city-typeahead egress
      'http://localhost:*', //                  loopback LLM, any port (still on-device)
      'http://127.0.0.1:*', //                  same, explicit IPv4 form
    ];
    expect(connectSrc!.split(/\s+/)).toEqual(allowed);
  });

  // The finding this file exists to close. A wildcard scheme or host in ANY
  // fetch-directive re-opens arbitrary egress even if connect-src looks tidy.
  it('permits no wildcard scheme or host in any egress directive', () => {
    for (const directive of ['connect-src', 'default-src', 'script-src', 'frame-src', 'img-src']) {
      const value = csp.match(new RegExp(`${directive} ([^;]+)`))?.[1] ?? '';
      expect(value, `${directive} must not allow a bare scheme`).not.toMatch(
        /(?:^|\s)(?:https?|ws|wss|ftp):(?:\s|$)/,
      );
      expect(value, `${directive} must not allow a wildcard host`).not.toMatch(/(?:^|\s)\*(?:\s|$)/);
    }
  });

  it('upgrades any stray cleartext subresource', () => {
    expect(csp).toContain('upgrade-insecure-requests');
  });

  // SQLite's shared OPFS Web-Locks VFS needs SharedArrayBuffer, so the deployed
  // app must be cross-origin isolated. `require-corp` has broader browser support
  // than `credentialless`; every shipped cross-origin resource is separately
  // covered by CORS/CORP and exercised in the browser integration gate.
  it('enables cross-origin isolation with the portable COOP/COEP pair', () => {
    expect(catchAllBlock).toMatch(/^\s*Cross-Origin-Opener-Policy:\s*same-origin\s*$/m);
    expect(catchAllBlock).toMatch(
      /^\s*Cross-Origin-Embedder-Policy:\s*require-corp\s*$/m,
    );
    expect(catchAllBlock).not.toMatch(
      /^\s*Cross-Origin-Embedder-Policy:\s*(?:credentialless|unsafe-none)\s*$/m,
    );
  });

  it('does not expose the application shell through wildcard CORS', () => {
    expect(catchAllBlock).toContain('! Access-Control-Allow-Origin');
    expect(catchAllBlock).not.toMatch(/^\s*Access-Control-Allow-Origin:/m);
  });

  it('enforces HTTPS after first secure contact', () => {
    expect(headers).toMatch(/Strict-Transport-Security:\s*max-age=\d+/);
  });

  it('disables browser capabilities the app does not use', () => {
    expect(headers).toMatch(/Permissions-Policy:/);
    for (const capability of ['camera=()', 'geolocation=()', 'microphone=()', 'payment=()']) {
      expect(headers, capability).toContain(capability);
    }
  });

  it('prevents edge transforms from injecting third-party scripts into app HTML', () => {
    expect(catchAllBlock).not.toBe('');
    expect(catchAllBlock).toContain('Cache-Control: public, no-cache, no-transform');
  });
});

// RFC 9116. Lives in public/.well-known/ so Vite copies it verbatim and Pages
// serves it at /.well-known/security.txt (build-prod.sh asserts it reached dist,
// which is what proves Vite copies the DOTFILE directory at all).
describe('security.txt', () => {
  const securityTxt = readFileSync(path.join(publicDir, '.well-known/security.txt'), 'utf-8');
  const field = (name: string): string | undefined =>
    securityTxt.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim();

  it('publishes a reachable contact and the policy it points at', () => {
    expect(field('Contact')).toBe('mailto:harish.seshadri@gmail.com');
    expect(readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf-8')).toContain(
      'harish.seshadri@gmail.com',
    );
    expect(field('Policy')).toBe('https://github.com/gainratio/almamesh/blob/main/SECURITY.md');
    expect(field('Canonical')).toBe(`${SITE_ORIGIN}/.well-known/security.txt`);
  });

  // Deliberate tripwire: RFC 9116 makes `Expires` mandatory, and an expired
  // security.txt is a contact nobody is required to honour. This test goes red
  // when the date passes — that is the renewal reminder, not a flake. Bump the
  // date in public/.well-known/security.txt by a year to clear it.
  it('carries an Expires date that has not passed', () => {
    const expires = field('Expires');
    expect(expires, 'RFC 9116 requires an Expires field').toBeDefined();
    const expiry = new Date(expires!);
    expect(Number.isNaN(expiry.getTime()), `Expires must be ISO-8601, got ${expires}`).toBe(false);
    expect(
      expiry.getTime() > Date.now(),
      `security.txt expired on ${expires} — re-confirm the contact and bump it a year`,
    ).toBe(true);
  });
});

describe('HTML heading contract', () => {
  it('does not add a second h1 from the noscript fallback', () => {
    const template = readFileSync(path.join(publicDir, '../index.html'), 'utf-8');
    const noscript = template.match(/<noscript>([\s\S]*?)<\/noscript>/i)?.[1] ?? '';
    expect(noscript).not.toMatch(/<h1(?:\s|>)/i);
  });
});

describe('IndexNow key', () => {
  const keyFiles = readdirSync(publicDir).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));

  it('exactly one key file exists and contains its own key', () => {
    expect(keyFiles).toHaveLength(1);
    const key = keyFiles[0].replace(/\.txt$/, '');
    expect(readFileSync(path.join(publicDir, keyFiles[0]), 'utf-8').trim()).toBe(key);
  });

  it('the Dagger deploy pings api.indexnow.org, deriving the key from the shipped file', () => {
    const delivery = readFileSync(
      path.join(repoRoot, 'dagger/src/index.ts'),
      'utf-8',
    );
    const proof = readFileSync(
      path.join(repoRoot, 'dagger/src/deployment.ts'),
      'utf-8',
    );
    expect(delivery).toContain('return releaseIndexNowScript(artifact)');
    expect(proof).toContain('fetch("https://api.indexnow.org/indexnow"');
    expect(proof).toContain('AbortSignal.timeout(${timeoutMs})');
    expect(proof).toContain('redirect: "error"');
    // No key literal in delivery code (gitleaks false-positives on inline hex
    // keys): it must derive the key from the key file shipped in public/.
    expect(proof).toContain("find ${shellQuote(artifact)} -maxdepth 1 -type f -name '????????????????????????????????.txt'");
    const key = keyFiles[0].replace(/\.txt$/, '');
    expect(`${delivery}\n${proof}`).not.toContain(key);
    for (const head of PUBLIC_ROUTE_HEADS) {
      expect(proof, head.canonical).toContain(head.canonical);
    }
    // Non-fatal by contract: the ping must never break a deploy.
    expect(proof).toContain('|| echo "IndexNow notification failed (non-fatal)" >&2');
    expect(proof).not.toContain('curl');
    expect(`${delivery}\n${proof}`).not.toContain('wrangler pages deploy');
    expect(`${delivery}\n${proof}`).not.toContain('verify-pages-source.mjs');
  });
});
