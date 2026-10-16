#!/usr/bin/env node
// Build this app TWICE, into dist-sw-update/deploy-skew/{a,b} (gitignored with
// the other two-build fixtures), for the deploy-skew gate
// (e2e/deploy-skew.e2e.spec.ts).
//
// The gate asks: "a tab opened on release A, still open when release B goes
// live, lazy-imports one of A's hashed chunks — does it load?" That needs two
// builds whose chunk hashes differ, like two real releases.
//
// B differs from A in the inlined `__APP_VERSION__` (a Vite `define` override
// passed to the build API) and in its file-name hash length, so EVERY hashed
// file is renamed: the shape of a release that touches a shared dependency.
// A version bump alone leaves leaf chunks byte-identical (measured: 75 of 102
// files), including `placeLookup-*.js`, the chunk the 2026-10-13 incident hit
// from an open chat tab, so the gate could not see the skew on it.
// Unlike build-sw-update-fixtures.mjs this never edits package.json, so a
// concurrent build in the same checkout is unaffected. Both builds are hooked
// (VITE_EXIT_GATE_HOOKS=1) so the spec can seed a chart without onboarding.
//
// A is then "deployed" as a release with no predecessor: the carry-forward
// step writes its assets-manifest.json (the file the next deploy reads). B is
// left as a plain build; the spec runs the carry-forward step on a copy of it,
// against the origin serving A, exactly as the production deploy does.
//
// Usage:  node scripts/build-skew-fixtures.mjs        (~2 builds, a few minutes)

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { carryForwardAssets } from './carryForwardAssets.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(appDir, 'dist-sw-update', 'deploy-skew');
const version = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;

/** One isolated `vite build` (own process: plugins keep per-build state). */
function build(label, appVersion, hash) {
  const target = path.join(outDir, label);
  rmSync(target, { recursive: true, force: true });
  console.log(`\n=== building skew fixture "${label}" (__APP_VERSION__=${appVersion}) ===`);
  const program = `import { build } from 'vite';
await build({
  root: ${JSON.stringify(appDir)},
  configFile: ${JSON.stringify(path.join(appDir, 'vite.config.ts'))},
  logLevel: 'warn',
  define: { __APP_VERSION__: ${JSON.stringify(JSON.stringify(appVersion))} },
  build: {
    outDir: ${JSON.stringify(target)},
    emptyOutDir: true,
    rollupOptions: { output: {
      entryFileNames: 'assets/[name]-${hash}.js',
      chunkFileNames: 'assets/[name]-${hash}.js',
      assetFileNames: 'assets/[name]-${hash}.[ext]',
    } },
  },
});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_API_URL: '', VITE_EXIT_GATE_HOOKS: '1', BUILD_COMMIT: label.repeat(40) },
  });
  const html = readFileSync(path.join(target, 'index.html'), 'utf8');
  return html.match(/<script[^>]+src="(\/assets\/index-[^"]+)"/)?.[1];
}

const entryA = build('a', version, '[hash]');
const entryB = build('b', `${version}-skew-fixture`, '[hash:10]');
if (!entryA || !entryB || entryA === entryB) {
  throw new Error(`the two fixtures must differ — got a=${entryA} b=${entryB}. Identical builds prove nothing.`);
}
const summary = await carryForwardAssets({ distDir: path.join(outDir, 'a'), previousOrigin: null });
console.log(`release A manifest: ${summary.ownFiles} own assets, ${summary.carriedFiles} carried`);
console.log(`\nfixtures ready in ${outDir} (a=${entryA}, b=${entryB})`);
