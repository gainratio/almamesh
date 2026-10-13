import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  matchesKnownWebKitFlake,
  planRetries,
  readIpsSignature,
  retryTestList,
  summarizeRetryPlans,
  verifyRetries,
} from '../../scripts/webkitFlakeRetry.mjs';

/**
 * The two WebContent crashes from run 38442783185 (webkit-lane-travel-evidence):
 * the known macOS-VM flake, a JSC crash on a "WebCore: Worker" thread.
 */
const FIXTURES = join(import.meta.dirname, '../../scripts/fixtures/webkit-crash');
const SIGILL_NAME = 'com.apple.WebKit.WebContent.Development-2026-10-13-180528.ips';
const SIGBUS_NAME = 'com.apple.WebKit.WebContent.Development-2026-10-13-182553.ips';
const SIGILL = readFileSync(join(FIXTURES, SIGILL_NAME), 'utf8');
const SIGBUS = readFileSync(join(FIXTURES, SIGBUS_NAME), 'utf8');
/** captureTime of the SIGILL report: 2026-10-13 18:05:12.8854 +0000. */
const SIGILL_CAPTURED = Date.UTC(2026, 9, 13, 18, 5, 12, 885);

interface IpsBody {
  procName: string;
  faultingThread: number;
  exception: { type: string; signal: string };
  threads: { name?: string; frames: { imageIndex: number; symbol?: string }[] }[];
  usedImages: { name?: string }[];
}

/** A copy of a real report with its JSON body edited. */
function edited(text: string, edit: (body: IpsBody) => void): string {
  const newline = text.indexOf('\n');
  const body = JSON.parse(text.slice(newline + 1)) as IpsBody;
  edit(body);
  return `${text.slice(0, newline)}\n${JSON.stringify(body)}`;
}

function matches(text: string): boolean {
  return matchesKnownWebKitFlake(readIpsSignature(text));
}

