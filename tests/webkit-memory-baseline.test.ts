import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  parseLocalBaselineMiB,
  REFERENCE_RELEASE_COMMIT,
  summarizeWebKitBaseline,
} from '../frontend/apps/web/scripts/webkit-memory-baseline.mjs';

const MEASUREMENT_COMMIT = '1234567890abcdef1234567890abcdef12345678';
const samples = [1038, 1042, 1022, 1047, 1056];
const options = { measurementCommit: MEASUREMENT_COMMIT };

function report() {
  return {
    config: { version: '1.63.0' }, errors: [],
    suites: [{ suites: [{ specs: [{ tests: samples.map((rss, repeatEachIndex) => ({
      projectName: 'iphone-15-webkit', expectedStatus: 'passed', status: 'expected',
      results: [{ status: 'passed', retry: 0, attachments: [{
        name: 'time-travel-memory.json', contentType: 'application/json',
        body: Buffer.from(JSON.stringify({
          lane: 'iphone-15-webkit', kind: 'boot-baseline', completed: true, repeatEachIndex,
          peakSingleWebMiB: rss,
          reference: {
            expectedCommit: REFERENCE_RELEASE_COMMIT,
            servedCommit: REFERENCE_RELEASE_COMMIT,
            measurementCommit: MEASUREMENT_COMMIT,
            platform: 'darwin', buildVersion: 'reference-build',
          },
        })).toString('base64'),
      }] }],
    })) }] }] }],
  };
}

type Report = ReturnType<typeof report>;
const tests = (value: Report) => value.suites[0].suites[0].specs[0].tests;
function mutateSample(value: Report, mutate: (sample: Record<string, unknown>) => void) {
  const attachment = tests(value)[0].results[0].attachments[0];
  const sample = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
  mutate(sample);
  attachment.body = Buffer.from(JSON.stringify(sample)).toString('base64');
}

describe('hosted WebKit original-release baseline', () => {
  test('retains all five original samples and selects their maximum', () => {
    const result = summarizeWebKitBaseline(report(), options);
    expect(result).toMatchObject({
      schemaVersion: 1, source: 'same-host-original-release',
      referenceCommit: REFERENCE_RELEASE_COMMIT,
      measurementCommit: MEASUREMENT_COMMIT, playwrightVersion: '1.63.0',
      sampleCount: 5, samplesMiB: samples, baselineMiB: 1056,
    });
  });

  test.each([4, 6])('refuses %i samples', (count) => {
    const value = report();
    if (count === 4) tests(value).pop();
    else tests(value).push(structuredClone(tests(value)[0]));
    expect(() => summarizeWebKitBaseline(value, options)).toThrow();
  });

  test.each([0, -1, null, '1056', 'NaN'])('refuses an invalid RSS sample %j', (rss) => {
    const value = report();
    mutateSample(value, (sample) => { sample.peakSingleWebMiB = rss; });
    expect(() => summarizeWebKitBaseline(value, options)).toThrow();
  });

  test.each([
    ['incomplete boot', (sample: Record<string, unknown>) => { sample.completed = false; }],
    ['candidate journey', (sample: Record<string, unknown>) => { sample.kind = 'journey'; }],
    ['missing provenance', (sample: Record<string, unknown>) => { delete sample.reference; }],
    ['candidate served commit', (sample: Record<string, unknown>) => {
      (sample.reference as Record<string, unknown>).servedCommit = MEASUREMENT_COMMIT;
    }],
    ['wrong sampler commit', (sample: Record<string, unknown>) => {
      (sample.reference as Record<string, unknown>).measurementCommit = REFERENCE_RELEASE_COMMIT;
    }],
    ['non-Mac measurement', (sample: Record<string, unknown>) => {
      (sample.reference as Record<string, unknown>).platform = 'linux';
    }],
  ] as const)('refuses %s', (_name, mutate) => {
    const value = report();
    mutateSample(value, mutate);
    expect(() => summarizeWebKitBaseline(value, options)).toThrow();
  });

  test('refuses failed, retried, duplicated or wrong-device results', () => {
    const invalid = [
      (value: Report) => { tests(value)[0].results[0].status = 'failed'; },
      (value: Report) => { tests(value)[0].results[0].retry = 1; },
      (value: Report) => { tests(value)[0].results.push(structuredClone(tests(value)[0].results[0])); },
      (value: Report) => { mutateSample(value, (sample) => { sample.repeatEachIndex = 1; }); },
      (value: Report) => { tests(value)[0].projectName = 'webkit'; },
      (value: Report) => { tests(value)[0].results[0].attachments = []; },
    ];
    for (const mutate of invalid) {
      const value = report();
      mutate(value);
      expect(() => summarizeWebKitBaseline(value, options)).toThrow();
    }
  });

  test('refuses global runner errors and mismatched reference builds', () => {
    const errors = { ...report(), errors: [{ message: 'runner failed' }] };
    expect(() => summarizeWebKitBaseline(errors, options)).toThrow();
    const mismatched = report();
    mutateSample(mismatched, (sample) => {
      (sample.reference as Record<string, unknown>).buildVersion = 'another-build';
    });
    expect(() => summarizeWebKitBaseline(mismatched, options)).toThrow();
  });

  test('refuses a passing result that the runner classifies as unexpected', () => {
    const value = report();
    tests(value)[0].status = 'unexpected';
    expect(() => summarizeWebKitBaseline(value, options)).toThrow();
  });

  test('refuses to identify candidate measurements as the original release', () => {
    expect(() => summarizeWebKitBaseline(report(), { measurementCommit: REFERENCE_RELEASE_COMMIT })).toThrow(/measurement commit/);
  });
});

