import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  captureReloadConsole, classifyReloadConsole,
  type ReloadDiagnostic, type ReloadEvidence, type ReloadRequestFailure,
} from '../../e2e/reloadConsole';

const WORKER = 'http://127.0.0.1:4350/assets/worker-CJnCC9AM.js';
const OTHER_WORKER = 'http://127.0.0.1:4350/assets/worker-other.js';
const TEXT = 'opfs-wl: Error initializing OPFS asyncer: Event';
const diagnostic: ReloadDiagnostic = { kind: 'console', text: TEXT, url: WORKER, at: 4 };
const cancellation: ReloadRequestFailure = {
  url: 'blob:http://127.0.0.1:4350/2e49994c-7adc-4bf5-bf39-4d7ef2300329',
  referer: WORKER, errorText: 'cancelled', at: 3,
};
const evidence: ReloadEvidence = {
  startedAt: 2, committedAt: 5, oldSqlWorkerUrls: [WORKER], failures: [cancellation],
};

describe('explicit reload OPFS cancellation classification', () => {
  it('archives only the exact proven old-worker cancellation', () => {
    expect(classifyReloadConsole([diagnostic], evidence)).toEqual({
      fatal: [], matched: [{ diagnostic, cancellation }],
    });
  });

  it('allows the console event to precede its canceled request event', () => {
    const earlier = { ...diagnostic, at: 3 };
    const later = { ...cancellation, at: 4 };
    expect(classifyReloadConsole([earlier], { ...evidence, failures: [later] })).toEqual({
      fatal: [], matched: [{ diagnostic: earlier, cancellation: later }],
    });
  });

  it.each([
    ['no old worker request', { oldSqlWorkerUrls: [] }],
    ['a different old worker', { oldSqlWorkerUrls: [OTHER_WORKER] }],
    ['no matching failed request', { failures: [] }],
    ['no main-frame commit', { committedAt: null }],
    ['console at commit', { committedAt: diagnostic.at }],
    ['console after commit', { committedAt: diagnostic.at - 1 }],
    ['console before explicit reload', { startedAt: diagnostic.at }],
  ] satisfies Array<[string, Partial<ReloadEvidence>]>)('keeps the error fatal with %s', (_name, change) => {
    expect(classifyReloadConsole([diagnostic], { ...evidence, ...change })).toEqual({ fatal: [diagnostic], matched: [] });
  });

  it.each([
    ['non-cancellation failure', { errorText: 'Failed to fetch' }],
    ['another cancellation signature', { errorText: 'net::ERR_ABORTED' }],
    ['a missing Referer', { referer: null }],
    ['a different Referer', { referer: OTHER_WORKER }],
    ['a non-blob request', { url: WORKER }],
    ['failure at commit', { at: evidence.committedAt! }],
    ['failure before reload', { at: evidence.startedAt }],
  ] satisfies Array<[string, Partial<ReloadRequestFailure>]>)('keeps the error fatal with %s', (_name, change) => {
    expect(classifyReloadConsole([diagnostic], { ...evidence, failures: [{ ...cancellation, ...change }] }))
      .toEqual({ fatal: [diagnostic], matched: [] });
  });

  it.each([
    ['a different worker location', { url: OTHER_WORKER }],
    ['a missing worker location', { url: undefined }],
    ['a page error with the same text', { kind: 'pageerror' as const }],
    ['a longer message', { text: `${TEXT}: failure` }],
    ['a shorter message', { text: 'Error initializing OPFS asyncer: Event' }],
    ['a different cause', { text: TEXT.replace('Event', 'Error') }],
  ] satisfies Array<[string, Partial<ReloadDiagnostic>]>)('keeps %s fatal', (_name, change) => {
    const error = { ...diagnostic, ...change };
    expect(classifyReloadConsole([error], evidence)).toEqual({ fatal: [error], matched: [] });
  });

  it('retains every unrelated and new-document error alongside a classified old error', () => {
    const unrelated = { ...diagnostic, text: 'SQLite could not open' };
    const newDocument = { ...diagnostic, at: 6 };
    const pageError = { ...diagnostic, kind: 'pageerror' as const };
    expect(classifyReloadConsole([diagnostic, unrelated, newDocument, pageError], evidence)).toEqual({
      fatal: [unrelated, newDocument, pageError], matched: [{ diagnostic, cancellation }],
    });
  });

  it('requires separate canceled-request proof for each diagnostic', () => {
    const repeated = { ...diagnostic, at: 4.5 };
    expect(classifyReloadConsole([diagnostic, repeated], evidence)).toEqual({
      fatal: [repeated], matched: [{ diagnostic, cancellation }],
    });
  });
});

