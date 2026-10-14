import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  crashSignature,
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
    const directory = mkdtempSync(join(tmpdir(), 'lane-crashes-'));
    for (const name of [SIGILL_NAME, SIGSEGV_NAME]) copyFileSync(join(FIXTURES, name), join(directory, name));
    const { text, reporterKey } = identifiedReport();
    writeFileSync(join(directory, 'com.apple.WebKit.WebContent-2026-10-14-101010.ips'), text);
    writeFileSync(join(directory, 'JetsamEvent-2026-10-14-101010.ips'), '{"bug_type":"298"}\n{"memoryPages":{}}');
    return { directory, reporterKey };
  }

  it('redacts every report in place and returns one signature per key, tagged with its lane', () => {
    const { directory, reporterKey } = laneDirectory();
    const signatures = laneSignatures(directory, 'travel');
    expect(signatures.map((signature: { key: string }) => signature.key).sort()).toEqual([
      'JSC Heap Collector Thread | SIGSEGV | JSC::Heap::collect',
      `WebCore: Worker | SIGILL | ${LLINT}`,
      'WebCore: Worker | SIGSEGV | JSC::JSWebAssemblyArray::visitChildren',
    ]);
    expect(signatures.every((signature: { lane: string }) => signature.lane === 'travel')).toBe(true);
    for (const name of readdirSync(directory)) {
      const text = readFileSync(join(directory, name), 'utf8');
      expect(text).not.toContain(reporterKey);
      expect(text).not.toMatch(UUID);
    }
  });

  it('prints one GITHUB_OUTPUT line, and an empty list when the lane wrote no reports', () => {
    const script = join(import.meta.dirname, '../../scripts/crashReportSummary.mjs');
    const { directory } = laneDirectory();
    const found = spawnSync('node', [script, '--signatures', 'memory', directory], { encoding: 'utf8' });
    expect(found.status).toBe(0);
    expect(found.stdout.trim().split('\n')).toHaveLength(1);
    expect(found.stdout).toMatch(/^crashes=\[/);
    expect(JSON.parse(found.stdout.trim().slice('crashes='.length))).toHaveLength(3);
    const missing = spawnSync('node', [script, '--signatures', 'memory', join(directory, 'absent')], { encoding: 'utf8' });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe('crashes=[]\n');
  });
});