describe('explicit already-measured local baseline', () => {
  test.each([undefined, '', ' ', 'NaN', 'Infinity', '-1', '0'])('refuses %j', (value) => {
    expect(() => parseLocalBaselineMiB(value)).toThrow();
  });
  test('accepts a finite positive local measurement without treating it as hosted evidence', () => {
    expect(parseLocalBaselineMiB(' 1056.25 ')).toBe(1056.25);
  });
});

describe('baseline CLI provenance', () => {
  const helper = resolve(import.meta.dir, '../frontend/apps/web/scripts/webkit-memory-baseline.mjs');
  function runFixture(source: 'report' | 'local', ci: string, input?: object) {
    const directory = mkdtempSync(join(tmpdir(), 'almamesh-webkit-baseline-test-'));
    const evidencePath = join(directory, 'provenance.json');
    try {
      const reportPath = join(directory, 'report.json');
      writeFileSync(reportPath, JSON.stringify(input ?? report()));
      const result = Bun.spawnSync({
        cmd: [process.execPath, helper,
          ...(source === 'report' ? ['--report', reportPath] : ['--local-baseline', '1056.25']),
          '--measurement-commit', MEASUREMENT_COMMIT, '--provenance', evidencePath],
        env: { ...process.env, CI: ci }, stdout: 'pipe', stderr: 'pipe',
      });
      return {
        code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(),
        evidence: existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null,
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test('writes same-host sample provenance before emitting the numeric cap', () => {
    const result = runFixture('report', '1');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('1056\n');
    expect(result.evidence).toMatchObject({
      source: 'same-host-original-release', referenceCommit: REFERENCE_RELEASE_COMMIT,
      measurementCommit: MEASUREMENT_COMMIT, sampleCount: 5, samplesMiB: samples,
      machine: { platform: process.platform },
    });
  });

  test('does not produce a cap or provenance for an incomplete hosted report', () => {
    const input = report();
    tests(input).pop();
    const result = runFixture('report', '1', input);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.evidence).toBeNull();
  });

  test('rejects caller-supplied local scalars in CI', () => {
    const result = runFixture('local', 'true');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('hosted CI cannot use');
    expect(result.evidence).toBeNull();
  });

  test('labels an explicit local scalar as local evidence', () => {
    const result = runFixture('local', '');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('1056.25\n');
    expect(result.evidence).toMatchObject({ source: 'explicit-local-measurement', baselineMiB: 1056.25 });
    expect(result.evidence).not.toHaveProperty('samplesMiB');
  });
});
