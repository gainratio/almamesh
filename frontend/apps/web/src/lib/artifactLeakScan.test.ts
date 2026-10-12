import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const LANE_SCRIPT = resolve(__dirname, '../../scripts/webkit-macos-lane.sh');
/**
 * Fixture secrets are made at runtime, so nothing in this file looks like a
 * credential to a secret scanner. Mixed case, so case-insensitive matching is
 * exercised too.
 */
function fakeValue(): string {
  return ['Fx', randomBytes(12).toString('hex'), 'Qz'].join('');
}
const SECRET = fakeValue();
const HOMEBREW_PATHS = {
  HOMEBREW_CELLAR: '/opt/homebrew/Cellar',
  HOMEBREW_PREFIX: '/opt/homebrew',
  HOMEBREW_REPOSITORY: '/opt/homebrew',
};
const PUBLIC_CI_PROVENANCE = {
  GITHUB_RUN_ID: '38175621224',
  GITHUB_WORKFLOW_SHA: 'a5d1c61cc1968f40b2495c6db083ad7ffdc3f3f6',
};
const PUBLIC_ACTION = { GITHUB_ACTION: 'leak-scan' };
const PRIVATE_ACTION_NAMES = ['GITHUB_ACTION_TOKEN', 'GITHUB_ACTION_SECRET', 'GITHUB_ACTION_CONTROL', 'UNRELATED_API_KEY'];
const PRIVATE_CI_NAMES = [
  'GITHUB_TOKEN', 'GITHUB_SECRET', 'GITHUB_RUN_ID_SECRET', 'GITHUB_WORKFLOW_SHA_SECRET',
  'GITHUB_RUN_ID_CONTROL', 'GITHUB_WORKFLOW_SHA_CONTROL',
];
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

function runScan(dir: string, env: Record<string, string>, home = tempDir()) {
  const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, ...env } });
  if (result.error) throw result.error;
  return result;
}

