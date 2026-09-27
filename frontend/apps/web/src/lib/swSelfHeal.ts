/**
 * Automatic recovery for a wedged service-worker session.
 *
 * The failure this heals (observed live on production): an active service worker
 * controls the page but its Workbox app-shell precache is missing/empty — so
 * `navigateFallback` has no shell to serve and client navigations intermittently
 * land on a Chrome error page. It can happen after a botched update, a mid-deploy
 * race, storage eviction, or a manual cache purge. A returning user must never be
 * stranded (CLAUDE.md engine-recovery invariant), so the app detects this at boot
 * and repairs itself with no user action.
 *
 * Repair strategy: unregister the SW (+ drop the stale, regenerable shell caches)
 * and reload once. This is fail-safe — even if the fresh precache later fails, the
 * page just falls back to the network (Cloudflare serves index.html 200), never a
 * dead end. It deliberately PRESERVES the immutable, content-addressed engine
 * caches (`*-immutable`) and OPFS, so healing never forces a ~38 MB re-download —
 * unlike the nuclear {@link resetAppData}.
 */

import { isChunkLoadError } from './chunkError';
import { safeWarn } from '@almamesh/shared-types';

/** One heal attempt per tab session, so a persistent fault can never loop-reload. */
const HEAL_KEY = 'almamesh:sw-precache-heal';
/** A restore owns the next reload; do not stack a SW-heal reload on top of it. */
const RESTORE_RELOAD_KEY = 'almamesh:restore-reload';

/** Separate one-shot budget for the global chunk-error recovery path. */
const CHUNK_HEAL_KEY = 'almamesh:chunk-reload:global';

function healAlreadyAttempted(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function markHealAttempted(key: string): void {
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // Best-effort: private-mode sessionStorage can throw; a missing guard only
    // risks one extra reload, never data loss.
  }
}

/**
 * Mark the next page boot as an intentional data-restore reload. The restore
 * commit is already fenced and durable; a concurrent SW self-heal reload would
 * race the fresh realm's hydration and can overwrite the restored snapshot with
 * its empty initial Zustand state.
 */
export function suppressNextServiceWorkerHeal(): void {
  try {
    sessionStorage.setItem(RESTORE_RELOAD_KEY, '1');
  } catch {
    // Best-effort: a blocked sessionStorage only loses this race protection.
  }
}

function consumeRestoreReloadMarker(): boolean {
  try {
    if (sessionStorage.getItem(RESTORE_RELOAD_KEY) !== '1') return false;
    sessionStorage.removeItem(RESTORE_RELOAD_KEY);
    return true;
  } catch {
    return false;
  }
}

async function unregisterAllServiceWorkers(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
}

/**
 * Delete the mutable / app-shell caches (Workbox precache + the NetworkFirst
 * pointer caches) while PRESERVING the immutable engine caches (`*-immutable`) and
 * OPFS. Regenerable-only wipe.
 */
async function clearShellCaches(): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => !k.endsWith('-immutable')).map((k) => caches.delete(k)));
}

/** True when a Workbox precache exists AND holds the navigation shell document. */
async function hasHealthyPrecache(): Promise<boolean> {
  const keys = await caches.keys();
  const precacheName = keys.find((k) => /precache/i.test(k));
  if (!precacheName) {
    return false;
  }
  const cache = await caches.open(precacheName);
  const requests = await cache.keys();
  return requests.some((req) => {
    const pathname = new URL(req.url).pathname;
    return pathname === '/' || /index\.html$/.test(pathname);
  });
}

// WebKit can expose an empty CacheStorage view for more than one browser task
// while a newly controlling service worker settles. Destructive recovery must
// therefore survive a short, bounded observation window rather than two
// back-to-back reads.
const PRECACHE_RECHECK_DELAYS_MS = [0, 100, 500] as const;

/** Require sustained absence before destructive recovery. */
async function isPrecacheStablyMissing(): Promise<boolean> {
  if (await hasHealthyPrecache()) return false;
  for (const delay of PRECACHE_RECHECK_DELAYS_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (await hasHealthyPrecache()) return false;
  }
  return true;
}

/**
 * A controller can briefly outlive the registration view in WebKit. Healing in
 * that window would turn a transient browser state into a real offline outage.
 */
async function hasVisibleActiveRegistration(): Promise<boolean> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.active?.state === 'activated';
}

/**
 * Detect and repair the "controlled by a SW but the app-shell precache is
 * missing" wedge. No-op when the page is uncontrolled or the precache is healthy.
 * Loop-guarded to reload at most once per session; if still broken afterward the
 * user reaches the visible ErrorBoundary recovery card. Never throws.
 */
