import type { Page } from '@playwright/test';

/** The page's service-worker registration, as `getRegistration()` reports it. */
export interface ServiceWorkerSnapshot {
  readonly registered: boolean;
  readonly installing: ServiceWorkerState | null;
  readonly waiting: ServiceWorkerState | null;
  readonly active: ServiceWorkerState | null;
  readonly controlled: boolean;
}

export interface ServiceWorkerReader {
  snapshot(): Promise<ServiceWorkerSnapshot>;
  /** Every URL the newest worker fetched (the hooked build's sw-egress-probe), or null when none answers. */
  probeFetches(): Promise<readonly string[] | null>;
}

export interface ActivationWaitOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly onState?: (state: ServiceWorkerSnapshot) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const PROBE_ANSWER_MS = 5_000;

function describeRegistration(state: ServiceWorkerSnapshot | undefined, lastError: string | undefined): string {
  if (state === undefined) return `the registration was never read (last error: ${lastError ?? 'none'})`;
  if (!state.registered) return 'no registration (register() never ran, or a failed install cleared it)';
  const field = (value: ServiceWorkerState | null): string => value ?? 'none';
  return `registration {installing: ${field(state.installing)}, waiting: ${field(state.waiting)}, `
    + `active: ${field(state.active)}, controlled: ${state.controlled ? 'yes' : 'no'}}`;
}

function describeProbe(fetched: readonly string[] | null): string {
  if (fetched === null) return 'no worker answered the egress probe (hung, terminated, or none to ask)';
  const last = fetched.at(-1);
  const where = last === undefined ? 'none' : new URL(last).pathname;
  return `the worker answered the egress probe with ${fetched.length} fetched URLs, the last ${where}`;
}

async function stallMessage(reader: ServiceWorkerReader, state: ServiceWorkerSnapshot | undefined, lastError: string | undefined, timeoutMs: number): Promise<string> {
  const head = `the service worker did not activate within ${timeoutMs} ms: ${describeRegistration(state, lastError)}`;
  if (state === undefined || !state.registered) return head;
  const fetched = await reader.probeFetches().catch(() => null);
  return `${head}; ${describeProbe(fetched)}`;
}

/**
 * Wait until the page's registration has an active worker (activating or
 * activated: what `navigator.serviceWorker.ready` waits for), polling from Node
 * so the wait survives the page's own navigations. Each state change is
 * reported once. A worker that never activates fails with its install state
 * and the worker's own fetch record, so a stall says where it stopped.
 */
export async function waitForServiceWorkerActive(reader: ServiceWorkerReader, options: ActivationWaitOptions): Promise<ServiceWorkerSnapshot> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  let last: ServiceWorkerSnapshot | undefined;
  let lastKey = '';
  let lastError: string | undefined;
  for (;;) {
    try {
      const state = await reader.snapshot();
      const key = JSON.stringify(state);
      if (key !== lastKey) options.onState?.(state);
      last = state;
      lastKey = key;
      if (state.active !== null) return state;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (now() >= deadline) throw new Error(await stallMessage(reader, last, lastError, options.timeoutMs));
    await sleep(options.pollMs);
  }
}

/** The reader over a live page. probeFetches asks the newest worker (installing, then waiting, then active). */
export function pageServiceWorkerReader(page: Page): ServiceWorkerReader {
  return {
    snapshot: () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return {
        registered: registration !== undefined,
        installing: registration?.installing?.state ?? null,
        waiting: registration?.waiting?.state ?? null,
        active: registration?.active?.state ?? null,
        controlled: navigator.serviceWorker.controller !== null,
      };
    }),
    probeFetches: () => page.evaluate(async (answerMs) => {
      const registration = await navigator.serviceWorker.getRegistration();
      const worker = registration?.installing ?? registration?.waiting ?? registration?.active ?? null;
      if (worker === null) return null;
      return new Promise<string[] | null>((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), answerMs);
        channel.port1.onmessage = (event: MessageEvent<string[]>) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.postMessage({ type: 'almamesh:egress-probe' }, [channel.port2]);
      });
    }, PROBE_ANSWER_MS),
  };
}
