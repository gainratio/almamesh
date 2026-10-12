import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page, Request, Response, TestInfo } from '@playwright/test';
import {
  captureRealReadingUi,
  observeRealReadingRequests,
  withRealReadingDiagnostics,
} from '../../e2e/realReadingDiagnostics';

class PageDouble {
  readonly listeners = new Map<string, Set<(value: never) => void>>();
  evaluate = vi.fn(async (read: () => unknown) => read());
  on(name: string, listener: (value: never) => void): void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
  }
  off(name: string, listener: (value: never) => void): void {
    this.listeners.get(name)?.delete(listener);
  }
  emit(name: string, value: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(value as never);
  }
  asPage(): Page { return this as unknown as Page; }
}

function request(url = 'https://openrouter.ai/api/v1/chat/completions?private=PRIVATE_QUERY', method = 'POST'): Request {
  return {
    url: () => url,
    method: () => method,
    // These methods must never be consulted, including on a transport failure.
    headers: () => { throw new Error('PRIVATE KEY'); },
    postData: () => { throw new Error('PRIVATE PROMPT'); },
    failure: () => { throw new Error('PRIVATE ERROR'); },
  } as unknown as Request;
}

function response(sent: Request, status: number): Response {
  return {
    request: () => sent,
    status: () => status,
    text: () => { throw new Error('PRIVATE REPORT'); },
    json: () => { throw new Error('PRIVATE BIRTH'); },
  } as unknown as Response;
}

function evidenceOutput() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const attach = vi.fn(async () => undefined);
  const info = { attach } as unknown as TestInfo;
  return { log, attach, info };
}

