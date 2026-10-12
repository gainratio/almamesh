import type { Page, Request, Response, TestInfo } from '@playwright/test';

const REQUEST_LIMIT = 32;
const SNAPSHOT_TIMEOUT_MS = 2_000;

type FailureCategory = 'none' | 'http-client-error' | 'http-server-error' | 'http-other' | 'invalid-status' | 'request-failed';

interface RequestDiagnostic {
  id: number;
  endpoint: 'openrouter-chat-completions';
  phase: 'started' | 'response' | 'finished' | 'failed';
  startedAtMs: number;
  responseAtMs?: number;
  finishedAtMs?: number;
  failedAtMs?: number;
  status?: number;
  failure?: FailureCategory;
}

/** Public network events only: no request headers/body, response body or error text. */
export function observeRealReadingRequests(page: Page, now: () => number = () => performance.now()) {
  const started = now();
  const requests: RequestDiagnostic[] = [];
  // Weak keys correlate lifecycle events without retaining Playwright requests.
  const ids = new WeakMap<Request, number>();
  let droppedRequests = 0;
  let observerFailures = 0;
  let stopped = false;
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const elapsed = () => {
    const value = now() - started;
    return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value))) : 0;
  };
  const observe = (work: () => void): void => {
    if (stopped) return;
    try { work(); } catch { observerFailures = increment(observerFailures); }
  };
  const rowFor = (sent: Request): RequestDiagnostic | undefined => {
    const id = ids.get(sent);
    return id === undefined ? undefined : requests[id - 1];
  };
  const onRequest = (sent: Request): void => observe(() => {
    if (ids.has(sent) || sent.method() !== 'POST') return;
    let url: URL;
    try { url = new URL(sent.url()); } catch { return; }
    if (url.origin !== 'https://openrouter.ai' || url.pathname !== '/api/v1/chat/completions' || url.username || url.password) return;
    if (requests.length === REQUEST_LIMIT) { droppedRequests = increment(droppedRequests); return; }
    const id = requests.length + 1;
    ids.set(sent, id);
    requests.push({ id, endpoint: 'openrouter-chat-completions', phase: 'started', startedAtMs: elapsed() });
  });
  const onResponse = (response: Response): void => observe(() => {
    const row = rowFor(response.request());
    if (!row || row.phase === 'finished' || row.phase === 'failed') return;
    const status = response.status();
    const valid = Number.isInteger(status) && status >= 100 && status <= 599;
    row.phase = 'response';
    row.responseAtMs = elapsed();
    if (valid) row.status = status;
    row.failure = !valid ? 'invalid-status' : status >= 500 ? 'http-server-error'
      : status >= 400 ? 'http-client-error' : status >= 200 && status < 300 ? 'none' : 'http-other';
  });
  const onFinished = (sent: Request): void => observe(() => {
    const row = rowFor(sent);
    if (!row || row.phase === 'failed' || row.phase === 'finished') return;
    row.phase = 'finished';
    row.finishedAtMs = elapsed();
  });
  const onFailed = (sent: Request): void => observe(() => {
    const row = rowFor(sent);
    if (!row || row.phase === 'failed' || row.phase === 'finished') return;
    row.phase = 'failed';
    row.failedAtMs = elapsed();
    row.failure = 'request-failed';
  });
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    snapshot: () => ({
      requestLimit: REQUEST_LIMIT,
      elapsedMs: elapsed(),
      requests: requests.map((row) => ({ ...row })),
      pendingCount: requests.filter((row) => row.phase === 'started' || row.phase === 'response').length,
      droppedRequests,
      observerFailures,
    }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    },
  };
}

type UiSnapshot =
  | { state: 'available'; reading: boolean; progress: boolean; error: boolean; unavailable: boolean; cta: boolean }
  | { state: 'snapshot-timeout' | 'page-unavailable' };

/** Handle both synchronous throws and late rejection after a bounded deadline. */
async function withinDeadline<T>(work: () => Promise<T>): Promise<
  { state: 'completed'; value: T } | { state: 'failed' | 'timeout' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work).then((value) => ({ state: 'completed' as const, value }), () => ({ state: 'failed' as const })),
      new Promise<{ state: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'timeout' }), SNAPSHOT_TIMEOUT_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function captureRealReadingUi(page: Page): Promise<UiSnapshot> {
  const result = await withinDeadline(() => page.evaluate(() => {
    const present = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) !== null;
    return {
      reading: present('reading-section'),
      progress: present('interpretation-progress'),
      error: present('interpretation-error'),
      unavailable: present('interpretation-unavailable'),
      cta: present('connect-ai-link'),
    };
  }));
  if (result.state !== 'completed') return { state: result.state === 'timeout' ? 'snapshot-timeout' : 'page-unavailable' };
  // Only literal own-data booleans cross the page boundary; never spread its value.
  const value: unknown = result.value;
  const bit = (key: string): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.value === true;
  };
  return { state: 'available', reading: bit('reading'), progress: bit('progress'), error: bit('error'), unavailable: bit('unavailable'), cta: bit('cta') };
}

async function retainRealReadingDiagnostics(
  page: Page,
  info: TestInfo,
  observer: ReturnType<typeof observeRealReadingRequests>,
  journeyFailed: boolean,
): Promise<void> {
  try {
    observer.stop();
    const body = JSON.stringify({
      event: 'real-reading-diagnostics',
      schemaVersion: 1,
      journey: journeyFailed ? 'failed' : 'passed',
      network: observer.snapshot(),
      ui: await captureRealReadingUi(page),
    });
    // Stdout is retained even when the failed Dagger container cannot export attachments.
    console.log(body);
    const attachment = await withinDeadline(() => info.attach('real-reading-diagnostics.json', { body, contentType: 'application/json' }));
    if (attachment.state !== 'completed') throw new Error('Real reading diagnostics could not be retained.');
  } catch {
    if (!journeyFailed) throw new Error('Real reading diagnostics could not be retained.');
  }
}

/** Evidence survives assertion failure; diagnostics never replace that original failure. */
export async function withRealReadingDiagnostics(page: Page, info: TestInfo, work: () => Promise<void>): Promise<void> {
  const observer = observeRealReadingRequests(page);
  let journeyFailed = false;
  try {
    await work();
  } catch (error) {
    journeyFailed = true;
    throw error;
  } finally {
    await retainRealReadingDiagnostics(page, info, observer, journeyFailed);
  }
}
