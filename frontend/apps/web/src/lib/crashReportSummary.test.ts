import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  crashSignature,
  failureSignatures,
  isLaneCrashReport,
  laneReportLabel,
  laneSignatures,
  redactIps,
  summarizeIps,
} from '../../scripts/crashReportSummary.mjs';

const HEADER = JSON.stringify({ app_name: 'com.apple.WebKit.WebContent.Development', bug_type: '309' });
const BODY = {
  procName: 'com.apple.WebKit.WebContent.Development',
  exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS at 0x10' },
  termination: { namespace: 'SIGNAL', indicator: 'Segmentation fault: 11' },
  faultingThread: 1,
  usedImages: [{ name: 'JavaScriptCore' }, { name: 'WebCore' }],
  threads: [
    { frames: [{ imageIndex: 1, symbol: 'idle' }] },
    {
      name: 'JSC Heap Collector Thread',
      frames: [
        { imageIndex: 0, symbol: 'JSC::Heap::collect' },
        { imageIndex: 1, imageOffset: 4096 },
      ],
    },
  ],
};

describe('summarizeIps', () => {
  it('names the process, the exception, the termination and the crashing thread', () => {
    expect(summarizeIps(`${HEADER}\n${JSON.stringify(BODY)}`)).toEqual([
      'process: com.apple.WebKit.WebContent.Development',
      'exception: EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0x10',
      'termination: SIGNAL Segmentation fault: 11',
      'crashing thread 1: JSC Heap Collector Thread',
      '  JavaScriptCore JSC::Heap::collect',
      '  WebCore +0x1000',
    ]);
  });

  it('reports a file that is not an .ips JSON report instead of throwing', () => {
    expect(summarizeIps('Event: GPU Reset\nnot json')).toEqual(['not a JSON crash report: Event: GPU Reset']);
  });
});

describe('isLaneCrashReport', () => {
  it.each([
    '/Users/runner/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent.Development-2026-10-10-075412.ips',
    '/Library/Logs/DiagnosticReports/com.apple.WebKit.Networking.Development_2026-10-10-054206_host.diag',
    '/Users/runner/Library/Logs/DiagnosticReports/com.apple.WebKit.GPU-2026-10-10-075412.ips',
    '/Users/runner/Library/Logs/DiagnosticReports/Playwright-2026-10-10-075412.ips',
    '/Library/Logs/DiagnosticReports/bun_2026-10-10-055322_host.diag',
    '/Library/Logs/DiagnosticReports/JetsamEvent-2026-10-10-075412.ips',
  ])('keeps %s', (path) => {
    expect(isLaneCrashReport(path)).toBe(true);
  });

  it.each([
    '/Library/Logs/DiagnosticReports/Kernel_2026-10-10-052445_host.gpuRestart',
    '/Library/Logs/DiagnosticReports/mds_stores_2026-10-10-060515_host.diag',
    '/Library/Logs/DiagnosticReports/WindowServer-2026-10-10-060515.ips',
    '/Users/runner/notWebKit/com.apple.WebKit.WebContent.txt',
  ])('drops %s', (path) => {
    expect(isLaneCrashReport(path)).toBe(false);
  });
});

describe('laneReportLabel', () => {
  it('calls a .diag a resource report, so a green log does not read like a crash', () => {
    expect(laneReportLabel('/Library/Logs/DiagnosticReports/bun_2026-10-10-055322_host.diag')).toBe('resource report');
  });

  it.each([
    '/Users/runner/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent.Development-2026-10-10-075412.ips',
    '/Library/Logs/DiagnosticReports/JetsamEvent-2026-10-10-075412.ips',
    '/Users/runner/Library/Logs/DiagnosticReports/Playwright-2026-10-10.crash',
  ])('calls %s a crash report', (path) => {
    expect(laneReportLabel(path)).toBe('crash report');
  });
});

