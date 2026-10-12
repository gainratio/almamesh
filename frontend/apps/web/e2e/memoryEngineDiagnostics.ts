import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';

/**
 * External observer shared by original-release and candidate memory tests.
 * Everything it executes lives inside this function so addInitScript needs no
 * application hooks or imports. It never clones or retains a protocol payload.
 */
export function memoryEngineDiagnosticsInit(): void {
  const scope = window as unknown as Record<string, unknown>;
  if (typeof scope.__almameshMemoryEngineSnapshot === 'function') return;
  type Event = {
    direction: 'send' | 'receive' | 'lifecycle';
    workerIndex: number;
    operation?: string;
    correlation?: number;
    ok?: boolean;
    category: string;
    elapsedMs: number;
  };
  const events: Event[] = [];
  const started = performance.now();
  const workerLimit = 32;
  const eventLimit = 256;
  const pendingLimit = 64;
  let workerCount = 0;
  let unobservedWorkers = 0;
  let droppedEvents = 0;
  let pendingCount = 0;
  let instrumentationFailures = 0;
  const chartOperations = new Set(['prewarm', 'boot', 'generateChart', 'computePredictive', 'computeMoonWindow', 'computeMeshEdge', 'computeRectification']);
  // @gainratio/browser 0.4.1 sqlite/protocol.d.ts and sql/protocol.d.ts.
  const stateOperations = new Set(['initialize', 'get', 'list', 'batch', 'migrate', 'integrity-check', 'export', 'stage-import', 'discard-import', 'commit-import', 'reset', 'runtime-info', 'dispose']);
  const sqlOperations = new Set(['open', 'exec', 'query', 'tx-exec', 'tx-query', 'transaction', 'execute-many', 'begin', 'commit', 'rollback', 'prepare', 'run-prepared', 'all-prepared', 'finalize', 'export', 'import', 'migrate-legacy', 'runtime-info', 'close']);
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const data = (value: unknown, key: string): unknown => {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const category = (name: unknown): string => {
    switch (name) {
      case 'RuntimeError': return 'error-runtime';
      case 'PythonError': return 'error-python';
      case 'PyodidePackageLoadError': return 'error-package-load';
      case 'AbortError': return 'error-abort';
      case 'TypeError': return 'error-type';
      case 'SqliteStateConflictError': return 'error-state-conflict';
      case 'SqliteStateSchemaError': return 'error-state-schema';
      case 'SqlStorageUnavailableError': return 'error-sql-storage';
      case 'SqlImportRejectedError': return 'error-sql-import';
      case 'SqlTransactionEndedError': return 'error-sql-transaction';
      default: return 'error-other';
    }
  };
  const append = (event: Omit<Event, 'elapsedMs'>): void => {
    const elapsed = performance.now() - started;
    if (events.length === eventLimit) { events.shift(); droppedEvents = increment(droppedEvents); }
    events.push({ ...event, elapsedMs: Number.isFinite(elapsed) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(elapsed))) : 0 });
  };
  const observe = (work: () => void): void => {
    try { work(); } catch { instrumentationFailures = increment(instrumentationFailures); }
  };
  Object.defineProperty(scope, '__almameshMemoryEngineSnapshot', {
    configurable: true,
    value: () => ({
      schemaVersion: 1, workerLimit, eventLimit, pendingLimitPerWorker: pendingLimit,
      maximumPendingCount: workerLimit * pendingLimit,
      droppedEvents, unobservedWorkers, pendingCount, instrumentationFailures,
      events: events.map((event) => ({ ...event })),
    }),
  });
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(Target, args, NewTarget) {
      // Constructor arguments/options/newTarget and native exceptions are
      // forwarded unchanged; no script URL or Worker name is inspected.
      workerCount = increment(workerCount);
      const workerIndex = workerCount;
      let worker: Worker;
      try { worker = Reflect.construct(Target, args, NewTarget) as Worker; }
      catch (error) {
        if (workerIndex <= workerLimit) observe(() => append({ direction: 'lifecycle', workerIndex, category: 'constructor-threw' }));
        else unobservedWorkers = increment(unobservedWorkers);
        throw error;
      }
      if (workerIndex > workerLimit) { unobservedWorkers = increment(unobservedWorkers); return worker; }
      const pending = new Map<number, string>();
      let protocol: 'chart' | 'state' | 'sql' | undefined;
      const correlation = (message: unknown): number | undefined => {
        const id = data(message, 'id');
        return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
      };
      const requestOperation = (message: unknown): string | undefined => {
        const kind = data(message, 'kind');
        if (typeof kind === 'string' && chartOperations.has(kind) && (!protocol || protocol === 'chart')) {
          protocol = 'chart';
          return kind;
        }
        const operation = data(message, 'operation');
        if (!protocol && operation === 'initialize') protocol = 'state';
        if (!protocol && operation === 'open') protocol = 'sql';
        if (typeof operation !== 'string') return undefined;
        if (protocol === 'state' && stateOperations.has(operation)) return `state:${operation}`;
        if (protocol === 'sql' && sqlOperations.has(operation)) return `sql:${operation}`;
        return undefined;
      };
      const clear = (): void => { pendingCount -= pending.size; pending.clear(); };
      observe(() => {
        worker.addEventListener('message', (event: MessageEvent<unknown>) => observe(() => {
          const message = event.data;
          const id = correlation(message);
          const ok = data(message, 'ok');
          if (id === undefined || typeof ok !== 'boolean') return;
          const operation = pending.get(id);
          if (!operation) return;
          const progress = protocol === 'chart' && operation === 'boot' && data(message, 'kind') === 'bootProgress' && ok;
          const errorName = protocol === 'chart' ? data(message, 'errorName') : data(data(message, 'error'), 'name');
          append({ direction: 'receive', workerIndex, operation: progress ? 'bootProgress' : operation, correlation: id, ok, category: ok ? 'ok' : category(errorName) });
          if (!progress) { pending.delete(id); pendingCount -= 1; }
        }));
        for (const [type, code] of [['error', 'worker-error'], ['messageerror', 'message-error']] as const) {
          worker.addEventListener(type, () => observe(() => {
            clear();
            append({ direction: 'lifecycle', workerIndex, category: code });
          }));
        }
        worker.postMessage = new Proxy(worker.postMessage, {
          apply(target, receiver, postArgs) {
            let result: unknown;
            try { result = Reflect.apply(target, receiver, postArgs); }
            catch (error) {
              if (receiver === worker) observe(() => {
                const id = correlation(postArgs[0]);
                const operation = requestOperation(postArgs[0]);
                if (id !== undefined && operation) append({ direction: 'send', workerIndex, operation, correlation: id, category: 'post-message-threw' });
              });
              throw error;
            }
            if (receiver === worker) observe(() => {
              const id = correlation(postArgs[0]);
              const operation = requestOperation(postArgs[0]);
              if (id === undefined || !operation) return;
              if (pending.has(id) || pending.size < pendingLimit) {
                if (!pending.has(id)) pendingCount += 1;
                pending.set(id, operation);
              }
              append({ direction: 'send', workerIndex, operation, correlation: id, category: 'sent' });
            });
            return result;
          },
        });
        worker.terminate = new Proxy(worker.terminate, {
          apply(target, receiver, terminateArgs) {
            const result = Reflect.apply(target, receiver, terminateArgs);
            if (receiver === worker) observe(() => {
              clear();
              append({ direction: 'lifecycle', workerIndex, category: 'terminated' });
            });
            return result;
          },
        });
      });
      return worker;
    },
  });
}

