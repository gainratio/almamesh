import { writeFile } from 'node:fs/promises';
import type { Page, Request, TestInfo } from '@playwright/test';

export interface ReloadDiagnostic {
  kind: 'console' | 'pageerror';
  text: string;
  url?: string;
  at: number;
}

export interface ReloadRequestFailure {
  url: string;
  referer: string | null;
  errorText: string;
  at: number;
}

export interface ReloadRequestEvent {
  kind: 'request' | 'requestfailed' | 'response' | 'requestfinished';
  url: string;
  at: number;
  referer?: string | null;
  refererReadFailed?: boolean;
  errorText?: string;
  status?: number;
}

export interface ReloadEvidence {
  startedAt: number;
  committedAt: number | null;
  oldDocumentUrl?: string;
  committedDocumentUrl?: string;
  oldDocumentBlobUrls?: readonly string[];
  oldDocumentBlobHistoryOverflow?: boolean;
  oldSqlWorkerUrls: readonly string[];
  failures: readonly ReloadRequestFailure[];
  requestEvents?: readonly ReloadRequestEvent[];
}

interface ResourceProof {
  request: ReloadRequestEvent;
  workerUrl: string;
  response?: ReloadRequestEvent;
  end: ReloadRequestEvent | ReloadRequestFailure;
}

type ReloadMatch =
  | { category: 'old-document-cancellation'; diagnostic: ReloadDiagnostic; cancellation: ReloadRequestFailure }
  | { category: 'old-document-resource-rejection'; diagnostic: ReloadDiagnostic; accessControl: ReloadDiagnostic; resource: ResourceProof }
  | { category: 'outgoing-navigation-diagnostic'; diagnostic: ReloadDiagnostic; source: 'unproven'; cause: 'unproven' };

export interface ReloadClassification {
  fatal: ReloadDiagnostic[];
  matched: ReloadMatch[];
}

const OPFS_CANCELLATION_TEXT = 'opfs-wl: Error initializing OPFS asyncer: Event';