function fakeCapture() {
  const events = new EventEmitter();
  const mainFrame = {};
  const page = Object.assign(events, { mainFrame: () => mainFrame }) as unknown as Page;
  const attach = vi.fn().mockResolvedValue(undefined);
  return { events, mainFrame, attach, capture: captureReloadConsole(page, { attach }) };
}

function consoleError(url = WORKER, text = TEXT) {
  return { type: () => 'error', text: () => text, location: () => ({ url }) };
}

describe('explicit reload console observation', () => {
  it('classifies after commit even when Referer resolves later, and archives complete proof', async () => {
    const { events, mainFrame, attach, capture } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    let resolveReferer!: (value: string) => void;
    const referer = new Promise<string>((resolve) => { resolveReferer = resolve; });
    const result = await capture.duringReload(async () => {
      events.emit('console', consoleError());
      events.emit('requestfailed', {
        url: () => cancellation.url, failure: () => ({ errorText: 'cancelled' }),
        headerValue: () => referer,
      });
      events.emit('framenavigated', mainFrame);
      // A new-document error from even the same asset URL must remain fatal.
      events.emit('console', consoleError());
      events.emit('pageerror', new Error(TEXT));
      resolveReferer(WORKER);
      return 'reload complete';
    });
    expect(result).toBe('reload complete');
    expect(capture.errors).toEqual([`console: ${TEXT}`, `pageerror: ${TEXT}`]);
    expect(attach).toHaveBeenCalledOnce();
    const [name, attachment] = attach.mock.calls[0] as [string, { body: string; contentType: string }];
    expect(name).toBe('reload-opfs-cancellations-1.json');
    expect(attachment.contentType).toBe('application/json');
    const proof = JSON.parse(attachment.body);
    expect(proof.evidence.oldSqlWorkerUrls).toEqual([WORKER]);
    expect(proof.matched).toMatchObject([{ diagnostic: { text: TEXT, url: WORKER }, cancellation: { referer: WORKER, errorText: 'cancelled' } }]);
  });

  it('does not adopt a worker requested only after reload starts', async () => {
    const { events, mainFrame, attach, capture } = fakeCapture();
    await capture.duringReload(async () => {
      events.emit('request', { url: () => WORKER });
      events.emit('requestfailed', {
        url: () => cancellation.url, failure: () => ({ errorText: 'cancelled' }),
        headerValue: async () => WORKER,
      });
      events.emit('console', consoleError());
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([`console: ${TEXT}`]);
    expect(attach).not.toHaveBeenCalled();
  });

  it('keeps the scope open through an iframe navigation, closing only at main-frame commit', async () => {
    const { events, mainFrame, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    await capture.duringReload(async () => {
      events.emit('framenavigated', {});
      events.emit('requestfailed', {
        url: () => cancellation.url, failure: () => ({ errorText: 'cancelled' }),
        headerValue: async () => WORKER,
      });
      events.emit('console', consoleError());
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([]);
    expect(attach).toHaveBeenCalledOnce();
  });

  it('keeps the error fatal when the canceled request Referer cannot be read', async () => {
    const { events, mainFrame, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    await capture.duringReload(async () => {
      events.emit('requestfailed', {
        url: () => cancellation.url, failure: () => ({ errorText: 'cancelled' }),
        headerValue: async () => { throw new Error('request unavailable'); },
      });
      events.emit('console', consoleError());
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([`console: ${TEXT}`]);
    expect(attach).not.toHaveBeenCalled();
  });

  it('retains errors outside the explicit reload and errors from a failed reload without commit', async () => {
    const { events, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    events.emit('console', consoleError());
    const reloadError = new Error('navigation failed');
    await expect(capture.duringReload(async () => {
      events.emit('console', consoleError());
      events.emit('requestfailed', {
        url: () => cancellation.url, failure: () => ({ errorText: 'cancelled' }),
        headerValue: async () => WORKER,
      });
      throw reloadError;
    })).rejects.toBe(reloadError);
    expect(capture.errors).toEqual([`console: ${TEXT}`, `console: ${TEXT}`]);
    expect(attach).not.toHaveBeenCalled();
  });
});