// Real WebContent crashes from GitHub's macOS runners, minimized and redacted.
const FIXTURES = join(import.meta.dirname, '../../scripts/fixtures/webkit-crash');
const SIGILL_NAME = 'com.apple.WebKit.WebContent.Development-2026-10-13-180528.ips';
const SIGBUS_NAME = 'com.apple.WebKit.WebContent.Development-2026-10-13-182553.ips';
const SIGSEGV_NAME = 'com.apple.WebKit.WebContent.Development-2026-10-13-200731.ips';
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const LLINT = 'jsc_llint_commonCallOp__llintOpWithMetadata__llintOpWithReturn__llintOp__commonOp__fn__fn__makeReturn__fn__fn__fn__683_callHelper__dispatch_LowLevelInterpreter64_asm_2579';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A report carrying the identifiers macOS writes: built at run time, never committed. */
function identifiedReport() {
  const reporterKey = randomBytes(20).toString('hex');
  const uuid = randomUUID().toUpperCase();
  const header = JSON.stringify({ app_name: 'com.apple.WebKit.WebContent', incident_id: uuid, slice_uuid: randomUUID() });
  const body = {
    ...BODY,
    crashReporterKey: reporterKey,
    sleepWakeUUID: randomUUID(),
    usedImages: [{ name: 'JavaScriptCore', uuid: randomUUID() }, { name: 'WebCore', uuid: randomUUID() }],
  };
  return { text: `${header}\n${JSON.stringify(body, null, 2)}`, reporterKey, uuid };
}

describe('crashSignature', () => {
  it.each([
    [SIGILL_NAME, `WebCore: Worker | SIGILL | ${LLINT}`],
    [SIGBUS_NAME, `WebCore: Worker | SIGBUS | ${LLINT}`],
    [SIGSEGV_NAME, 'WebCore: Worker | SIGSEGV | JSC::JSWebAssemblyArray::visitChildren'],
  ])('keys %s on thread, signal and the top named frame', (name, key) => {
    expect(crashSignature(fixture(name))?.key).toBe(key);
  });

  it('keeps the process, the exception and a few named frames for the issue body', () => {
    const signature = crashSignature(fixture(SIGSEGV_NAME));
    expect(signature).toMatchObject({ process: 'com.apple.WebKit.WebContent.Development', exception: 'EXC_BAD_ACCESS SIGSEGV' });
    expect(signature?.frames[0]).toBe('JavaScriptCore JSC::JSWebAssemblyArray::visitChildren(JSC::JSCell*, JSC::AbstractSlotVisitor&)');
    expect(signature?.frames.length).toBeLessThanOrEqual(8);
  });

  it('is null for a report with no crashing thread (a JetsamEvent, a .diag)', () => {
    expect(crashSignature('{"bug_type":"298"}\n{"memoryPages":{}}')).toBeNull();
    expect(crashSignature('Event: GPU Reset\nnot json')).toBeNull();
  });
});

describe('redactIps', () => {
  it('removes the crash reporter key and every UUID, and keeps the report parseable', () => {
    const { text, reporterKey, uuid } = identifiedReport();
    const redacted = redactIps(text);
    expect(redacted).not.toContain(reporterKey);
    expect(redacted).not.toContain(uuid);
    expect(redacted).not.toMatch(UUID);
    expect(summarizeIps(redacted)[0]).toBe('process: com.apple.WebKit.WebContent.Development');
  });
});

