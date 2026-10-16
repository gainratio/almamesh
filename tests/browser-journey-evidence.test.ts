import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BROWSER_JOURNEY_STATUS_CHECK, browserJourneyArtifactName, browserJourneyEvidenceScript, browserJourneyFetchRequest, validateBrowserJourneyExitCode } from '../dagger/src/browserJourneyEvidence.ts';

const root = resolve(import.meta.dir, '..');
const sha = 'd'.repeat(40);

describe('browser journey evidence remains available on failure', () => {
  test('Chromium retains traces without relying on a retry', () => {
    const source = readFileSync(join(root, 'frontend/apps/web/playwright.time-travel.config.ts'), 'utf8');
    expect(source).toContain('trace: "retain-on-failure"');
    expect(source).not.toContain('trace: "on-first-retry"');
  });

  test('validates original process exits without converting failures into success', () => {
    for (const code of [0, 1, 3, 124, 255]) expect(validateBrowserJourneyExitCode(code)).toBe(code);
    for (const invalid of [-1, 256, NaN, Infinity, 0.5, '1', null]) expect(() => validateBrowserJourneyExitCode(invalid)).toThrow();
  });

  test('host status check preserves the original failure and rejects absent/corrupt/provenance-mismatched evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'almamesh-journey-status-'));
    const run = () => spawnSync('node', [join(root, BROWSER_JOURNEY_STATUS_CHECK)], { cwd: dir, env: { ...process.env, EXPECTED_SHA: sha }, encoding: 'utf8' });
    try {
      expect(run().status).not.toBe(0);
      mkdirSync(join(dir, 'browser-journeys-evidence'));
      const path = join(dir, 'browser-journeys-evidence/journey-status.json');
      for (const code of [0, 1, 3, 124]) {
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, commitSha: sha, exitCode: code, scanned: true }));
        expect(run().status).toBe(code);
      }
      for (const invalid of [{}, { schemaVersion: 1, commitSha: 'a'.repeat(40), exitCode: 0, scanned: true }, { schemaVersion: 1, commitSha: sha, exitCode: 0, scanned: false }, { schemaVersion: 1, commitSha: sha, exitCode: '0', scanned: true }]) {
        writeFileSync(path, JSON.stringify(invalid)); expect(run().status).not.toBe(0);
      }
      writeFileSync(path, 'PRIVATE malformed');
      const malformed = run(); expect(malformed.status).not.toBe(0); expect(malformed.stderr).not.toContain('PRIVATE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the Dagger status gate and this test run the same single status-check file', () => {
    expect(BROWSER_JOURNEY_STATUS_CHECK).toBe('frontend/apps/web/scripts/browserJourneyStatusCheck.mjs');
    expect(existsSync(join(root, BROWSER_JOURNEY_STATUS_CHECK))).toBe(true);
    const workflow = readFileSync(join(root, '.github/workflows/dagger.yml'), 'utf8');
    // Fleet rule shell-step: the workflow runs no shell; Dagger enforces the receipt.
    expect(workflow).not.toContain('run:');
    expect(workflow).not.toContain('journey-status.json');
    const source = readFileSync(join(root, 'dagger/src/index.ts'), 'utf8');
    const status = source.slice(source.indexOf('async browserJourneysStatus('), source.indexOf('private browserJourneysRun('));
    expect(status).toContain('browserJourneyFetchRequest(');
    expect(status).toContain('"node", BROWSER_JOURNEY_STATUS_CHECK');
    expect(status).toContain('withEnvVariable("EXPECTED_SHA", commitSha)');
  });

  test('the status gate fetches only this run\'s artifact for this exact SHA', () => {
    expect(browserJourneyArtifactName('b', sha)).toBe(`browser-journeys-evidence-b-${sha}`);
    expect(browserJourneyArtifactName('a', sha)).not.toBe(browserJourneyArtifactName('c', sha));
    expect(() => browserJourneyArtifactName('d' as never, sha)).toThrow('lane');
    expect(browserJourneyFetchRequest('a', 'gainratio/almamesh', '987654321', sha)).toEqual({
      repository: 'gainratio/almamesh', runId: '987654321', artifact: `browser-journeys-evidence-a-${sha}`,
    });
    for (const runId of ['', '0', '12a', '1 --name x', '${{ github.run_id }}']) {
      expect(() => browserJourneyFetchRequest('a', 'gainratio/almamesh', runId, sha)).toThrow('run id');
    }
    expect(() => browserJourneyFetchRequest('a', 'gainratio/almamesh', '1', 'D'.repeat(40))).toThrow('commit');
    expect(() => browserJourneyFetchRequest('a', 'evil/almamesh', '1', sha)).toThrow();
  });

  // gainratio/ci fleet rule arbitrary-command: a Dagger function's caller input may
  // reach withExec only in data positions of an array literal whose executable is a
  // fixed string. A whole argv held in a variable (even one built by a validating
  // helper) reads as caller-controlled command structure and fails the fleet run.
  test('the status gate fetch names its executable and flags literally (fleet rule arbitrary-command)', () => {
    const source = readFileSync(join(root, 'dagger/src/index.ts'), 'utf8');
    const status = source.slice(source.indexOf('async browserJourneysStatus('), source.indexOf('private browserJourneysRun('));
    const execs = [...status.matchAll(/\.withExec\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(execs.length).toBe(2);
    for (const argv of execs) {
      expect(argv).toMatch(/^\["[^"]+"/);
      expect(argv).not.toContain('...');
    }
    expect(execs[0]).toBe(
      '["python3", "/opt/fetch_run_artifact.py", "--repository", fetch.repository, "--run-id", fetch.runId, "--name", fetch.artifact, "--output", FETCHED_EVIDENCE]',
    );
  });

  test('collects only the named browser results, requires a successful scanner, and records original status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'almamesh-journey-evidence-'));
    try {
      mkdirSync(join(dir, 'browser-journeys-artifacts/time-travel'), { recursive: true });
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'browser-journeys-artifacts/time-travel/trace.zip'), 'synthetic test trace');
      writeFileSync(join(dir, 'private-note.txt'), 'PRIVATE');
      writeFileSync(join(dir, 'scripts/artifactLeakScan.mjs'), 'if(process.argv[2]!=="browser-journeys-evidence")process.exit(9)');
      const run = spawnSync('bash', ['-c', browserJourneyEvidenceScript(3, sha)], { cwd: dir, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'browser-journeys-evidence/journey-status.json'), 'utf8'))).toEqual({ schemaVersion: 1, commitSha: sha, exitCode: 3, scanned: true });
      expect(readFileSync(join(dir, 'browser-journeys-evidence/time-travel/trace.zip'), 'utf8')).toBe('synthetic test trace');
      expect(existsSync(join(dir, 'browser-journeys-evidence/private-note.txt'))).toBe(false);
      rmSync(join(dir, 'browser-journeys-evidence'), { recursive: true, force: true });
      writeFileSync(join(dir, 'scripts/artifactLeakScan.mjs'), 'process.exit(7)');
      expect(spawnSync('bash', ['-c', browserJourneyEvidenceScript(3, sha)], { cwd: dir }).status).toBe(7);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
