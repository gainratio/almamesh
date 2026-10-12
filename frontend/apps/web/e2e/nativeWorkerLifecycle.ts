import type { BrowserContext, Page, Worker } from '@playwright/test';

type Category = 'chart-worker' | 'sqlite-worker' | 'sync-worker' | 'blob-worker' | 'other';
interface Event {
  sequence: number;
  elapsedMs: number;
  pageId: number;
  documentGeneration: number;
  workerId?: number;
  category?: Category;
  kind: 'page-observed' | 'main-frame-navigated' | 'worker-started' | 'worker-existing' | 'worker-closed' | 'page-crashed' | 'page-closed';
}
interface Snapshot {
  limitations: readonly string[];
  events: Event[];
  pageCount: number;
  workerCount: number;
  contextCount: number;
  droppedPages: number;
  droppedWorkers: number;
  droppedContexts: number;
  droppedEvents: number;
  observerFailures: number;
}

const MAX_PAGES = 8;
const MAX_WORKERS = 32;
const MAX_EVENTS = 256;
const MAX_CONTEXTS = 8;
const LIMITATIONS = [
  'public-worker-list-may-omit-nested-workers',
  'generic-worker-assets-unattributed',
  'generation-is-observed-main-frame-navigation',
  'existing-worker-start-time-unobserved',
] as const;

/** Classify transiently; generic bundled worker names do not establish their role. */
export function classifyNativeWorkerUrl(value: unknown): Category {
  if (typeof value !== 'string' || value.length > 4_096) return 'other';
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'blob:') return 'blob-worker';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'other';
    const basename = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
    if (/^chartWorker(?:-[A-Za-z0-9_-]{8,64})?\.(?:js|ts)$/.test(basename)) return 'chart-worker';
    if (/^edgeproc\.worker(?:-[A-Za-z0-9_-]{8,64})?\.(?:js|ts)$/.test(basename)) return 'sync-worker';
    if (/^(?:sqlite3-worker1|sqlite(?:3)?[.-]worker|sqlite3-opfs-async-proxy)(?:-[A-Za-z0-9_-]{8,64})?\.(?:js|mjs|ts)$/.test(basename)) return 'sqlite-worker';
  } catch { /* Malformed input is an unknown category, never diagnostic text. */ }
  return 'other';
}

type EventSource = {
  on(name: string, listener: (value: never) => void): unknown;
  off(name: string, listener: (value: never) => void): unknown;
};
type PageState = { id: number; generation: number; crashed: boolean; closed: boolean };

/**
 * Public Playwright events only. Everything retained lives in Node and survives
 * page loss. Generation zero means the current document predates observation;
 * later generations count observed main-frame navigations, not browser IDs.
 * Nested Workers may be absent from the public list. Generic worker assets
 * remain `other`; no canonical/derived SQLite ownership is inferred.
 */
export function createNativeWorkerLifecycle(now: () => number = () => performance.now()) {
  const events: Event[] = [];
  const contexts = new WeakSet<BrowserContext>();
  const pages = new WeakSet<Page>();
  const workers = new WeakSet<Worker>();
  const detach: (() => void)[] = [];
  let pageCount = 0;
  let workerCount = 0;
  let contextCount = 0;
  let droppedPages = 0;
  let droppedWorkers = 0;
  let droppedContexts = 0;
  let droppedEvents = 0;
  let observerFailures = 0;
  let sequence = 0;
  let elapsedMs = 0;
  let stopped = false;
  let completed: Snapshot | undefined;
  const clock = (): number => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      observerFailures += 1;
      return 0;
    }
  };
  const started = clock();
  const attempt = (work: () => void): void => {
    if (stopped) return;
    try { work(); } catch { observerFailures += 1; }
  };
  const append = (event: Omit<Event, 'sequence' | 'elapsedMs'>): void => {
    elapsedMs = Math.max(elapsedMs, Math.min(Number.MAX_SAFE_INTEGER, Math.round(clock() - started)));
    sequence += 1;
    if (events.length === MAX_EVENTS) {
      events.shift();
      droppedEvents += 1;
    }
    events.push({ ...event, sequence, elapsedMs });
  };
  const listen = (target: BrowserContext | Page | Worker, name: string, handler: (value: never) => void): void => {
    attempt(() => {
      const source = target as unknown as EventSource;
      const listener = (value: never): void => attempt(() => handler(value));
      source.on(name, listener);
      detach.push(() => { source.off(name, listener); });
    });
  };
  const watchWorker = (worker: Worker, page: PageState, existing: boolean): void => {
    if (workers.has(worker)) return;
    workers.add(worker);
    if (workerCount === MAX_WORKERS) { droppedWorkers += 1; return; }
    workerCount += 1;
    const workerId = workerCount;
    const documentGeneration = page.generation;
    let category: Category = 'other';
    attempt(() => { category = classifyNativeWorkerUrl(worker.url()); });
    const identity = { pageId: page.id, documentGeneration, workerId, category };
    append({ ...identity, kind: existing ? 'worker-existing' : 'worker-started' });
    let closed = false;
    listen(worker, 'close', () => {
      if (closed) return;
      closed = true;
      append({ ...identity, kind: 'worker-closed' });
    });
  };
  const watchPage = (page: Page): void => {
    if (pages.has(page)) return;
    pages.add(page);
    if (pageCount === MAX_PAGES) { droppedPages += 1; return; }
    pageCount += 1;
    const state: PageState = { id: pageCount, generation: 0, crashed: false, closed: false };
    const pageEvent = (kind: Event['kind']): void => append({ kind, pageId: state.id, documentGeneration: state.generation });
    pageEvent('page-observed');
    listen(page, 'worker', (worker: Worker) => watchWorker(worker, state, false));
    listen(page, 'framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      state.generation += 1;
      pageEvent('main-frame-navigated');
    });
    listen(page, 'crash', () => {
      if (state.crashed) return;
      state.crashed = true;
      pageEvent('page-crashed');
    });
    listen(page, 'close', () => {
      if (state.closed) return;
      state.closed = true;
      pageEvent('page-closed');
    });
    attempt(() => { for (const worker of page.workers()) attempt(() => watchWorker(worker, state, true)); });
  };
  const copy = (snapshot: Snapshot): Snapshot => ({ ...snapshot, limitations: [...snapshot.limitations], events: snapshot.events.map((event) => ({ ...event })) });
  return {
    watch(context: BrowserContext): void {
      attempt(() => {
        if (contexts.has(context)) return;
        contexts.add(context);
        if (contextCount === MAX_CONTEXTS) { droppedContexts += 1; return; }
        contextCount += 1;
        listen(context, 'page', (page: Page) => watchPage(page));
        for (const page of context.pages()) attempt(() => watchPage(page));
      });
    },
    finish(): Snapshot {
      if (!completed) {
        stopped = true;
        for (const remove of detach) {
          try { remove(); } catch { observerFailures += 1; }
        }
        detach.length = 0;
        completed = { limitations: LIMITATIONS, events, pageCount, workerCount, contextCount, droppedPages, droppedWorkers, droppedContexts, droppedEvents, observerFailures };
      }
      return copy(completed);
    },
  };
}
