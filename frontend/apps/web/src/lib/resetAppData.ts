/**
 * The bulletproof escape hatch for a stranded client: wipe every source of
 * stale state that can strand a returning visitor or a fail-closed engine boot —
 * a stale service worker, a stale precache, persisted stores written by an older
 * schema, and the synced signed bundle: the @gainratio/browser OPFS cache
 * (chunks, manifests, the durable active pointer) plus its IndexedDB rollback
 * floor. Everything else in the origin's OPFS (e.g. the chat-memory SQLite
 * file) is swept too, consistent with this reset deleting every IndexedDB
 * database and CacheStorage cache.
 *
 * SECURITY — why wiping the rollback floor here is sound: the durable active
 * pointer is an anti-rollback floor, so an origin that re-publishes at a lower
 * sequence (or a local dev re-sign) makes every boot fail closed with a
 * `RollbackError` until that floor is gone. An EXPLICIT user reset returns this
 * device to first-install trust: the next pointer is still verified against the
 * pinned ed25519 key, exactly as for a brand-new visitor — it just has no floor.
 * That is the same trust a new user has, and it takes a deliberate click. This
 * module must NEVER be invoked automatically in response to a `RollbackError`
 * (or any integrity failure): an auto-clear would let an attacker who can serve
 * an older signed bundle trigger the wipe and defeat rollback protection. The
 * automatic self-heal paths (`swSelfHeal.ts`, `lazyWithRetry`, chunk-error
 * recovery) deliberately do NOT touch OPFS and preserve the `*-immutable`
 * engine caches. When the failure IS a rollback refusal, every reset surface
 * wraps this in `RollbackResetGuard` (tampering warning + two-step confirm).
 *
 * Each cleanup path is isolated in its own try/catch so one failure (a blocked
 * unregister, a locked database) can never stop the others. This module is the
 * single source of truth for the reset — reused by both the global ErrorBoundary
 * and the onboarding error card so the two can never drift apart.
 *
 * Note: this only CLEARS state. Callers reload on success and show the
 * failure otherwise: a reload after an unconfirmed delete would look like a
 * finished reset while user data was still on the device.
 */

import { clearAlmaBundleCache } from '@almamesh/browser';
import { teardownLiveEngine } from './engineLifecycle';

/** Upper bound on each locked library clear attempt (a timeout is a failure). */
const BUNDLE_CLEAR_TIMEOUT_MS = 8_000;
/** Upper bound on each IndexedDB delete, so a blocked delete can't hang Reset. */
const IDB_DELETE_TIMEOUT_MS = 3_000;
/**
 * The service worker's cache-expiry bookkeeping (URLs and timestamps, no user
 * data). The worker that holds it open outlives its unregistration until the
 * page reloads, so its delete is attempted but never required.
 */
const NON_USER_DATABASE_PREFIX = 'workbox-';

/** Reset could not confirm that these databases were deleted; nothing was reloaded. */
export class ResetIncompleteError extends Error {
  public override readonly name = 'ResetIncompleteError';

  public constructor(public readonly databases: readonly string[]) {
    super(`Reset could not delete: ${databases.join(', ')}`);
  }
}

export async function resetAppData(): Promise<void> {
  // FIRST, while the service worker + caches can still serve the clear
  // Worker's script (offline included): tear down the live engine, then clear
  // the bundle cache + rollback floor under the library's Web Lock.
  await clearEngineBundleCache();
  await unregisterServiceWorkers();
  await clearCacheStorage();
  clearLocalStorage();
  await clearOpfs();
  // Last, after the engine Workers are gone and the floor database is closed,
  // so its delete is not blocked by an open connection. A user-data database
  // that is still there afterwards fails the reset visibly.
  const remaining = await clearIndexedDb();
  if (remaining.length > 0) throw new ResetIncompleteError(remaining);
}

