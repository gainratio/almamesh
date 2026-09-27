import { createLogger, defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA, type VitePluginPWAAPI } from 'vite-plugin-pwa'
import { vitePrerenderPlugin } from 'vite-prerender-plugin'
import path from 'path'
import { existsSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import { PUBLIC_ROUTE_PATHS, prerenderOutputFile } from './src/seo/routeHead'
import { createBuildIdentity } from './src/lib/buildIdentity'
import { extractYogaWasm, isYogaWasmModuleId } from './src/lib/yogaWasmAsset'
import {
  browserIsolationHeadersFromHeadersFile,
  cspForLocalHttpPreview,
} from './src/lib/previewHeaders'
import { selectSourcemapArtifacts, sourcemapLeakMessage } from './src/lib/noSourcemaps'
import {
  keyPrecacheByResponseHeaders,
  readPrecacheHeaderSources,
  responseHeadersKey,
} from './src/lib/precacheHeadersKey'

// App version injected into the bundle (see `define` below) so client code can
// report which release it is — e.g. submitFeedback's `X-App-Version` header.
// Read from package.json at config load; the single source of truth for version.
const APP_VERSION: string = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
).version

// Precache key: a hash of every file that sets response headers. Changing
// public/_headers re-keys (and so re-fetches) the whole app-shell precache.
const PRECACHE_HEADERS_KEY = responseHeadersKey(readPrecacheHeaderSources(__dirname))

// Version the offline trust-root cache by the exact release key in THIS build.
// A waiting service worker can warm the new cache without mutating the active
// release's cache; after activation, NetworkFirst still refreshes from origin
// and falls back to this release-matched key while offline.
const TRUST_KEY_PATH = path.resolve(__dirname, 'public/public.key')
const TRUST_KEY_BYTES = existsSync(TRUST_KEY_PATH) ? readFileSync(TRUST_KEY_PATH) : null
const TRUST_KEY_HASH = TRUST_KEY_BYTES === null
  ? null
  : createHash('sha256').update(TRUST_KEY_BYTES).digest('hex').slice(0, 16)
const TRUST_KEY_CACHE = TRUST_KEY_HASH === null
  ? 'almamesh-pubkey-unconfigured'
  : `almamesh-pubkey-${TRUST_KEY_HASH}`
const TRUST_KEY_CONFIG = TRUST_KEY_HASH === null
  ? null
  : `engine-trust-config-${TRUST_KEY_HASH}.js`

function trustKeyConfigPlugin(): Plugin {
  if (TRUST_KEY_BYTES === null || TRUST_KEY_HASH === null || TRUST_KEY_CONFIG === null) {
    return { name: 'trust-key-config-unconfigured' }
  }
  const source = [
    `self.__ALMAMESH_TRUST_KEY_B64__=${JSON.stringify(TRUST_KEY_BYTES.toString('base64'))};`,
    `self.__ALMAMESH_TRUST_KEY_HASH__=${JSON.stringify(TRUST_KEY_HASH)};`,
  ].join('\n')
  return {
    name: 'trust-key-config',
    generateBundle() {
      this.emitFile({ fileName: TRUST_KEY_CONFIG, source, type: 'asset' })
    },
  }
}

// Pyodide's `pyodide.mjs` statically imports Node builtins (`node:fs`, `node:url`,
// …) behind runtime environment guards that NEVER execute in the browser. Vite
// correctly externalizes them to browser-safe stubs, but emits a "Module has been
// externalized for browser compatibility" notice for each — pure benign noise on
// every build. Filter ONLY those messages so the build log stays clean and a real
// warning is never buried. (We keep Vite's externalization behavior unchanged;
// marking node:* `external` would instead emit literal `import "node:fs"` and break
// the engine worker at load.)
const quietLogger = createLogger()
const baseWarn = quietLogger.warn.bind(quietLogger)
quietLogger.warn = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('has been externalized for browser compatibility')) {
    return
  }
  baseWarn(msg, options)
}

