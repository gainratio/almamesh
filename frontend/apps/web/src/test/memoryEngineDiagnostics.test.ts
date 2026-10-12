import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

import { attachMemoryEngineDiagnostics, finalizeMemoryEngineDiagnostics, installMemoryEngineDiagnostics, memoryEngineDiagnosticsInit } from '../../e2e/memoryEngineDiagnostics';

interface DiagnosticEvent {
  direction: string;
  workerIndex: number;
  operation?: string;
  correlation?: number;
  ok?: boolean;
  category: string;
  elapsedMs: number;
}
interface Snapshot {
  schemaVersion: number;
  events: DiagnosticEvent[];
  droppedEvents: number;
  unobservedWorkers: number;
  pendingCount: number;
  instrumentationFailures: number;
}
const snapshot = (): Snapshot => (window as unknown as { __almameshMemoryEngineSnapshot: () => Snapshot }).__almameshMemoryEngineSnapshot();

class NativeWorkerDouble extends EventTarget {
  static instances: NativeWorkerDouble[] = [];
  static constructorFailure: unknown;
  readonly constructorArgs: unknown[];
  readonly sends: Array<{ receiver: unknown; args: unknown[] }> = [];
  postFailure: unknown;
  terminateFailure: unknown;
  terminated = false;
  constructor(...args: unknown[]) {
    super();
    if (NativeWorkerDouble.constructorFailure) throw NativeWorkerDouble.constructorFailure;
    this.constructorArgs = args;
    NativeWorkerDouble.instances.push(this);
  }
  postMessage(...args: unknown[]): unknown {
    if (!(this instanceof NativeWorkerDouble)) throw new TypeError('native brand');
    if (this.postFailure) throw this.postFailure;
    this.sends.push({ receiver: this, args });
    return 'native-return';
  }
  terminate(): unknown {
    if (this.terminateFailure) throw this.terminateFailure;
    this.terminated = true;
    return 'native-terminate-return';
  }
  receive(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

beforeEach(() => {
  NativeWorkerDouble.instances.length = 0;
  NativeWorkerDouble.constructorFailure = undefined;
  vi.stubGlobal('Worker', NativeWorkerDouble);
  Reflect.deleteProperty(window, '__almameshMemoryEngineSnapshot');
});
afterEach(() => {
  Reflect.deleteProperty(window, '__almameshMemoryEngineSnapshot');
  vi.unstubAllGlobals();
});

describe('external memory engine diagnostics', () => {
  it('correlates an error reply without a kind to its allowlisted request without retaining private data', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/private-worker-url?key=secret') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'generateChart', id: 7, birth: { name: 'PRIVATE PERSON', apiKey: 'PRIVATE KEY' } });
    worker.receive({ ok: false, id: 7, errorName: 'PythonError', error: 'PRIVATE ERROR /private/path', chart: 'PRIVATE OUTPUT' });
    const result = snapshot();
    expect(result.events).toMatchObject([
      { direction: 'send', workerIndex: 1, operation: 'generateChart', correlation: 7, category: 'sent' },
      { direction: 'receive', workerIndex: 1, operation: 'generateChart', correlation: 7, ok: false, category: 'error-python' },
    ]);
    expect(result.pendingCount).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|secret|private-worker|private\/path|birth|apiKey|chart/);
    for (const event of result.events) {
      expect(Object.keys(event).sort()).toEqual((event.direction === 'receive'
        ? ['direction', 'workerIndex', 'operation', 'correlation', 'ok', 'category', 'elapsedMs']
        : ['direction', 'workerIndex', 'operation', 'correlation', 'category', 'elapsedMs']).sort());
      expect(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0).toBe(true);
    }
  });

  it('keeps boot progress separate while retaining correlation for the terminal boot reply', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'boot', id: 1, config: { key: 'PRIVATE' } });
    worker.receive({ kind: 'bootProgress', id: 1, ok: true, progress: { stage: 'PRIVATE', bytesReceived: 999 } });
    expect(snapshot().pendingCount).toBe(1);
    worker.receive({ id: 1, ok: false, errorName: 'RuntimeError', error: 'PRIVATE WASM TEXT' });
    expect(snapshot().events.at(-1)).toMatchObject({ operation: 'boot', category: 'error-runtime', correlation: 1 });
    expect(snapshot().pendingCount).toBe(0);
  });

  it('distinguishes canonical SQLite persistence failures from chart replies using the actual initialize/batch protocol', () => {
    memoryEngineDiagnosticsInit();
    const state = new Worker('/state') as unknown as NativeWorkerDouble;
    state.postMessage({ operation: 'initialize', id: 1, options: { name: 'PRIVATE DB' } });
    state.receive({ ok: true, id: 1, value: { private: 'PRIVATE' } });
    state.postMessage({ operation: 'batch', id: 2, mutations: [{ key: 'PRIVATE KEY', value: 'PRIVATE VALUE' }] });
    state.receive({ ok: false, id: 2, error: { name: 'SqliteStateConflictError', message: 'PRIVATE ERROR' } });
    const chart = new Worker('/chart') as unknown as NativeWorkerDouble;
    chart.postMessage({ kind: 'generateChart', id: 2, birth: 'PRIVATE BIRTH' });
    chart.receive({ ok: true, kind: 'generateChart', id: 2, chart: 'PRIVATE CHART' });
    expect(snapshot().events.filter((event) => event.direction === 'receive')).toMatchObject([
      { workerIndex: 1, operation: 'state:initialize', ok: true, category: 'ok' },
      { workerIndex: 1, operation: 'state:batch', ok: false, category: 'error-state-conflict' },
      { workerIndex: 2, operation: 'generateChart', ok: true, category: 'ok' },
    ]);
    expect(JSON.stringify(snapshot())).not.toMatch(/PRIVATE|mutations|birth|namespace|SqliteStateConflictError/);
  });

  it('distinguishes derived SQL open/query replies and classifies its fixed public error names', () => {
    memoryEngineDiagnosticsInit();
    const sql = new Worker('/sql') as unknown as NativeWorkerDouble;
    sql.postMessage({ operation: 'open', id: 1, options: { name: 'PRIVATE' } });
    sql.receive({ ok: false, id: 1, error: { name: 'SqlStorageUnavailableError', message: 'PRIVATE', reason: 'PRIVATE' } });
    sql.postMessage({ operation: 'query', id: 2, sql: 'PRIVATE SQL', bind: ['PRIVATE VALUE'] });
    sql.receive({ ok: false, id: 2, error: { name: 'SqlImportRejectedError', message: 'PRIVATE' } });
    expect(snapshot().events.filter((event) => event.direction === 'receive')).toMatchObject([
      { operation: 'sql:open', category: 'error-sql-storage' },
      { operation: 'sql:query', category: 'error-sql-import' },
    ]);
    expect(JSON.stringify(snapshot())).not.toMatch(/PRIVATE|bind|SqlStorageUnavailableError|SqlImportRejectedError/);
  });

  it('does not guess an ambiguous SQL operation before initialize/open identifies the protocol', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/unknown') as unknown as NativeWorkerDouble;
    worker.postMessage({ operation: 'export', id: 1, value: 'PRIVATE' });
    worker.receive({ id: 1, ok: false, error: { name: 'PRIVATE' } });
    expect(snapshot().events).toEqual([]);
  });

  it.each([
    ['PyodidePackageLoadError', 'error-package-load'], ['AbortError', 'error-abort'],
    ['TypeError', 'error-type'], ['PrivateCustomError', 'error-other'],
  ])('emits only a fixed error category for %s', (errorName, category) => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'prewarm', id: 2 });
    worker.receive({ id: 2, ok: false, errorName, error: 'PRIVATE' });
    expect(snapshot().events.at(-1)).toMatchObject({ operation: 'prewarm', category });
    expect(JSON.stringify(snapshot())).not.toMatch(/PrivateCustomError|PRIVATE/);
  });

  it('forwards constructor options, subclass prototype, postMessage transfer/options and native return values', () => {
    memoryEngineDiagnosticsInit();
    class SubWorker extends Worker { marker = 'subclass'; }
    const options: WorkerOptions = { name: 'PRIVATE WORKER', type: 'module', credentials: 'include' };
    const worker = new SubWorker('/private-url', options) as unknown as NativeWorkerDouble & { marker: string };
    expect(worker).toBeInstanceOf(SubWorker);
    expect(worker).toBeInstanceOf(NativeWorkerDouble);
    expect(worker.constructorArgs).toEqual(['/private-url', options]);
    const payload = { kind: 'boot', id: 3 };
    const transfer: Transferable[] = [new ArrayBuffer(2)];
    const sendOptions = { transfer };
    expect(worker.postMessage(payload, transfer)).toBe('native-return');
    expect(worker.postMessage(payload, sendOptions)).toBe('native-return');
    expect(worker.sends[0]?.args[0]).toBe(payload);
    expect(worker.sends[0]?.args[1]).toBe(transfer);
    expect(worker.sends[1]?.args[1]).toBe(sendOptions);
    expect(worker.terminate()).toBe('native-terminate-return');
    expect(worker.terminated).toBe(true);
    expect(snapshot().events.at(-1)).toMatchObject({ direction: 'lifecycle', category: 'terminated', workerIndex: 1 });
  });

  it('preserves constructor and postMessage thrown error identities', () => {
    memoryEngineDiagnosticsInit();
    const constructorError = new Error('PRIVATE CONSTRUCTOR');
    NativeWorkerDouble.constructorFailure = constructorError;
    const construction = (): unknown => { try { new Worker('/private'); } catch (error) { return error; } };
    expect(construction()).toBe(constructorError);
    expect(snapshot().events.at(-1)).toMatchObject({ direction: 'lifecycle', category: 'constructor-threw' });
    NativeWorkerDouble.constructorFailure = undefined;
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    const sendError = new DOMException('PRIVATE CLONE', 'DataCloneError');
    worker.postFailure = sendError;
    const sending = (): unknown => { try { worker.postMessage({ kind: 'generateChart', id: 4 }); } catch (error) { return error; } };
    expect(sending()).toBe(sendError);
    expect(snapshot().events.at(-1)).toMatchObject({ category: 'post-message-threw', correlation: 4 });
    expect(snapshot().pendingCount).toBe(0);
    expect(JSON.stringify(snapshot())).not.toMatch(/PRIVATE|DataCloneError/);
  });

  it('preserves a native terminate exception and the pending request until termination succeeds', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'boot', id: 1 });
    const failure = new Error('PRIVATE TERMINATE');
    worker.terminateFailure = failure;
    const terminating = (): unknown => { try { worker.terminate(); } catch (error) { return error; } };
    expect(terminating()).toBe(failure);
    expect(snapshot().pendingCount).toBe(1);
    worker.terminateFailure = undefined;
    worker.terminate();
    expect(snapshot().pendingCount).toBe(0);
    expect(JSON.stringify(snapshot())).not.toContain('PRIVATE');
  });

  it('keeps borrowed postMessage receiver semantics and observes only its own receiver', () => {
    memoryEngineDiagnosticsInit();
    const first = new Worker('/first') as unknown as NativeWorkerDouble;
    const second = new Worker('/second') as unknown as NativeWorkerDouble;
    const payload = { kind: 'generateChart', id: 5 };
    expect(first.postMessage.call(second, payload)).toBe('native-return');
    expect(second.sends[0]?.receiver).toBe(second);
    expect(second.sends[0]?.args[0]).toBe(payload);
    expect(snapshot().events).toEqual([]);
    expect(() => first.postMessage.call({}, payload)).toThrow('native brand');
  });

  it('never calls payload getters or copies payloads to observe protocol metadata', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    const getter = vi.fn(() => { throw new Error('PRIVATE GETTER'); });
    const request = { kind: 'generateChart', id: 6, get birth() { return getter(); } };
    worker.postMessage(request);
    const response = { ok: false, id: 6, get errorName() { return getter(); }, get error() { return getter(); } };
    worker.receive(response);
    expect(getter).not.toHaveBeenCalled();
    expect(snapshot().events.at(-1)).toMatchObject({ category: 'error-other' });
    const getterKind = { id: 8, get kind() { return getter(); } };
    worker.postMessage(getterKind);
    expect(getter).not.toHaveBeenCalled();
    expect(snapshot().events).toHaveLength(2);
  });

  it('diagnostic reflection failures never change a successful native send or response delivery', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('PRIVATE PROXY'); } });
    const listener = vi.fn();
    worker.addEventListener('message', listener);
    expect(worker.postMessage(hostile)).toBe('native-return');
    expect(() => worker.receive(hostile)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(snapshot().events).toEqual([]);
  });

  it('records fixed lifecycle failures without consuming application listeners or private event text', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'boot', id: 1 });
    const onError = vi.fn();
    const onMessageError = vi.fn();
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    worker.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE NATIVE ERROR', filename: '/private', cancelable: true }));
    worker.dispatchEvent(new MessageEvent('messageerror', { data: 'PRIVATE MESSAGE' }));
    expect(onError).toHaveBeenCalledOnce();
    expect(onMessageError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0].defaultPrevented).toBe(false);
    expect(snapshot().events.slice(-2)).toMatchObject([{ category: 'worker-error' }, { category: 'message-error' }]);
    expect(snapshot().pendingCount).toBe(0);
    expect(JSON.stringify(snapshot())).not.toMatch(/PRIVATE|private/);
  });

  it('bounds event history, worker observation and pending correlations while preserving latest failure metadata', () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    for (let id = 0; id < 1_000; id += 1) worker.postMessage({ kind: 'generateChart', id });
    expect(snapshot().events).toHaveLength(256);
    expect(snapshot().droppedEvents).toBe(744);
    expect(snapshot().pendingCount).toBe(64);
    worker.receive({ id: 1, ok: false, errorName: 'RuntimeError', error: 'PRIVATE' });
    expect(snapshot().events.at(-1)).toMatchObject({ operation: 'generateChart', category: 'error-runtime' });
    for (let index = 0; index < 40; index += 1) new Worker('/private');
    expect(snapshot().unobservedWorkers).toBe(9);
  });

  it('returns detached metadata snapshots and does not reinstall instrumentation', () => {
    memoryEngineDiagnosticsInit();
    const wrapped = window.Worker;
    memoryEngineDiagnosticsInit();
    expect(window.Worker).toBe(wrapped);
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'boot', id: 1 });
    const first = snapshot();
    first.events[0]!.operation = 'PRIVATE MUTATION';
    first.events.length = 0;
    expect(snapshot().events).toHaveLength(1);
    expect(snapshot().events[0]?.operation).toBe('boot');
  });

  it('executes the serialized init function in an isolated scope without module imports or closure state', async () => {
    const addInitScript = vi.fn(async (init: () => void) => {
      // Playwright serializes this function into the next document. Function
      // construction deliberately removes this module's lexical environment.
      const run = new Function('window', 'performance', `(${init.toString()})();`) as (target: Window, clock: Performance) => void;
      run(window, performance);
    });
    await installMemoryEngineDiagnostics({ addInitScript } as unknown as Page);
    expect(addInitScript).toHaveBeenCalledExactlyOnceWith(memoryEngineDiagnosticsInit);
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'boot', id: 1 });
    worker.receive({ id: 1, ok: false, errorName: 'RuntimeError', error: 'PRIVATE' });
    expect(snapshot().events.at(-1)).toMatchObject({ operation: 'boot', category: 'error-runtime' });
  });

  it.each([null, 'PRIVATE', { kind: 'PRIVATE', id: 1 }, { kind: 'boot', id: 'PRIVATE' }, { kind: 'boot', id: -1 }, { kind: 'boot', id: Infinity }])('ignores non-protocol or invalid-correlation messages: %j', (message) => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/engine') as unknown as NativeWorkerDouble;
    worker.postMessage(message);
    worker.receive(message);
    expect(snapshot().events).toEqual([]);
  });
});

