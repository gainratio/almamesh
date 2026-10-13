/**
 * Where canonical SQLite state lives, and what happens when it cannot live there.
 *
 * AlmaMesh keeps one SQLite database in the Origin Private File System. SQLite
 * is the only store; never IndexedDB or localStorage.
 *
 * - OPFS works: durable SQLite on OPFS ('opfs').
 * - OPFS refused while site storage works (Safari Private Browsing, older iOS,
 *   some WebViews, every throwaway Playwright WebKit context): SQLite runs in
 *   memory for this tab ('memory') and the UI says plainly that nothing is
 *   saved after the tab closes (product rule 2026-10-11; from 2026-10-05 to
 *   2026-10-12 this showed a block screen instead).
 * - Site storage blocked ("Block all cookies") or a probe that never answers:
 *   'blocked'. The UI shows the block screen and every hydration keeps waiting
 *   on the same pending open. `checkPortableStorageAgain()` re-runs the exact
 *   probe; once storage is allowed it opens SQLite on OPFS and that pending
 *   open resolves, so waiting stores finish hydrating with no reload.
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

/** What a probe allows: durable OPFS SQLite, SQLite in memory for this tab, or nothing yet. */
export type PortablePersistence = 'opfs' | 'memory' | 'blocked';
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

/** OPFS when it works; a refusal runs in memory; an unanswered probe blocks (recheckable). */
export function selectPortablePersistence(probe: OpfsProbe): PortablePersistence {
  if (probe.status === 'available') return 'opfs';
  return probe.status === 'refused' ? 'memory' : 'blocked';
}

let currentPersistence: PortableStatePersistence = 'pending';
const listeners = new Set<() => void>();
/** The blocked open waiting for storage, re-run by checkPortableStorageAgain(). */
let pendingAttempt: (() => Promise<PortableStatePersistence>) | undefined;

function reportPersistence(next: PortableStatePersistence): void {
  currentPersistence = next;
  for (const listener of listeners) listener();
}

/** 'memory': nothing survives this tab. 'blocked': the app is waiting for the user to allow storage. */
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

/**
 * The app's SQLite is open, but the engine's own cache was refused (the
 * library's cacheFallback "none", reason "opfs-unavailable"). Show the same
 * block screen; "Check again" re-probes OPFS and, once allowed, reports
 * 'opfs' again so the engine can retry. The repository is already open, so
 * there is nothing to re-open here.
 */
export function markPortableStorageBlockedByEngine(options: { readonly storage?: OpfsEntrypoint } = {}): void {
  pendingAttempt = async () => {
    if ((await probePersistence(options)) !== 'opfs') return 'blocked';
    pendingAttempt = undefined;
    reportPersistence('opfs');
    return 'opfs';
  };
  reportPersistence('blocked');
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
  /** The same store with `persistence: 'memory'`, used only when OPFS is refused. */
  readonly openInMemory: () => Promise<Repository>;
  readonly storage?: OpfsEntrypoint;
  /** Fast early check; defaults to whether the browser throws on site storage. */
  readonly storageBlocked?: () => boolean;
}

async function probePersistence(
  options: Pick<WhenAllowedOptions<unknown>, 'storage' | 'storageBlocked'>,
): Promise<PortablePersistence> {
  if ((options.storageBlocked ?? siteStorageBlocked)()) {
    safeWarn('storage.opfs_unavailable', 'site storage blocked');
    return 'blocked';
  }
  const probe = await probeOpfs(options.storage);
  // Code-only diagnostic: the browser's refusal text never reaches the console.
  if (probe.status !== 'available') safeWarn('storage.opfs_unavailable', probe);
  return selectPortablePersistence(probe);
}

/**
 * Open durable OPFS SQLite once storage is allowed. OPFS refused: open the
 * in-memory store and report 'memory'. Site storage blocked or no answer:
 * report 'blocked' and keep this promise pending (never a throw) until a
 * recheck succeeds. A real open failure rejects as 'unavailable'.
 */
export function openPortableStateWhenAllowed<Repository>(
  options: WhenAllowedOptions<Repository>,
): Promise<Repository> {
  return new Promise<Repository>((resolve, reject) => {
    let inFlight: Promise<PortableStatePersistence> | undefined;
    const run = async (): Promise<PortableStatePersistence> => {
      const persistence = await probePersistence(options);
      if (persistence === 'blocked') {
        reportPersistence('blocked');
        return 'blocked';
      }
      try {
        resolve(await (persistence === 'opfs' ? options.open() : options.openInMemory()));
        pendingAttempt = undefined;
        reportPersistence(persistence);
        return persistence;
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