// Plugin to generate version.json for cache invalidation and build.json for
// exact production provenance. Writes into the
// RESOLVED build outDir (not a hardcoded `dist/`), so a non-default --outDir
// (e.g. the exit-gate's dist-verify) works on a fresh checkout.
function versionPlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'version-plugin',
    configResolved(config) {
      outDir = config.build.outDir
    },
    writeBundle() {
      const version = createHash('sha256')
        .update(Date.now().toString())
        .digest('hex')
        .slice(0, 12)

      const buildTime = new Date().toISOString()
      const identity = createBuildIdentity(process.env.BUILD_COMMIT, version, buildTime)
      const versionData = { version, buildTime, commit: identity.commit }

      writeFileSync(
        path.resolve(__dirname, outDir, 'version.json'),
        JSON.stringify(versionData)
      )
      writeFileSync(path.resolve(__dirname, outDir, 'build.json'), JSON.stringify(identity))
      console.log(`✅ Generated version.json: ${version}`)
    },
  }
}

// Report-PDF layout engine wasm — serve it as a real asset, not a data: URI.
//
// @react-pdf (the report-PDF pipeline) computes page layout with yoga-layout,
// whose npm build embeds its wasm as a base64 `data:application/octet-stream`
// URI (emscripten SINGLE_FILE) and fetch()es that URI at init. The production
// CSP (public/_headers) rightly has no `data:` in connect-src, so every live
// PDF generation logged blocked-fetch console errors and instantiated the
// wasm through emscripten's slower synchronous base64 fallback. This plugin
// lifts the embedded binary out of the JS into a content-hashed asset served
// from OUR origin (pinned-asset policy — never a CDN) and rewrites the module
// to point at it: WebAssembly.instantiateStreaming over an allowed 'self'
// fetch, zero console noise, and ~120 KB less JS in the react-pdf chunk.
//
// Build-only on purpose: `vite dev` serves no _headers/CSP, so the upstream
// data-URI path is harmless there, and vitest never bundles the binary.
// Helpers + failure modes are unit-tested in src/lib/yogaWasmAsset.test.ts
// against the REAL installed module (a yoga-layout upgrade that changes the
// embedding fails the unit suite, never silently regresses production).
function yogaWasmAssetPlugin(): Plugin {
  return {
    name: 'almamesh-yoga-wasm-asset',
    apply: 'build',
    load(id) {
      const cleanPath = id.split('?', 1)[0]
      if (!isYogaWasmModuleId(cleanPath)) return null
      const source = readFileSync(cleanPath, 'utf-8')
      const { quotedDataUri, bytes } = extractYogaWasm(source)
      const referenceId = this.emitFile({
        type: 'asset',
        name: 'yoga-layout.wasm',
        source: bytes,
      })
      // Inject the hashed BASENAME, not a full URL. For any non-data-URI
      // value the emscripten loader prepends its scriptDirectory
      // (`wasmBinaryFile = scriptDirectory + wasmBinaryFile`), so a full URL
      // here double-prefixes into garbage
      // (`/assets/http://…/assets/yoga-….wasm` → 404 → "both async and sync
      // fetching of the wasm failed" → no PDF; the report-pdf e2e catches it).
      // The bare basename resolves next to the emitting chunk — both live
      // under assets/ — and String(…).split('/').pop() yields it however
      // Vite/Rollup materialize ROLLUP_FILE_URL_ (URL object or href string).
      return source.replace(
        quotedDataUri,
        `String(import.meta.ROLLUP_FILE_URL_${referenceId}).split('/').pop()`,
      )
    },
  }
}