export async function installMemoryEngineDiagnostics(page: Page): Promise<void> {
  await page.addInitScript(memoryEngineDiagnosticsInit);
}

/** Keep the bounded metadata artifact even when onboarding or the page fails. */
export async function attachMemoryEngineDiagnostics(page: Page, testInfo: TestInfo): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let report: unknown;
  try {
    const timeout = new Promise<unknown>((resolve) => {
      deadline = setTimeout(() => resolve({ available: false, reason: 'snapshot-timeout' }), 2_000);
    });
    // Observe late rejection after the metadata deadline without changing the
    // journey's existing navigation, memory or test deadlines.
    const snapshot = Promise.resolve().then(() => page.evaluate(() => {
      const read = (window as unknown as { __almameshMemoryEngineSnapshot?: () => unknown }).__almameshMemoryEngineSnapshot;
      return typeof read === 'function' ? { available: true, snapshot: read() } : { available: false, reason: 'observer-missing' };
    })).catch(() => ({ available: false, reason: 'page-unavailable' }));
    report = await Promise.race([snapshot, timeout]);
  } finally { clearTimeout(deadline); }
  const path = testInfo.outputPath('memory-engine-diagnostics.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach('memory-engine-diagnostics.json', { path, contentType: 'application/json' });
}

/** Always finish the native sampler, retaining simultaneous failure causes. */
export async function finalizeMemoryEngineDiagnostics(
  page: Page,
  testInfo: TestInfo,
  finish: () => Promise<void>,
  journeyFailure?: { error: unknown },
): Promise<void> {
  const failures: unknown[] = [];
  try { await attachMemoryEngineDiagnostics(page, testInfo); }
  catch (error) { failures.push(error); }
  finally {
    try { await finish(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 0) return;
  if (journeyFailure) failures.unshift(journeyFailure.error);
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'Memory journey and evidence finalization failed.');
}
