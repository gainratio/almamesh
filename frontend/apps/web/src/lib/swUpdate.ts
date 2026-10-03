/**
 * Applying a pending app update — the ONE path "Reload to update" takes.
 *
 * The bug this exists to fix (observed live on almamesh.com, 2026-08-01):
 * `build.json` served the new git SHA while returning visitors kept executing
 * the OLD chunks out of the Workbox precache, with the new service worker stuck
 * in `waiting`. The banner was on screen and clicking it did nothing.
 *
 * Why it did nothing: the banner has TWO triggers — the Workbox `waiting` event
 * and the /version.json poller — but only the first one reached a skipWaiting
 * path. A banner raised by the poller ran a bare `window.location.reload()`,
 * and a reload CANNOT activate a waiting worker: the old worker still controls
 * the page and still serves its old precached shell, so the reload lands on the
 * same stale build. Forever.
 *
 * The three steps that make the click always work:
 *
 *   1. `registration.update()` — re-check sw.js NOW. This step carries the fix.
 *      Measured in Chromium against two real builds of this app: after a deploy,
 *      a plain navigation leaves `registration.waiting` null indefinitely (still
 *      null after 20s and repeated reloads), while an explicit
 *      `registration.update()` produces a waiting worker in about one second.
 *      So Workbox's `waiting` event — the thing that sets `needRefresh` — never
 *      fires for a returning visitor here, which is why the poller was in
 *      practice the ONLY trigger that ever raised the banner, and why the branch
 *      it took being a no-op meant there was no working update path at all.
 *   2. postMessage SKIP_WAITING to `registration.waiting` — the NEW worker.
 *      Posting to `navigator.serviceWorker.controller` (the OLD, active worker)
 *      is a no-op, and was the second half of the same defect.
 *   3. reload on `controllerchange`, once the new worker takes over.
 *
 * Three invariants worth stating because they are easy to break later:
 *
 *   - The click NEVER silently lands on the old build. Chromium promotes a
 *     worker that called skipWaiting() only once the ACTIVE worker has no work
 *     in flight (`ServiceWorkerRegistration::IsReadyToActivate`), and a Workbox
 *     CacheFirst fetch of the ~68 MB engine keeps it busy until the body is in
 *     the cache, for up to five minutes (`kMaxLameDuckTime`). A reload before
 *     then is served by the OLD worker. So we wait for `controllerchange`, the
 *     one reliable signal, and report status instead of reloading on a timer.
 *     This used to reload after a fixed 10 s, which on a slow link put the
 *     user straight back on the old build looking at a "failed" update.
 *   - The click is never a dead button. The banner always offers "Reload now"
 *     while we wait, and at ACTIVATION_CAP_MS we report `stalled` so the UI
 *     can say plainly that the update did not finish.
 *   - The `controllerchange` listener is per click, NOT global at boot. A new
 *     worker takes over every open tab; reloading tabs whose user did not ask
 *     for it would throw away whatever they were doing.
 *
 * Aborting the old worker's in-flight engine download on SKIP_WAITING is not
 * possible from here: that worker is the PREVIOUS deploy's code, and Workbox's
 * CacheFirst strategy exposes no abort for a fetch it is writing to the cache.
 *
 * This does NOT change `registerType: 'prompt'` semantics. Nothing activates
 * without a user click; we only make the click do what it always claimed to.
 */

import { safeWarn } from '@almamesh/shared-types';

/** The message the generated Workbox service worker listens for. */
const SKIP_WAITING_MESSAGE = { type: 'SKIP_WAITING' } as const;

/**
 * How long the click may plausibly take on its own (update check, install,
 * activation from an idle worker) before we tell the user we are waiting on
 * the previous worker's download.
 */
const FINISHING_PREVIOUS_AFTER_MS = 3_000;

/**
 * Chromium's lame-duck limit is five minutes; past it the old worker is
 * dropped and the new one activates anyway. A little slack on top, then we
 * stop pretending and say the update did not finish.
 */
const ACTIVATION_CAP_MS = 5 * 60_000 + 15_000;

/** What the click is doing, for the banner. */
export type UpdateStatus = 'activating' | 'finishing-previous' | 'stalled';

export interface ServiceWorkerUpdateOptions {
  /** Injected by tests; defaults to a real page reload. */
  reload?: () => void;
  /** Told each time the status changes while we wait for the new worker. */
  onStatus?: (status: UpdateStatus) => void;
}

/**
 * Reload once, on `controllerchange` or on demand. Status timers run alongside;
 * the listener stays armed past the cap, since a late takeover is still the
 * update the user asked for.
 */
function armReload(reload: () => void, onStatus: (status: UpdateStatus) => void): { now: () => void } {
  let fired = false;
  const timers = [
    setTimeout(() => onStatus('finishing-previous'), FINISHING_PREVIOUS_AFTER_MS),
    setTimeout(() => onStatus('stalled'), ACTIVATION_CAP_MS),
  ];
  const fire = () => {
    if (fired) return;
    fired = true;
    timers.forEach(clearTimeout);
    navigator.serviceWorker.removeEventListener('controllerchange', fire);
    reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', fire);
  onStatus('activating');
  return { now: fire };
}

/** The manual escape hatch: a plain reload, whatever build it lands on. */
export function reloadPage(): void {
  window.location.reload();
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch (err) {
    safeWarn('sw.get_registration_failed', err);
    return null;
  }
}

/** Resolve once an installing worker has left the `installing` state. */
function settled(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    const onChange = () => {
      if (worker.state === 'installing') return;
      worker.removeEventListener('statechange', onChange);
      resolve();
    };
    worker.addEventListener('statechange', onChange);
    onChange();
  });
}

/**
 * The worker to activate. Asks the browser to re-check sw.js first: the banner
 * may have been raised by the version poller, before the browser ever looked.
 */
async function waitingWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (reg.waiting) {
    return reg.waiting;
  }
  try {
    await reg.update();
  } catch (err) {
    safeWarn('sw.update_check_failed', err);
  }
  if (reg.installing) {
    await settled(reg.installing);
  }
  return reg.waiting ?? null;
}

/**
 * Activate the waiting service worker, then reload onto the new build once it
 * has taken control. Never rejects.
 */
export async function applyServiceWorkerUpdate(
  options: ServiceWorkerUpdateOptions = {},
): Promise<void> {
  const reload = options.reload ?? reloadPage;
  const registration = await currentRegistration();
  if (!registration) {
    reload();
    return;
  }
  // Armed BEFORE we touch the worker, so a hung update check still reports.
  const reloader = armReload(reload, options.onStatus ?? (() => undefined));
  const waiting = await waitingWorker(registration);
  if (!waiting) {
    reloader.now();
    return;
  }
  waiting.postMessage(SKIP_WAITING_MESSAGE);
}