// Un-bypassable check that the build publishes no original source.
//
// `build.sourcemap: false` below is a flag; this is the property. Cloudflare
// Pages serves every file in the output directory, so a `_headers` rule cannot
// un-serve a `.map` — the only enforcement point is "never emit one". Runs in
// generateBundle (before anything is written) on every lane that builds:
// `bun run gate`, CI, and build-prod.sh. Helpers + red cases are unit-tested in
// src/lib/noSourcemaps.test.ts.
function noSourcemapsPlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'almamesh-no-sourcemaps',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir
    },
    // closeBundle, scanning the WRITTEN directory — not generateBundle over the
    // Rollup bundle. Two of the three map producers here never appear in that
    // bundle: vite-plugin-pwa writes `sw.js.map` / `workbox-*.js.map` itself,
    // and vite-prerender-plugin deletes its map entries in its own
    // generateBundle. Checking the bytes that will actually be uploaded is both
    // the honest property and immune to plugin-ordering surprises.
    closeBundle() {
      const dir = path.resolve(__dirname, outDir)
      const walk = (current: string): string[] =>
        readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
          const child = path.join(current, entry.name)
          return entry.isDirectory() ? walk(child) : [path.relative(dir, child)]
        })
      const leaks = selectSourcemapArtifacts(
        walk(dir).map((fileName) => ({ fileName, carriesSourcemap: false })),
      )
      if (leaks.length > 0) {
        this.error(sourcemapLeakMessage(leaks))
      }
    },
  }
}

// Preview fidelity: serve the production CSP enforcement directives and
// browser-isolation headers on
// every `vite preview` response. In production Cloudflare Pages parses
// public/_headers; plain `vite preview` serves none of them, so every
// preview-driven e2e lane ran with a materially looser policy than production
// — a CSP-blocked fetch (exactly the yoga-layout data:-URI wasm case above)
// sailed through CI green and only surfaced as console errors on
// almamesh.com. Local HTTP omits only `upgrade-insecure-requests`, because
// WebKit otherwise rewrites Vite's own subresources to an unavailable HTTPS
// listener; production is already HTTPS and keeps that directive. Applying the
// remaining real policy makes the clean-console e2e gates enforce production
// behavior. COOP/COEP also apply to workers and enable the
// SharedArrayBuffer required by SQLite's OPFS Web-Locks VFS. The CSP is NOT
// applied to `vite dev`, whose react-refresh preamble uses inline scripts; the
// isolation headers are applied there below. Full Pages merge/detach semantics
// remain Cloudflare's job. Parser tested in src/lib/previewHeaders.test.ts.
function previewProdBrowserHeadersPlugin(): Plugin {
  return {
    name: 'almamesh-preview-prod-browser-headers',
    configurePreviewServer(server) {
      const headersFile = readFileSync(path.resolve(__dirname, 'public/_headers'), 'utf-8')
      const csp = cspForLocalHttpPreview(headersFile)
      const isolationHeaders = browserIsolationHeadersFromHeadersFile(headersFile)
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', csp)
        for (const [name, value] of Object.entries(isolationHeaders)) {
          res.setHeader(name, value)
        }
        next()
      })
    },
  }
}

// Workbox appends vite-plugin-pwa's own entries (manifest icons + the
// webmanifest) AFTER manifestTransforms run, so key those here through the
// plugin's public API. Together with the manifest transform in pwaPlugin this
// keys EVERY precache entry on the response headers (verify-precache-redirect
// asserts it on the built sw.js).
function precacheHeadersKeyedExtrasPlugin(): Plugin {
  let pwa: VitePluginPWAAPI | undefined
  return {
    name: 'almamesh-precache-headers-keyed-extras',
    configResolved(config) {
      pwa = config.plugins.find((plugin) => plugin.name === 'vite-plugin-pwa')?.api as VitePluginPWAAPI | undefined
    },
    buildStart() {
      pwa?.extendManifestEntries((entries) =>
        keyPrecacheByResponseHeaders(
          entries.map((entry) => (typeof entry === 'string' ? { url: entry, revision: null } : entry)),
          PRECACHE_HEADERS_KEY,
        ),
      )
    },
  }
}