function finalizeLane(sandbox: string, mode: string) {
  const result = spawnSync('bash', [LANE_SCRIPT, '--finalize-evidence', mode], {
    cwd: sandbox, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: sandbox },
  });
  if (result.error) throw result.error;
  return result;
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

  it.each(Object.entries(HOMEBREW_PATHS))('excludes the exact public installation metadata name %s', (name, value) => {
    expect(envNeedles({ [name]: value })).toEqual([]);
  });

  it.each(Object.entries(PUBLIC_CI_PROVENANCE))('excludes the exact public CI provenance name %s', (name, value) => {
    expect(PUBLIC_ENV_NAMES).toContain(name);
    expect(envNeedles({ [name]: value })).toEqual([]);
  });

  it('excludes only the exact public GITHUB_ACTION step ID name', () => {
    expect(PUBLIC_ENV_NAMES).toContain('GITHUB_ACTION');
    expect(envNeedles(PUBLIC_ACTION)).toEqual([]);
  });

  it('retains a credential needle sharing the public action step ID', () => {
    const needles = envNeedles({ ...PUBLIC_ACTION, GITHUB_TOKEN: PUBLIC_ACTION.GITHUB_ACTION });
    expect(needles.map((needle) => needle.label)).toEqual(['environment variable GITHUB_TOKEN']);
    expect(scanDirectory(evidenceDir({ 'worker.log': PUBLIC_ACTION.GITHUB_ACTION }), needles)).toEqual(['environment variable GITHUB_TOKEN']);
  });

  it.each(PRIVATE_ACTION_NAMES)('retains the exact credential or control name %s beside public action metadata', (name) => {
    const needles = envNeedles({ ...PUBLIC_ACTION, [name]: SECRET });
    expect(needles.map((needle) => needle.label)).toEqual([`environment variable ${name}`]);
    expect(scanDirectory(evidenceDir({ 'worker.log': SECRET }), needles)).toEqual([`environment variable ${name}`]);
  });

  it.each(Object.entries(PUBLIC_CI_PROVENANCE))('retains a secret needle sharing the public %s value', (_name, value) => {
    const needles = envNeedles({ ...PUBLIC_CI_PROVENANCE, GITHUB_TOKEN: value });
    expect(needles.map((needle) => needle.label)).toEqual(['environment variable GITHUB_TOKEN']);
    expect(scanDirectory(evidenceDir({ 'worker.log': value }), needles)).toEqual(['environment variable GITHUB_TOKEN']);
  });

  it.each(PRIVATE_CI_NAMES)('still scans the neighboring CI secret or control name %s', (name) => {
    const needles = envNeedles({ ...PUBLIC_CI_PROVENANCE, [name]: SECRET });
    expect(needles.map((needle) => needle.label)).toContain(`environment variable ${name}`);
    expect(scanDirectory(evidenceDir({ 'worker.log': SECRET }), needles)).toEqual([`environment variable ${name}`]);
  });

  it.each(['HOMEBREW_GITHUB_API_TOKEN', 'HOMEBREW_PASSWORD', 'HOMEBREW_CELLAR_SECRET', 'UNRELATED_API_KEY'])(
    'still scans the unlisted environment secret %s', (name) => {
      const needles = envNeedles({ ...HOMEBREW_PATHS, [name]: SECRET });
      expect(needles.map((needle) => needle.label)).toContain(`environment variable ${name}`);
      expect(scanDirectory(evidenceDir({ 'worker.log': SECRET }), needles)).toEqual([`environment variable ${name}`]);
    },
  );
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
  it('exits 0 and keeps a clean directory', () => {
    const dir = evidenceDir({ 'machine.txt': 'macOS 15' });
    const result = runScan(dir, { LANE_TOKEN: SECRET });
    expect(result.status).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps evidence containing only public Homebrew installation paths', () => {
    const dir = evidenceDir({ 'webkit-browser.log': Object.values(HOMEBREW_PATHS).join('\n') });
    const result = runScan(dir, HOMEBREW_PATHS);
    expect(result.status).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a real trace artifact containing the public CI run URL and full workflow SHA', () => {
    const trace = zipSync({ 'trace.trace': strToU8(JSON.stringify({
      ci: { runUrl: `https://github.com/gainratio/almamesh/actions/runs/${PUBLIC_CI_PROVENANCE.GITHUB_RUN_ID}` },
      workflowSha: PUBLIC_CI_PROVENANCE.GITHUB_WORKFLOW_SHA,
    })) });
    const dir = evidenceDir({
      'time-travel/t/trace.zip': trace,
      'machine.txt': `workflow checkout: ${PUBLIC_CI_PROVENANCE.GITHUB_WORKFLOW_SHA}`,
    });
    const result = runScan(dir, { ...PUBLIC_CI_PROVENANCE, GITHUB_TOKEN: SECRET });
    expect(result.status).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it.each(['plain', 'zip'])('keeps a %s artifact containing the public GITHUB_ACTION step ID', (format) => {
    const value = PUBLIC_ACTION.GITHUB_ACTION;
    const dir = evidenceDir(format === 'zip'
      ? { 'trace.zip': zipSync({ 'trace.trace': strToU8(value) }) }
      : { 'worker.log': value });
    const result = runScan(dir, { ...PUBLIC_ACTION, GITHUB_TOKEN: SECRET });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it.each(['plain', 'zip'])('deletes a %s artifact when a credential shares the public action step ID', (format) => {
    const value = PUBLIC_ACTION.GITHUB_ACTION;
    const dir = evidenceDir(format === 'zip'
      ? { 'trace.zip': zipSync({ 'trace.trace': strToU8(value) }) }
      : { 'worker.log': value });
    const result = runScan(dir, { ...PUBLIC_ACTION, GITHUB_TOKEN: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('environment variable GITHUB_TOKEN');
    expect(existsSync(dir)).toBe(false);
  });

  it.each(PRIVATE_ACTION_NAMES)('deletes artifacts containing %s despite public action metadata', (name) => {
    const dir = evidenceDir({ 'worker.log': SECRET });
    const result = runScan(dir, { ...PUBLIC_ACTION, [name]: SECRET });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`environment variable ${name}`);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(existsSync(dir)).toBe(false);
  });

  it.each(Object.entries(PUBLIC_CI_PROVENANCE))('deletes an artifact when a secret shares the public %s value', (_name, value) => {
    const dir = evidenceDir({ 'machine.txt': value });
    const result = runScan(dir, { ...PUBLIC_CI_PROVENANCE, GITHUB_TOKEN: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('environment variable GITHUB_TOKEN');
    expect(result.stdout + result.stderr).not.toContain(value);
    expect(existsSync(dir)).toBe(false);
  });

  it.each(PRIVATE_CI_NAMES)('deletes an artifact containing the neighboring CI secret or control %s', (name) => {
    const dir = evidenceDir({ 'worker.log': SECRET });
    const result = runScan(dir, { ...PUBLIC_CI_PROVENANCE, [name]: SECRET });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`environment variable ${name}`);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(existsSync(dir)).toBe(false);
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
    expect(() => execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' })).toThrow();
  });
});

describe('finalized macOS lane evidence', () => {
  it.each(['memory', 'travel', 'portable', 'functional', 'all'])('finalizes and scans the actual %s snapshot independently of later raw evidence changes', (mode) => {
    const sandbox = tempDir();
    const source = join(sandbox, mode === 'all' ? 'webkit-lane-artifacts' : `webkit-lane-artifacts-${mode}`);
    const snapshot = join(sandbox, `webkit-lane-evidence-${mode}`);
    const trace = Buffer.from(zipSync({ 'trace.trace': strToU8('completed travel evidence\n') }));
    mkdirSync(source);
    writeFileSync(join(source, '.lane-cleanup-finished'), '');
    writeFileSync(join(source, 'completed.log'), 'completed evidence\n');
    writeFileSync(join(source, 'trace.zip'), trace);

    const finalized = finalizeLane(sandbox, mode);
    expect(finalized.status, finalized.stderr).toBe(0);
    expect(readFileSync(join(snapshot, 'completed.log'), 'utf8')).toBe('completed evidence\n');
    expect(readFileSync(join(snapshot, 'trace.zip'))).toEqual(trace);
    writeFileSync(join(source, 'completed.log'), SECRET);

    const scanned = runScan(snapshot, { LANE_TOKEN: SECRET }, sandbox);
    expect(scanned.status, scanned.stderr).toBe(0);
    expect(scanned.stdout).toContain(`artifact leak scan: ${snapshot} is clean`);
    expect(readFileSync(join(source, 'completed.log'), 'utf8')).toBe(SECRET);
    expect(readFileSync(join(snapshot, 'completed.log'), 'utf8')).toBe('completed evidence\n');
    expect(readFileSync(join(snapshot, 'trace.zip'))).toEqual(trace);
  });

  it('scans the unchanged finalized copy while an actual detached writer continues changing its raw source', async () => {
    const sandbox = tempDir();
    const source = join(sandbox, 'webkit-lane-artifacts-functional');
    const snapshot = join(sandbox, 'webkit-lane-evidence-functional');
    const sourceLog = join(source, 'detached-writer.log');
    mkdirSync(source);
    writeFileSync(join(source, '.lane-cleanup-finished'), '');
    const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.argv[1],"sample\\n"),10)', sourceLog], {
      detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: sandbox },
    });
    let spawnError: Error | undefined;
    let exitDescription: string | undefined;
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2048); });
    const exited = new Promise<void>((done) => {
      child.once('error', (error) => { spawnError = error; done(); });
      child.once('exit', (code, signal) => { exitDescription = `code=${code}, signal=${signal}`; done(); });
    });
    try {
      const waitFor = async (predicate: () => boolean) => {
        const ready = () => {
          if (spawnError) throw spawnError;
          if (exitDescription) throw new Error(`Detached writer exited before snapshot verification (${exitDescription}): ${stderr}`);
          return predicate();
        };
        const deadline = Date.now() + 3000;
        while (!ready() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
        expect(ready()).toBe(true);
      };
      await waitFor(() => existsSync(sourceLog));
      if (child.pid === undefined) throw new Error('Detached writer has no process ID');
      expect(process.kill(-child.pid, 0)).toBe(true);

      const finalized = finalizeLane(sandbox, 'functional');
      expect(finalized.status, finalized.stderr).toBe(0);
      const snapshotLog = join(snapshot, 'detached-writer.log');
      const copied = readFileSync(snapshotLog, 'utf8');
      await waitFor(() => readFileSync(sourceLog, 'utf8').length > copied.length);
      expect(readFileSync(snapshotLog, 'utf8')).toBe(copied);

      const scanned = runScan(snapshot, { LANE_TOKEN: SECRET }, sandbox);
      expect(scanned.status, scanned.stderr).toBe(0);
      expect(scanned.stdout).toContain(`artifact leak scan: ${snapshot} is clean`);
      expect(readFileSync(snapshotLog, 'utf8')).toBe(copied);
      expect(readFileSync(sourceLog, 'utf8').length).toBeGreaterThan(copied.length);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  });
});