describe('the known WebKit flake signature', () => {
  it.each([SIGILL_NAME, SIGBUS_NAME])('keeps no machine identifiers in the minimized fixture %s', (name) => {
    const text = name === SIGILL_NAME ? SIGILL : SIGBUS;
    expect(text).not.toMatch(/crashReporterKey|sleepWakeUUID|bootSessionUUID|incident_id|incident|slice_uuid|"uuid"|\/Users\/|sharedCache|"path"/i);
    expect(text).not.toMatch(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i);
  });

  it('matches the real SIGILL report: JSC LLInt frames on a WebCore: Worker thread', () => {
    const signature = readIpsSignature(SIGILL);
    expect(signature).toMatchObject({
      process: 'com.apple.WebKit.WebContent.Development',
      thread: 'WebCore: Worker',
      exceptionType: 'EXC_BAD_INSTRUCTION',
      signal: 'SIGILL',
      capturedAtMs: SIGILL_CAPTURED,
    });
    expect(matchesKnownWebKitFlake(signature)).toBe(true);
  });

  it('matches the real SIGBUS report, whose top 90 frames are JIT code', () => {
    const signature = readIpsSignature(SIGBUS);
    expect(signature).toMatchObject({ thread: 'WebCore: Worker', exceptionType: 'EXC_BAD_ACCESS', signal: 'SIGBUS' });
    expect(matchesKnownWebKitFlake(signature)).toBe(true);
  });

  it('names the JSC frame that identified it', () => {
    expect(readIpsSignature(SIGILL)?.jscFrame).toMatch(/^jsc_llint_commonCallOp/);
  });

  it('does not match a main-thread crash', () => {
    expect(matches(edited(SIGILL, (body) => { body.faultingThread = 0; }))).toBe(false);
  });

  it('does not match a Worker thread crash with a different thread name', () => {
    expect(matches(edited(SIGILL, (body) => { body.threads[body.faultingThread].name = 'JSC Heap Collector Thread'; }))).toBe(false);
  });

  it.each([
    ['EXC_BAD_ACCESS', 'SIGSEGV'],
    ['EXC_CRASH', 'SIGABRT'],
    ['EXC_BAD_INSTRUCTION', 'SIGBUS'],
  ])('does not match %s/%s', (type, signal) => {
    expect(matches(edited(SIGILL, (body) => { body.exception = { type, signal }; }))).toBe(false);
  });

  it.each(['Playwright', 'com.apple.WebKit.Networking', 'com.apple.WebKit.GPU', 'Safari'])('does not match a %s process', (procName) => {
    expect(matches(edited(SIGILL, (body) => { body.procName = procName; }))).toBe(false);
  });

  it('does not match a Worker crash whose top frame is outside JSC and JIT code', () => {
    const libsystem = (body: IpsBody): void => {
      body.usedImages.push({ name: 'libsystem_malloc.dylib' });
      body.threads[body.faultingThread].frames.unshift({ imageIndex: body.usedImages.length - 1, symbol: 'free' });
    };
    expect(matches(edited(SIGILL, libsystem))).toBe(false);
  });

  it('does not match a JSC Worker crash with no interpreter, BBQ or Wasm frame', () => {
    const noExecutionFrame = (body: IpsBody): void => {
      for (const frame of body.threads[body.faultingThread].frames) {
        if (frame.symbol?.includes('llint')) frame.symbol = 'JSC::Heap::collect';
      }
    };
    expect(matches(edited(SIGILL, noExecutionFrame))).toBe(false);
  });

  it.each([
    ['a truncated report', SIGILL.slice(0, Math.floor(SIGILL.length / 2))],
    ['the header line alone', SIGILL.slice(0, SIGILL.indexOf('\n'))],
    ['an empty file', ''],
    ['a non-JSON report', 'Event: GPU Reset\nnot json'],
  ])('reads %s as no signature and does not match it', (_label, text) => {
    expect(readIpsSignature(text)).toBeNull();
    expect(matchesKnownWebKitFlake(null)).toBe(false);
  });

  it('reads a faulting thread index that names no thread as no signature', () => {
    expect(readIpsSignature(edited(SIGILL, (body) => { body.faultingThread = 999; }))).toBeNull();
  });

  it('does not match a report with no exception or process name', () => {
    const bare = (body: IpsBody): void => {
      const loose = body as unknown as Record<string, unknown>;
      delete loose.exception;
      delete loose.procName;
    };
    expect(readIpsSignature(edited(SIGILL, bare))).toMatchObject({ process: null, exceptionType: null, signal: null });
    expect(matches(edited(SIGILL, bare))).toBe(false);
  });

  it('does not match a Worker stack of anonymous JIT frames with no JSC tier symbol', () => {
    const jitOnly = (body: IpsBody): void => {
      const jit = body.threads[body.faultingThread].frames[0];
      body.threads[body.faultingThread].frames = Array.from({ length: 200 }, () => ({ imageIndex: jit.imageIndex }));
    };
    expect(matches(edited(SIGILL, jitOnly))).toBe(false);
  });

  it('reads a capture time with a negative UTC offset', () => {
    const pacific = SIGILL.replace(/"captureTime"\s*:\s*"[^"]*"/, '"captureTime" : "2026-10-13 11:05:12.8854 -0700"');
    expect(readIpsSignature(pacific)?.capturedAtMs).toBe(SIGILL_CAPTURED);
  });

  it('does not match a report with no capture time', () => {
    const noTime = SIGILL.replace(/"captureTime"\s*:\s*"[^"]*"/, '"captureTime" : "soon"');
    expect(matches(noTime)).toBe(false);
  });
});

const CRASH_MESSAGE = 'Error: page.waitForFunction: Target page, context or browser has been closed';
const PAGE_CRASHED_STDERR = '[webkit-diagnostics] page crashed: http://127.0.0.1:4199/dashboard (June in Bogotá)\n';
const START = '2026-10-13T18:03:57.409Z';
const DURATION = 83_084;

interface ResultInput {
  status?: string;
  message?: string;
  stderr?: string;
  startTime?: string;
  duration?: number;
}