// PWA + Service Worker (Workbox via vite-plugin-pwa).
//
// Cache discipline — the whole point of P6:
//   PRECACHE (install)  the small, hashed APP SHELL only: index.html + the
//                       /assets/*.{js,css} chunks (incl. the lazy cities chunk).
//                       NEVER the ~38 MB Pyodide/bundle blobs — that would block
//                       first paint on 38 MB.
//   RUNTIME CacheFirst  the large, immutable engine data on first use:
//                       /pyodide/** (wasm + lock + wheels) and /bundle/chunk(s)
//                       + /bundle/manifest(s) (content-addressed -> immutable).
//   RUNTIME NetworkFirst the update SIGNALS: /bundle/latest, /version.json,
//                       and the webmanifest — short TTL so updates propagate.
//
// registerType 'prompt' (NOT autoUpdate): a new SW waits and the UI offers a
// reload (see useVersionCheck/UpdateBanner). A SKIP_WAITING message provides a
// force path for security updates.
function pwaPlugin(): Plugin[] {
  return VitePWA({
    registerType: 'prompt',
    injectRegister: null, // we register manually in main.tsx (typed, prompt-driven)
    // The 38 MB Pyodide + bundle live under public/ -> copied to dist root.
    // Keep them OUT of the precache manifest; they are runtime-cached below.
    workbox: {
      // No service-worker sourcemaps. MUST be explicit: vite-plugin-pwa derives
      // `workbox.sourcemap` from `viteConfig.build.sourcemap`, and
      // vite-prerender-plugin force-sets `build.sourcemap = true` in its
      // `config()` hook (to make prerender stack traces readable). It cleans up
      // the ROLLUP maps afterwards, but the SW is written by workbox outside
      // that bundle — so `build.sourcemap: false` alone still shipped
      // `sw.js.map` (20 KB) and `workbox-<hash>.js.map` (228 KB). Pinning it
      // here is what actually stops them.
      sourcemap: false,
      // A first install has no older worker to protect. Claim the already-open
      // first-session page as soon as install/activation (including the trust-
      // root warm below) completes, so its very next offline reload is served
      // by this worker. Updates still wait for explicit user acceptance because
      // skipWaiting remains disabled under registerType: 'prompt'.
      clientsClaim: true,
      // Activation-time warm of the VERSIONED NetworkFirst fallback. This is not
      // a precache entry: /public.key must keep reaching the NetworkFirst route
      // online so key rotation and bundle-pointer updates stay paired.
      // Stale precached HEADERS (the #157 COEP incident) are handled
      // structurally by the headers-keyed manifest transform below, not by a
      // repair script: see src/lib/precacheHeadersKey.ts.
      importScripts: [
        ...(TRUST_KEY_CONFIG === null ? [] : [TRUST_KEY_CONFIG, 'engine-trust-install.js']),
      ],
      // `wasm` covers the small hashed yoga-layout asset and the SQLite runtime
      // used by local semantic memory. The giant engine/model wasms stay out
      // via the directory globIgnores below (pyodide/**, models/**).
      globPatterns: ['**/*.{js,css,html,woff,woff2,ttf,otf,wasm}'],
      globIgnores: [
        'pyodide/**',
        'bundle/**',
        '**/*.map',
        'engine-trust-install.js',
        'engine-trust-config-*.js',
        'public.key',
        'planets/**',
        // The self-hosted RAG embedding model + onnxruntime-web wasm (~25 MB).
        // Same discipline as Pyodide: far too large for the app-shell precache;
        // it is runtime-cached (CacheFirst) below and fetched on first chat use,
        // so offline-after-first-use still holds.
        'models/**',
        // The onnxruntime wasm ALSO lands in /assets/ as a Rollup emission
        // artifact of the @huggingface/transformers import graph (21.6 MB).
        // The runtime never fetches it from there — ort is configured to load
        // from the runtime-cached /models/ort/** above — so keep it out of the
        // precache (it would otherwise trip maximumFileSizeToCacheInBytes).
        'assets/ort-*.wasm',
        // Spec 064: the build-time prerender entry chunk (vite-prerender-plugin
        // executes it in Node during `vite build`). Nothing in the browser ever
        // imports it — index.html carries no reference — so precaching it would
        // ship ~200 KB of dead code to every client at SW install.
        'assets/prerender-entry-*.js',
      ],
      // App-shell SPA fallback: an offline navigation to a registered client
      // route serves the precached shell (then React Router takes over). The shell is precached
      // under the extensionless canonical URL `/` (see manifestTransforms below),
      // NOT `/index.html`, because Cloudflare Pages 308-redirects `/index.html`
      // -> `/`. Precaching/falling-back on a redirecting URL is fragile and left
      // returning users with an empty precache + a Chrome error page. `/` is
      // served 200 by CF Pages and by `vite preview`.
      navigateFallback: '/',
      navigateFallbackAllowlist: [
        /^\/(?:onboarding|dashboard|predictive|report|edit-birth-details)\/?$/,
        /^\/life\/(?:career|finances|health|relationships|spiritual|education|family)\/?$/,
        /^\/mesh(?:\/[^/]+)?\/?$/,
        /^\/rectify\/[^/]+\/?$/,
        /^\/settings(?:\/(?:profile|people|ai|preferences|data))?\/?$/,
      ],
      // Raise the 2 MiB default so the offline geocoder data (~2 MB cities) and
      // the larger app-shell chunks precache.
      maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      cleanupOutdatedCaches: true,
      // Cloudflare Pages 308-redirects the prerendered `*.html` shells to their
      // extensionless canonical URLs (`index.html`->`/`, `welcome.html`->
      // `/welcome`, ... — the SEO-canonical behaviour from spec 064). Workbox
      // precaches by fetching each entry; precaching under a REDIRECTING key is
      // fragile and is the root cause of the empty-precache wedge. Rewrite those
      // 5 shell entries to the 200 canonical URL before the manifest is written
      // (revisions preserved). Hashed assets are untouched, and the SEO redirect
      // is unchanged — we only change the service worker's precache keys.
      manifestTransforms: [
        (
          entries: { url: string; revision: string | null; integrity?: string; size: number }[],
        ) => {
          // Derive the shell->canonical map from the SAME source of truth the
          // prerender + SEO gates use (PUBLIC_ROUTE_PATHS + prerenderOutputFile in
          // src/seo/routeHead.ts): `welcome.html` -> `/welcome`, root -> `/`. A
          // future public route is picked up automatically, so it can never
          // silently reintroduce a redirecting precache key (the wedge root cause).
          const canonical: Record<string, string> = Object.fromEntries(
            PUBLIC_ROUTE_PATHS.map((p) => [prerenderOutputFile(p), p === '/' ? '/' : p]),
          )
          const manifest = entries.map((entry) => {
            const url = canonical[entry.url.replace(/^\//, '')]
            return url ? { ...entry, url } : entry
          })
          return { manifest, warnings: [] as string[] }
        },
        // Re-key EVERY precache entry on the files that set response headers
        // (src/lib/precacheHeadersKey.ts). A deploy that changes only headers
        // (#157's COOP/COEP) must not leave returning visitors on precached
        // responses carrying the old headers.
        (entries: { url: string; revision: string | null; integrity?: string; size: number }[]) => ({
          manifest: keyPrecacheByResponseHeaders(entries, PRECACHE_HEADERS_KEY),
          warnings: [] as string[],
        }),
      ],
      runtimeCaching: [
        {
          // Immutable, content-addressed bundle data (chunks + manifests).
          urlPattern: ({ url }) =>
            /^\/bundle\/(chunk|chunks|manifest|manifests)\//.test(url.pathname),
          handler: 'CacheFirst',
          options: {
            cacheName: 'almamesh-bundle-immutable',
            expiration: { maxEntries: 4096, maxAgeSeconds: 60 * 60 * 24 * 365 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // Immutable Pyodide dist (wasm + lock + wheels + asm).
          urlPattern: ({ url }) => url.pathname.startsWith('/pyodide/'),
          handler: 'CacheFirst',
          options: {
            cacheName: 'almamesh-pyodide-immutable',
            expiration: { maxEntries: 128, maxAgeSeconds: 60 * 60 * 24 * 365 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // The self-hosted RAG model: MiniLM q8 ONNX + tokenizer/config under
          // /models/Xenova/** and the onnxruntime-web wasm under /models/ort/**.
          // Immutable, same-origin; cached on first chat use so semantic search +
          // RAG memory work offline thereafter (zero egress — never the HF CDN).
          urlPattern: ({ url }) => url.pathname.startsWith('/models/'),
          handler: 'CacheFirst',
          options: {
            cacheName: 'almamesh-models-immutable',
            expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 365 },
            cacheableResponse: { statuses: [0, 200] },
            rangeRequests: true,
          },
        },
        {
          // The verify key MUST match the CURRENTLY deployed bundle, so it has to
          // track the server — never be frozen at first-visit time. CacheFirst here
          // pinned a stale (e.g. dev-signed) key forever, so a later prod-signed
          // bundle failed ed25519 verification ("signature verification failed",
          // 0 chunks synced). NetworkFirst always revalidates the key against the
          // server and keeps the cached copy only as an offline fallback.
          urlPattern: ({ url }) => url.pathname === '/public.key',
          handler: 'NetworkFirst',
          options: {
            cacheName: TRUST_KEY_CACHE,
            networkTimeoutSeconds: 5,
            expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // Update SIGNALS: the version pointer + build version. Fresh-first,
          // but fall back to cache so an offline boot still resolves a pointer.
          urlPattern: ({ url }) =>
            url.pathname === '/bundle/latest' || url.pathname === '/version.json',
          handler: 'NetworkFirst',
          options: {
            cacheName: 'almamesh-signals',
            networkTimeoutSeconds: 5,
            expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
      ],
    },
    includeAssets: [
      'favicon.png',
      'favicon.svg',
      'apple-touch-icon.png',
      'logo.png',
    ],
    manifest: {
      name: 'AlmaMesh — Vedic Astrology',
      short_name: 'AlmaMesh',
      description:
        'Compute authentic Vedic (sidereal) astrology charts entirely on your device. No account, works offline.',
      theme_color: '#0D0D1A',
      background_color: '#0D0D1A',
      display: 'standalone',
      orientation: 'portrait',
      start_url: '/',
      scope: '/',
      icons: [
        { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        {
          src: '/pwa-maskable-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    devOptions: {
      // Keep the SW OUT of `vite dev` (module-worker engine + SW interact badly
      // in dev); the SW is exercised in the production build / preview / e2e.
      enabled: false,
    },
  }) as Plugin[]
}

// The non-root public routes, as `additionalPrerenderRoutes` seeds and, below,
// the preview allowlist. `/` is always prerendered by the plugin.
const NON_ROOT_PUBLIC_ROUTES: readonly string[] = PUBLIC_ROUTE_PATHS.filter((p) => p !== '/')

// Spec 064 — build-time prerender of the PUBLIC routes only (landing + legal).
// `src/prerender-entry.tsx` runs IN NODE during `vite build` and renders the
// engine-free public shells to real per-route HTML (dist/index.html + the FLAT
// dist/{welcome,privacy,terms,data-deletion}.html — see flattening below) with
// per-route head tags from src/seo/routeHead.ts — so crawlers get content, not
// an empty JS shell. Private app routes stay 100% client-rendered. Runs BEFORE
// VitePWA in the plugin list: the prerendered pages are emitted during
// generateBundle, so the SW precache manifest (built at closeBundle) includes
// them with correct revisions.
//
// The plugin's bundled `serve-prerendered-html` preview middleware is DROPPED:
// it rewrites EVERY extensionless path without a matching index.html to the
// prerendered /index.html — including the engine's extensionless
// `/bundle/latest` pointer, which then returns HTML to a JSON fetch and kills
// the engine bootstrap (CHART_GEN_001) under `vite preview` / `poe demo` / the
// CI exit gate. The closed-allowlist middleware below replaces it.
function prerenderPublicRoutesPlugin(): Plugin[] {
  const plugins = vitePrerenderPlugin({
    renderTarget: '#root',
    prerenderScript: path.resolve(__dirname, 'src/prerender-entry.tsx'),
    additionalPrerenderRoutes: [...NON_ROOT_PUBLIC_ROUTES],
  }) as Plugin[]
  return plugins.filter((p) => p.name !== 'serve-prerendered-html')
}

// SEO canonical fix — FLATTEN the prerendered public routes.
//
// vite-prerender-plugin emits each non-root route as a NESTED directory index
// (`dist/welcome/index.html`). Cloudflare Pages serves a directory index at the
// TRAILING-SLASH URL and 308-redirects the no-slash form to it
// (`/welcome` -> 308 -> `/welcome/`). But our canonical tag, `og:url` AND
// `sitemap.xml` all declare the NO-slash `/welcome` (see src/seo/routeHead.ts),
// so the declared canonical redirected AWAY from itself and Google never
// settled it — the pages stayed unindexed. Renaming each emitted asset to a
// FLAT `dist/welcome.html` makes CF Pages serve `/welcome` with HTTP 200 (and
// 308-normalize the `/welcome/` and `/welcome.html` variants back to it), so
// all four signals finally agree on the no-slash canonical.
//
// `enforce: 'post'` + registered AFTER the prerender plugin and BEFORE VitePWA
// so this generateBundle runs once the prerendered assets exist and before the
// SW precache manifest is computed — the manifest then lists `welcome.html`,
// never the stale nested path. Root `index.html` is left untouched.
function flattenPrerenderedRoutesPlugin(): Plugin {
  const renames = NON_ROOT_PUBLIC_ROUTES.map((route) => {
    const slug = route.replace(/^\//, '')
    return { nested: `${slug}/index.html`, flat: prerenderOutputFile(route) }
  })
  return {
    name: 'almamesh-flatten-prerendered-routes',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const { nested, flat } of renames) {
        const asset = bundle[nested]
        if (asset && asset.type === 'asset') {
          delete bundle[nested]
          asset.fileName = flat
          bundle[flat] = asset
        } else {
          this.warn(
            `flatten-prerendered-routes: expected prerendered asset "${nested}" not found — ` +
              `the no-slash canonical for /${nested.replace('/index.html', '')} will NOT be served flat`,
          )
        }
      }
    },
  }
}

// Preview-only: serve the FLAT per-route prerendered HTML for EXACTLY the public
// routes, mirroring how Cloudflare Pages serves /welcome -> welcome.html (200)
// in production. Trailing slashes are stripped first so /welcome and /welcome/
// both resolve to the flat file (CF 308-normalizes the slash form). A closed
// allowlist so no engine/data path can ever be rewritten to HTML.
function previewPublicRoutesMiddleware(): Plugin {
  const publicRoutes = new Set(NON_ROOT_PUBLIC_ROUTES)
  return {
    name: 'almamesh-preview-public-routes',
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '')
          if (publicRoutes.has(pathname)) {
            req.url = `/${prerenderOutputFile(pathname)}`
          }
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  customLogger: quietLogger,
  plugins: [
    react(),
    versionPlugin(),
    trustKeyConfigPlugin(),
    yogaWasmAssetPlugin(),
    noSourcemapsPlugin(),
    previewProdBrowserHeadersPlugin(),
    ...prerenderPublicRoutesPlugin(),
    flattenPrerenderedRoutesPlugin(),
    previewPublicRoutesMiddleware(),
    ...pwaPlugin(),
    precacheHeadersKeyedExtrasPlugin(),
  ],
  // Inline the app version at build time so client code (e.g. the feedback
  // widget's X-App-Version header) reports the running release. Absent in
  // `vite dev` / unit tests, where the reader falls back to 'dev'.
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  // Pyodide must NOT be pre-bundled: optimizeDeps rewrites the worker entry and
  // breaks `new Worker(new URL('./chartWorker.ts', import.meta.url))` resolution.
  optimizeDeps: {
    // Pyodide: pre-bundling rewrites the worker entry and breaks the engine
    // worker's `new Worker(new URL(...))` resolution (see above).
    // @huggingface/transformers: heavy, worker-only RAG model runtime that
    // dynamic-imports onnxruntime-web wasm; excluding it keeps the dep optimizer
    // from choking on its wasm assets and from rewriting the embedder worker URL.
    exclude: ['pyodide', '@huggingface/transformers'],
  },
  // The engine's workers are ES modules (`{ type: 'module' }`) and import Pyodide
  // (code-split), so workers must emit ESM — the default `iife` cannot code-split.
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@almamesh/shared-types': path.resolve(__dirname, '../../packages/shared-types/src'),
      '@almamesh/constants': path.resolve(__dirname, '../../packages/constants/src'),
      '@almamesh/store': path.resolve(__dirname, '../../packages/store/src'),
      '@almamesh/llm': path.resolve(__dirname, '../../packages/llm/src'),
      '@almamesh/memory': path.resolve(__dirname, '../../packages/memory/src'),
      // `/types` must precede the bare alias so the more specific one wins.
      '@almamesh/browser/types': path.resolve(__dirname, '../../packages/browser/src/types'),
      '@almamesh/browser': path.resolve(__dirname, '../../packages/browser/src'),
      // `@edgeproc/browser/*` resolves through its exact-Git package exports.
      // AlmaMesh owns the one-line Vite Worker entry in @almamesh/browser; the
      // standalone package owns the compiled sync/storage implementation.
    },
  },
  server: {
    port: 3000,
    allowedHosts: ['host.docker.internal', 'localhost', '127.0.0.1'],
    // Keep local development on the same SharedArrayBuffer/OPFS capability
    // boundary as production. The production CSP is intentionally preview-only
    // because Vite's react-refresh preamble uses inline scripts.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Allow serving AlmaMesh workspace packages above apps/web in dev. The
    // standalone sync Worker is an installed dependency. (No effect on the
    // production build / preview.)
    fs: {
      allow: ['..'],
    },
  },
  build: {
    outDir: 'dist',
    // NO production sourcemaps. Cloudflare Pages serves whatever is in the
    // output directory, so an emitted `.map` IS a served asset — a `_headers`
    // rule cannot un-serve it. almamesh.com was publishing
    // `assets/index-*.js.map` (2.76 MB, content-type: application/json) with
    // `sourcesContent` for 334 sources including 51 first-party TypeScript
    // files, i.e. the complete original app source plus a precise map of the
    // attack surface. (A credential scan of the live maps came back clean, so
    // this was source/attack-surface exposure, not secret exposure.)
    //
    // `false` rather than `'hidden'` + a delete step on purpose: nothing here
    // consumes maps (no Sentry/upload lane), and not EMITTING them cannot
    // regress, whereas a delete step silently stops working the moment a new
    // build lane forgets it. The workbox `**/*.map` globIgnore above is kept as
    // harmless defence-in-depth. Pinned by src/lib/__tests__/securityHeaders.test.ts.
    sourcemap: false,
    // The largest legitimate lazy chunks are intentional and code-split, so the
    // 500 kB default warning is pure noise: the offline geocoder city DB
    // (~2 MB, loaded only in onboarding's location search) and the React/vendor
    // entry chunk (~1 MB, gzip ~300 kB). Neither blocks first paint. Set the
    // limit just above them so a genuinely oversized NEW chunk still trips it.
    // (We deliberately do NOT hand-group chunks: an explicit regex grouping of
    // the React ecosystem crashed the app with `React.createContext` of
    // undefined under bun's hoisted node_modules layout, so we let Rollup's
    // default code-splitting order React correctly.)
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        // Include content hash in filenames for cache invalidation
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        // LOAD-BEARING no-op — DO NOT delete. vite-prerender-plugin installs its
        // OWN `manualChunks` (remapping src/prerender-entry.tsx) ONLY when the user
        // config sets none (see its configResolved guard:
        //   `if (config.build.rollupOptions.output?.manualChunks) return`).
        // That plugin-injected remapping merges the Node-only SSR renderer
        // (react-dom/server.edge, imported ONLY by the prerender entry) into a
        // chunk Vite then injects into the CLIENT index.html — which shipped ~800 KB
        // of SSR to every browser AND broke the offline app shell (the prerender
        // chunk is globIgnored from the SW precache, so an offline reload 404'd it
        // and the engine never rebooted → exit-gate CHECK 7). Defining any
        // `manualChunks` makes the plugin bail, restoring Rollup's default split
        // (SSR stays in a separate, un-injected prerender chunk). This previously
        // rode on the webllm `manualChunks`; that dep was removed, so the no-op is
        // now the explicit carrier. Returning undefined = Rollup default splitting
        // (hand-grouping the React ecosystem is still avoided — see the
        // chunkSizeWarningLimit note above).
        manualChunks: () => undefined,
      },
    },
  },
})
