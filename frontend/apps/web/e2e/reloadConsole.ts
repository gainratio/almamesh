import type { Page, TestInfo } from '@playwright/test';

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

export interface ReloadEvidence {
  startedAt: number;
  committedAt: number | null;
  oldSqlWorkerUrls: readonly string[];
  failures: readonly ReloadRequestFailure[];
}

export interface ReloadClassification {
  fatal: ReloadDiagnostic[];
  matched: Array<{ diagnostic: ReloadDiagnostic; cancellation: ReloadRequestFailure }>;
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

/** Every condition is required. A canceled blob proves at most one diagnostic. */
export function classifyReloadConsole(diagnostics: readonly ReloadDiagnostic[], evidence: ReloadEvidence): ReloadClassification {
  const result: ReloadClassification = { fatal: [], matched: [] };
  const remaining = [...evidence.failures];
  const during = (at: number) => evidence.committedAt !== null && at > evidence.startedAt && at < evidence.committedAt;
  for (const diagnostic of diagnostics) {
    const index = diagnostic.kind === 'console' && diagnostic.text === OPFS_CANCELLATION_TEXT
      && diagnostic.url !== undefined && isSqlWorker(diagnostic.url)
      && evidence.oldSqlWorkerUrls.includes(diagnostic.url) && during(diagnostic.at)
      ? remaining.findIndex((failure) => failure.url.startsWith('blob:') && failure.errorText === 'cancelled'
        && failure.referer === diagnostic.url && during(failure.at))
      : -1;
    if (index < 0) result.fatal.push(diagnostic);
    else result.matched.push({ diagnostic, cancellation: remaining.splice(index, 1)[0] });
  }
  return result;
}

export interface ReloadConsoleCapture {
  errors: string[];
  duringReload<T>(reload: () => Promise<T>): Promise<T>;
}

export function captureReloadConsole(page: Page, testInfo: Pick<TestInfo, 'attach'>): ReloadConsoleCapture {
  interface Scope {
    evidence: ReloadEvidence;
    diagnostics: ReloadDiagnostic[];
    failures: Array<Promise<ReloadRequestFailure>>;
  }
  const errors: string[] = [];
  const requestedWorkers = new Set<string>();
  let sequence = 0;
  let reloadNumber = 0;
  let active: Scope | undefined;
  let reloading = false;
  const recordFatal = (diagnostic: ReloadDiagnostic) => errors.push(`${diagnostic.kind}: ${diagnostic.text}`);
  page.on('request', (request) => {
    if (isSqlWorker(request.url())) requestedWorkers.add(request.url());
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const diagnostic: ReloadDiagnostic = {
      kind: 'console', text: message.text(), url: message.location().url, at: ++sequence,
    };
    if (active) active.diagnostics.push(diagnostic);
    else recordFatal(diagnostic);
  });
  page.on('pageerror', (error) => recordFatal({ kind: 'pageerror', text: error.message, at: ++sequence }));
  page.on('requestfailed', (request) => {
    if (!active || !request.url().startsWith('blob:')) return;
    const failure = { url: request.url(), errorText: request.failure()?.errorText ?? '', at: ++sequence };
    // Capture event order now, even if the header lookup finishes after commit.
    active.failures.push(request.headerValue('referer').catch(() => null).then((referer) => ({ ...failure, referer })));
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    requestedWorkers.clear();
    if (active) {
      active.evidence.committedAt = ++sequence;
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
        evidence: { startedAt: ++sequence, committedAt: null, oldSqlWorkerUrls: [...requestedWorkers], failures: [] },
        diagnostics: [], failures: [],
      };
      active = scope;
      try {
        return await reload();
      } finally {
        if (active === scope) active = undefined;
        try {
          scope.evidence.failures = await Promise.all(scope.failures);
          const classified = classifyReloadConsole(scope.diagnostics, scope.evidence);
          classified.fatal.forEach(recordFatal);
          if (classified.matched.length) {
            await testInfo.attach(`reload-opfs-cancellations-${number}.json`, {
              body: JSON.stringify({ evidence: scope.evidence, matched: classified.matched }, null, 2),
              contentType: 'application/json',
            });
          }
        } finally {
          reloading = false;
        }
      }
    },
  };
}
