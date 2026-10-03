import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Release timing is not a trust boundary. AlmaMesh accepts exact registry
// artifacts immediately and verifies them through frozen locks, integrity data,
// provenance contracts, and unsuppressed audits.

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNFIG_PATH = resolve(HERE, '../../../../bunfig.toml');
const BROWSER_PACKAGE_PATH = resolve(HERE, '../../../../packages/browser/package.json');
const BUN_LOCK_PATH = resolve(HERE, '../../../../bun.lock');
const ASSAY_VERSION = '0.5.0-dev.6';
const ASSAY_SRI =
  'sha512-VOH1brU6gHHOZ1jRO4DXRPseSCnOLAlKewlfuzYumG3Kswb9KvrngoN5mPv7rdw61O3EuqGQO+WFPON8AV3NzQ==';

function activeLines(toml: string): string[] {
  return toml
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter((line) => line.length > 0);
}

function readBunfig(): string {
  return existsSync(BUNFIG_PATH) ? readFileSync(BUNFIG_PATH, 'utf8') : '';
}

describe('registry dependency timing policy', () => {
  it('does not delay exact registry artifacts based on publication age', () => {
    const releaseAgePolicy = activeLines(readBunfig()).filter((line) =>
      line.startsWith('minimumReleaseAge'),
    );
    expect(releaseAgePolicy).toEqual([]);
  });

  it('pins the reviewed Assay npm artifact and registry integrity', () => {
    const manifest = JSON.parse(readFileSync(BROWSER_PACKAGE_PATH, 'utf8'));
    const lock = readFileSync(BUN_LOCK_PATH, 'utf8');
    expect(manifest.dependencies?.['@gainratio/assay']).toBe(ASSAY_VERSION);
    expect(lock).toContain(`"@gainratio/assay": ["@gainratio/assay@${ASSAY_VERSION}"`);
    expect(lock).toContain(`"${ASSAY_SRI}"`);
  });
});

// The owner's own Legos moved from the deprecated @edgeproc npm scope to
// @gainratio (avow 0.5.2 changed the receipt envelope: `schema` is now
// required and ReplayMismatch became PayloadHashMismatch). A manifest that
// still names an @edgeproc package would install a deprecated, frozen copy.
const WORKSPACE_MANIFESTS = [
  '../../../../package.json',
  '../../package.json',
  '../../../../packages/browser/package.json',
  '../../../../packages/memory/package.json',
  '../../../../packages/store/package.json',
] as const;

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readManifest(relative: string): Manifest {
  return JSON.parse(readFileSync(resolve(HERE, relative), 'utf8')) as Manifest;
}

describe('own-library dependency policy', () => {
  it('names no deprecated @edgeproc package in any workspace manifest', () => {
    const stale = WORKSPACE_MANIFESTS.flatMap((relative) => {
      const manifest = readManifest(relative);
      return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
        .filter((name) => name.startsWith('@edgeproc/'))
        .map((name) => `${relative}: ${name}`);
    });
    expect(stale).toEqual([]);
  });

  it('tracks the newest avow, receipt-ui, and errors releases', () => {
    const web = readManifest('../../package.json');
    const browser = readManifest('../../../../packages/browser/package.json');
    expect(web.dependencies?.['@gainratio/errors']).toBe('^0.2.1');
    expect(web.dependencies?.['@gainratio/receipt-ui']).toBe('0.3.0');
    expect(web.devDependencies?.['@gainratio/avow']).toBe('^0.5.2');
    expect(browser.dependencies?.['@gainratio/avow']).toBe('^0.5.2');
  });
});
