/**
 * Spec 064 — the build-time prerender entry vite-prerender-plugin executes IN
 * NODE during `vite build` (see vite.config.ts). It renders ONLY the public
 * marketing/legal shells to static HTML:
 *
 *   /              the landing (no-chart state — exactly what a crawler sees)
 *   /welcome       the full explanatory landing, stable/shareable
 *   /privacy /terms /data-deletion   the legal pages
 *   /how-we-test     how readings are tested (aggregates only)
 *
 * It deliberately does NOT render `App.tsx` / `AppLayout` / the runtime
 * provider: the engine, workers, and OPFS are browser-only and the private
 * routes stay client-rendered. `usePrewarmEngineOnIntent` (landing CTAs) needs
 * a ChartEngineContext, so a no-op stub is provided — type-only imports keep
 * `@almamesh/browser` runtime code OUT of this graph.
 *
 * Hydration is intentionally NOT used: `main.tsx` keeps `createRoot().render()`
 * which replaces the prerendered markup once React mounts (every page sits
 * behind a root `React.lazy` + Suspense, so true hydrateRoot adoption would
 * always mismatch). See docs/specs/064-seo-prerender-public-routes.md.
 *
 * `src/prerender-entry.test.tsx` runs this same function under Vitest's plain
 * Node environment — the canary that keeps this graph SSR-safe.
 */
import type { ComponentType, ReactElement } from 'react';
// server.EDGE, not `react-dom/server`: under the client build's resolve
// conditions Vite bundles react-dom-server.BROWSER, whose module scope creates
// a `new MessageChannel()` — in Node that is a referenced libuv handle that
// keeps `vite build` alive FOREVER after the build completes. The edge build
// schedules with setTimeout/queueMicrotask only (no handles) and is
// byte-equivalent for our synchronous renderToString use.
import { renderToString } from 'react-dom/server.edge';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import i18n from './i18n/config';
import {
  ChartEngineContext,
  type ChartEngineContextValue,
} from './providers/chartEngineContext';
import Landing from './pages/Landing';
import PrivacyPolicy from './pages/legal/PrivacyPolicy';
import TermsOfService from './pages/legal/TermsOfService';
import DataDeletion from './pages/legal/DataDeletion';
import HowWeTest from './pages/legal/HowWeTest';
import {
  PUBLIC_ROUTE_PATHS,
  getRouteHead,
  headElementsFor,
  type HeadElement,
} from './seo/routeHead';

/** No-op engine context: prerendering never boots (or needs) the engine. */
const engineStub: ChartEngineContextValue = {
  engine: null,
  stage: null,
  error: null,
  meta: null,
  reboot: () => Promise.reject(new Error('engine unavailable during build-time prerender')),
  whenReady: () => Promise.reject(new Error('engine unavailable during build-time prerender')),
  startBootstrap: () => {},
};

function HomeLanding(): ReactElement {
  return <Landing variant="home" />;
}

function WelcomeLanding(): ReactElement {
  return <Landing variant="welcome" />;
}

const PAGES: Readonly<Record<string, ComponentType>> = {
  '/': HomeLanding,
  '/welcome': WelcomeLanding,
  '/privacy': PrivacyPolicy,
  '/terms': TermsOfService,
  '/data-deletion': DataDeletion,
  '/how-we-test': HowWeTest,
};

export interface PrerenderResult {
  html: string;
  links: Set<string>;
  head: {
    lang: string;
    title: string;
    elements: Set<HeadElement>;
  };
}

/** Strip query/hash and any trailing slash so `/welcome/` matches `/welcome`. */
function normalizePath(url: string): string {
  const pathname = new URL(url, SITE_FAKE_BASE).pathname;
  return pathname.replace(/\/+$/, '') || '/';
}
const SITE_FAKE_BASE = 'http://localhost';

export async function prerender(data: { url: string }): Promise<PrerenderResult> {
  // i18next.init resolves asynchronously; with bundled catalogs this settles on
  // the next tick. Prerendered output is English — the authoritative catalog.
  if (!i18n.isInitialized) {
    await new Promise<void>((resolve) => i18n.on('initialized', () => resolve()));
  }
  await i18n.changeLanguage('en');

  const path = normalizePath(data.url);
  const Page = PAGES[path];
  const head = getRouteHead(path);
  if (!Page || !head) {
    throw new Error(`prerender: no public shell registered for "${path}"`);
  }

  const html = renderToString(
    <I18nextProvider i18n={i18n}>
      <ChartEngineContext.Provider value={engineStub}>
        <MemoryRouter initialEntries={[path]}>
          <Page />
        </MemoryRouter>
      </ChartEngineContext.Provider>
    </I18nextProvider>,
  );

  return {
    html,
    // Explicit, closed route list — the plugin prerenders exactly these.
    links: new Set(PUBLIC_ROUTE_PATHS),
    head: {
      lang: 'en',
      title: head.title,
      elements: new Set(headElementsFor(path)),
    },
  };
}
