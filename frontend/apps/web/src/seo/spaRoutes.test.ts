/**
 * Every client route must survive a refresh.
 *
 * Cloudflare Pages serves the SPA shell only for paths listed in
 * public/_redirects; everything else gets the real 404.html. A route that is
 * registered in the router but missing from _redirects works when you click to
 * it and 404s when you reload it or open a shared link. /onboarding/ai and
 * /life/obstacles shipped that way.
 *
 * The route list here is DERIVED from the router source (App.tsx, parsed with
 * the TypeScript compiler), never hand-copied, so a new <Route> without a
 * rewrite fails this file. The same goes for the service worker's offline
 * fallback allowlist.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { LIFE_DOMAINS } from '../lib/lifeAtlas';
import { PUBLIC_ROUTE_PATHS } from './routeHead';
import { SPA_FALLBACK_ALLOWLIST } from './spaRoutes';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(path.resolve(here, '../App.tsx'), 'utf-8');
const redirects = readFileSync(path.resolve(here, '../../public/_redirects'), 'utf-8');

function routePathAttr(node: ts.JsxOpeningLikeElement): string | null {
  if (node.tagName.getText() !== 'Route') return null;
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === 'path' && prop.initializer && ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
  }
  return null;
}

function joinRoute(parent: string, child: string): string {
  if (child.startsWith('/')) return child;
  return `${parent.replace(/\/$/, '')}/${child}`;
}

/** Every `<Route path>` in App.tsx, nested paths resolved against their parent. */
function routerPaths(source: string): string[] {
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node, parent: string): void => {
    if (ts.isJsxSelfClosingElement(node)) {
      const own = routePathAttr(node);
      if (own !== null) found.push(joinRoute(parent, own));
    }
    if (ts.isJsxElement(node)) {
      const own = routePathAttr(node.openingElement);
      const base = own === null ? parent : joinRoute(parent, own);
      if (own !== null) found.push(base);
      node.children.forEach((child) => visit(child, base));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, parent));
  };
  visit(file, '');
  return found;
}

/** Concrete URLs a person can land on for one router path. */
function samplesFor(route: string): string[] {
  if (route.includes(':domain')) return LIFE_DOMAINS.map((d) => route.replace(':domain', d));
  return [route.replace(/:[A-Za-z]+/g, 'sample-id')];
}

/** Cloudflare `_redirects` source patterns: `:name` is one segment, `*` a splat. */
function rewriteSources(text: string): RegExp[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter(([, to, status]) => to === '/' && status === '200')
    .map(([from]) => {
      const body = from
        .split('/')
        .map((seg) => (seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
      return new RegExp(`^${body}$`);
    });
}

const clientRoutes = routerPaths(appSource).filter((route) => route !== '*' && !route.endsWith('/*'));
const shellUrls = clientRoutes.filter((route) => !PUBLIC_ROUTE_PATHS.includes(route)).flatMap(samplesFor);
const rules = rewriteSources(redirects);

describe('client routes survive a refresh', () => {
  it('reads the routes from the router itself (parser sanity)', () => {
    expect(clientRoutes).toContain('/onboarding/ai');
    expect(clientRoutes).toContain('/settings/data');
    expect(clientRoutes).toContain('/life/:domain');
    expect(clientRoutes).toContain('/how-we-test');
    expect(shellUrls).toContain('/life/obstacles');
  });

  it.each(shellUrls)('%s has a _redirects rewrite to the app shell', (url) => {
    expect(rules.some((rule) => rule.test(url)), url).toBe(true);
  });

  it.each(shellUrls)('%s is in the service worker offline fallback allowlist', (url) => {
    expect(SPA_FALLBACK_ALLOWLIST.some((rule) => rule.test(url)), url).toBe(true);
  });

  it('does not let the offline fallback swallow an unknown address', () => {
    for (const url of ['/nope', '/life/astrology', '/settings/secret', '/onboarding/other']) {
      expect(SPA_FALLBACK_ALLOWLIST.some((rule) => rule.test(url)), url).toBe(false);
    }
  });
});
