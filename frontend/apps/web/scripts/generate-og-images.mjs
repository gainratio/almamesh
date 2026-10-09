#!/usr/bin/env node
// Generate the per-route Open Graph cards (public/og/<slug>.png, 1200x630).
//
// Run:  node scripts/generate-og-images.mjs        (from apps/web)
//
// The PNGs are COMMITTED — the build never runs this script; it is the
// reproducible source of the cards. Rendering is fully local: satori lays the
// card out with the repo's self-hosted Hanken Grotesk TTFs (public/fonts/) and
// @resvg/resvg-js rasterizes the SVG. No network, no CDN fonts, no runtime dep.
//
// Design contract: every card is a SIBLING of the original public/og-card.png —
// same obsidian gradient, same 8px #7c6cf0 top rule, same dual-tone
// "Alma"+"Mesh" wordmark, same "almamesh.com · open source" footer. ONLY the
// headline/subtitle copy varies per route. Colors below were sampled from the
// original card so the family stays pixel-faithful.
//
// Slugs must match `ogSlugFor()` in src/seo/routeHead.ts — the routeHead unit
// test asserts every route's card exists here as a 1200x630 PNG < 200 KB.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import subsetFont from 'subset-font';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontsDir = path.join(webRoot, 'public', 'fonts');
const outDir = path.join(webRoot, 'public', 'og');

// Palette — sampled from the original og-card.png (NOT re-themed).
const BG_FROM = '#0d0d1b';
const BG_TO = '#161528';
const PURPLE = '#7c6cf0';
const WHITE = '#f5f7fb';
const FOOTER_GRAY = '#9aa6b8';

const WIDTH = 1200;
const HEIGHT = 630;

/** One card per public route. `home` renders the full-size brand wordmark. */
const CARDS = [
  {
    slug: 'home',
    kind: 'brand',
    subtitle: 'Free, local-first Vedic astrology\nin your browser',
  },
  {
    slug: 'welcome',
    kind: 'page',
    headline: 'Your real sky.\nComputed on your device.\nFree, forever.',
    subtitle: 'No account. No email. Your chart is computed in your browser.',
  },
  {
    slug: 'privacy',
    kind: 'page',
    headline: 'Privacy Policy',
    subtitle: 'Your chart is computed on your device. AI is opt-in.',
  },
  {
    slug: 'terms',
    kind: 'page',
    headline: 'Terms of Service',
    subtitle: 'Free and open source. Astrology as reflection, not fact.',
  },
  {
    slug: 'data-deletion',
    kind: 'page',
    headline: 'Data Deletion',
    subtitle: 'Your data lives only in your browser. Delete it any time.',
  },
];

// The repo's self-hosted Hanken Grotesk TTF is a VARIABLE font (wght 100–900,
// default 400) — satori's opentype.js cannot parse its fvar table and would
// render the default weight anyway. Pin the wght axis with harfbuzz
// (subset-font) to produce true STATIC instances for satori. Subsetting to the
// card charset is a free bonus; everything stays local to public/fonts/.
const CHARSET = [...new Set(
  CARDS.flatMap((c) => [c.headline ?? '', c.subtitle]).join('') +
    'AlmaMesh almamesh.com · open source' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?()&’—·-',
)].join('');

const hankenVF = readFileSync(path.join(fontsDir, 'HankenGrotesk-Bold.ttf'));
const instance = (wght) =>
  subsetFont(hankenVF, CHARSET, { targetFormat: 'sfnt', variationAxes: { wght } });

const fonts = [
  { name: 'Hanken Grotesk', data: await instance(400), weight: 400, style: 'normal' },
  { name: 'Hanken Grotesk', data: await instance(700), weight: 700, style: 'normal' },
];

/** satori element helper — plain `{type, props}` nodes, no JSX. */
const el = (type, style, children) => ({ type, props: { style, ...(children !== undefined ? { children } : {}) } });

/** The dual-tone wordmark: "Alma" in white + "Mesh" in brand purple. */
function wordmark(fontSize) {
  return el(
    'div',
    { display: 'flex', flexDirection: 'row', fontWeight: 700, fontSize, letterSpacing: '-0.02em' },
    [
      el('span', { color: WHITE }, 'Alma'),
      el('span', { color: PURPLE }, 'Mesh'),
    ],
  );
}

/** Multi-line block: explicit `\n` breaks, satori-safe (one span per line). */
function lines(text, style) {
  return el(
    'div',
    { display: 'flex', flexDirection: 'column', ...style },
    text.split('\n').map((line) => el('span', {}, line)),
  );
}

function card({ kind, headline, subtitle }) {
  const isBrand = kind === 'brand';
  return el(
    'div',
    {
      width: WIDTH,
      height: HEIGHT,
      display: 'flex',
      flexDirection: 'column',
      backgroundImage: `linear-gradient(135deg, ${BG_FROM} 0%, ${BG_TO} 100%)`,
      fontFamily: 'Hanken Grotesk',
      padding: '0 80px',
      position: 'relative',
    },
    [
      // The 8px brand rule across the very top.
      el('div', {
        position: 'absolute',
        top: 0,
        left: 0,
        width: WIDTH,
        height: 8,
        backgroundColor: PURPLE,
      }),
      // Eyebrow wordmark on page cards; brand card carries it as the headline.
      el(
        'div',
        { display: 'flex', height: 128, alignItems: 'flex-end' },
        isBrand ? [] : [wordmark(44)],
      ),
      // Headline + subtitle, vertically centered in the remaining space.
      el(
        'div',
        { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' },
        [
          isBrand
            ? wordmark(112)
            : lines(headline, {
                color: WHITE,
                fontWeight: 700,
                fontSize: 72,
                lineHeight: 1.12,
                letterSpacing: '-0.02em',
              }),
          lines(subtitle, {
            color: WHITE,
            fontWeight: 400,
            fontSize: isBrand ? 40 : 32,
            lineHeight: 1.35,
            marginTop: isBrand ? 36 : 28,
            opacity: isBrand ? 1 : 0.92,
            maxWidth: 980,
          }),
        ],
      ),
      // Footer — identical on every card in the family.
      el(
        'div',
        { display: 'flex', height: 110, alignItems: 'flex-start', color: FOOTER_GRAY, fontSize: 28 },
        'almamesh.com · open source',
      ),
    ],
  );
}

mkdirSync(outDir, { recursive: true });

for (const spec of CARDS) {
  const svg = await satori(card(spec), { width: WIDTH, height: HEIGHT, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'original' } }).render().asPng();
  const file = path.join(outDir, `${spec.slug}.png`);
  writeFileSync(file, png);
  console.log(`✅ ${path.relative(webRoot, file)}  ${(png.byteLength / 1024).toFixed(1)} KB`);
}
console.log(`\nDone — ${CARDS.length} cards in ${path.relative(webRoot, outDir)}/`);