function result(input: ResultInput = {}) {
  return {
    status: input.status ?? 'failed',
    startTime: input.startTime ?? START,
    duration: input.duration ?? DURATION,
    errors: input.message === undefined ? [] : [{ message: input.message }],
    stderr: input.stderr === undefined ? [] : [{ text: input.stderr }],
  };
}

function spec(title: string, project: string, results: ReturnType<typeof result>[], status = 'unexpected') {
  return { title, file: 'time-travel.spec.ts', line: 10, tests: [{ projectName: project, status, results }] };
}

function report(specs: ReturnType<typeof spec>[], errors: { message: string }[] = []) {
  return {
    errors,
    suites: [{ title: 'time-travel.spec.ts', file: 'time-travel.spec.ts', specs: [], suites: [{ title: 'places', specs }] }],
  };
}

const CRASHED = spec('June in Bogotá', 'webkit', [result({ message: CRASH_MESSAGE })]);
const MATCHING_IPS = [{ name: SIGILL_NAME, text: SIGILL }];

describe('planRetries', () => {
  it('retries a page-crash failure once when a matching .ips was captured during the test', () => {
    const plan = planRetries(report([CRASHED]), MATCHING_IPS);
    expect(plan.verdict).toBe('retry');
    expect(plan.retries).toEqual([
      expect.objectContaining({
        testId: '[webkit] › time-travel.spec.ts › places › June in Bogotá',
        ips: SIGILL_NAME,
        signature: expect.objectContaining({ thread: 'WebCore: Worker', signal: 'SIGILL' }),
      }),
    ]);
    expect(retryTestList(plan)).toBe('[webkit] › time-travel.spec.ts › places › June in Bogotá\n');
  });

  it('also reads the [webkit-diagnostics] page crashed line as a crash failure', () => {
    const crashed = spec('June in Bogotá', 'webkit', [result({ message: 'Error: locator.click: Test ended.', stderr: PAGE_CRASHED_STDERR })]);
    expect(planRetries(report([crashed]), MATCHING_IPS).verdict).toBe('retry');
  });

  it('never retries a plain assertion failure, even with a matching crash report in its window', () => {
    const asserted = spec('June in Bogotá', 'webkit', [result({ message: 'Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1' })]);
    const plan = planRetries(report([asserted]), MATCHING_IPS);
    expect(plan.verdict).toBe('red');
    expect(plan.retries).toEqual([]);
    expect(plan.refused).toEqual([expect.objectContaining({ reason: 'not a page crash' })]);
  });

  it('never retries a timeout, even one that mentions a closed page', () => {
    const timedOut = spec('June in Bogotá', 'webkit', [result({ status: 'timedOut', message: CRASH_MESSAGE })]);
    expect(planRetries(report([timedOut]), MATCHING_IPS).verdict).toBe('red');
  });

  it('does not retry a crash with no crash report', () => {
    const plan = planRetries(report([CRASHED]), []);
    expect(plan.verdict).toBe('red');
    expect(plan.refused).toEqual([expect.objectContaining({ reason: 'no matching .ips captured during the test' })]);
  });

  it('does not retry a crash whose report has a different signature', () => {
    const segv = edited(SIGILL, (body) => { body.exception = { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' }; });
    expect(planRetries(report([CRASHED]), [{ name: SIGILL_NAME, text: segv }]).verdict).toBe('red');
  });

  it('does not retry on a matching report captured before the test started', () => {
    const later = spec('June in Bogotá', 'webkit', [result({ message: CRASH_MESSAGE, startTime: '2026-10-13T18:05:13.000Z' })]);
    expect(planRetries(report([later]), MATCHING_IPS).verdict).toBe('red');
  });

  it('does not retry on a matching report captured long after the test ended', () => {
    const earlier = spec('June in Bogotá', 'webkit', [result({ message: CRASH_MESSAGE, startTime: '2026-10-13T18:00:00.000Z', duration: 60_000 })]);
    expect(planRetries(report([earlier]), MATCHING_IPS).verdict).toBe('red');
  });

  it('does not retry a test that already ran twice', () => {
    const twice = spec('June in Bogotá', 'webkit', [result({ message: CRASH_MESSAGE }), result({ message: CRASH_MESSAGE })]);
    expect(planRetries(report([twice]), MATCHING_IPS).verdict).toBe('red');
  });

  it('retries nothing when any other failure leaves the suite red anyway', () => {
    const asserted = spec('Back to today', 'webkit', [result({ message: 'Error: expect(received).toBe(expected)', startTime: '2026-10-13T18:10:00.000Z' })]);
    const plan = planRetries(report([CRASHED, asserted]), MATCHING_IPS);
    expect(plan.verdict).toBe('red');
    expect(plan.retries).toEqual([]);
  });

  it('lets one crash report justify only one retry', () => {
    const second = spec('June in Bogotá', 'iphone-webkit', [result({ message: CRASH_MESSAGE })]);
    expect(planRetries(report([CRASHED, second]), MATCHING_IPS).verdict).toBe('red');
  });

  it('does not retry when the run reported a global error', () => {
    expect(planRetries(report([CRASHED], [{ message: 'Error: worker teardown' }]), MATCHING_IPS).verdict).toBe('red');
  });

  it('calls a run with no failed test clean', () => {
    const passed = spec('June in Bogotá', 'webkit', [result({ status: 'passed' })], 'expected');
    expect(planRetries(report([passed]), MATCHING_IPS)).toMatchObject({ verdict: 'clean', retries: [], refused: [] });
  });

  it('offers no retry for a run that failed without a failed test (the lane keeps its red exit)', () => {
    expect(planRetries(report([]), MATCHING_IPS)).toMatchObject({ verdict: 'clean', retries: [] });
  });
});

describe('verifyRetries', () => {
  const plan = planRetries(report([CRASHED]), MATCHING_IPS);

  it('accepts a rerun in which every retried test ran once and passed', () => {
    const rerun = report([spec('June in Bogotá', 'webkit', [result({ status: 'passed' })], 'expected')]);
    expect(verifyRetries(plan, rerun)).toEqual({ ok: true, problems: [] });
  });

  it('rejects a rerun in which the retried test failed again', () => {
    expect(verifyRetries(plan, report([CRASHED])).ok).toBe(false);
  });

  it('rejects a rerun in which the retried test ran more than once', () => {
    const twice = report([spec('June in Bogotá', 'webkit', [result({ status: 'passed' }), result({ status: 'passed' })], 'expected')]);
    expect(verifyRetries(plan, twice)).toEqual({ ok: false, problems: ['[webkit] › time-travel.spec.ts › places › June in Bogotá: expected'] });
  });

  it('rejects a rerun that Playwright calls flaky', () => {
    const flaky = report([spec('June in Bogotá', 'webkit', [result({ status: 'passed' })], 'flaky')]);
    expect(verifyRetries(plan, flaky)).toEqual({ ok: false, problems: ['[webkit] › time-travel.spec.ts › places › June in Bogotá: flaky'] });
  });

  it('rejects a rerun that did not run the retried test', () => {
    const other = report([spec('Back to today', 'webkit', [result({ status: 'passed' })], 'expected')]);
    expect(verifyRetries(plan, other)).toEqual({ ok: false, problems: ['[webkit] › time-travel.spec.ts › places › June in Bogotá: not run'] });
  });
});

describe('summarizeRetryPlans', () => {
  it('counts the retries per suite for the lane summary', () => {
    const retried = { suite: 'travel', ...planRetries(report([CRASHED]), MATCHING_IPS) };
    const clean = { suite: 'portable', verdict: 'clean' as const, retries: [], refused: [] };
    expect(summarizeRetryPlans([retried, clean])).toBe('[webkit-flake-retry] lane summary: 1 known-flake retry (travel=1, portable=0)');
  });
});

describe('the lane CLI', () => {
  const SCRIPT = join(import.meta.dirname, '../../scripts/webkitFlakeRetry.mjs');

  function lane(failure: ReturnType<typeof spec>, ipsAgeMs: number) {
    const dir = mkdtempSync(join(tmpdir(), 'webkit-flake-'));
    const reports = join(dir, 'DiagnosticReports');
    mkdirSync(reports);
    writeFileSync(join(dir, '.lane-start'), '');
    const laneStart = Date.now() / 1000;
    utimesSync(join(dir, '.lane-start'), laneStart, laneStart);
    writeFileSync(join(reports, SIGILL_NAME), SIGILL);
    utimesSync(join(reports, SIGILL_NAME), laneStart + ipsAgeMs / 1000, laneStart + ipsAgeMs / 1000);
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report([failure])));
    const run = spawnSync(process.execPath, [
      SCRIPT, 'plan', '--suite', 'travel', '--report', join(dir, 'report.json'), '--since', join(dir, '.lane-start'),
      '--reports-dir', reports, '--reports-dir', join(dir, 'missing'), '--test-list', join(dir, 'retry.txt'), '--out', join(dir, 'plan.json'),
    ], { encoding: 'utf8' });
    return { dir, run, testList: readFileSync(join(dir, 'retry.txt'), 'utf8') };
  }

  it('exits 0, writes the test list and logs the signature for a known-flake crash', () => {
    const { run, testList } = lane(CRASHED, 10_000);
    expect(run.status).toBe(0);
    expect(testList).toBe('[webkit] › time-travel.spec.ts › places › June in Bogotá\n');
    const line = run.stdout.split('\n').find((text) => text.startsWith('[webkit-flake-retry] {'));
    expect(JSON.parse(line?.slice('[webkit-flake-retry] '.length) ?? '{}')).toMatchObject({
      event: 'retry', suite: 'travel', ips: SIGILL_NAME, thread: 'WebCore: Worker', exceptionType: 'EXC_BAD_INSTRUCTION', signal: 'SIGILL',
    });
  });

  it('exits 1 with an empty test list for a plain assertion failure', () => {
    const asserted = spec('June in Bogotá', 'webkit', [result({ message: 'Error: expect(received).toBe(expected)' })]);
    const { run, testList } = lane(asserted, 10_000);
    expect(run.status).toBe(1);
    expect(testList).toBe('');
    expect(run.stdout).toContain('"reason":"not a page crash"');
  });

  it('fails closed when invoked through a symlink with an unreadable report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webkit-flake-link-'));
    symlinkSync(SCRIPT, join(dir, 'webkitFlakeRetry.mjs'));
    const run = spawnSync(process.execPath, [join(dir, 'webkitFlakeRetry.mjs'), 'plan', '--report', join(dir, 'absent.json')], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
  });

  it('refuses an unknown command', () => {
    expect(spawnSync(process.execPath, [SCRIPT, 'retry-everything']).status).toBe(64);
  });

  it('ignores a crash report written before the lane started', () => {
    expect(lane(CRASHED, -60_000).run.status).toBe(1);
  });

  it('verifies the rerun and prints the lane summary', () => {
    const { dir } = lane(CRASHED, 10_000);
    const passed = report([spec('June in Bogotá', 'webkit', [result({ status: 'passed' })], 'expected')]);
    writeFileSync(join(dir, 'rerun.json'), JSON.stringify(passed));
    writeFileSync(join(dir, 'still-red.json'), JSON.stringify(report([CRASHED])));
    const verify = (rerun: string) => spawnSync(process.execPath, [SCRIPT, 'verify', '--plan', join(dir, 'plan.json'), '--report', join(dir, rerun)]).status;
    expect(verify('rerun.json')).toBe(0);
    expect(verify('still-red.json')).toBe(1);
    copyFileSync(join(dir, 'plan.json'), join(dir, 'flake-retry-travel.json'));
    writeFileSync(join(dir, 'flake-retry-portable.json'), JSON.stringify({ suite: 'portable', verdict: 'clean', retries: [], refused: [] }));
    writeFileSync(join(dir, 'flake-retry-broken.json'), '{');
    const summary = spawnSync(process.execPath, [SCRIPT, 'summary', dir], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    expect(summary.stdout.trim()).toBe('[webkit-flake-retry] lane summary: 1 known-flake retry (portable=0, travel=1)');
  });
});