describe('laneSignatures (--signatures)', () => {
  function laneDirectory() {
    const artifacts = mkdtempSync(join(tmpdir(), 'lane-artifacts-'));
    const directory = join(artifacts, 'crash-reports');
    mkdirSync(directory);
    for (const name of [SIGILL_NAME, SIGSEGV_NAME]) copyFileSync(join(FIXTURES, name), join(directory, name));
    const { text, reporterKey } = identifiedReport();
    writeFileSync(join(directory, 'com.apple.WebKit.WebContent-2026-10-14-101010.ips'), text);
    writeFileSync(join(directory, 'JetsamEvent-2026-10-14-101010.ips'), '{"bug_type":"298"}\n{"memoryPages":{}}');
    return { artifacts, directory, reporterKey };
  }

  it('redacts every report in place and returns one signature per key, tagged with its lane', () => {
    const { artifacts, directory, reporterKey } = laneDirectory();
    const signatures = laneSignatures(artifacts, 'travel');
    expect(signatures.map((signature: { key: string }) => signature.key).sort()).toEqual([
      'JSC Heap Collector Thread | SIGSEGV | JSC::Heap::collect',
      `WebCore: Worker | SIGILL | ${LLINT}`,
      'WebCore: Worker | SIGSEGV | JSC::JSWebAssemblyArray::visitChildren',
    ]);
    expect(signatures.every((signature: { lane: string; kind: string }) => signature.lane === 'travel' && signature.kind === 'crash')).toBe(true);
    for (const name of readdirSync(directory)) {
      const text = readFileSync(join(directory, name), 'utf8');
      expect(text).not.toContain(reporterKey);
      expect(text).not.toMatch(UUID);
    }
  });

  it('prints one GITHUB_OUTPUT line, and an empty list when the lane wrote no reports', () => {
    const script = join(import.meta.dirname, '../../scripts/crashReportSummary.mjs');
    const { artifacts } = laneDirectory();
    const found = spawnSync('node', [script, '--signatures', 'memory', artifacts], { encoding: 'utf8' });
    expect(found.status).toBe(0);
    expect(found.stdout.trim().split('\n')).toHaveLength(1);
    expect(found.stdout).toMatch(/^crashes=\[/);
    expect(JSON.parse(found.stdout.trim().slice('crashes='.length))).toHaveLength(3);
    const missing = spawnSync('node', [script, '--signatures', 'memory', join(artifacts, 'absent')], { encoding: 'utf8' });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe('crashes=[]\n');
  });
});

/** A Playwright JSON report (reporter=json) with the failures PR #355 hit: no .ips for any of them. */
function playwrightReport(...failures: Array<{ project: string; line: number; title: string; message: string }>) {
  return {
    suites: [{
      title: 'time-travel.spec.ts',
      suites: [{
        title: 'Dashboard time travel',
        specs: [
          { title: 'passes', file: 'time-travel.spec.ts', line: 10, tests: [{ projectName: 'webkit', status: 'expected', results: [{ status: 'passed', errors: [] }] }] },
          ...failures.map((failure) => ({
            title: failure.title,
            file: 'time-travel.spec.ts',
            line: failure.line,
            tests: [{ projectName: failure.project, status: 'unexpected', results: [{ status: 'failed', errors: [{ message: failure.message }] }] }],
          })),
        ],
      }],
    }],
  };
}
const JOURNEY = '\u001b[31mError: the journey must have no unexpected runtime or page errors\u001b[39m\n\nexpect(received).toEqual(expected) // deep equality\n\n- Expected  - 0\n+ Received  + 3\n\n  Array [\n';
const BLOB = `${JOURNEY}+   "console: Cannot load blob:http://127.0.0.1:4199/7ca88c4b-c49c-4446-85cc-89a4c1371462 due to access control checks.",\n  ]`;
const WASM = (hash: string) => `${JOURNEY}+   "console: Fetch API cannot load http://127.0.0.1:4199/assets/sqlite3-${hash}.wasm due to access control checks.",\n+   "console: wasm streaming compile failed: TypeError: Load failed",\n  ]`;

describe('failureSignatures (failures without an .ips)', () => {
  it('keys each failure on its first unexpected error line, with origins, hashes and UUIDs normalized', () => {
    const report = playwrightReport(
      { project: 'webkit', line: 1382, title: 'a reload returns the Dashboard to today', message: BLOB },
      { project: 'iphone-webkit', line: 978, title: 'offers Day, Month and Year', message: WASM('C1o5_k_G') },
      { project: 'webkit', line: 990, title: 'another journey', message: WASM('Dx9_a-Zq') },
    );
    const signatures = failureSignatures([report], 'travel', false);
    expect(signatures.map((signature: { key: string }) => signature.key)).toEqual([
      'console: Cannot load blob:<uuid> due to access control checks.',
      'console: Fetch API cannot load /assets/sqlite3-*.wasm due to access control checks.',
    ]);
    expect(signatures[1]).toMatchObject({ kind: 'failure', lane: 'travel', frames: ['[iphone-webkit] time-travel.spec.ts:978 offers Day, Month and Year', '[webkit] time-travel.spec.ts:990 another journey'] });
  });

  it('falls back to the first line when the error has no diff', () => {
    const report = playwrightReport({ project: 'webkit', line: 5, title: 't', message: 'page.goto: Timeout 30000ms exceeded.\nCall log:' });
    expect(failureSignatures([report], 'portable', false)[0]?.key).toBe('page.goto: Timeout <n>ms exceeded.');
  });

  it('leaves a page crash to its .ips signature when the lane captured one, and files it when it did not', () => {
    const report = playwrightReport({ project: 'webkit', line: 5, title: 't', message: 'page.goto: Target crashed' });
    expect(failureSignatures([report], 'travel', true)).toEqual([]);
    expect(failureSignatures([report], 'travel', false)[0]?.key).toBe('page.goto: Target crashed');
  });

  it('laneSignatures reads the lane\'s Playwright JSON reports beside its crash reports', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'lane-failures-'));
    writeFileSync(join(artifacts, 'time-travel-report.json'), JSON.stringify(playwrightReport({ project: 'webkit', line: 1382, title: 'reload', message: BLOB })));
    expect(laneSignatures(artifacts, 'travel')).toEqual([expect.objectContaining({ kind: 'failure', key: 'console: Cannot load blob:<uuid> due to access control checks.' })]);
  });
});
