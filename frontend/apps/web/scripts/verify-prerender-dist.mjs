#!/usr/bin/env node
// Verify the BUILT dist prerender layout that makes almamesh.com serve the
// no-slash canonical (/welcome) with HTTP 200 on Cloudflare Pages.
//
// Run AFTER `bun run build`:  node scripts/verify-prerender-dist.mjs [distDir]
//
// Asserts, against the real build output:
//   1. Every public route emits a FLAT `<slug>.html` (root -> index.html) and
//      NOT a nested `<slug>/index.html` (the nested form is what CF 308-redirects
//      the no-slash canonical away to — the bug this fix removes).
//   2. Each flat file declares the matching NO-slash canonical + og:url, and
//      carries its OWN per-route og:image + twitter:image (/og/<slug>.png,
//      present in dist) — never the shared brand card.
//   3. The SW precache manifest (sw.js) lists the flat HTML files and STILL
//      excludes the build-time `prerender-entry-*.js` chunk (Spec 064 guarantee).
//      The /og/*.png share cards must NOT be precached either — they are
//      scraper-fetched preview assets, not app shell (same treatment as
//      og-card.png).
//
// Exit non-zero on the first failed invariant so CI / the exit gate can gate on it.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(webRoot, 'dist'));

const failures = [];
const ok = (msg) => console.log(`  ok  ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.log(`FAIL  ${msg}`);
};

if (!existsSync(distDir)) {
  console.error(`dist not found at ${distDir} — run \`bun run build\` first`);
  process.exit(2);
}

// Load the typed route source so the script and the app agree on the layout.
const routeHead = await import(
  pathToFileURL(path.join(webRoot, 'src/seo/routeHead.ts')).href
).catch(async () => {
  // `.ts` import needs a TS-aware runtime (bun). Fall back to the hard-coded
  // public routes if plain node can't load it, so `node ...` still works.
  return null;
});

const PUBLIC_ROUTE_PATHS = routeHead?.PUBLIC_ROUTE_PATHS ?? [
  '/',
  '/welcome',
  '/privacy',
  '/terms',
  '/data-deletion',
  '/how-we-test',
];
const SITE_ORIGIN = routeHead?.SITE_ORIGIN ?? 'https://almamesh.com';
const prerenderOutputFile =
  routeHead?.prerenderOutputFile ??
  ((p) => (p === '/' ? 'index.html' : `${p.replace(/^\//, '')}.html`));