describe('memory engine diagnostic evidence', () => {
  async function capture(evaluate: (read: () => unknown) => Promise<unknown>) {
    const directory = await mkdtemp(join(tmpdir(), 'almamesh-memory-protocol-test-'));
    const path = join(directory, 'memory-engine-diagnostics.json');
    const attach = vi.fn(async () => undefined);
    try {
      await attachMemoryEngineDiagnostics({ evaluate } as unknown as Page, {
        outputPath: () => path, attach,
      } as unknown as TestInfo);
      const report: unknown = JSON.parse(await readFile(path, 'utf8'));
      expect(attach).toHaveBeenCalledExactlyOnceWith('memory-engine-diagnostics.json', { path, contentType: 'application/json' });
      return report;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  it('physically writes the bounded snapshot before attaching it', async () => {
    memoryEngineDiagnosticsInit();
    const worker = new Worker('/private') as unknown as NativeWorkerDouble;
    worker.postMessage({ kind: 'generateChart', id: 1, birth: 'PRIVATE' });
    const report = await capture(async (read) => read());
    expect(report).toMatchObject({ available: true, snapshot: {
      instrumentationFailures: 0, workerLimit: 32, eventLimit: 256,
      pendingLimitPerWorker: 64, maximumPendingCount: 2048,
      events: [{ operation: 'generateChart' }],
    } });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|private/);
  });

  it('writes a fixed unavailable category when the page has failed without leaking its error', async () => {
    const report = await capture(async () => { throw new Error('PRIVATE PAGE FAILURE'); });
    expect(report).toEqual({ available: false, reason: 'page-unavailable' });
  });

  it('writes a fixed missing-observer category instead of claiming protocol evidence exists', async () => {
    expect(await capture(async (read) => read())).toEqual({ available: false, reason: 'observer-missing' });
  });

  it('bounds a wedged metadata read and handles its late rejection without retaining private errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'almamesh-memory-protocol-timeout-test-'));
    const path = join(directory, 'memory-engine-diagnostics.json');
    let rejectRead!: (error: Error) => void;
    const pendingRead = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
    const attach = vi.fn(async () => undefined);
    vi.useFakeTimers();
    const task = attachMemoryEngineDiagnostics({ evaluate: () => pendingRead } as unknown as Page, {
      outputPath: () => path, attach,
    } as unknown as TestInfo);
    try {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(attach).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ available: false, reason: 'snapshot-timeout' });
      rejectRead(new Error('PRIVATE LATE PAGE ERROR'));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rejectRead(new Error('PRIVATE CLEANUP ERROR'));
      await task.catch(() => undefined);
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('finishes RSS reporting after a real attachment failure and preserves the original journey failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'almamesh-memory-protocol-finalizer-test-'));
    const path = join(directory, 'memory-engine-diagnostics.json');
    const attachmentError = new Error('attachment failed');
    const journeyError = new Error('original journey failed');
    const attach = vi.fn(async () => { throw attachmentError; });
    const finish = vi.fn(async () => {
      // The metadata file must already have been written, even if its reporter failed.
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ available: false, reason: 'observer-missing' });
    });
    try {
      const failure = await finalizeMemoryEngineDiagnostics({ evaluate: async (read: () => unknown) => read() } as unknown as Page, {
        outputPath: () => path, attach,
      } as unknown as TestInfo, finish, { error: journeyError }).catch((error: unknown) => error);
      expect(finish).toHaveBeenCalledOnce();
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([journeyError, attachmentError]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves both metadata and RSS reporter failures without a preceding journey error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'almamesh-memory-protocol-double-failure-test-'));
    const attachmentError = new Error('attachment failed');
    const finishError = new Error('RSS reporter failed');
    const finish = vi.fn(async () => { throw finishError; });
    try {
      const failure = await finalizeMemoryEngineDiagnostics({ evaluate: async (read: () => unknown) => read() } as unknown as Page, {
        outputPath: () => join(directory, 'memory-engine-diagnostics.json'),
        attach: async () => { throw attachmentError; },
      } as unknown as TestInfo, finish).catch((error: unknown) => error);
      expect(finish).toHaveBeenCalledOnce();
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([attachmentError, finishError]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
