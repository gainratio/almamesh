import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Frame, Page, TestInfo, Worker } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { classifyNativeWorkerUrl, createNativeWorkerLifecycle } from '../../e2e/nativeWorkerLifecycle';
import { startWebKitDiagnostics } from '../../e2e/webkitDiagnostics';

// Exercise the real diagnostics finish path without spawning ps or writing artifacts.
vi.mock('node:child_process', () => {
  const module = { execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(async () => ({ stdout: '', stderr: '' })),
  }) };
  return { ...module, default: module };
});
vi.mock('node:fs', () => {
  const module = { writeFileSync: vi.fn() };
  return { ...module, default: module };
});

class Events {
  readonly listeners = new Map<string, Set<(value: never) => void>>();
  on(name: string, listener: (value: never) => void): this {
    const callbacks = this.listeners.get(name) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(name, callbacks);
    return this;
  }
  off(name: string, listener: (value: never) => void): this {
    this.listeners.get(name)?.delete(listener);
    return this;
  }
  emit(name: string, value?: unknown): void {
    for (const callback of this.listeners.get(name) ?? []) callback(value as never);
  }
  listenerCount(): number { return [...this.listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0); }
}

class WorkerDouble extends Events {
  url = vi.fn(() => 'http://127.0.0.1:4350/assets/chartWorker-Abcd1234.js?PRIVATE_QUERY');
  asWorker(): Worker { return this as unknown as Worker; }
}
class PageDouble extends Events {
  readonly frame = {} as Frame;
  readonly initialWorkers: Worker[] = [];
  mainFrame = vi.fn(() => this.frame);
  workers = vi.fn(() => this.initialWorkers);
  url = vi.fn(() => 'http://127.0.0.1:4350/PRIVATE_PATH?PRIVATE_QUERY');
  asPage(): Page { return this as unknown as Page; }
}
class ContextDouble extends Events {
  readonly initialPages: Page[] = [];
  pages = vi.fn(() => this.initialPages);
  asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

beforeEach(() => {
  vi.mocked(writeFileSync).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('public native Worker URL categories', () => {
  it.each([
    ['http://localhost:4350/assets/chartWorker-Abcd1234.js?PRIVATE_QUERY', 'chart-worker'],
    ['https://localhost/assets/edgeproc.worker-Abcd1234.js#PRIVATE', 'sync-worker'],
    ['http://localhost/assets/sqlite3-worker1-Abcd1234.js', 'sqlite-worker'],
    ['http://localhost/assets/sqlite.worker-Abcd1234.js', 'sqlite-worker'],
    ['http://localhost/assets/sqlite3-opfs-async-proxy-Abcd1234.js', 'sqlite-worker'],
    ['blob:http://127.0.0.1:4350/PRIVATE_ID', 'blob-worker'],
    ['http://localhost/assets/worker-DB1nQm7l.js', 'other'],
    ['http://localhost/assets/not-chartWorker-Abcd1234.js', 'other'],
    ['http://localhost/assets/chartWorker-Abcd1234.js/PRIVATE', 'other'],
    ['http://localhost/assets/chartWorker-Abcd1234.js.map', 'other'],
    ['data:text/javascript,PRIVATE_SOURCE', 'other'],
    ['file:///PRIVATE/chartWorker-Abcd1234.js', 'other'],
    ['PRIVATE malformed url', 'other'],
  ] as const)('classifies %s without retaining it', (url, category) => {
    expect(classifyNativeWorkerUrl(url)).toBe(category);
  });

  it('does not coerce hostile objects or inspect oversized URLs', () => {
    const coerce = vi.fn(() => { throw new Error('PRIVATE'); });
    expect(classifyNativeWorkerUrl({ toString: coerce })).toBe('other');
    expect(classifyNativeWorkerUrl(`http://localhost/${'PRIVATE'.repeat(1_000)}`)).toBe('other');
    expect(coerce).not.toHaveBeenCalled();
  });
});

describe('public native Worker lifecycle', () => {
  it('attributes old and new Workers to their most recent observed main-frame navigation and keeps the old close generation', () => {
    let now = 100;
    const observer = createNativeWorkerLifecycle(() => now);
    const context = new ContextDouble();
    const page = new PageDouble();
    context.initialPages.push(page.asPage());
    observer.watch(context.asContext());
    now = 105;
    page.emit('framenavigated', page.frame);
    const oldWorker = new WorkerDouble();
    now = 110;
    page.emit('worker', oldWorker.asWorker());
    now = 115;
    page.emit('framenavigated', {} as Frame); // subframe does not rotate the generation
    now = 120;
    page.emit('framenavigated', page.frame);
    const newWorker = new WorkerDouble();
    now = 125;
    page.emit('worker', newWorker.asWorker());
    now = 130;
    oldWorker.emit('close');
    const snapshot = observer.finish();
    expect(snapshot.events.map(({ sequence, kind, documentGeneration, workerId, elapsedMs }) => ({ sequence, kind, documentGeneration, workerId, elapsedMs }))).toEqual([
      { sequence: 1, kind: 'page-observed', documentGeneration: 0, workerId: undefined, elapsedMs: 0 },
      { sequence: 2, kind: 'main-frame-navigated', documentGeneration: 1, workerId: undefined, elapsedMs: 5 },
      { sequence: 3, kind: 'worker-started', documentGeneration: 1, workerId: 1, elapsedMs: 10 },
      { sequence: 4, kind: 'main-frame-navigated', documentGeneration: 2, workerId: undefined, elapsedMs: 20 },
      { sequence: 5, kind: 'worker-started', documentGeneration: 2, workerId: 2, elapsedMs: 25 },
      { sequence: 6, kind: 'worker-closed', documentGeneration: 1, workerId: 1, elapsedMs: 30 },
    ]);
    expect(snapshot.events.every((event) => event.pageId === 1)).toBe(true);
    expect(snapshot.events.filter((event) => event.workerId).every((event) => event.category === 'chart-worker')).toBe(true);
  });

  it('keeps a Node-side snapshot after page crash/close, and distinguishes initially existing Workers', () => {
    const observer = createNativeWorkerLifecycle(() => 0);
    const context = new ContextDouble();
    const page = new PageDouble();
    const worker = new WorkerDouble();
    page.initialWorkers.push(worker.asWorker());
    context.initialPages.push(page.asPage());
    observer.watch(context.asContext());
    page.emit('crash');
    page.emit('close');
    worker.emit('close');
    page.url.mockImplementation(() => { throw new Error('PRIVATE DEAD PAGE'); });
    expect(observer.finish().events).toMatchObject([
      { kind: 'page-observed', documentGeneration: 0 },
      { kind: 'worker-existing', documentGeneration: 0, workerId: 1 },
      { kind: 'page-crashed', documentGeneration: 0 },
      { kind: 'page-closed', documentGeneration: 0 },
      { kind: 'worker-closed', documentGeneration: 0, workerId: 1 },
    ]);
    expect(page.url).not.toHaveBeenCalled();
  });

  it('deduplicates context watches, pages, Workers and terminal lifecycle events', () => {
    const observer = createNativeWorkerLifecycle();
    const context = new ContextDouble();
    const page = new PageDouble();
    const worker = new WorkerDouble();
    page.initialWorkers.push(worker.asWorker());
    context.initialPages.push(page.asPage());
    observer.watch(context.asContext());
    observer.watch(context.asContext());
    context.emit('page', page.asPage());
    page.emit('worker', worker.asWorker());
    page.emit('crash'); page.emit('crash');
    page.emit('close'); page.emit('close');
    worker.emit('close'); worker.emit('close');
    expect(observer.finish()).toMatchObject({ pageCount: 1, workerCount: 1, droppedPages: 0, droppedWorkers: 0 });
    expect(observer.finish().events).toHaveLength(5);
  });

  it('observes newly opened pages and closes their listeners at finish without touching native behavior', () => {
    const observer = createNativeWorkerLifecycle();
    const context = new ContextDouble();
    const page = new PageDouble();
    const worker = new WorkerDouble();
    observer.watch(context.asContext());
    context.emit('page', page.asPage());
    page.emit('worker', worker.asWorker());
    expect(context.listenerCount()).toBeGreaterThan(0);
    expect(page.listenerCount()).toBe(4);
    expect(worker.listenerCount()).toBe(1);
    const first = observer.finish();
    expect([context.listenerCount(), page.listenerCount(), worker.listenerCount()]).toEqual([0, 0, 0]);
    context.emit('page', new PageDouble().asPage());
    page.emit('crash'); worker.emit('close');
    expect(observer.finish()).toEqual(first);
    first.events.splice(0);
    expect(observer.finish().events.length).toBeGreaterThan(0);
  });

  it('bounds pages, Workers, contexts and events while keeping the latest crash and reporting drops', () => {
    const observer = createNativeWorkerLifecycle(() => 0);
    const context = new ContextDouble();
    const pages = Array.from({ length: 12 }, () => new PageDouble());
    context.initialPages.push(...pages.map((page) => page.asPage()));
    observer.watch(context.asContext());
    for (let i = 0; i < 40; i += 1) pages[0].emit('worker', new WorkerDouble().asWorker());
    for (let i = 0; i < 300; i += 1) pages[0].emit('framenavigated', pages[0].frame);
    for (let i = 0; i < 10; i += 1) observer.watch(new ContextDouble().asContext());
    pages[0].emit('crash');
    const snapshot = observer.finish();
    expect(snapshot).toMatchObject({ pageCount: 8, workerCount: 32, contextCount: 8, droppedPages: 4, droppedWorkers: 8, droppedContexts: 3, droppedEvents: 85 });
    expect(snapshot.events).toHaveLength(256);
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'page-crashed', documentGeneration: 300, sequence: 341 });
    expect(snapshot.events.every((event, index) => index === 0 || event.sequence > snapshot.events[index - 1].sequence)).toBe(true);
    expect(JSON.stringify(snapshot).length).toBeLessThan(50_000);
    expect(pages.slice(8).every((page) => page.listenerCount() === 0)).toBe(true);
  });

  it('contains URL and event input failures and never serializes private URLs/errors/payloads', () => {
    const observer = createNativeWorkerLifecycle(() => Number.POSITIVE_INFINITY);
    const context = new ContextDouble();
    const page = new PageDouble();
    context.initialPages.push(page.asPage());
    observer.watch(context.asContext());
    const worker = new WorkerDouble();
    worker.url.mockImplementation(() => { throw new Error('PRIVATE KEY AND BIRTH'); });
    expect(() => page.emit('worker', worker.asWorker())).not.toThrow();
    page.mainFrame.mockImplementation(() => { throw new Error('PRIVATE FRAME URL'); });
    expect(() => page.emit('framenavigated', { private: 'PRIVATE CHART' })).not.toThrow();
    const snapshot = observer.finish();
    expect(snapshot.observerFailures).toBe(2);
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'worker-started', category: 'other', elapsedMs: 0 });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|https?:|blob:|url|payload|errorMessage|chartData/);
    expect(snapshot.events.every((event) => Number.isFinite(event.elapsedMs))).toBe(true);
  });

  it('continues detaching other listeners if one public off call throws and records only a failure count', () => {
    const observer = createNativeWorkerLifecycle();
    const context = new ContextDouble();
    const page = new PageDouble();
    const worker = new WorkerDouble();
    context.initialPages.push(page.asPage());
    observer.watch(context.asContext());
    page.emit('worker', worker.asWorker());
    context.off = () => { throw new Error('PRIVATE DETACH FAILURE'); };
    const snapshot = observer.finish();
    expect(snapshot.observerFailures).toBe(1);
    expect(page.listenerCount()).toBe(0);
    expect(worker.listenerCount()).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    context.emit('page', new PageDouble().asPage());
    expect(observer.finish()).toEqual(snapshot);
  });

  it('keeps future events observable after failed initial enumeration or one listener registration', () => {
    const observer = createNativeWorkerLifecycle(() => 0);
    const context = new ContextDouble();
    context.pages.mockImplementation(() => { throw new Error('PRIVATE ENUMERATION'); });
    expect(() => observer.watch(context.asContext())).not.toThrow();
    const page = new PageDouble();
    const nativeOn = page.on.bind(page);
    page.on = (name, listener) => {
      if (name === 'worker') throw new Error('PRIVATE REGISTRATION');
      return nativeOn(name, listener);
    };
    page.workers.mockImplementation(() => { throw new Error('PRIVATE WORKERS'); });
    context.emit('page', page.asPage());
    page.emit('framenavigated', page.frame);
    page.emit('crash');
    const snapshot = observer.finish();
    expect(snapshot.observerFailures).toBe(3);
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'page-crashed', documentGeneration: 1 });
    expect([context.listenerCount(), page.listenerCount()]).toEqual([0, 0]);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });

  it('keeps elapsed time finite and monotonic even when an injected clock fails or moves backward', () => {
    const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(105)
      .mockReturnValueOnce(90).mockImplementationOnce(() => { throw new Error('PRIVATE CLOCK'); })
      .mockReturnValue(120);
    const observer = createNativeWorkerLifecycle(clock);
    const context = new ContextDouble();
    const page = new PageDouble();
    context.initialPages.push(page.asPage());
    observer.watch(context.asContext());
    page.emit('framenavigated', page.frame);
    page.emit('crash');
    page.emit('close');
    const snapshot = observer.finish();
    expect(snapshot.events.map((event) => event.elapsedMs)).toEqual([5, 5, 5, 20]);
    expect(snapshot.observerFailures).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });
});

