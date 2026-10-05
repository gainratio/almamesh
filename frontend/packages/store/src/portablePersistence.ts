/**
 * Where canonical SQLite state lives, and what happens when it cannot live there.
 *
 * AlmaMesh keeps one SQLite database in the Origin Private File System. Product
 * rule (2026-10-05): durable SQLite on OPFS is the only option. Some browsers
 * expose `navigator.storage.getDirectory` but refuse it (Safari Private
 * Browsing, "Block all cookies", older iOS, some embedded WebViews); a probe
 * may also never answer. Either way the app does NOT fall back to SQLite in
 * memory, and never to IndexedDB or localStorage: it reports 'blocked', the UI
 * shows a block screen, and every hydration keeps waiting on the same pending
 * open. `checkPortableStorageAgain()` re-runs the exact probe; once storage is
 * allowed it opens SQLite on OPFS and that pending open resolves, so waiting
 * stores simply finish hydrating with no reload.
 *
 * The probe is bounded; the open itself is not. On slow 4G the SQLite Worker's
 * wasm download alone can take minutes, and a fixed budget turned that success
 * into "database unavailable". The Worker reports its own failures (a rejected
 * open, or a crashed Worker), and those fail closed as 'unavailable'.
 */

import { safeError, safeWarn } from '@almamesh/shared-types';

import { siteStorageBlocked } from './webStorage';

/** OPFS normally answers in milliseconds; past this the probe counts as blocked (recheckable). */
export const OPFS_PROBE_TIMEOUT_MS = 5_000;

export type OpfsProbe =
  | { readonly status: 'available' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'timed-out' };

/** What a probe allows: durable OPFS SQLite, or nothing until the user allows storage. */
export type PortablePersistence = 'opfs' | 'blocked';
export type PortableStatePersistence = 'pending' | PortablePersistence | 'unavailable';

interface OpfsEntrypoint {
  readonly getDirectory?: () => Promise<unknown>;
}

export class PortableStateStartupError extends Error {
  public override readonly name = 'PortableStateStartupError';

  public constructor(step: string, milliseconds: number) {
    super(`AlmaMesh startup step "${step}" did not finish within ${milliseconds} ms.`);
  }
}

/** Reject with an error naming the step, instead of waiting forever. */
export function withStartupTimeout<T>(promise: Promise<T>, milliseconds: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PortableStateStartupError(step, milliseconds)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeRefusal(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Ask the browser for the OPFS root once, bounded. Never throws. */
export async function probeOpfs(
  storage: OpfsEntrypoint | undefined = (globalThis as { navigator?: { storage?: OpfsEntrypoint } })
    .navigator?.storage,
  milliseconds = OPFS_PROBE_TIMEOUT_MS,
): Promise<OpfsProbe> {
  if (typeof storage?.getDirectory !== 'function') {
    return { status: 'refused', reason: 'navigator.storage.getDirectory is unavailable' };
  }
  try {
    await withStartupTimeout(Promise.resolve().then(() => storage.getDirectory!()), milliseconds, 'probe OPFS');
    return { status: 'available' };
  } catch (error) {
    if (error instanceof PortableStateStartupError) return { status: 'timed-out' };
    return { status: 'refused', reason: describeRefusal(error) };
  }
}

/** OPFS or nothing: a refused or unanswered probe blocks; there is no in-memory fallback. */
export function selectPortablePersistence(probe: OpfsProbe): PortablePersistence {
  return probe.status === 'available' ? 'opfs' : 'blocked';
}

let currentPersistence: PortableStatePersistence = 'pending';
const listeners = new Set<() => void>();
/** The blocked open waiting for storage, re-run by checkPortableStorageAgain(). */
let pendingAttempt: (() => Promise<PortableStatePersistence>) | undefined;

function reportPersistence(next: PortableStatePersistence): void {
  currentPersistence = next;
  for (const listener of listeners) listener();
}

/** 'blocked' means the browser refuses durable storage and the app is waiting for the user. */
export function portableStatePersistence(): PortableStatePersistence {
  return currentPersistence;
}

export function subscribePortableStatePersistence(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The runtime cannot host SQLite at all (no Worker, no isolation): say so instead of hydrating forever. */
export function markPortableStateUnavailable(): void {
  reportPersistence('unavailable');
}

export function resetPortableStatePersistenceForTests(): void {
  currentPersistence = 'pending';
  listeners.clear();
  pendingAttempt = undefined;
}

/**
 * Re-run the exact OPFS probe (and the site-storage check) without a reload.
 * When storage is now allowed, SQLite opens on OPFS and the pending open that
 * hydration is waiting on resolves. Nothing waiting: report the current state.
 */
export function checkPortableStorageAgain(): Promise<PortableStatePersistence> {
  return pendingAttempt?.() ?? Promise.resolve(currentPersistence);
}

interface WhenAllowedOptions<Repository> {
  readonly open: () => Promise<Repository>;
  readonly storage?: OpfsEntrypoint;
  /** Fast early check; defaults to whether the browser throws on site storage. */
  readonly storageBlocked?: () => boolean;
}

async function probeAllows(options: WhenAllowedOptions<unknown>): Promise<boolean> {
  if ((options.storageBlocked ?? siteStorageBlocked)()) {
    safeWarn('storage.opfs_unavailable', 'site storage blocked');
    return false;
  }
  const probe = await probeOpfs(options.storage);
  // Code-only diagnostic: the browser's refusal text never reaches the console.
  if (probe.status !== 'available') safeWarn('storage.opfs_unavailable', probe);
  return selectPortablePersistence(probe) === 'opfs';
}

/**
 * Open durable OPFS SQLite once storage is allowed. Refused or unanswered:
 * report 'blocked' and keep this promise pending (never a RAM repository, never
 * a throw) until a recheck succeeds. A real open failure rejects as 'unavailable'.
 */
export function openPortableStateWhenAllowed<Repository>(
  options: WhenAllowedOptions<Repository>,
): Promise<Repository> {
  return new Promise<Repository>((resolve, reject) => {
    let inFlight: Promise<PortableStatePersistence> | undefined;
    const run = async (): Promise<PortableStatePersistence> => {
      if (!(await probeAllows(options))) {
        reportPersistence('blocked');
        return 'blocked';
      }
      try {
        resolve(await options.open());
        pendingAttempt = undefined;
        reportPersistence('opfs');
        return 'opfs';
      } catch (error) {
        safeError('storage.state_open_failed', error);
        pendingAttempt = undefined;
        reportPersistence('unavailable');
        reject(error);
        return 'unavailable';
      }
    };
    // Single flight: concurrent rechecks share one probe and at most one open.
    const attempt = (): Promise<PortableStatePersistence> => {
      inFlight ??= run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    pendingAttempt = attempt;
    void attempt();
  });
}