async function performServiceWorkerHeal(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || typeof caches === 'undefined') {
      return;
    }
    // Consume this marker even when the new page is not yet controlled (the
    // normal first boot after registration). Otherwise it would leak into a
    // later unrelated boot and suppress a legitimate heal.
    if (consumeRestoreReloadMarker()) {
      return;
    }
    // Not controlled → the SW can't be the thing breaking navigations.
    if (!navigator.serviceWorker.controller) {
      return;
    }
    if (healAlreadyAttempted(HEAL_KEY)) {
      return;
    }
    if (!(await isPrecacheStablyMissing())) {
      return;
    }
    if (!(await hasVisibleActiveRegistration())) {
      return;
    }
    markHealAttempted(HEAL_KEY);
    await unregisterAllServiceWorkers();
    await clearShellCaches();
    window.location.reload();
  } catch (err) {
    // Best-effort: a heal that itself fails must never crash the boot path.
    // Surface it on-device (this app is zero-egress — no telemetry backend), so
    // a regressed heal is visible in the console instead of silently swallowed.
    safeWarn('sw.heal_failed', err);
  }
}

let serviceWorkerHealInFlight: Promise<void> | null = null;

export function healStrandedServiceWorker(): Promise<void> {
  if (serviceWorkerHealInFlight !== null) {
    return serviceWorkerHealInFlight;
  }
  serviceWorkerHealInFlight = performServiceWorkerHeal().finally(() => {
    serviceWorkerHealInFlight = null;
  });
  return serviceWorkerHealInFlight;
}

/** One non-destructive channel-recovery reload per tab session. */
const CHANNEL_RELOAD_KEY = 'almamesh:sw-channel-reload';

/** True when the controller can no longer serve even the precached shell. */
async function isControllerChannelSevered(): Promise<boolean> {
  try {
    await fetch('/', { cache: 'no-store' });
    return false;
  } catch {
    return true;
  }
}

/**
 * Re-attach a document whose service-worker channel was severed. When WebKit
 * restarts its network process (iOS memory pressure, a loaded CI runner) the
 * registration and caches survive, but the already-loaded document's
 * controlled fetches all reject, including the precached shell, so an engine
 * boot in flight fails forever in that document. The shell being in cache
 * while a controlled fetch for it fails is that signature; a real outage still
 * gets the cached shell. A fresh navigation re-attaches the page to its
 * worker. Nothing is unregistered or deleted. Loop-guarded to one reload per
 * session. Resolves true when a reload was started; never throws.
 */
export async function recoverSeveredServiceWorkerChannel(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator) || typeof caches === 'undefined') return false;
    if (!navigator.serviceWorker.controller) return false;
    if (healAlreadyAttempted(CHANNEL_RELOAD_KEY)) return false;
    if (!(await hasHealthyPrecache())) return false;
    if (!(await isControllerChannelSevered())) return false;
    markHealAttempted(CHANNEL_RELOAD_KEY);
    window.location.reload();
    return true;
  } catch (err) {
    safeWarn('sw.heal_failed', err);
    return false;
  }
}

/**
 * Deliberate "swap the stale shell and reload" — used when a code-split chunk
 * fails to load (a stale precache served an old/missing chunk). Unregisters the
 * SW and drops the shell caches (engine caches preserved), then reloads to pull
 * the fresh index.html + hashed chunk graph. Caller owns loop-guarding for
 * automatic triggers; the visible recovery button is user-initiated.
 */
export async function reloadForUpdate(): Promise<void> {
  try {
    await unregisterAllServiceWorkers();
    await clearShellCaches();
  } catch (err) {
    // Best-effort — reload regardless so the user is never stuck. Surface the
    // failure on-device (zero-egress app, no telemetry) rather than swallow it.
    safeWarn('sw.shell_cleanup_failed', err);
  } finally {
    window.location.reload();
  }
}

/**
 * Catch code-split import failures that never reach {@link lazyWithRetry} — a
 * dynamic `import()` inside an already-loaded page (R3F scenes, the PDF renderer)
 * whose chunk went stale. Vite fires `vite:preloadError` for a failed module
 * preload; we also watch `unhandledrejection`. On a genuine chunk error we
 * swap the stale shell and reload ONCE per session (guarded), then fall through
 * to the ErrorBoundary if it still fails. Idempotent-safe: install once at boot.
 */
export function installChunkErrorRecovery(target: Window = window): void {
  const recover = (reason: unknown, preventDefault?: () => void): void => {
    if (!isChunkLoadError(reason)) {
      return;
    }
    if (healAlreadyAttempted(CHUNK_HEAL_KEY)) {
      return;
    }
    preventDefault?.();
    markHealAttempted(CHUNK_HEAL_KEY);
    void reloadForUpdate();
  };

  target.addEventListener('vite:preloadError', (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    recover(payload ?? new Error('vite:preloadError'), () => event.preventDefault());
  });
  target.addEventListener('unhandledrejection', (event) => {
    recover((event as PromiseRejectionEvent).reason);
  });
}