const canonicalFor = (p) => (p === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${p}`);
const ogSlugFor = routeHead?.ogSlugFor ?? ((p) => (p === '/' ? 'home' : p.replace(/^\//, '')));
const ogImageUrlFor =
  routeHead?.ogImageUrlFor ?? ((p) => `${SITE_ORIGIN}/og/${ogSlugFor(p)}.png`);

console.log(`\nVerifying prerender dist layout in ${distDir}\n`);

// 1 + 2. Flat files exist with the right canonical; nested form is gone.
for (const route of PUBLIC_ROUTE_PATHS) {
  const file = prerenderOutputFile(route);
  const abs = path.join(distDir, file);
  if (existsSync(abs) && statSync(abs).isFile()) {
    ok(`${route}  ->  ${file} (flat, exists)`);
  } else {
    fail(`${route}  ->  ${file} MISSING`);
    continue;
  }

  const html = readFileSync(abs, 'utf-8');
  const canonical = canonicalFor(route);
  const canonMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0] ?? '';
  if (canonMatch.includes(`href="${canonical}"`) || canonMatch.includes(`href='${canonical}'`)) {
    ok(`${file} declares canonical ${canonical}`);
  } else {
    fail(`${file} canonical mismatch — expected ${canonical}, got: ${canonMatch || '(none)'}`);
  }
  if (html.includes(`content="${canonical}"`)) {
    ok(`${file} og:url is ${canonical}`);
  } else {
    fail(`${file} og:url missing/!= ${canonical}`);
  }

  // Per-route OG card: this route's own /og/<slug>.png in og:image AND
  // twitter:image, and the referenced PNG actually shipped in dist.
  const ogImage = ogImageUrlFor(route);
  const ogImageTag = html.match(/<meta[^>]+property=["']og:image["'][^>]*>/i)?.[0] ?? '';
  if (ogImageTag.includes(`content="${ogImage}"`) || ogImageTag.includes(`content='${ogImage}'`)) {
    ok(`${file} og:image is its own card ${ogImage}`);
  } else {
    fail(`${file} og:image missing/!= ${ogImage} — got: ${ogImageTag || '(none)'}`);
  }
  const twImageTag = html.match(/<meta[^>]+name=["']twitter:image["'][^>]*>/i)?.[0] ?? '';
  if (twImageTag.includes(`content="${ogImage}"`) || twImageTag.includes(`content='${ogImage}'`)) {
    ok(`${file} twitter:image matches`);
  } else {
    fail(`${file} twitter:image missing/!= ${ogImage} — got: ${twImageTag || '(none)'}`);
  }
  const ogAsset = path.join(distDir, 'og', `${ogSlugFor(route)}.png`);
  if (existsSync(ogAsset) && statSync(ogAsset).isFile()) {
    ok(`dist ships og/${ogSlugFor(route)}.png`);
  } else {
    fail(`dist MISSING og/${ogSlugFor(route)}.png (referenced by ${file})`);
  }

  // The nested directory form must NOT exist (it is what 308s the canonical away).
  if (route !== '/') {
    const slug = route.replace(/^\//, '');
    const nested = path.join(distDir, slug, 'index.html');
    if (existsSync(nested)) fail(`nested directory form still present: ${slug}/index.html`);
    else ok(`no nested ${slug}/index.html`);
  }
}

// 3. SW precache manifest: includes the flat HTML, excludes prerender-entry.
const swPath = path.join(distDir, 'sw.js');
if (!existsSync(swPath)) {
  fail('sw.js not found in dist (PWA precache manifest missing)');
} else {
  const sw = readFileSync(swPath, 'utf-8');
  const urls = [...sw.matchAll(/["'`]([^"'`]+?)["'`]\s*,\s*revision/g)].map((m) => m[1]);
  // Raw keys (leading slash preserved) — the shell HTMLs are now precached under
  // their extensionless canonical URL, so we must compare against '/', '/welcome'…
  const precachedRaw = new Set(urls);
  const precached = new Set(urls.map((u) => u.replace(/^\//, '')));
  const listAll = precachedRaw.size ? [...precachedRaw] : [];

  // The shell HTMLs are precached under their EXTENSIONLESS CANONICAL URL
  // (index.html -> '/', welcome.html -> '/welcome', …) because Cloudflare Pages
  // 308-redirects the '.html' forms; precaching a redirecting key breaks the SW
  // install (see manifestTransforms in vite.config.ts).
  for (const route of PUBLIC_ROUTE_PATHS) {
    if (precachedRaw.has(route)) ok(`precache manifest lists canonical ${route}`);
    else fail(`precache manifest is MISSING canonical ${route} (found: ${listAll.join(', ') || '∅'})`);
  }
  // The redirecting flat '.html' and nested forms must NOT be precached.
  for (const route of PUBLIC_ROUTE_PATHS) {
    const flat = prerenderOutputFile(route);
    if (precached.has(flat)) fail(`precache manifest still lists redirecting ${flat} (want canonical ${route})`);
    if (route === '/') continue;
    const slug = route.replace(/^\//, '');
    if (precached.has(`${slug}/index.html`)) fail(`precache manifest still lists ${slug}/index.html`);
  }
  // Spec 064 guarantee: the build-time prerender entry chunk is never precached.
  const leaked = [...precached].filter((u) => /(^|\/)prerender-entry-[^/]*\.js$/.test(u));
  if (leaked.length) fail(`prerender-entry chunk LEAKED into precache: ${leaked.join(', ')}`);
  else ok('prerender-entry-*.js excluded from precache (Spec 064 guarantee holds)');
  // The per-route OG cards are scraper-fetched share assets, NOT app shell —
  // keep them out of the precache (same treatment as og-card.png).
  const ogLeaked = [...precached].filter((u) => /^og\//.test(u) || u === 'og-card.png');
  if (ogLeaked.length) fail(`OG share cards LEAKED into precache: ${ogLeaked.join(', ')}`);
  else ok('og/*.png share cards excluded from precache');
}

// Sanity: the engine's extensionless pointer + shell are intact.
for (const must of ['index.html', 'sw.js']) {
  if (existsSync(path.join(distDir, must))) ok(`dist has ${must}`);
  else fail(`dist missing ${must}`);
}

// A stray listing so a human can eyeball the top-level HTML files.
const topHtml = readdirSync(distDir).filter((f) => f.endsWith('.html')).sort();
console.log(`\nTop-level dist HTML: ${topHtml.join(', ')}\n`);

if (failures.length) {
  console.error(`\n❌ ${failures.length} prerender-dist invariant(s) failed.\n`);
  process.exit(1);
}
console.log('✅ prerender dist layout verified — flat no-slash canonical files + clean precache.\n');
