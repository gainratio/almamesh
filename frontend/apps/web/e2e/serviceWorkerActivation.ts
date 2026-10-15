import type { Page } from '@playwright/test';

/** The page's service-worker registration, as `getRegistration()` reports it. */
export interface ServiceWorkerSnapshot {
  readonly registered: boolean;
  readonly installing: ServiceWorkerState | null;
  readonly waiting: ServiceWorkerState | null;
  readonly active: ServiceWorkerState | null;
  readonly controlled: boolean;
}

/**
 * What the hooked build's sw-egress-probe (vite.config.ts) wrote to Cache
 * Storage: every URL a worker fetched, and its lifecycle events (script start,
 * install, activate, a rejected waitUntil, a failed or non-OK fetch, an
 * uncaught error), oldest first. Cache Storage is the origin's, so the page
 * reads it even when no worker is left to ask.
 */
export interface ProbeRecord {
  readonly fetched: readonly string[];
  readonly events: readonly string[];
}

export interface ServiceWorkerReader {
  snapshot(): Promise<ServiceWorkerSnapshot>;
  /** The probe record, or null when no worker ever wrote one. */
  probeRecord(): Promise<ProbeRecord | null>;
}

export interface ActivationWaitOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly onState?: (state: ServiceWorkerSnapshot) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const MAX_EVENTS = 12;

function describeRegistration(state: ServiceWorkerSnapshot | undefined, lastError: string | undefined): string {
  if (state === undefined) return `the registration was never read (last error: ${lastError ?? 'none'})`;
  if (!state.registered) return 'no registration (register() never ran, or a failed install cleared it)';
  const controlled = `controlled: ${state.controlled ? 'yes' : 'no'}`;
  if (state.installing === null && state.waiting === null && state.active === null) {
    return `a registration with no worker in any slot (${controlled})`;
  }
  const field = (value: ServiceWorkerState | null): string => value ?? 'none';
  return `registration {installing: ${field(state.installing)}, waiting: ${field(state.waiting)}, active: ${field(state.active)}, ${controlled}}`;
}

function describeRecord(record: ProbeRecord | null): string {
  if (record === null) return 'no probe record (sw.js never ran its first statement)';
  const last = record.fetched.at(-1);
  const where = last === undefined ? 'none' : new URL(last).pathname;
  const kept = record.events.slice(-MAX_EVENTS);
  const label = kept.length < record.events.length ? `worker events (last ${kept.length} of ${record.events.length})` : 'worker events';
  return `probe record: ${record.fetched.length} fetched URLs, the last ${where}; ${label}: ${kept.join(' | ') || 'none'}`;
}

async function stallMessage(reader: ServiceWorkerReader, state: ServiceWorkerSnapshot | undefined, lastError: string | undefined, timeoutMs: number): Promise<string> {
  const head = `the service worker did not activate within ${timeoutMs} ms: ${describeRegistration(state, lastError)}`;
  if (state === undefined) return head;
  const record = await reader.probeRecord().then(describeRecord, (error: unknown) => `the probe record could not be read (${errorText(error)})`);
  return `${head}; ${record}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A read that cannot outlive the wait: it rejects once `ms` passes, naming the wait's deadline (not the clock-dependent remainder). */
function bounded<T>(read: Promise<T>, ms: number, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the registration read did not settle before the ${timeoutMs} ms deadline`)), ms);
  });
  return Promise.race([read, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Wait until the page's registration has an active worker (activating or
 * activated: what `navigator.serviceWorker.ready` waits for), polling from Node
 * so the wait survives the page's own navigations. Each state change is
 * reported once. A worker that never activates fails with the registration's
 * state and the probe record the worker left, so a stall says where it stopped.
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
      const state = await bounded(reader.snapshot(), Math.max(deadline - now(), options.pollMs), options.timeoutMs);
      // Both snapshot builders list the five fields in the same order, so the key is stable.
      const key = JSON.stringify(state);
      if (key !== lastKey) options.onState?.(state);
      last = state;
      lastKey = key;
      if (state.active !== null) return state;
    } catch (error) {
      lastError = errorText(error);
    }
    if (now() >= deadline) throw new Error(await stallMessage(reader, last, lastError, options.timeoutMs));
    await sleep(options.pollMs);
  }
}

/** The reader over a live page. The probe record is read from Cache Storage, not asked of a worker. */
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
    probeRecord: () => page.evaluate(async () => {
      // The probe's names (vite.config.ts SW_EGRESS_PROBE_SOURCE).
      const CACHE = 'almamesh-egress-probe';
      const FETCHED = '/__egress-probe/';
      const EVENTS = '/__sw-event/';
      if (!(await caches.has(CACHE))) return null;
      const paths = (await (await caches.open(CACHE)).keys()).map((request) => new URL(request.url).pathname);
      const under = (prefix: string): string[] => paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
      return {
        fetched: under(FETCHED).map((name) => decodeURIComponent(name)),
        // Event keys are `<time>-<seq>-<instance>/<text>`; sorting the key orders them across worker instances.
        events: under(EVENTS).sort().map((key) => decodeURIComponent(key.slice(key.indexOf('/') + 1))),
      };
    }),
  };
}