/** The production asset name of the pinned @gainratio/browser/sql worker. */
function isSqlWorker(url: string): boolean {
  try {
    return /\/assets\/worker-[\w-]+\.js$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function duringReload(at: number, evidence: ReloadEvidence): boolean {
  return evidence.committedAt !== null && at > evidence.startedAt && at < evidence.committedAt;
}

/** This names the observed rejection; it does not infer which WebKit loader branch caused it. */
function resourceRejection(diagnostic: ReloadDiagnostic, evidence: ReloadEvidence): ResourceProof | undefined {
  const blobUrl = /^Cannot load (blob:\S+) due to access control checks\.$/.exec(diagnostic.text)?.[1];
  if (diagnostic.kind !== 'console' || diagnostic.url !== '' || !blobUrl || !duringReload(diagnostic.at, evidence)) return;
  const events = evidence.requestEvents ?? [];
  for (const request of events) {
    const workerUrl = request.referer;
    if (request.kind !== 'request' || request.url !== blobUrl || !duringReload(request.at, evidence)
      || request.at >= diagnostic.at || !workerUrl || request.refererReadFailed
      || !isSqlWorker(workerUrl) || !evidence.oldSqlWorkerUrls.includes(workerUrl)) continue;
    try {
      const blob = new URL(blobUrl);
      if (blob.origin === 'null' || blob.origin !== new URL(workerUrl).origin) continue;
    } catch {
      continue;
    }
    const beforeDiagnostic = (event: { url: string; at: number }) => event.url === blobUrl
      && duringReload(event.at, evidence) && request.at < event.at && event.at < diagnostic.at;
    const response = events.find((event) => event.kind === 'response' && event.status === 200 && beforeDiagnostic(event));
    const finished = response && events.find((event) => event.kind === 'requestfinished'
      && beforeDiagnostic(event) && response.at < event.at);
    if (response && finished) return { request, response, end: finished, workerUrl };
    const cancelled = evidence.failures.find((failure) => failure.errorText === 'cancelled'
      && failure.referer === workerUrl && beforeDiagnostic(failure));
    if (cancelled) return { request, end: cancelled, workerUrl };
  }
}

/** Explicit test exception only: neither its source nor its cause is established. */
function unprovenOutgoingDiagnostic(diagnostic: ReloadDiagnostic, evidence: ReloadEvidence): boolean {
  const blobUrl = /^Cannot load (blob:\S+) due to access control checks\.$/.exec(diagnostic.text)?.[1];
  if (diagnostic.kind !== 'console' || diagnostic.url !== '' || !blobUrl || !duringReload(diagnostic.at, evidence)
    || !evidence.oldDocumentUrl || evidence.oldDocumentUrl !== evidence.committedDocumentUrl
    || !evidence.requestEvents || !evidence.oldDocumentBlobUrls || evidence.oldDocumentBlobHistoryOverflow !== false
    || evidence.oldDocumentBlobUrls.includes(blobUrl)
    || evidence.requestEvents.some((event) => event.url === blobUrl)
    || evidence.failures.some((failure) => failure.url === blobUrl)) return false;
  try {
    const document = new URL(evidence.oldDocumentUrl);
    if (!['http:', 'https:'].includes(document.protocol) || new URL(blobUrl).origin !== document.origin) return false;
    return evidence.oldSqlWorkerUrls.some((worker) => isSqlWorker(worker) && new URL(worker).origin === document.origin);
  } catch {
    return false;
  }
}

/** Exact old-document cancellation and resource-rejection evidence remain separate. */
export function classifyReloadConsole(diagnostics: readonly ReloadDiagnostic[], evidence: ReloadEvidence): ReloadClassification {
  const result: ReloadClassification = { fatal: [], matched: [] };
  const remaining = [...evidence.failures];
  const during = (at: number) => duringReload(at, evidence);
  for (const diagnostic of diagnostics) {
    const index = diagnostic.kind === 'console' && diagnostic.text === OPFS_CANCELLATION_TEXT
      && diagnostic.url !== undefined && isSqlWorker(diagnostic.url)
      && evidence.oldSqlWorkerUrls.includes(diagnostic.url) && during(diagnostic.at)
      ? remaining.findIndex((failure) => failure.url.startsWith('blob:') && failure.errorText === 'cancelled'
        && failure.referer === diagnostic.url && during(failure.at))
      : -1;
    if (index < 0) result.fatal.push(diagnostic);
    else result.matched.push({ category: 'old-document-cancellation', diagnostic, cancellation: remaining.splice(index, 1)[0] });
  }
  const rejections: Array<{ diagnostic: ReloadDiagnostic; resource: ResourceProof }> = [];
  const seenBlobs = new Set<string>();
  result.fatal = result.fatal.filter((diagnostic) => {
    const resource = resourceRejection(diagnostic, evidence);
    if (!resource || seenBlobs.has(resource.request.url)) return true;
    seenBlobs.add(resource.request.url);
    rejections.push({ diagnostic, resource });
    result.matched.push({ category: 'old-document-resource-rejection', diagnostic, accessControl: diagnostic, resource });
    return false;
  });
  const usedInitializers = new Set(result.matched.filter((match) => match.category === 'old-document-cancellation')
    .map((match) => `${match.diagnostic.url}|${match.diagnostic.text}`));
  result.fatal = result.fatal.filter((diagnostic) => {
    const key = `${diagnostic.url}|${diagnostic.text}`;
    if (diagnostic.kind !== 'console' || !during(diagnostic.at) || usedInitializers.has(key)
      || !['opfs: Error initializing OPFS asyncer: Event', OPFS_CANCELLATION_TEXT].includes(diagnostic.text)) return true;
    const rejection = rejections.find(({ resource }) => diagnostic.url === resource.workerUrl && resource.request.at < diagnostic.at);
    if (!rejection) return true;
    usedInitializers.add(key);
    result.matched.push({ category: 'old-document-resource-rejection', diagnostic, accessControl: rejection.diagnostic, resource: rejection.resource });
    return false;
  });
  let outgoingMatched = false;
  result.fatal = result.fatal.filter((diagnostic) => {
    if (outgoingMatched || !unprovenOutgoingDiagnostic(diagnostic, evidence)) return true;
    outgoingMatched = true;
    result.matched.push({ category: 'outgoing-navigation-diagnostic', diagnostic, source: 'unproven', cause: 'unproven' });
    return false;
  });
  result.matched.sort((left, right) => left.diagnostic.at - right.diagnostic.at);
  return result;
}

export interface ReloadConsoleCapture {
  errors: string[];
  duringReload<T>(reload: () => Promise<T>): Promise<T>;
}

export function captureReloadConsole(page: Page, testInfo: Pick<TestInfo, 'attach' | 'outputPath'>): ReloadConsoleCapture {
  interface Scope {
    evidence: ReloadEvidence;
    oldSqlWorkerRequests: Array<{ url: string; at: number }>;
    diagnostics: ReloadDiagnostic[];
    failures: Array<Promise<ReloadRequestFailure>>;
    requestEvents: Array<ReloadRequestEvent | Promise<ReloadRequestEvent>>;
    consoleEvents: Array<{ type: string; text: string; url: string; at: number }>;
    pageErrors: ReloadDiagnostic[];
  }
  const errors: string[] = [];
  const archive = async (name: string, proof: unknown) => {
    const path = testInfo.outputPath(name);
    await writeFile(path, JSON.stringify(proof, null, 2), 'utf8');
    await testInfo.attach(name, { path, contentType: 'application/json' });
  };
  const requestedWorkers = new Map<string, number>();
  // Keep a conservative capture-lifetime superset: framenavigated also fires
  // for same-document SPA navigation, so it cannot prove a new Blob lifetime.
  // At most 256 URLs are retained; overflow permanently disables the outgoing
  // exception for this capture. Strict resource/cancellation proof is unchanged.
  const documentBlobUrls = new Set<string>();
  let documentBlobHistoryOverflow = false;
  const observeBlob = (url: string) => {
    if (!url.startsWith('blob:') || documentBlobUrls.has(url)) return;
    if (documentBlobUrls.size < 256) documentBlobUrls.add(url);
    else documentBlobHistoryOverflow = true;
  };
  let sequence = 0;
  let reloadNumber = 0;
  let active: Scope | undefined;
  let reloading = false;
  const recordFatal = (diagnostic: ReloadDiagnostic) => errors.push(`${diagnostic.kind}: ${diagnostic.text}`);
  const relevantRequest = (url: string) => url.startsWith('blob:') || isSqlWorker(url);
  const readReferer = (request: Request) => request.headerValue('referer').then(
    (referer) => ({ referer }),
    () => ({ referer: null, refererReadFailed: true }),
  );
  page.on('request', (request) => {
    const url = request.url();
    observeBlob(url);
    if (!relevantRequest(url)) return;
    const at = ++sequence;
    if (isSqlWorker(url)) requestedWorkers.set(url, at);
    if (active) active.requestEvents.push(readReferer(request).then((headers) => ({ kind: 'request', url, at, ...headers })));
  });
  page.on('console', (message) => {
    const type = message.type();
    if (!active && type !== 'error') return;
    const diagnostic: ReloadDiagnostic = {
      kind: 'console', text: message.text(), url: message.location().url, at: ++sequence,
    };
    active?.consoleEvents.push({ type, text: diagnostic.text, url: diagnostic.url!, at: diagnostic.at });
    if (type !== 'error') return;
    if (active) active.diagnostics.push(diagnostic);
    else recordFatal(diagnostic);
  });
  page.on('pageerror', (error) => {
    const diagnostic: ReloadDiagnostic = { kind: 'pageerror', text: error.message, at: ++sequence };
    active?.pageErrors.push(diagnostic);
    recordFatal(diagnostic);
  });
  page.on('requestfailed', (request) => {
    observeBlob(request.url());
    if (!active) return;
    const failure = { url: request.url(), errorText: request.failure()?.errorText ?? '', at: ++sequence };
    // Capture event order now, even if the header lookup finishes after commit.
    const observed = readReferer(request).then((headers) => ({ kind: 'requestfailed' as const, ...failure, ...headers }));
    active.failures.push(observed);
    active.requestEvents.push(observed);
  });
  page.on('response', (response) => {
    observeBlob(response.url());
    if (active && relevantRequest(response.url())) {
      active.requestEvents.push({ kind: 'response', url: response.url(), status: response.status(), at: ++sequence });
    }
  });
  page.on('requestfinished', (request) => {
    observeBlob(request.url());
    if (active && relevantRequest(request.url())) {
      active.requestEvents.push({ kind: 'requestfinished', url: request.url(), at: ++sequence });
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    requestedWorkers.clear();
    if (active) {
      active.evidence.committedAt = ++sequence;
      active.evidence.committedDocumentUrl = frame.url();
      active = undefined;
    }
  });
  return {
    errors,
    async duringReload(reload) {
      if (reloading) throw new Error('Explicit reload console scopes cannot overlap');
      reloading = true;
      const number = ++reloadNumber;
      const scope: Scope = {
        evidence: {
          startedAt: ++sequence, committedAt: null, oldDocumentUrl: page.url(),
          oldDocumentBlobUrls: [...documentBlobUrls], oldDocumentBlobHistoryOverflow: documentBlobHistoryOverflow,
          oldSqlWorkerUrls: [...requestedWorkers.keys()], failures: [],
        },
        oldSqlWorkerRequests: [...requestedWorkers].map(([url, at]) => ({ url, at })),
        diagnostics: [], failures: [], requestEvents: [], consoleEvents: [], pageErrors: [],
      };
      active = scope;
      try {
        return await reload();
      } finally {
        if (active === scope) active = undefined;
        try {
          scope.evidence.failures = await Promise.all(scope.failures);
          scope.evidence.requestEvents = await Promise.all(scope.requestEvents);
          const classified = classifyReloadConsole(scope.diagnostics, scope.evidence);
          classified.fatal.forEach(recordFatal);
          // Preserve even unmatched scopes so the public API's actual evidence
          // can be compared with the trace without widening the classifier.
          await archive(`reload-console-scope-${number}.json`, {
              evidence: scope.evidence, oldSqlWorkerRequests: scope.oldSqlWorkerRequests,
              consoleEvents: scope.consoleEvents, pageErrors: scope.pageErrors,
              requestEvents: scope.evidence.requestEvents,
              fatal: [...classified.fatal, ...scope.pageErrors].sort((left, right) => left.at - right.at),
              matched: classified.matched,
          });
          const cancellations = classified.matched.filter((match) => match.category === 'old-document-cancellation');
          if (cancellations.length) {
            await archive(`reload-opfs-cancellations-${number}.json`, {
              evidence: scope.evidence, matched: cancellations,
            });
          }
          const rejections = classified.matched.filter((match) => match.category === 'old-document-resource-rejection');
          if (rejections.length) {
            await archive(`reload-old-document-resource-rejections-${number}.json`, {
              evidence: scope.evidence, matched: rejections,
            });
          }
          const outgoing = classified.matched.filter((match) => match.category === 'outgoing-navigation-diagnostic');
          if (outgoing.length) {
            await archive(`reload-outgoing-navigation-diagnostics-${number}.json`, {
              evidence: scope.evidence, matched: outgoing,
            });
          }
        } finally {
          reloading = false;
        }
      }
    },
  };
}
