/**
 * Where canonical SQLite state lives this session, and a time bound on every
 * step of getting there.
 *
 * AlmaMesh keeps one SQLite database in the Origin Private File System. Some
 * browsers expose `navigator.storage.getDirectory` but refuse it: Safari
 * Private Browsing, older iOS, some embedded WebViews, and every throwaway
 * Playwright WebKit context reject with `UnknownError`. The SQLite Worker then
 * failed to open, zustand persist never finished hydrating, and the dashboard
 * waited on "Loading Your Chart" forever with no error.
 *
 * When OPFS is refused, the same EdgeProc SQLite store runs in memory instead:
 * the app works, nothing persists past the tab, and the UI says so and points
 * at export. Memory use is bounded by the canonical row cap (1,000 JSON rows of
 * this session's data, typically a few hundred KB), not by anything on disk.
 */

import { safeError, safeWarn } from '@almamesh/shared-types';

/** OPFS normally answers in milliseconds; a probe slower than this is treated as refused. */
export const OPFS_PROBE_TIMEOUT_MS = 5_000;
/** Opening SQLite includes loading its wasm; generous for low-end phones, still finite. */
export const PORTABLE_STATE_OPEN_TIMEOUT_MS = 30_000;

export type OpfsProbe =
  | { readonly status: 'available' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'timed-out' };

export type PortablePersistence = 'opfs' | 'memory';
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

export function selectPortablePersistence(probe: OpfsProbe): PortablePersistence {
  return probe.status === 'available' ? 'opfs' : 'memory';
}

let currentPersistence: PortableStatePersistence = 'pending';
const listeners = new Set<() => void>();

function reportPersistence(next: PortableStatePersistence): void {
  currentPersistence = next;
  for (const listener of listeners) listener();
}

/** 'memory' means this session's data disappears when the tab closes. */
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
}

const OPEN_STEP: Record<PortablePersistence, string> = {
  opfs: 'open the on-device state database',
  memory: 'open the in-memory state database',
};

/** Pick OPFS or memory from a real probe, open within a bound, and publish the outcome. */
export async function openPortableStateWithFallback<Repository>(options: {
  readonly open: (persistence: PortablePersistence) => Promise<Repository>;
  readonly storage?: OpfsEntrypoint;
}): Promise<{ readonly repository: Repository; readonly persistence: PortablePersistence }> {
  const probe = await probeOpfs(options.storage);
  const persistence = selectPortablePersistence(probe);
  // Code-only diagnostic: the browser's refusal text never reaches the console.
  if (probe.status !== 'available') safeWarn('storage.opfs_unavailable', probe);
  try {
    const repository = await withStartupTimeout(
      options.open(persistence),
      PORTABLE_STATE_OPEN_TIMEOUT_MS,
      OPEN_STEP[persistence],
    );
    reportPersistence(persistence);
    return { repository, persistence };
  } catch (error) {
    safeError('storage.state_open_failed', error);
    reportPersistence('unavailable');
    throw error;
  }
}

interface LegacyRows {
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/** An in-memory session may read pre-SQLite IndexedDB rows but must never delete the only copy. */
export function nonDestructiveLegacyStorage(legacy: LegacyRows): LegacyRows {
  return { get: (key) => legacy.get(key), delete: async () => undefined };
}
