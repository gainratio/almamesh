import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureReloadConsole, classifyReloadConsole,
  type ReloadDiagnostic, type ReloadEvidence, type ReloadRequestEvent, type ReloadRequestFailure,
} from '../../e2e/reloadConsole';

const WORKER = 'http://127.0.0.1:4350/assets/worker-CJnCC9AM.js';
const OTHER_WORKER = 'http://127.0.0.1:4350/assets/worker-other.js';
const DOCUMENT = 'http://127.0.0.1:4350/dashboard';
const TEXT = 'opfs-wl: Error initializing OPFS asyncer: Event';
const diagnostic: ReloadDiagnostic = { kind: 'console', text: TEXT, url: WORKER, at: 4 };
const cancellation: ReloadRequestFailure = {
  url: 'blob:http://127.0.0.1:4350/2e49994c-7adc-4bf5-bf39-4d7ef2300329',
  referer: WORKER, errorText: 'cancelled', at: 3,
};
const evidence: ReloadEvidence = {
  startedAt: 2, committedAt: 5, oldSqlWorkerUrls: [WORKER], failures: [cancellation],
};
const outputDirectories: string[] = [];
afterEach(() => { for (const path of outputDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function attachmentProof(attachment: { path: string }) {
  return JSON.parse(readFileSync(attachment.path, 'utf8'));
}

describe('explicit reload OPFS cancellation classification', () => {
  it('archives only the exact proven old-worker cancellation', () => {
    expect(classifyReloadConsole([diagnostic], evidence)).toEqual({
      fatal: [], matched: [{ category: 'old-document-cancellation', diagnostic, cancellation }],
    });
  });

  it('allows the console event to precede its canceled request event', () => {
    const earlier = { ...diagnostic, at: 3 };
    const later = { ...cancellation, at: 4 };
    expect(classifyReloadConsole([earlier], { ...evidence, failures: [later] })).toEqual({
      fatal: [], matched: [{ category: 'old-document-cancellation', diagnostic: earlier, cancellation: later }],
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
      fatal: [unrelated, newDocument, pageError], matched: [{ category: 'old-document-cancellation', diagnostic, cancellation }],
    });
  });

  it('requires separate canceled-request proof for each diagnostic', () => {
    const repeated = { ...diagnostic, at: 4.5 };
    expect(classifyReloadConsole([diagnostic, repeated], evidence)).toEqual({
      fatal: [repeated], matched: [{ category: 'old-document-cancellation', diagnostic, cancellation }],
    });
  });
});

const blobRequest = { kind: 'request', url: cancellation.url, referer: WORKER, at: 3 } as const;
const blobResponse = { kind: 'response', url: cancellation.url, status: 200, at: 4 } as const;
const blobFinished = { kind: 'requestfinished', url: cancellation.url, at: 5 } as const;
const accessDiagnostic: ReloadDiagnostic = {
  kind: 'console', text: `Cannot load ${cancellation.url} due to access control checks.`, url: '', at: 7,
};
const resourceEvidence = {
  ...evidence, committedAt: 10, failures: [], requestEvents: [blobRequest, blobResponse, blobFinished],
};

describe('separate old-document resource rejection classification', () => {
  it('requires the exact access-control message plus the same-origin blob request, response200 and finish before commit', () => {
    const result = classifyReloadConsole([accessDiagnostic], resourceEvidence);
    expect(result.fatal).toEqual([]);
    expect(result.matched).toMatchObject([{
      category: 'old-document-resource-rejection', diagnostic: accessDiagnostic, accessControl: accessDiagnostic,
      resource: { request: blobRequest, response: blobResponse, end: blobFinished, workerUrl: WORKER },
    }]);
  });

  it('accepts the separately evidenced exact canceled resource end without calling it a completed200 response', () => {
    const ended = { ...cancellation, at: 4 };
    const result = classifyReloadConsole([accessDiagnostic], { ...resourceEvidence, failures: [ended], requestEvents: [blobRequest] });
    expect(result.fatal).toEqual([]);
    expect(result.matched).toMatchObject([{
      category: 'old-document-resource-rejection', resource: { request: blobRequest, end: ended, workerUrl: WORKER },
    }]);
  });

  it('pairs at most one exact opfs and opfs-wl initializer with that same evidenced old-worker rejection', () => {
    const opfs = { ...diagnostic, text: 'opfs: Error initializing OPFS asyncer: Event', at: 6 };
    const wl = { ...diagnostic, at: 8 };
    const duplicate = { ...opfs, at: 9 };
    const result = classifyReloadConsole([opfs, accessDiagnostic, wl, duplicate], resourceEvidence);
    expect(result.fatal).toEqual([duplicate]);
    expect(result.matched.map((match) => match.diagnostic)).toEqual([opfs, accessDiagnostic, wl]);
    expect(result.matched.every((match) => 'category' in match && match.category === 'old-document-resource-rejection')).toBe(true);
  });

  it('preserves the original cancellation category when it accompanies the separate resource rejection', () => {
    const ended = { ...cancellation, at: 4 };
    const opfs = { ...diagnostic, text: 'opfs: Error initializing OPFS asyncer: Event', at: 5 };
    const wl = { ...diagnostic, at: 8 };
    const extraWl = { ...wl, at: 9 };
    const result = classifyReloadConsole([opfs, accessDiagnostic, wl, extraWl], {
      ...resourceEvidence, failures: [ended], requestEvents: [blobRequest],
    });
    expect(result.fatal).toEqual([extraWl]);
    expect(result.matched).toMatchObject([
      { category: 'old-document-resource-rejection', diagnostic: opfs },
      { category: 'old-document-resource-rejection', diagnostic: accessDiagnostic },
      { category: 'old-document-cancellation', diagnostic: wl },
    ]);
  });

  it.each(['opfs', 'opfs-wl'])('keeps a second same-variant %s initializer fatal', (variant) => {
    const first = { ...diagnostic, text: `${variant}: Error initializing OPFS asyncer: Event`, at: 6 };
    const duplicate = { ...first, at: 8 };
    const result = classifyReloadConsole([first, accessDiagnostic, duplicate], resourceEvidence);
    expect(result.fatal).toEqual([duplicate]);
    expect(result.matched.map((match) => match.diagnostic)).toEqual([first, accessDiagnostic]);
  });

  it('never uses cancellation of another blob to prove an unrelated access-control error', () => {
    const unrelated = { ...cancellation, url: 'blob:http://127.0.0.1:4350/other-resource', at: 4 };
    expect(classifyReloadConsole([accessDiagnostic], {
      ...resourceEvidence, failures: [unrelated], requestEvents: [blobRequest],
    })).toEqual({ fatal: [accessDiagnostic], matched: [] });
  });

  it('retains unmatched native errors alongside an evidenced rejection', () => {
    const nativeError = { ...diagnostic, text: 'SQLite worker initialization failed', at: 8 };
    const result = classifyReloadConsole([accessDiagnostic, nativeError], resourceEvidence);
    expect(result.fatal).toEqual([nativeError]);
    expect(result.matched.map((match) => match.diagnostic)).toEqual([accessDiagnostic]);
  });

  it.each([
    ['missing request', { requestEvents: [blobResponse, blobFinished] }],
    ['missing response', { requestEvents: [blobRequest, blobFinished] }],
    ['missing finished event', { requestEvents: [blobRequest, blobResponse] }],
    ['non200 response', { requestEvents: [blobRequest, { ...blobResponse, status: 403 }, blobFinished] }],
    ['missing Referer', { requestEvents: [{ ...blobRequest, referer: null }, blobResponse, blobFinished] }],
    ['another Referer', { requestEvents: [{ ...blobRequest, referer: OTHER_WORKER }, blobResponse, blobFinished] }],
    ['unknown old worker', { oldSqlWorkerUrls: [] }],
    ['uncommitted reload', { committedAt: null }],
    ['request before reload', { requestEvents: [{ ...blobRequest, at: evidence.startedAt }, blobResponse, blobFinished] }],
    ['response before request', { requestEvents: [blobRequest, { ...blobResponse, at: 2.5 }, blobFinished] }],
    ['response after diagnostic', { requestEvents: [blobRequest, { ...blobResponse, at: 8 }, { ...blobFinished, at: 9 }] }],
    ['finished after diagnostic', { requestEvents: [blobRequest, blobResponse, { ...blobFinished, at: 8 }] }],
    ['finished at commit', { requestEvents: [blobRequest, blobResponse, { ...blobFinished, at: 10 }] }],
    ['non-cancel end alone', { requestEvents: [blobRequest], failures: [{ ...cancellation, errorText: 'Failed to fetch', at: 4 }] }],
    ['cancel end before request', { requestEvents: [blobRequest], failures: [{ ...cancellation, at: 2.5 }] }],
    ['cancel end after diagnostic', { requestEvents: [blobRequest], failures: [{ ...cancellation, at: 8 }] }],
  ])('keeps %s fatal', (_name, change) => {
    expect(classifyReloadConsole([accessDiagnostic], { ...resourceEvidence, ...change })).toEqual({ fatal: [accessDiagnostic], matched: [] });
  });

  it.each([
    { text: `prefix ${accessDiagnostic.text}` }, { text: `${accessDiagnostic.text} more` },
    { text: accessDiagnostic.text.replace('checks.', 'checks') }, { kind: 'pageerror' as const },
    { at: 10 }, { url: WORKER },
  ])('keeps unmatched/new-document/page errors fatal: %j', (change) => {
    const error = { ...accessDiagnostic, ...change };
    expect(classifyReloadConsole([error], resourceEvidence)).toEqual({ fatal: [error], matched: [] });
  });

  it('rejects an exact recorded blob from a different origin', () => {
    const url = 'blob:https://another.example/2e49994c-7adc-4bf5-bf39-4d7ef2300329';
    const error = { ...accessDiagnostic, text: `Cannot load ${url} due to access control checks.` };
    const requestEvents = [blobRequest, blobResponse, blobFinished].map((event) => ({ ...event, url }));
    expect(classifyReloadConsole([error], { ...resourceEvidence, requestEvents })).toEqual({ fatal: [error], matched: [] });
  });

  it('never uses initializers alone or ones from another worker, with changed text or before the request', () => {
    const opfs = { ...diagnostic, text: 'opfs: Error initializing OPFS asyncer: Event', at: 6 };
    const wl = { ...diagnostic, at: 8 };
    expect(classifyReloadConsole([opfs, wl], resourceEvidence)).toEqual({ fatal: [opfs, wl], matched: [] });
    for (const error of [{ ...opfs, url: OTHER_WORKER }, { ...opfs, text: `${opfs.text}: other` }, { ...opfs, at: 2.5 }]) {
      expect(classifyReloadConsole([error, accessDiagnostic], resourceEvidence).fatal).toEqual([error]);
    }
  });
});

const outgoingEvidence = {
  ...resourceEvidence, requestEvents: [], oldDocumentUrl: DOCUMENT, committedDocumentUrl: DOCUMENT,
  oldDocumentBlobUrls: [], oldDocumentBlobHistoryOverflow: false,
};

describe('explicit unproven outgoing-navigation diagnostic exception', () => {
  it('separately labels a native same-origin precommit diagnostic with no observable matching request', () => {
    expect(classifyReloadConsole([accessDiagnostic], outgoingEvidence)).toEqual({
      fatal: [], matched: [{
        category: 'outgoing-navigation-diagnostic', diagnostic: accessDiagnostic,
        source: 'unproven', cause: 'unproven',
      }],
    });
  });

  it.each([
    ['different target', { committedDocumentUrl: `${DOCUMENT}?another-target` }],
    ['missing original URL', { oldDocumentUrl: undefined }],
    ['missing committed URL', { committedDocumentUrl: undefined }],
    ['missing request-event evidence', { requestEvents: undefined }],
    ['missing document Blob history', { oldDocumentBlobUrls: undefined }],
    ['missing history completeness', { oldDocumentBlobHistoryOverflow: undefined }],
    ['overflowed document Blob history', { oldDocumentBlobHistoryOverflow: true }],
    ['previously observed matching Blob', { oldDocumentBlobUrls: [cancellation.url] }],
    ['invalid document URL', { oldDocumentUrl: 'bad', committedDocumentUrl: 'bad' }],
    ['nonHTTP document', { oldDocumentUrl: 'file:///dashboard', committedDocumentUrl: 'file:///dashboard' }],
    ['unknown old worker', { oldSqlWorkerUrls: [] }],
    ['other-origin worker', { oldSqlWorkerUrls: ['https://another.example/assets/worker-known.js'] }],
    ['nonSQL contextual worker', { oldSqlWorkerUrls: ['http://127.0.0.1:4350/assets/other-known.js'] }],
    ['uncommitted reload', { committedAt: null }],
    ['diagnostic at commit', { committedAt: accessDiagnostic.at }],
    ['diagnostic before scope', { startedAt: accessDiagnostic.at }],
  ])('keeps %s fatal', (_name, change) => {
    expect(classifyReloadConsole([accessDiagnostic], { ...outgoingEvidence, ...change }))
      .toEqual({ fatal: [accessDiagnostic], matched: [] });
  });

  it.each([
    { text: accessDiagnostic.text.replace('127.0.0.1:4350', 'another.example') },
    { text: accessDiagnostic.text.replace('blob:http://127.0.0.1:4350', 'blob:null') },
    { text: `prefix ${accessDiagnostic.text}` },
    { text: `${accessDiagnostic.text} extra` },
    { text: accessDiagnostic.text.replace('checks.', 'checks') },
    { url: WORKER },
    { kind: 'pageerror' as const },
    { at: outgoingEvidence.committedAt + 1 },
  ])('keeps unmatched native/page/new-document errors fatal: %j', (change) => {
    const error = { ...accessDiagnostic, ...change };
    expect(classifyReloadConsole([error], outgoingEvidence)).toEqual({ fatal: [error], matched: [] });
  });

  it.each([
    { kind: 'request', url: cancellation.url, referer: null, at: 3 },
    { kind: 'request', url: cancellation.url, referer: OTHER_WORKER, at: 3 },
    { kind: 'request', url: cancellation.url, referer: null, refererReadFailed: true, at: 3 },
    { kind: 'response', url: cancellation.url, status: 403, at: 4 },
    { kind: 'requestfinished', url: cancellation.url, at: 5 },
    { kind: 'requestfailed', url: cancellation.url, errorText: 'unknown failure', at: 5 },
    { kind: 'request', url: cancellation.url, at: 11 },
  ] satisfies ReloadRequestEvent[])('never excuses a Blob with any matching event: %j', (event) => {
    expect(classifyReloadConsole([accessDiagnostic], { ...outgoingEvidence, requestEvents: [event] }))
      .toEqual({ fatal: [accessDiagnostic], matched: [] });
  });

  it('rejects any matching failure even when no request event or Referer is available', () => {
    expect(classifyReloadConsole([accessDiagnostic], {
      ...outgoingEvidence, failures: [{ ...cancellation, referer: null, errorText: '', at: 4 }],
    })).toEqual({ fatal: [accessDiagnostic], matched: [] });
  });

  it('permits only one outgoing diagnostic per explicit reload', () => {
    const second = { ...accessDiagnostic, text: accessDiagnostic.text.replace('2e49994c', 'second00'), at: 8 };
    const result = classifyReloadConsole([accessDiagnostic, second], outgoingEvidence);
    expect(result.fatal).toEqual([second]);
    expect(result.matched.map((match) => match.diagnostic)).toEqual([accessDiagnostic]);
  });

  it('cannot justify either OPFS initializer or any unrelated native error', () => {
    const opfs = { ...diagnostic, text: 'opfs: Error initializing OPFS asyncer: Event', at: 6 };
    const wl = { ...diagnostic, at: 8 };
    const native = { ...diagnostic, text: 'Native resource failure', at: 9 };
    const result = classifyReloadConsole([opfs, accessDiagnostic, wl, native], outgoingEvidence);
    expect(result.fatal).toEqual([opfs, wl, native]);
    expect(result.matched.map((match) => match.diagnostic)).toEqual([accessDiagnostic]);
  });
});

function fakeCapture() {
  const events = new EventEmitter();
  const mainFrame = { url: () => DOCUMENT };
  const page = Object.assign(events, { mainFrame: () => mainFrame, url: () => DOCUMENT }) as unknown as Page;
  const attach = vi.fn().mockResolvedValue(undefined);
  const directory = mkdtempSync(join(tmpdir(), 'almamesh-reload-console-'));
  outputDirectories.push(directory);
  const outputPath = vi.fn((...names: string[]) => join(directory, ...names));
  return { events, mainFrame, attach, outputPath, capture: captureReloadConsole(page, { attach, outputPath }) };
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
    expect(attach).toHaveBeenCalledTimes(2);
    const [name, attachment] = attach.mock.calls.find(([name]) => name === 'reload-opfs-cancellations-1.json') as [string, { path: string; contentType: string }];
    expect(name).toBe('reload-opfs-cancellations-1.json');
    expect(attachment.contentType).toBe('application/json');
    const proof = attachmentProof(attachment);
    expect(proof.evidence.oldSqlWorkerUrls).toEqual([WORKER]);
    expect(proof.matched).toMatchObject([{ diagnostic: { text: TEXT, url: WORKER }, cancellation: { referer: WORKER, errorText: 'cancelled' } }]);
  });

  it('does not adopt a worker requested only after reload starts', async () => {
    const { events, mainFrame, attach, capture } = fakeCapture();
    await capture.duringReload(async () => {
      events.emit('request', { url: () => WORKER, headerValue: async () => null });
      events.emit('requestfailed', {
        url: () => cancellation.url, failure: () => ({ errorText: 'cancelled' }),
        headerValue: async () => WORKER,
      });
      events.emit('console', consoleError());
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([`console: ${TEXT}`]);
    expect(attach).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0][0]).toBe('reload-console-scope-1.json');
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
    expect(attach).toHaveBeenCalledTimes(2);
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
    expect(attach).toHaveBeenCalledOnce();
    const proof = attachmentProof(attach.mock.calls[0][1]);
    expect(proof.requestEvents[0]).toMatchObject({ kind: 'requestfailed', referer: null, refererReadFailed: true });
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
    expect(attach).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0][0]).toBe('reload-console-scope-1.json');
  });

  it('archives every scope even without a match, including all console kinds and failed-request proof', async () => {
    const { events, mainFrame, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    const accessError = `Cannot load ${cancellation.url} due to access control checks.`;
    const failedUrl = 'http://127.0.0.1:4350/unrelated.json';
    await capture.duringReload(async () => {
      events.emit('request', { url: () => cancellation.url, headerValue: async () => WORKER });
      events.emit('response', { url: () => cancellation.url, status: () => 403 });
      events.emit('requestfinished', { url: () => cancellation.url });
      events.emit('requestfailed', {
        url: () => failedUrl, failure: () => ({ errorText: 'Failed to fetch' }), headerValue: async () => WORKER,
      });
      events.emit('console', { ...consoleError(), type: () => 'warning', text: () => 'worker startup warning' });
      events.emit('console', consoleError('', accessError));
      events.emit('pageerror', new Error('uncaught startup error'));
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual(['pageerror: uncaught startup error', `console: ${accessError}`]);
    expect(attach).toHaveBeenCalledOnce();
    const [name, attachment] = attach.mock.calls[0];
    expect(name).toBe('reload-console-scope-1.json');
    const proof = attachmentProof(attachment);
    expect(proof.matched).toEqual([]);
    expect(proof.fatal).toMatchObject([{ text: accessError }, { text: 'uncaught startup error' }]);
    expect(proof.consoleEvents).toMatchObject([
      { type: 'warning', text: 'worker startup warning' }, { type: 'error', text: accessError, url: '' },
    ]);
    expect(proof.pageErrors).toMatchObject([{ text: 'uncaught startup error' }]);
    expect(proof.requestEvents).toMatchObject([
      { kind: 'request', url: cancellation.url, referer: WORKER },
      { kind: 'response', url: cancellation.url, status: 403 },
      { kind: 'requestfinished', url: cancellation.url },
      { kind: 'requestfailed', url: failedUrl, referer: WORKER, errorText: 'Failed to fetch' },
    ]);
    expect(proof.evidence.failures).toMatchObject([{ url: failedUrl, errorText: 'Failed to fetch' }]);
  });

  it('persists complete scope and separate resource-rejection proof for a successful reload', async () => {
    const { events, mainFrame, outputPath, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    await capture.duringReload(async () => {
      events.emit('request', { url: () => cancellation.url, headerValue: async () => WORKER });
      events.emit('response', { url: () => cancellation.url, status: () => 200 });
      events.emit('requestfinished', { url: () => cancellation.url });
      events.emit('console', consoleError('', accessDiagnostic.text));
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([]);
    expect(attach).toHaveBeenCalledTimes(2);
    for (const name of ['reload-console-scope-1.json', 'reload-old-document-resource-rejections-1.json']) {
      const path = outputPath(name);
      expect(existsSync(path)).toBe(true);
      expect(attach).toHaveBeenCalledWith(name, { path, contentType: 'application/json' });
      const proof = attachmentProof({ path });
      expect(proof.matched).toMatchObject([{
        category: 'old-document-resource-rejection',
        diagnostic: { text: accessDiagnostic.text, url: '' },
        resource: {
          workerUrl: WORKER, request: { url: cancellation.url, referer: WORKER },
          response: { status: 200 }, end: { kind: 'requestfinished' },
        },
      }]);
    }
  });

  it('retains physical JSON for a successful scope even when the reporter does not save attachment bodies', async () => {
    const { events, mainFrame, outputPath, capture, attach } = fakeCapture();
    await capture.duringReload(async () => { events.emit('framenavigated', mainFrame); });
    expect(capture.errors).toEqual([]);
    const path = outputPath('reload-console-scope-1.json');
    expect(existsSync(path)).toBe(true);
    expect(attach).toHaveBeenCalledWith('reload-console-scope-1.json', { path, contentType: 'application/json' });
    expect(attachmentProof({ path })).toMatchObject({ consoleEvents: [], requestEvents: [], fatal: [], matched: [] });
  });

  it('archives an outgoing-only diagnostic with document boundaries and explicit unproven attribution', async () => {
    const { events, mainFrame, outputPath, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    await capture.duringReload(async () => {
      events.emit('console', consoleError('', accessDiagnostic.text));
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([]);
    expect(attach).toHaveBeenCalledTimes(2);
    for (const name of ['reload-console-scope-1.json', 'reload-outgoing-navigation-diagnostics-1.json']) {
      const path = outputPath(name);
      expect(existsSync(path)).toBe(true);
      expect(attach).toHaveBeenCalledWith(name, { path, contentType: 'application/json' });
      expect(attachmentProof({ path })).toMatchObject({
        evidence: {
          oldDocumentUrl: DOCUMENT, committedDocumentUrl: DOCUMENT, requestEvents: [], failures: [],
          oldDocumentBlobUrls: [], oldDocumentBlobHistoryOverflow: false,
        },
        matched: [{ category: 'outgoing-navigation-diagnostic', source: 'unproven', cause: 'unproven' }],
      });
    }
  });

  it.each(['request', 'response', 'requestfinished', 'requestfailed'])('disqualifies outgoing diagnostics after a pre-scope %s for that Blob', async (kind) => {
    const { events, mainFrame, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    events.emit(kind, { url: () => cancellation.url, status: () => 200 });
    await capture.duringReload(async () => {
      events.emit('console', consoleError('', accessDiagnostic.text));
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([`console: ${accessDiagnostic.text}`]);
    expect(attach).toHaveBeenCalledOnce();
    expect(attachmentProof(attach.mock.calls[0][1]).evidence).toMatchObject({
      oldDocumentBlobUrls: [cancellation.url], oldDocumentBlobHistoryOverflow: false,
    });
  });

  it('caps retained Blob URLs and fails closed for outgoing diagnostics when history overflows', async () => {
    const { events, mainFrame, capture, attach } = fakeCapture();
    events.emit('request', { url: () => WORKER });
    for (let index = 0; index < 257; index++) {
      events.emit('request', { url: () => `blob:http://127.0.0.1:4350/previous-${index}` });
    }
    await capture.duringReload(async () => {
      events.emit('console', consoleError('', accessDiagnostic.text));
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([`console: ${accessDiagnostic.text}`]);
    const proof = attachmentProof(attach.mock.calls[0][1]);
    expect(proof.evidence.oldDocumentBlobUrls).toHaveLength(256);
    expect(proof.evidence.oldDocumentBlobHistoryOverflow).toBe(true);
  });

  it('retains previously observed Blob evidence across public same-document navigation', async () => {
    const { events, mainFrame, capture, attach } = fakeCapture();
    events.emit('request', { url: () => cancellation.url });
    events.emit('framenavigated', mainFrame);
    events.emit('request', { url: () => WORKER });
    await capture.duringReload(async () => {
      events.emit('console', consoleError('', accessDiagnostic.text));
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([`console: ${accessDiagnostic.text}`]);
    expect(attachmentProof(attach.mock.calls[0][1]).evidence).toMatchObject({
      oldDocumentBlobUrls: [cancellation.url], oldDocumentBlobHistoryOverflow: false,
    });
  });

  it('never resets overflow across public same-document navigation during the capture lifetime', async () => {
    const { events, mainFrame, capture, attach } = fakeCapture();
    for (let index = 0; index < 257; index++) {
      events.emit('request', { url: () => `blob:http://127.0.0.1:4350/previous-${index}` });
    }
    events.emit('framenavigated', mainFrame);
    events.emit('request', { url: () => WORKER });
    await capture.duringReload(async () => {
      events.emit('console', consoleError('', accessDiagnostic.text));
      events.emit('framenavigated', mainFrame);
    });
    expect(capture.errors).toEqual([`console: ${accessDiagnostic.text}`]);
    const proof = attachmentProof(attach.mock.calls[0][1]);
    expect(proof.evidence.oldDocumentBlobUrls).toHaveLength(256);
    expect(proof.evidence.oldDocumentBlobHistoryOverflow).toBe(true);
  });
});
