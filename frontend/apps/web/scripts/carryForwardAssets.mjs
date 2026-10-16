#!/usr/bin/env node
// Deploy skew protection: carry the previous releases' hashed /assets/* into
// the next Cloudflare Pages upload.
//
// WHY. A tab opened on release A lazy-imports A's content-hashed chunks
// (`/assets/Dashboard-<hash>.js`) for as long as it stays open. Every Pages
// deployment is immutable, but the production domain serves only the newest
// one, so the moment release B goes live A's chunks 404 and the open tab's
// `import()` fails. The standard fix is to keep serving old hashed assets for
// a while: each deploy uploads its own assets plus the last
// MAX_CARRIED_RELEASES releases' assets, downloaded from the deployment that
// is live right before the upload.
//
// HOW. Every deploy writes `assets-manifest.json` at the site root:
//   { schema: 1, releases: [ own, carried-1, carried-2 ] }
// where each release lists its own assets as { path, bytes, sha256 }. The next
// deploy reads that file from the previous production deployment, keeps the
// first MAX_CARRIED_RELEASES releases (newest first), and downloads their
// files, verifying every byte against the manifest. Bounds, all checked before
// anything is downloaded:
//   - whole releases only, newest first, at most MAX_CARRIED_RELEASES;
//   - at most MAX_CARRIED_BYTES of carried files;
//   - the finished upload stays inside the Pages file-count and per-file
//     limits (dagger/src/pagesUploadLimits.ts passes them in);
//   - a carried file never replaces a file of the new build (same path, other
//     bytes: the new file wins and the carried one is dropped and reported).
// An unknown hash must still be a real 404 (a top-level 404.html and no
// catch-all rewrite), so a truly missing chunk stays detectable rather than
// resolving to the SPA's HTML; `missingAssetFallbackProblems` checks that.
//
// The pure parts (parse, plan, fallback check) are unit-tested in
// tests/dagger-asset-carry-forward.test.ts; `carryForwardAssets` is the thin
// filesystem + network layer.
//
// CLI:  node scripts/carryForwardAssets.mjs <distDir> [previousOrigin]
//         [--max-files N] [--max-file-bytes N]

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSET_MANIFEST_FILE = 'assets-manifest.json';
export const ASSET_MANIFEST_SCHEMA = 1;
/** Releases carried besides the new one: an open tab survives two deploys. */
export const MAX_CARRIED_RELEASES = 2;
/** One release's /assets is ~9 MB today; two carried releases fit with room. */
export const MAX_CARRIED_BYTES = 64 * 1024 * 1024;
/** Cloudflare Pages direct-upload limits (mirrors dagger/src/pagesUploadLimits.ts). */
export const DEFAULT_MAX_FILES = 20_000;
export const DEFAULT_MAX_FILE_BYTES = 26_214_400;

const ASSET_PATH = /^assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_ID = /^[A-Za-z0-9._:+-]{1,128}$/;
const DOWNLOAD_CONCURRENCY = 8;

/**
 * Validate an untrusted manifest (the previous deployment's, fetched over the
 * network). Throws on anything that is not exactly the schema.
 */
export function parseAssetManifest(value, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
  if (!isRecord(value) || value.schema !== ASSET_MANIFEST_SCHEMA || !Array.isArray(value.releases)) {
    throw new Error('assets manifest schema differs');
  }
  return { schema: ASSET_MANIFEST_SCHEMA, releases: value.releases.map((release) => parseRelease(release, maxFileBytes)) };
}

function parseRelease(release, maxFileBytes) {
  if (!isRecord(release) || typeof release.id !== 'string' || !RELEASE_ID.test(release.id) || !Array.isArray(release.assets)) {
    throw new Error('assets manifest release differs');
  }
  const seen = new Set();
  const assets = release.assets.map((asset) => {
    const entry = parseAsset(asset, maxFileBytes);
    if (seen.has(entry.path)) throw new Error(`assets manifest lists ${entry.path} twice`);
    seen.add(entry.path);
    return entry;
  });
  return { id: release.id, assets };
}

