import { lazy, type ComponentType } from 'react';

import { isChunkLoadError } from './chunkError';
import { isDocumentLeaving, LEAVING_WINDOW_MS } from './documentLeaving';

/**
 * `React.lazy` hardened against a failed code-split `import()` — the symptom of a
 * stale/poisoned service-worker cache after a deploy (a lazy chunk resolves to
 * HTML or 404s). Two lines of defense:
 *   1. Retry the import once — clears a transient network / SW-takeover race.
 *   2. If a genuine chunk error survives, reload ONCE (guarded per chunk name) to
 *      pull the fresh index.html + hashed chunk graph. The returned promise is
 *      left pending so Suspense holds its fallback through the reload instead of
 *      flashing an error.
 * Anything else (a real runtime error in the module) is rethrown to the
 * ErrorBoundary unchanged.
 */

/** One reload per chunk per session — a persistent fault can't loop-reload. */
function reloadKey(name: string): string {
  return `almamesh:chunk-reload:${name}`;
}

function alreadyReloaded(name: string): boolean {
  try {
    return sessionStorage.getItem(reloadKey(name)) === '1';
  } catch {
    return false;
  }
}

function markReloaded(name: string): void {
  try {
    sessionStorage.setItem(reloadKey(name), '1');
  } catch {
    // Best-effort; a missing flag only risks one extra reload.
  }
}

/**
 * The visitor's navigation cancelled this chunk (WebKit cancels the outgoing
 * page's loads at navigation start). Never reload: that would replace their
 * navigation. Hold Suspense until the new page replaces this one; if this page
 * is somehow still here after the window, surface the error to the boundary.
 */
function holdWhileLeaving(error: unknown): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(error), LEAVING_WINDOW_MS);
  });
}

export async function loadWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
  name: string,
): Promise<{ default: T }> {
  try {
    return await factory();
  } catch {
    // First failure: retry once (transient network / SW-takeover race).
    try {
      return await factory();
    } catch (retryError) {
      if (isChunkLoadError(retryError) && isDocumentLeaving()) {
        return holdWhileLeaving(retryError);
      }
      if (isChunkLoadError(retryError) && !alreadyReloaded(name)) {
        markReloaded(name);
        window.location.reload();
        // Hold Suspense through the reload — never resolve or reject.
        return new Promise<never>(() => {});
      }
      throw retryError;
    }
  }
}

export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
  name: string,
) {
  return lazy(() => loadWithRetry(factory, name));
}