describe('WebKit diagnostics public Worker receipt integration', () => {
  function info(): TestInfo {
    return { title: 'synthetic lifecycle', titlePath: ['synthetic lifecycle'], status: 'failed', project: { name: 'webkit' }, outputPath: (name: string) => `/tmp/${name}` } as unknown as TestInfo;
  }

  it('writes and prints the same safe Node-side lifecycle snapshot and preserves the RSS result', async () => {
    const context = new ContextDouble();
    const page = new PageDouble();
    const worker = new WorkerDouble();
    context.initialPages.push(page.asPage());
    const diagnostics = startWebKitDiagnostics(info());
    diagnostics.watch(context.asContext());
    page.emit('worker', worker.asWorker());
    page.emit('crash');
    const summary = await diagnostics.finish();
    expect(summary).toMatchObject({ samples: 1 });
    const receipt = vi.mocked(writeFileSync).mock.calls.find(([path]) => String(path).endsWith('-worker-lifecycle.json'));
    expect(receipt).toBeDefined();
    const snapshot = JSON.parse(String(receipt?.[1]));
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'page-crashed' });
    const stdout = vi.mocked(console.log).mock.calls.map(([value]) => String(value)).find((value) => value.startsWith('{"event":"native-worker-lifecycle"'));
    expect(JSON.parse(stdout ?? '{}').snapshot).toEqual(snapshot);
    expect(stdout).not.toMatch(/PRIVATE|https?:|blob:|url|payload/);
    // The observer's four page listeners detach; the existing browser logger remains unchanged.
    expect(page.listenerCount()).toBe(2);
    expect(worker.listenerCount()).toBe(0);
  });

  it('still finishes RSS artifacts when the new lifecycle file cannot be retained', async () => {
    vi.mocked(writeFileSync).mockImplementation((path) => {
      if (String(path).endsWith('-worker-lifecycle.json')) throw new Error('PRIVATE FILE FAILURE');
    });
    const diagnostics = startWebKitDiagnostics(info());
    await expect(diagnostics.finish()).rejects.toThrow('Native worker lifecycle diagnostics could not be retained.');
    expect(vi.mocked(writeFileSync).mock.calls.some(([path]) => String(path).endsWith('-rss.csv'))).toBe(true);
    expect(vi.mocked(writeFileSync).mock.calls.some(([path]) => String(path).endsWith('-browser.log'))).toBe(true);
  });

  it('preserves an original RSS write error when lifecycle retention also fails', async () => {
    const original = new Error('ORIGINAL RSS FAILURE');
    vi.mocked(writeFileSync).mockImplementation((path) => {
      if (String(path).endsWith('-worker-lifecycle.json')) throw new Error('PRIVATE FILE FAILURE');
      if (String(path).endsWith('-rss.csv')) throw original;
    });
    const diagnostics = startWebKitDiagnostics(info());
    await expect(diagnostics.finish()).rejects.toBe(original);
  });
});
