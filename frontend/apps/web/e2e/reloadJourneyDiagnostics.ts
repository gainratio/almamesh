import type { Page, TestInfo } from '@playwright/test';

const PHASES = ['created', 'engine-boot', 'chart-seed', 'dashboard-open', 'period-open', 'period-visible', 'reload-start', 'reload-complete', 'dashboard-ready', 'verified'] as const;
type Phase = typeof PHASES[number];
type ConsoleCategory = 'wasm-memory-fault' | 'wasm-fatal' | 'storage' | 'network' | 'other';
const BOOT_STAGES = ['syncing', 'synced', 'reassembling', 'booting-engine', 'ready'] as const;

function own(value: unknown, key: string): unknown {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function category(text: string): ConsoleCategory {
  if (/out of bounds memory access|memory access out of bounds|wasm.*memory/i.test(text)) return 'wasm-memory-fault';
  if (/pyodide.*fatal|fatal.*pyodide|WebAssembly\.RuntimeError/i.test(text)) return 'wasm-fatal';
  if (/sqlite|opfs|storage|database/i.test(text)) return 'storage';
  if (/network|fetch|access control|load failed/i.test(text)) return 'network';
  return 'other';
}

/** Node-side state survives document loss. No console text, URL, payload or error is retained. */
export function observeReloadJourney(page: Page, clock: () => number = () => performance.now()) {
  const began = clock();
  const phases: Array<{ phase: Phase; atMs: number }> = [];
  const events: Array<{ kind: 'console' | 'pageerror'; category: ConsoleCategory; atMs: number }> = [];
  let phase: Phase = 'created';
  let crashed = false;
  let closed = false;
  let droppedPhases = 0;
  let droppedConsole = 0;
  let observerFailures = 0;
  let stopped = false;
  const elapsed = () => {
    const now = clock() - began;
    return Number.isFinite(now) ? Math.max(0, Math.round(now)) : 0;
  };
  const record = (kind: 'console' | 'pageerror', text: string) => {
    if (events.length >= 64) { droppedConsole += 1; return; }
    events.push({ kind, category: category(text.slice(0, 4_096)), atMs: elapsed() });
  };
  const onConsole = (message: { type(): string; text(): string }) => {
    try { if (message.type() === 'error') record('console', message.text()); } catch { observerFailures += 1; }
  };
  const onError = (error: Error) => {
    try { record('pageerror', typeof error.message === 'string' ? error.message : ''); } catch { observerFailures += 1; }
  };
  const onCrash = () => { crashed = true; };
  const onClose = () => { closed = true; };
  page.on('console', onConsole); page.on('pageerror', onError); page.on('crash', onCrash); page.on('close', onClose);
  return {
    phase(next: Phase) {
      if (stopped || !PHASES.includes(next)) return;
      phase = next;
      if (phases.length >= 32) { droppedPhases += 1; return; }
      phases.push({ phase: next, atMs: elapsed() });
    },
    snapshot() { return { phase, elapsedMs: elapsed(), crashed, closed, phases: phases.map((row) => ({ ...row })), console: events.map((row) => ({ ...row })), droppedPhases, droppedConsole, observerFailures }; },
    stop() {
      if (stopped) return;
      stopped = true;
      page.off('console', onConsole); page.off('pageerror', onError); page.off('crash', onCrash); page.off('close', onClose);
    },
  };
}

async function bounded<T>(work: () => Promise<T>): Promise<{ state: 'completed'; value: T } | { state: 'timeout' | 'failed' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work).then((value) => ({ state: 'completed' as const, value }), () => ({ state: 'failed' as const })),
      new Promise<{ state: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ state: 'timeout' }), 2_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function routeOf(page: Page): 'dashboard' | 'settings-data' | 'onboarding' | 'other' | 'unavailable' {
  try {
    const path = new URL(page.url()).pathname;
    if (path === '/dashboard') return 'dashboard';
    if (path === '/settings/data') return 'settings-data';
    if (path === '/onboarding') return 'onboarding';
    return 'other';
  } catch { return 'unavailable'; }
}

