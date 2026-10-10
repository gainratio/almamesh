import { describe, expect, it } from 'vitest';

import { isLaneCrashReport, laneReportLabel, summarizeIps } from '../../scripts/crashReportSummary.mjs';

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