function parseAsset(asset, maxFileBytes) {
  const valid = isRecord(asset)
    && typeof asset.path === 'string' && ASSET_PATH.test(asset.path)
    && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && asset.bytes <= maxFileBytes
    && typeof asset.sha256 === 'string' && SHA256.test(asset.sha256);
  if (!valid) throw new Error(`assets manifest entry differs: ${JSON.stringify(asset)?.slice(0, 200)}`);
  return { path: asset.path, bytes: asset.bytes, sha256: asset.sha256 };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decide what the new deployment carries. Pure: no IO.
 *
 * @param {object} input
 * @param {{id: string, assets: Array<{path: string, bytes: number, sha256: string}>}} input.own
 *   the new build's release (its own /assets files)
 * @param {{releases: Array<object>} | null} input.previous the previous deployment's parsed manifest
 * @param {number} input.uploadFiles files the new build already uploads (all of dist, plus the manifest)
 * @param {object} [input.limits]
 */
export function planCarryForward({ own, previous, uploadFiles, limits = {} }) {
  const maxReleases = limits.maxReleases ?? MAX_CARRIED_RELEASES;
  const maxBytes = limits.maxCarriedBytes ?? MAX_CARRIED_BYTES;
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const ownByPath = new Map(own.assets.map((asset) => [asset.path, asset]));
  const state = { files: new Map(), bytes: 0, uploadFiles, releases: [], conflicts: [], dropped: [] };
  for (const release of (previous?.releases ?? []).slice(0, maxReleases)) {
    if (release.id === own.id) continue; // a redeploy of the same release carries nothing new
    const added = newFiles(release, ownByPath, state);
    const addedBytes = added.reduce((sum, asset) => sum + asset.bytes, 0);
    if (state.bytes + addedBytes > maxBytes || state.uploadFiles + added.length > maxFiles) {
      state.dropped.push(release.id); // whole releases only; older ones are dropped too
      break;
    }
    for (const asset of added) state.files.set(asset.path, asset);
    state.bytes += addedBytes;
    state.uploadFiles += added.length;
    state.releases.push({ id: release.id, assets: release.assets.filter((asset) => !conflicts(asset, ownByPath)) });
  }
  return {
    carry: [...state.files.values()],
    carriedBytes: state.bytes,
    conflicts: state.conflicts,
    dropped: state.dropped,
    manifest: { schema: ASSET_MANIFEST_SCHEMA, releases: [own, ...state.releases] },
  };
}

/** The release's files this upload does not have yet; same-path/other-bytes files are conflicts. */
function newFiles(release, ownByPath, state) {
  const added = [];
  for (const asset of release.assets) {
    if (conflicts(asset, ownByPath)) {
      state.conflicts.push(asset.path); // never overwrite a file of the new build
      continue;
    }
    if (ownByPath.has(asset.path)) continue; // identical bytes already in the new build
    const carried = state.files.get(asset.path);
    if (carried === undefined) added.push(asset); // parseAssetManifest rejects duplicate paths
    else if (carried.sha256 !== asset.sha256) {
      state.conflicts.push(asset.path); // the newer release's copy wins
    }
  }
  return added;
}

function conflicts(asset, ownByPath) {
  const mine = ownByPath.get(asset.path);
  return mine !== undefined && mine.sha256 !== asset.sha256;
}

/**
 * Why a request for an unknown /assets/<hash> would NOT be a real 404 on Pages.
 * Pages serves the SPA shell (200) for every unmatched path unless the upload
 * has a top-level 404.html; a `_redirects` rule matching /assets/* would also
 * turn a missing chunk into HTML. Empty array = a missing chunk stays a 404.
 */
export function missingAssetFallbackProblems({ hasTopLevel404, redirects }) {
  const problems = [];
  if (!hasTopLevel404) problems.push('no top-level 404.html: Pages would serve the SPA shell for a missing chunk');
  for (const line of redirects.split('\n')) {
    const source = line.trim().split(/\s+/)[0];
    if (!source || source.startsWith('#')) continue;
    if (redirectSourceMatchesAssets(source)) problems.push(`_redirects rule "${line.trim()}" matches /assets/*`);
  }
  return problems;
}

function redirectSourceMatchesAssets(source) {
  const pathname = source.replace(/^https?:\/\/[^/]+/, '');
  if (!pathname.startsWith('/')) return false;
  const pattern = pathname
    .split('/')
    .map((segment) => (segment === '*' ? '.*' : segment.startsWith(':') ? '[^/]+' : segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')))
    .join('/');
  return new RegExp(`^${pattern}$`).test('/assets/missing-0000.js');
}

// ---------------------------------------------------------------------------
// Filesystem + network layer.
// ---------------------------------------------------------------------------

function walkFiles(dir, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, root));
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The new build's own release: every file under dist/assets, hashed. */
export function readOwnRelease(distDir) {
  const assetsDir = path.join(distDir, 'assets');
  const assets = existsSync(assetsDir)
    ? walkFiles(assetsDir).sort().map((name) => {
      const bytes = readFileSync(path.join(assetsDir, name));
      return { path: `assets/${name}`, bytes: bytes.byteLength, sha256: sha256(bytes) };
    })
    : [];
  return { id: releaseId(distDir), assets };
}

function releaseId(distDir) {
  try {
    const commit = JSON.parse(readFileSync(path.join(distDir, 'build.json'), 'utf8')).commit;
    if (typeof commit === 'string' && RELEASE_ID.test(commit)) return commit;
  } catch {
    // fall through: an unidentified build still gets a stable content id
  }
  return `content-${sha256(Buffer.from(walkFiles(path.join(distDir, 'assets')).sort().join('\n'))).slice(0, 16)}`;
}

async function fetchPreviousManifest(origin, fetchImpl, maxFileBytes) {
  const response = await fetchImpl(new URL(`/${ASSET_MANIFEST_FILE}`, origin), { redirect: 'error' });
  // The first deploy after this shipped: the live release has no manifest yet.
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`previous assets manifest returned HTTP ${response.status}`);
  let value;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new Error('previous assets manifest is not JSON (an SPA fallback?)');
  }
  return parseAssetManifest(value, maxFileBytes);
}

