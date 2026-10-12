import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page, TestInfo } from '@playwright/test';
import { zipSync } from 'fflate';

import { observeReloadJourney, captureReloadJourneyState, withReloadJourneyDiagnostics } from '../../e2e/reloadJourneyDiagnostics';

class PageDouble extends EventEmitter {
  address = 'http://localhost/dashboard?PRIVATE=BIRTH';
  closed = false;
  evaluate = vi.fn(async (read: () => unknown) => read());
  url() { return this.address; }
  isClosed() { return this.closed; }
  asPage() { return this as unknown as Page; }
}

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '';
  for (const name of ['__ALMAMESH_STAGE__', '__ALMAMESH_ERROR__', '__almameshPortableStatePersistence']) delete (window as unknown as Record<string, unknown>)[name];
});

describe('reload journey failure receipts', () => {
  it('keeps ordered closed phases and console categories without retaining raw inputs', () => {
    const page = new PageDouble();
    let now = 10;
    const observer = observeReloadJourney(page.asPage(), () => now);
    observer.phase('reload-start');
    now = 25;
    page.emit('console', { type: () => 'error', text: () => 'RuntimeError: out of bounds memory access PRIVATE CHART' });
    page.emit('pageerror', new Error('PRIVATE BIRTH key=SECRET'));
    page.emit('crash');
    const snapshot = observer.snapshot();
    expect(snapshot).toMatchObject({ phase: 'reload-start', crashed: true, console: [{ category: 'wasm-memory-fault', atMs: 15 }, { category: 'other', atMs: 15 }] });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|CHART|BIRTH|SECRET|localhost|http/);
    observer.stop(); observer.stop();
    expect(page.eventNames()).toEqual([]);
  });

  it('caps phases and console observations, counts drops and never accepts a caller phase string', () => {
    const page = new PageDouble();
    const observer = observeReloadJourney(page.asPage());
    observer.phase('PRIVATE' as never);
    for (let i = 0; i < 100; i += 1) {
      observer.phase('reload-start');
      page.emit('console', { type: () => 'error', text: () => 'PRIVATE' });
    }
    const snapshot = observer.snapshot();
    expect(snapshot.phases.length).toBeLessThanOrEqual(32);
    expect(snapshot.console.length).toBeLessThanOrEqual(64);
    expect(snapshot.droppedPhases).toBeGreaterThan(0);
    expect(snapshot.droppedConsole).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    observer.stop();
  });

  it('counts hostile callbacks and emits only fixed console categories', () => {
    const page = new PageDouble();
    const observer = observeReloadJourney(page.asPage());
    for (const text of ['SQLite OPFS PRIVATE', 'Fetch API network PRIVATE', 'Pyodide fatal PRIVATE']) page.emit('console', { type: () => 'error', text: () => text });
    page.emit('console', { type: () => { throw new Error('PRIVATE'); } });
    expect(observer.snapshot()).toMatchObject({ observerFailures: 1, console: [{ category: 'storage' }, { category: 'network' }, { category: 'wasm-fatal' }] });
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
    observer.stop();
  });

  it('captures only route, known boot/storage states and UI booleans', async () => {
    const page = new PageDouble();
    document.body.innerHTML = '<button data-testid="dashboard-time-travel-button">PRIVATE NAME</button><section data-testid="chart-read-failed">PRIVATE ERROR</section>';
    Object.assign(window, { __ALMAMESH_STAGE__: 'ready', __ALMAMESH_ERROR__: 'PRIVATE ERROR', __almameshPortableStatePersistence: () => 'opfs' });
    const snapshot = await captureReloadJourneyState(page.asPage());
    expect(snapshot).toMatchObject({ state: 'available', route: 'dashboard', boot: 'ready', bootError: true, storage: 'opfs', ui: { timeTravelButton: true, timeTravelButtonDisabled: false, chartReadFailed: true } });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|localhost|BIRTH|http/);
    delete (window as unknown as Record<string, unknown>).__ALMAMESH_STAGE__;
    delete (window as unknown as Record<string, unknown>).__ALMAMESH_ERROR__;
    delete (window as unknown as Record<string, unknown>).__almameshPortableStatePersistence;
  });

  it('does not evaluate a closed or crashed page and rejects hostile snapshot properties', async () => {
    const page = new PageDouble(); page.closed = true;
    expect(await captureReloadJourneyState(page.asPage())).toMatchObject({ state: 'page-unavailable' });
    expect(page.evaluate).not.toHaveBeenCalled();
    page.closed = false;
    page.evaluate.mockImplementation(async () => ({ boot: 'PRIVATE', storage: 'PRIVATE', ui: { get timeTravelButton() { throw new Error('PRIVATE'); } } }));
    expect(JSON.stringify(await captureReloadJourneyState(page.asPage()))).not.toContain('PRIVATE');
  });

  it('bounds held evaluation to two seconds and handles its late rejection', async () => {
    vi.useFakeTimers();
    const page = new PageDouble();
    let reject!: (reason: unknown) => void;
    page.evaluate.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const snapshot = captureReloadJourneyState(page.asPage());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await snapshot).toMatchObject({ state: 'snapshot-timeout' });
    reject(new Error('PRIVATE')); await Promise.resolve();
  });

  it('retains stdout and an attachment after a failed assertion without replacing the original error', async () => {
    const page = new PageDouble();
    const original = new Error('original assertion');
    const attach = vi.fn(async () => { throw new Error('attachment unavailable'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(withReloadJourneyDiagnostics(page.asPage(), { attach } as unknown as TestInfo, async (observer) => { observer.phase('reload-complete'); throw original; })).rejects.toBe(original);
    expect(attach).toHaveBeenCalledOnce();
    const receipt = JSON.parse(log.mock.calls[0][0] as string);
    expect(receipt).toMatchObject({ event: 'reload-journey-diagnostics', journey: 'failed', lifecycle: { phase: 'reload-complete' } });
    expect(page.eventNames()).toEqual([]);
  });

  it('keeps the failure receipt when a crash made the document inaccessible', async () => {
    const page = new PageDouble();
    const attach = vi.fn(async (_name: string, _details: { body: string }) => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(withReloadJourneyDiagnostics(page.asPage(), { attach } as unknown as TestInfo, async () => { page.emit('crash'); throw new Error('assertion'); })).rejects.toThrow('assertion');
    const receipt = JSON.parse(attach.mock.calls[0][1].body as string);
    expect(receipt.document.state).toBe('page-unavailable');
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('fails closed when diagnostics cannot be retained after an otherwise successful journey', async () => {
    const page = new PageDouble();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(withReloadJourneyDiagnostics(page.asPage(), { attach: async () => { throw new Error('PRIVATE'); } } as unknown as TestInfo, async () => {})).rejects.toThrow('Reload journey diagnostics could not be retained.');
  });

  it('bounds held attachment cleanup and preserves the original assertion', async () => {
    vi.useFakeTimers();
    const page = new PageDouble();
    const original = new Error('original assertion');
    let reject!: (reason: unknown) => void;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const outcome = withReloadJourneyDiagnostics(page.asPage(), { attach: () => new Promise<void>((_resolve, fail) => { reject = fail; }) }, async () => { throw original; }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toBe(original);
    reject(new Error('PRIVATE')); await Promise.resolve();
  });

  it.each([false, true])('the actual scanner protects retained failed-journey artifacts (secret present: %s)', (containsSecret) => {
    const workdir = mkdtempSync(join(tmpdir(), 'almamesh-journey-actual-scan-'));
    const secret = 'synthetic-credential-should-never-be-exported-93457';
    try {
      mkdirSync(join(workdir, 'empty-home'));
      const evidence = join(workdir, 'browser-journeys-evidence');
      mkdirSync(join(evidence, 'time-travel'), { recursive: true });
      const scanner = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/artifactLeakScan.mjs');
      writeFileSync(join(evidence, 'journey-status.json'), JSON.stringify({ schemaVersion: 1, commitSha: 'd'.repeat(40), exitCode: 3, scanned: true }));
      writeFileSync(join(evidence, 'time-travel/trace.zip'), zipSync({ 'trace.trace': new TextEncoder().encode(containsSecret ? secret : 'synthetic public test event') }));
      const result = spawnSync(process.execPath, [scanner, evidence], { cwd: workdir, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, HOME: join(workdir, 'empty-home'), JOURNEY_TEST_CREDENTIAL: secret } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(containsSecret ? 1 : 0);
      expect(result.stdout + result.stderr).not.toContain(secret);
      if (containsSecret) expect(existsSync(evidence)).toBe(false);
      else expect(JSON.parse(readFileSync(join(evidence, 'journey-status.json'), 'utf8'))).toMatchObject({ exitCode: 3, scanned: true });
    } finally { rmSync(workdir, { force: true, recursive: true }); }
  });
});