/** No canonical store data is read. Individual store hydration is not publicly observable here. */
export async function captureReloadJourneyState(page: Page, documentLost = false) {
  const route = routeOf(page);
  if (documentLost || page.isClosed()) return { state: 'page-unavailable' as const, route, hydration: 'unavailable' as const };
  const captured = await bounded(() => page.evaluate(() => {
    const host = window as unknown as { __ALMAMESH_STAGE__?: unknown; __ALMAMESH_ERROR__?: unknown; __almameshPortableStatePersistence?: () => unknown };
    const present = (id: string) => document.querySelector(`[data-testid="${id}"]`) !== null;
    const button = document.querySelector('[data-testid="dashboard-time-travel-button"]');
    return {
      boot: host.__ALMAMESH_STAGE__, bootError: host.__ALMAMESH_ERROR__ !== undefined,
      storage: typeof host.__almameshPortableStatePersistence === 'function' ? host.__almameshPortableStatePersistence() : undefined,
      ui: {
        rootPresent: document.getElementById('root') !== null, rootEmpty: document.getElementById('root')?.childElementCount === 0,
        loadingIndicator: document.querySelector('[role="status"]') !== null,
        timeTravelButton: button !== null, timeTravelButtonDisabled: button?.hasAttribute('disabled') === true,
        noChart: present('no-chart-state'), chartReadFailed: present('chart-read-failed'), lifeAtlas: present('life-atlas'),
        periodBanner: present('dashboard-time-travel-banner'), periodCard: present('time-travel-moment-card'), periodFailed: present('time-travel-moment-failed'),
        storageBlocked: present('storage-blocked-notice'), engineError: present('engine-error-detail'),
      },
    };
  }));
  if (captured.state !== 'completed') return { state: captured.state === 'timeout' ? 'snapshot-timeout' as const : 'page-unavailable' as const, route, hydration: 'unavailable' as const };
  const boot = own(captured.value, 'boot');
  const storage = own(captured.value, 'storage');
  const rawUi = own(captured.value, 'ui');
  const bit = (name: string) => own(rawUi, name) === true;
  return {
    state: 'available' as const, route, hydration: 'unavailable' as const,
    boot: typeof boot === 'string' && BOOT_STAGES.includes(boot as typeof BOOT_STAGES[number]) ? boot : 'unavailable',
    bootError: own(captured.value, 'bootError') === true,
    storage: ['pending', 'opfs', 'blocked', 'unavailable'].includes(storage as string) ? storage as string : 'unavailable',
    ui: { rootPresent: bit('rootPresent'), rootEmpty: bit('rootEmpty'), loadingIndicator: bit('loadingIndicator'), timeTravelButton: bit('timeTravelButton'), timeTravelButtonDisabled: bit('timeTravelButtonDisabled'), noChart: bit('noChart'), chartReadFailed: bit('chartReadFailed'), lifeAtlas: bit('lifeAtlas'), periodBanner: bit('periodBanner'), periodCard: bit('periodCard'), periodFailed: bit('periodFailed'), storageBlocked: bit('storageBlocked'), engineError: bit('engineError') },
  };
}

async function retainReloadJourneyDiagnostics(page: Page, info: Pick<TestInfo, 'attach'>, observer: ReturnType<typeof observeReloadJourney>, failed: boolean): Promise<void> {
  try {
    observer.stop();
    const lifecycle = observer.snapshot();
    const body = JSON.stringify({ event: 'reload-journey-diagnostics', schemaVersion: 1, journey: failed ? 'failed' : 'passed', lifecycle, document: await captureReloadJourneyState(page, lifecycle.crashed || lifecycle.closed) });
    console.log(body);
    const attached = await bounded(() => info.attach('reload-journey-diagnostics.json', { body, contentType: 'application/json' }));
    if (attached.state !== 'completed') throw new Error();
  } catch { if (!failed) throw new Error('Reload journey diagnostics could not be retained.'); }
}

/** Always retain a closed receipt; a diagnostic failure never replaces the journey's original error. */
export async function withReloadJourneyDiagnostics(page: Page, info: Pick<TestInfo, 'attach'>, work: (observer: ReturnType<typeof observeReloadJourney>) => Promise<void>): Promise<void> {
  const observer = observeReloadJourney(page);
  let failed = false;
  try { await work(observer); } catch (error) { failed = true; throw error; } finally {
    await retainReloadJourneyDiagnostics(page, info, observer, failed);
  }
}