async function downloadVerified(origin, asset, fetchImpl) {
  const response = await fetchImpl(new URL(`/${asset.path}`, origin), { redirect: 'error' });
  if (response.status !== 200) throw new Error(`carried asset ${asset.path} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
    throw new Error(`carried asset ${asset.path} differs from the previous manifest`);
  }
  return bytes;
}

async function downloadAll(origin, assets, fetchImpl) {
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const asset = assets[next++];
      results.set(asset.path, await downloadVerified(origin, asset, fetchImpl));
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, assets.length) }, worker));
  return results;
}

/**
 * Carry the previous releases' assets into `distDir` (in place) and write its
 * assets-manifest.json. `previousOrigin` null = no predecessor: the manifest
 * lists only this release. Every carried file is downloaded and verified
 * before the first one is written, so a failure leaves `distDir` untouched.
 */
export async function carryForwardAssets({ distDir, previousOrigin, fetch: fetchImpl = globalThis.fetch, limits = {} }) {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const redirectsFile = path.join(distDir, '_redirects');
  const problems = missingAssetFallbackProblems({
    hasTopLevel404: existsSync(path.join(distDir, '404.html')),
    redirects: existsSync(redirectsFile) ? readFileSync(redirectsFile, 'utf8') : '',
  });
  if (problems.length > 0) throw new Error(`a missing chunk would not 404: ${problems.join('; ')}`);
  const manifestPath = path.join(distDir, ASSET_MANIFEST_FILE);
  if (existsSync(manifestPath)) throw new Error(`${ASSET_MANIFEST_FILE} already exists: carry forward runs once per build`);
  const own = readOwnRelease(distDir);
  const previous = previousOrigin === null ? null : await fetchPreviousManifest(previousOrigin, fetchImpl, maxFileBytes);
  const plan = planCarryForward({ own, previous, uploadFiles: walkFiles(distDir).length + 1, limits });
  const bytes = plan.carry.length === 0 ? new Map() : await downloadAll(previousOrigin, plan.carry, fetchImpl);
  for (const asset of plan.carry) {
    // 'wx': fail rather than overwrite — a carried file can never replace a new one.
    writeFileSync(path.join(distDir, asset.path), bytes.get(asset.path), { flag: 'wx' });
  }
  writeFileSync(manifestPath, `${JSON.stringify(plan.manifest)}\n`, { flag: 'wx' });
  return {
    previousManifest: previous !== null,
    ownFiles: own.assets.length,
    carriedFiles: plan.carry.length,
    carriedBytes: plan.carriedBytes,
    carriedReleases: plan.manifest.releases.slice(1).map((release) => release.id),
    conflicts: plan.conflicts,
    dropped: plan.dropped,
  };
}

function parseCliArgs(argv) {
  const positional = [];
  const limits = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-files' || arg === '--max-file-bytes') {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${arg} needs a positive integer`);
      limits[arg === '--max-files' ? 'maxFiles' : 'maxFileBytes'] = value;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error('usage: carryForwardAssets.mjs <distDir> [previousOrigin] [--max-files N] [--max-file-bytes N]');
  }
  return { distDir: positional[0], previousOrigin: positional[1] ?? null, limits };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await carryForwardAssets(parseCliArgs(process.argv.slice(2)));
  const origin = summary.previousManifest ? 'previous manifest found' : 'no previous manifest';
  console.log(`Deploy skew carry-forward: ${origin}; ${summary.ownFiles} own assets; carried ${summary.carriedFiles} files `
    + `(${summary.carriedBytes} bytes) from [${summary.carriedReleases.join(', ')}]`
    + (summary.conflicts.length > 0 ? `; kept the new build's copy of ${summary.conflicts.join(', ')}` : '')
    + (summary.dropped.length > 0 ? `; over the bound, not carried: ${summary.dropped.join(', ')}` : ''));
}