/**
 * Clear ONLY the synced signed-bundle cache (OPFS primary + IndexedDB rollback
 * floor) through @gainratio/browser's own `EngineClient.clear()`, which runs
 * under the same Web Lock as sync, so it cannot race an in-flight boot. User
 * data (charts, profiles, chat) is untouched. Explicit user action only — see
 * the SECURITY note above.
 *
 * The live engine is torn down first so its sync Worker releases the lock and
 * its handles. A failed or timed-out attempt is a failure: tear down again and
 * retry exactly once. Never rejects; resolves true when the clear completed.
 */
export async function clearEngineBundleCache(): Promise<boolean> {
  await teardownLiveEngine();
  if (await attemptBundleClear()) {
    return true;
  }
  await teardownLiveEngine();
  return attemptBundleClear();
}

async function attemptBundleClear(): Promise<boolean> {
  try {
    await clearAlmaBundleCache({ timeoutMs: BUNDLE_CLEAR_TIMEOUT_MS });
    return true;
  } catch {
    // A sync Worker that cannot load (wedged session) or a lock that never
    // frees; resetAppData still sweeps OPFS and deletes IndexedDB after this.
    return false;
  }
}

interface OpfsRoot {
  keys(): AsyncIterable<string>;
  removeEntry(name: string, options: { recursive: boolean }): Promise<void>;
}

/**
 * Sweep every entry at the origin's OPFS root — the fallback that still clears
 * the bundle cache + durable active pointer when the library clear could not
 * run. Each removal is isolated: a file held open by a live worker must not stop
 * the rest.
 */
async function clearOpfs(): Promise<void> {
  try {
    const storage = navigator.storage as { getDirectory?: () => Promise<unknown> } | undefined;
    if (typeof storage?.getDirectory !== 'function') {
      return;
    }
    const root = (await storage.getDirectory()) as OpfsRoot;
    const names: string[] = [];
    for await (const name of root.keys()) {
      names.push(name);
    }
    await Promise.all(
      names.map((name) => root.removeEntry(name, { recursive: true }).catch(() => undefined)),
    );
  } catch {
    // Best-effort.
  }
}

async function unregisterServiceWorkers(): Promise<void> {
  try {
    const sw = navigator.serviceWorker;
    if (!sw?.getRegistrations) {
      return;
    }
    const registrations = await sw.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  } catch {
    // Best-effort: a blocked unregister must not stop the rest of the reset.
  }
}

async function clearCacheStorage(): Promise<void> {
  try {
    if (typeof caches === 'undefined') {
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // Best-effort.
  }
}

function clearLocalStorage(): void {
  try {
    localStorage.clear();
  } catch {
    // Best-effort.
  }
}

/** Delete every database; return the user-data ones not confirmed deleted. */
async function clearIndexedDb(): Promise<string[]> {
  let names: string[];
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
      return [];
    }
    names = (await indexedDB.databases()).flatMap(({ name }) => (name ? [name] : []));
  } catch {
    // Cannot enumerate: nothing to confirm (best-effort, as before).
    return [];
  }
  const outcomes = await Promise.all(names.map(async (name) => ({ name, deleted: await deleteDatabaseConfirmed(name) })));
  return outcomes
    .filter(({ name, deleted }) => !deleted && !name.startsWith(NON_USER_DATABASE_PREFIX))
    .map(({ name }) => name);
}

/**
 * Await one delete. `blocked` (an open connection) keeps waiting, bounded,
 * since the delete completes once the connection closes; every AlmaMesh
 * connection closes on versionchange (idbConnectionHygiene.ts). Resolves true
 * only on success. Never rejects.
 */
function deleteDatabaseConfirmed(name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), IDB_DELETE_TIMEOUT_MS);
    const done = (deleted: boolean): void => {
      clearTimeout(timer);
      resolve(deleted);
    };
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => done(true);
      request.onerror = () => done(false);
    } catch {
      done(false);
    }
  });
}