/** Timeline bits and route of a page showing none of the timeline controls, at `/`. */
const NO_TIMELINE = {
  generateTimeline: false,
  generateTimelineEnabled: false,
  timelineProgress: false,
  timelineSection: false,
  currentSky: false,
  timelinePartialFailure: false,
  regenerateTimeline: false,
  route: '/',
} as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('closed real reading request diagnostics', () => {
  it('retains a held request as pending without consulting or retaining private request data', () => {
    const page = new PageDouble();
    let now = 100;
    const observer = observeRealReadingRequests(page.asPage(), () => now);
    const sent = request();
    now = 112;
    page.emit('request', sent);
    now = 400;
    expect(observer.snapshot()).toMatchObject({
      pendingCount: 1,
      requests: [{ id: 1, endpoint: 'openrouter-chat-completions', phase: 'started', startedAtMs: 12 }],
    });
    expect(JSON.stringify(observer.snapshot())).not.toMatch(/PRIVATE|private=|https:|apiKey|messages|prompt/i);
    observer.stop();
    expect([...page.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it.each([[401, 'http-client-error'], [429, 'http-client-error'], [503, 'http-server-error'], [302, 'http-other']] as const)(
    'records completed HTTP %i as closed failure category %s without reading the response body',
    (status, failure) => {
      const page = new PageDouble();
      let now = 10;
      const observer = observeRealReadingRequests(page.asPage(), () => now);
      const sent = request();
      page.emit('request', sent);
      now = 25;
      page.emit('response', response(sent, status));
      now = 32;
      page.emit('requestfinished', sent);
      expect(observer.snapshot()).toMatchObject({
        pendingCount: 0,
        requests: [{ id: 1, phase: 'finished', status, failure, responseAtMs: 15, finishedAtMs: 22 }],
      });
      expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
      observer.stop();
    },
  );

  it('distinguishes response headers from a finished body and records transport failure without its raw message', () => {
    const page = new PageDouble();
    const observer = observeRealReadingRequests(page.asPage(), () => 0);
    const sent = request();
    page.emit('request', sent);
    page.emit('response', response(sent, 200));
    expect(observer.snapshot()).toMatchObject({ pendingCount: 1, requests: [{ phase: 'response', failure: 'none', status: 200 }] });
    page.emit('requestfailed', sent);
    expect(observer.snapshot()).toMatchObject({ pendingCount: 0, requests: [{ phase: 'failed', failure: 'request-failed', status: 200 }] });
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
    observer.stop();
  });

  it('only observes the exact public completion endpoint and method', () => {
    const page = new PageDouble();
    const observer = observeRealReadingRequests(page.asPage());
    for (const url of [
      'https://openrouter.ai.attacker.invalid/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions/private',
      'https://openrouter.ai/api/v1/models',
      'https://openrouter.ai:444/api/v1/chat/completions',
      'https://PRIVATE:PRIVATE@openrouter.ai/api/v1/chat/completions',
      'http://openrouter.ai/api/v1/chat/completions',
      'PRIVATE MALFORMED URL',
    ]) page.emit('request', request(url));
    page.emit('request', request(undefined, 'GET'));
    page.emit('response', response(request(), 200));
    expect(observer.snapshot()).toMatchObject({ pendingCount: 0, requests: [] });
    observer.stop();
  });

  it('caps retained requests and counters, validates numbers, and returns detached closed snapshots', () => {
    const page = new PageDouble();
    const observer = observeRealReadingRequests(page.asPage(), () => Number.POSITIVE_INFINITY);
    for (let i = 0; i < 100; i += 1) {
      const sent = request();
      page.emit('request', sent);
      page.emit('response', response(sent, i === 0 ? Number.NaN : 200));
      page.emit('requestfinished', sent);
    }
    const first = observer.snapshot();
    expect(first.requests).toHaveLength(32);
    expect(first.droppedRequests).toBe(68);
    expect(first.pendingCount).toBe(0);
    expect(first.requests[0]).toMatchObject({ startedAtMs: 0, responseAtMs: 0, finishedAtMs: 0, failure: 'invalid-status' });
    expect(first.requests[0]).not.toHaveProperty('status');
    first.requests.splice(0);
    expect(observer.snapshot().requests).toHaveLength(32);
    expect(JSON.stringify(observer.snapshot()).length).toBeLessThan(10_000);
    for (const row of observer.snapshot().requests) {
      expect(Object.keys(row).every((key) => ['id', 'endpoint', 'phase', 'startedAtMs', 'responseAtMs', 'finishedAtMs', 'failedAtMs', 'status', 'failure'].includes(key))).toBe(true);
    }
    observer.stop();
    observer.stop();
    page.emit('request', request());
    expect(observer.snapshot().droppedRequests).toBe(68);
  });

  it('contains observer exceptions without changing the request event or serializing its error', () => {
    const page = new PageDouble();
    const observer = observeRealReadingRequests(page.asPage());
    expect(() => page.emit('request', { method: () => { throw new Error('PRIVATE CREDENTIAL'); } })).not.toThrow();
    expect(observer.snapshot()).toMatchObject({ observerFailures: 1, requests: [] });
    expect(JSON.stringify(observer.snapshot())).not.toContain('PRIVATE');
    observer.stop();
  });
});

describe('safe real reading evidence finalization', () => {
  it('records all five successful body completions with no reading or error without guessing why the summary is absent', async () => {
    const page = new PageDouble();
    const { log, info } = evidenceOutput();
    await withRealReadingDiagnostics(page.asPage(), info, async () => {
      for (let section = 0; section < 5; section += 1) {
        const sent = request();
        page.emit('request', sent);
        page.emit('response', response(sent, 200));
        page.emit('requestfinished', sent);
      }
    });
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.network.pendingCount).toBe(0);
    expect(report.network.requests).toHaveLength(5);
    expect(report.network.requests.every((row: { phase: string; status: number }) => row.phase === 'finished' && row.status === 200)).toBe(true);
    expect(report.ui).toEqual({ state: 'available', reading: false, progress: false, error: false, unavailable: false, cta: false, ...NO_TIMELINE });
    expect(report).not.toHaveProperty('cause');
  });

  it('distinguishes completed requests with no rendered core summary using only actual UI presence', async () => {
    const page = new PageDouble();
    const { log, attach, info } = evidenceOutput();
    document.body.innerHTML = '<div data-testid="interpretation-unavailable">PRIVATE PROVIDER ERROR</div><div data-testid="connect-ai-link">PRIVATE CONTENT</div>';
    await withRealReadingDiagnostics(page.asPage(), info, async () => {
      const sent = request();
      page.emit('request', sent);
      page.emit('response', response(sent, 200));
      page.emit('requestfinished', sent);
    });
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report).toMatchObject({ event: 'real-reading-diagnostics', journey: 'passed', network: { pendingCount: 0, requests: [{ phase: 'finished', status: 200 }] }, ui: { state: 'available', reading: false, progress: false, error: false, unavailable: true, cta: true } });
    expect(attach).toHaveBeenCalledWith('real-reading-diagnostics.json', { body: log.mock.calls[0]?.[0], contentType: 'application/json' });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|PRIVATE_QUERY|https:|birth|prompt|rawError|apiKey/);
  });

  it('captures present reading/progress/error bits without reading the DOM prose', async () => {
    const page = new PageDouble();
    document.body.innerHTML = '<section data-testid="reading-section">PRIVATE REPORT</section><div data-testid="interpretation-progress">PRIVATE STAGE</div><div data-testid="interpretation-error">PRIVATE ERROR</div>';
    expect(await captureRealReadingUi(page.asPage())).toEqual({ state: 'available', reading: true, progress: true, error: true, unavailable: false, cta: false, ...NO_TIMELINE });
  });

  it('captures the timeline controls as presence bits and the route, never their prose', async () => {
    const page = new PageDouble();
    window.history.pushState(null, '', '/dashboard');
    document.body.innerHTML = [
      '<button data-testid="generate-timeline" disabled>PRIVATE</button>',
      '<div data-testid="timeline-progress">PRIVATE STAGE</div>',
      '<section data-testid="current-timeline-section"><p data-testid="dashboard-current-sky">PRIVATE SKY</p></section>',
      '<p data-testid="timeline-partial-failure">PRIVATE SECTION</p>',
      '<button data-testid="regenerate-timeline">PRIVATE</button>',
    ].join('');
    const ui = await captureRealReadingUi(page.asPage());
    window.history.pushState(null, '', '/');
    expect(ui).toEqual({
      state: 'available', reading: false, progress: false, error: false, unavailable: false, cta: false,
      generateTimeline: true, generateTimelineEnabled: false, timelineProgress: true, timelineSection: true,
      currentSky: true, timelinePartialFailure: true, regenerateTimeline: true, route: '/dashboard',
    });
    expect(JSON.stringify(ui)).not.toContain('PRIVATE');
  });

  it('reports an enabled timeline control and replaces an unexpected route shape with "other"', async () => {
    const page = new PageDouble();
    page.evaluate.mockResolvedValue({ generateTimeline: true, generateTimelineEnabled: true, route: '/mesh/PRIVATE?name=Ada' });
    expect(await captureRealReadingUi(page.asPage())).toMatchObject({ generateTimeline: true, generateTimelineEnabled: true, route: 'other' });
    page.evaluate.mockResolvedValue({ route: { toString: () => '/dashboard' } });
    expect(await captureRealReadingUi(page.asPage())).toMatchObject({ route: 'other' });
  });

  it('emits and attaches diagnostics in finally after assertion failure while rethrowing the identical original error', async () => {
    const page = new PageDouble();
    const { log, attach, info } = evidenceOutput();
    const original = new Error('PRIVATE ASSERTION');
    await expect(withRealReadingDiagnostics(page.asPage(), info, async () => {
      page.emit('request', request());
      throw original;
    })).rejects.toBe(original);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ journey: 'failed', network: { pendingCount: 1 } });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join('')).not.toContain('PRIVATE');
    expect([...page.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('bounds a held UI snapshot at two seconds and observes its late rejection', async () => {
    vi.useFakeTimers();
    const page = new PageDouble();
    let rejectSnapshot!: (error: Error) => void;
    page.evaluate.mockImplementation(() => new Promise((_, reject) => { rejectSnapshot = reject; }));
    const { log, info } = evidenceOutput();
    const done = withRealReadingDiagnostics(page.asPage(), info, async () => undefined);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).ui).toEqual({ state: 'snapshot-timeout' });
    rejectSnapshot(new Error('PRIVATE LATE FAILURE'));
    await Promise.resolve();
    expect(log.mock.calls.flat().join('')).not.toContain('PRIVATE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('normalizes hostile snapshot fields to closed booleans and handles page failure without raw errors', async () => {
    const page = new PageDouble();
    page.evaluate.mockResolvedValue({ reading: 'PRIVATE', progress: true, error: false, unavailable: true, cta: { key: 'PRIVATE' }, raw: 'PRIVATE BIRTH' });
    expect(await captureRealReadingUi(page.asPage())).toEqual({ state: 'available', reading: false, progress: true, error: false, unavailable: true, cta: false, ...NO_TIMELINE, route: 'other' });
    page.evaluate.mockRejectedValue(new Error('PRIVATE PAGE URL'));
    expect(await captureRealReadingUi(page.asPage())).toEqual({ state: 'page-unavailable' });
  });

  it('never invokes accessors supplied by a malformed page snapshot', async () => {
    const page = new PageDouble();
    const getter = vi.fn(() => { throw new Error('PRIVATE GETTER'); });
    page.evaluate.mockResolvedValue(Object.defineProperty(Object.defineProperty({ progress: true }, 'reading', { get: getter }), 'route', { get: getter }));
    expect(await captureRealReadingUi(page.asPage())).toEqual({ state: 'available', reading: false, progress: true, error: false, unavailable: false, cta: false, ...NO_TIMELINE, route: 'other' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('records a synchronous page evaluation throw as unavailable and still retains evidence', async () => {
    const page = new PageDouble();
    const { log, attach, info } = evidenceOutput();
    page.evaluate.mockImplementation(() => { throw new Error('PRIVATE SYNC PAGE FAILURE'); });
    await withRealReadingDiagnostics(page.asPage(), info, async () => undefined);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).ui).toEqual({ state: 'page-unavailable' });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join('')).not.toContain('PRIVATE');
  });

  it('preserves assertion failure if attachment fails, while keeping the safe stdout receipt', async () => {
    const page = new PageDouble();
    const { log, attach, info } = evidenceOutput();
    attach.mockRejectedValue(new Error('PRIVATE ATTACHMENT PATH'));
    const original = new Error('PRIVATE ORIGINAL');
    await expect(withRealReadingDiagnostics(page.asPage(), info, async () => { throw original; })).rejects.toBe(original);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ journey: 'failed' });
    expect(log.mock.calls.flat().join('')).not.toContain('PRIVATE');
  });

  it('bounds attachment completion, retains stdout and preserves a pre-existing failure', async () => {
    vi.useFakeTimers();
    const page = new PageDouble();
    const { log, attach, info } = evidenceOutput();
    attach.mockImplementation(() => new Promise(() => undefined));
    const original = new Error('PRIVATE ORIGINAL');
    const done = withRealReadingDiagnostics(page.asPage(), info, async () => { throw original; });
    const assertion = expect(done).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(log.mock.calls.flat().join('')).not.toContain('PRIVATE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a passing journey with a fixed message if evidence attachment cannot be retained', async () => {
    const page = new PageDouble();
    const { attach, info } = evidenceOutput();
    attach.mockRejectedValue(new Error('PRIVATE ATTACHMENT PATH'));
    await expect(withRealReadingDiagnostics(page.asPage(), info, async () => undefined)).rejects.toThrow('Real reading diagnostics could not be retained.');
  });
});
