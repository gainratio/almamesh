import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PUBLIC_ENV_NAMES,
  envNeedles,
  netrcNeedles,
  gitconfigNeedles,
  scanDirectory,
} from '../../scripts/artifactLeakScan.mjs';

const SCRIPT = resolve(__dirname, '../../scripts/artifactLeakScan.mjs');
/**
 * Fixture secrets are made at runtime, so nothing in this file looks like a
 * credential to a secret scanner. Mixed case, so case-insensitive matching is
 * exercised too.
 */
function fakeValue(): string {
  return ['Fx', randomBytes(12).toString('hex'), 'Qz'].join('');
}
const SECRET = fakeValue();
const b64 = (text: string): string => Buffer.from(text).toString('base64');
const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-leak-scan-'));
  roots.push(dir);
  return dir;
}

function evidenceDir(files: Record<string, string | Uint8Array>): string {
  const dir = tempDir();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('envNeedles', () => {
  it('takes every value of 8 or more characters and skips the listed public names', () => {
    const labels = envNeedles({ TOKEN: SECRET, SHORT: '1234567', HOME: '/Users/runner', PATH: '/usr/bin:/bin' }).map((needle) => needle.label);
    expect(labels).toEqual(['environment variable TOKEN']);
  });

  it('lists PATH, HOME and TMPDIR as public, and never a token-shaped name', () => {
    expect(PUBLIC_ENV_NAMES).toEqual(expect.arrayContaining(['PATH', 'HOME', 'TMPDIR', 'GITHUB_WORKSPACE']));
    expect(PUBLIC_ENV_NAMES.filter((name: string) => /TOKEN|SECRET|KEY|PASS|AUTH|CRED/.test(name))).toEqual([]);
  });
});

describe('scanDirectory', () => {
  it('passes a clean directory', () => {
    const dir = evidenceDir({ 'a/webkit-browser.log': 'page closed\n', 'machine.txt': 'macOS 15' });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual([]);
  });

  it('finds an environment value in a nested file', () => {
    const dir = evidenceDir({ 'portable-invariants/t/webkit-browser.log': `x ${SECRET} y` });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('finds a value written URL-encoded, JSON-escaped or base64', () => {
    const value = `p@ss/${fakeValue()}"with+chars`;
    const needles = envNeedles({ A: value });
    for (const written of [encodeURIComponent(value), JSON.stringify(value), Buffer.from(value).toString('base64')]) {
      expect(scanDirectory(evidenceDir({ 'x.txt': written }), needles)).toEqual(['environment variable A']);
    }
  });

  it.each([
    ['base64 at byte offset 0', (v: string) => `basic ${b64(`abc${v}`)}`],
    ['base64 at byte offset 1', (v: string) => `basic ${b64(`x:${v}tail`)}`],
    ['base64 at byte offset 2', (v: string) => `basic ${b64(`:${v}tail`)}`],
    ['lowercase hex', (v: string) => Buffer.from(v).toString('hex')],
    ['uppercase hex', (v: string) => Buffer.from(v).toString('hex').toUpperCase()],
    ['UTF-16LE', (v: string) => Buffer.from(v, 'utf16le')],
    ['lowercased', (v: string) => v.toLowerCase()],
    ['uppercased', (v: string) => v.toUpperCase()],
  ])('finds a value written as %s', (_name, write) => {
    expect(scanDirectory(evidenceDir({ 'x.log': write(SECRET) }), envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('finds a value written as base64url, whose characters differ from base64', () => {
    const value = `${fakeValue()}???>>>`;
    const written = `${Buffer.from(`q${value}`).toString('base64url')}_-`;
    expect(written).toMatch(/[-_]/);
    expect(scanDirectory(evidenceDir({ 'x.log': written }), envNeedles({ TOKEN: value }))).toEqual(['environment variable TOKEN']);
  });

  it('finds a zip after a stray zip signature earlier in the file', () => {
    const zip = zipSync({ 'a.txt': strToU8(`x=${SECRET}`) });
    const file = Buffer.concat([Buffer.from('PK\x03\x04 not a zip', 'latin1'), Buffer.from(zip)]);
    const dir = evidenceDir({ 't.bin': Buffer.concat([Buffer.from('header '), file]) });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('finds a value inside a gzip file', () => {
    const dir = evidenceDir({ 'a.log.gz': gzipSync(`x=${SECRET}`) });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('fails closed on a gzip file it cannot open', () => {
    const dir = evidenceDir({ 'a.log.gz': Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not gzip')]) });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['an unreadable gzip file']);
  });

  it('finds a value inside a zip that does not start the file', () => {
    const zip = zipSync({ 'a.txt': strToU8(`x=${SECRET}`) });
    const dir = evidenceDir({ 't.bin': Buffer.concat([Buffer.from('junk header'), Buffer.from(zip)]) });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('passes a binary file that merely contains the zip signature, as a video can by chance', () => {
    const video = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32), Buffer.from('PK\x03\x04', 'latin1'), randomBytes(64)]);
    expect(scanDirectory(evidenceDir({ 'v.webm': video }), envNeedles({ TOKEN: SECRET }))).toEqual([]);
  });

  it('finds a value inside a compressed zip, the way Playwright writes a trace', () => {
    const trace = zipSync({ 'trace.trace': strToU8(`{"env":"${SECRET}"}`), 'nested.zip': zipSync({ 'inner.txt': strToU8('clean') }) });
    const dir = evidenceDir({ 'time-travel/t/trace.zip': trace });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('finds a value in a zip nested inside a zip', () => {
    const outer = zipSync({ 'inner.zip': zipSync({ 'x.txt': strToU8(SECRET) }) });
    expect(scanDirectory(evidenceDir({ 'trace.zip': outer }), envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('fails closed on a zip it cannot open, since it cannot see inside', () => {
    const dir = evidenceDir({ 'trace.zip': Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('not a zip')]) });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['an unreadable zip file']);
  });

  it('finds a value in a file name', () => {
    const dir = evidenceDir({ [`crash-reports/${SECRET}.txt`]: 'clean' });
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['environment variable TOKEN']);
  });

  it('reports a symbolic link, which an upload would follow out of the directory', () => {
    const dir = evidenceDir({ 'machine.txt': 'clean' });
    symlinkSync(tmpdir(), join(dir, 'escape'));
    expect(scanDirectory(dir, envNeedles({ TOKEN: SECRET }))).toEqual(['a symbolic link']);
  });

  it('finds ~/.gitconfig content, line by line', () => {
    const header = `extraheader = AUTHORIZATION: basic ${b64(`x:${SECRET}`)}`;
    const needles = gitconfigNeedles(`[credential]\n\thelper = store\n[http]\n\t${header}\n`);
    const dir = evidenceDir({ 'unified-log.txt': header });
    expect(scanDirectory(dir, needles)).toEqual(['~/.gitconfig line 4']);
  });

  it('takes the values and quoted section names of ~/.gitconfig, not its generic keys', () => {
    const token = fakeValue();
    const needles = gitconfigNeedles(`[credential]\n\thelper =\n\thelper = osxkeychain\n[lfs]\n\trequired = true\n[url "https://x:${token}@example.com/"]\n\tinsteadOf = https://example.com/\n[credential "https://github.com"]\n`);
    expect(needles.map((needle) => needle.label)).toEqual(['~/.gitconfig line 3', '~/.gitconfig line 6', '~/.gitconfig line 7']);
    expect(scanDirectory(evidenceDir({ 'page.js': 'fetch("https://github.com/x")' }), needles)).toEqual([]);
    const dir = evidenceDir({ 'wasm.txt': 'TBroadcastHelper = onnxruntime; required = true', 'url.log': `https://x:${token}@example.com/` });
    expect(scanDirectory(dir, needles)).toEqual(['~/.gitconfig line 6']);
  });

  it('finds a ~/.netrc password on its own', () => {
    const needles = netrcNeedles(`machine github.com login x-access-token password ${SECRET}\n`);
    expect(scanDirectory(evidenceDir({ 'x.log': `pw=${SECRET}` }), needles)).toEqual(['~/.netrc password']);
  });
});

describe('the command line', () => {
  function runScan(dir: string, env: Record<string, string>, home = tempDir()) {
    return spawnSync('node', [SCRIPT, dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, ...env } });
  }

  it('exits 0 and keeps a clean directory', () => {
    const dir = evidenceDir({ 'machine.txt': 'macOS 15' });
    const result = runScan(dir, { LANE_TOKEN: SECRET });
    expect(result.status).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('on a leak prints only the variable name, deletes the directory and exits 1', () => {
    const dir = evidenceDir({ 'portable-invariants/t/webkit-1-browser.log': `leak ${SECRET}` });
    const result = runScan(dir, { LANE_TOKEN: SECRET });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('environment variable LANE_TOKEN');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(existsSync(dir)).toBe(false);
  });

  it('finds the contents of ~/.gitconfig and ~/.netrc from HOME', () => {
    const home = tempDir();
    writeFileSync(join(home, '.gitconfig'), '[user]\n\temail = someone@example.com\n');
    writeFileSync(join(home, '.netrc'), `machine example.com login me password ${SECRET}\n`);
    const dir = evidenceDir({ 'a.txt': 'email = someone@example.com', 'b.txt': SECRET });
    const result = runScan(dir, {}, home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('~/.gitconfig line 2');
    expect(result.stderr).toContain('~/.netrc password');
    expect(result.stdout + result.stderr).not.toContain('someone@example.com');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
  });

  it('passes when the directory does not exist, so a lane that died early still reports', () => {
    const result = runScan(join(tempDir(), 'missing'), { LANE_TOKEN: SECRET });
    expect(result.status).toBe(0);
  });

  it('refuses to run without a directory', () => {
    expect(() => execFileSync('node', [SCRIPT], { stdio: 'pipe' })).toThrow();
  });
});
