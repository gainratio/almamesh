import { useCallback, useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

import { healStrandedServiceWorker } from '../lib/swSelfHeal'
import { applyServiceWorkerUpdate, type UpdateStatus } from '../lib/swUpdate'

/**
 * Registers the PWA Service Worker and surfaces its update lifecycle.
 *
 * Update policy (matches the P6 cache-discipline spec):
 *   - `registerType: 'prompt'` — a new SW installs but WAITS. We never auto
 *     `skipWaiting` for a normal update; instead `needRefresh` flips true and
 *     the UI offers a reload (see {@link UpdateBanner}).
 *   - `update()` is the force path: it activates the waiting SW (skipWaiting)
 *     and reloads, so a security update can be pushed through immediately.
 *
 * `update()` deliberately does NOT use the updater `registerSW` returns. That
 * updater only messages a worker that is ALREADY waiting, so it is a no-op in
 * the common case where /version.json noticed the deploy before the browser
 * re-checked sw.js. {@link applyServiceWorkerUpdate} re-checks first — see the
 * bug write-up there. One update path, so the two triggers cannot diverge.
 *
 * Persistence: the sync Worker best-effort calls `navigator.storage.persist()`;
 * we ALSO request it from the main thread so OPFS/IndexedDB (the cached engine
 * data + saved charts) are not evicted under storage pressure.
 */
export function useServiceWorker() {
  const [needRefresh, setNeedRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  // Non-null once the user clicked: the banner stays up and reports progress
  // until the new worker takes over (see applyServiceWorkerUpdate).
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => false)

    // Self-heal a wedged session: an active SW whose app-shell precache is
    // missing/empty serves nothing for `navigateFallback`, so navigations hit a
    // Chrome error page. Detect + repair (unregister + reload once, engine caches
    // preserved) so a returning visitor is never stranded — no manual reset.
    void healStrandedServiceWorker()

    registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true)
      },
      onOfflineReady() {
        setOfflineReady(true)
      },
    })
  }, [])

  const update = useCallback(() => {
    setNeedRefresh(false)
    void applyServiceWorkerUpdate({ onStatus: setUpdateStatus })
  }, [])

  const dismiss = useCallback(() => {
    setNeedRefresh(false)
  }, [])

  return { needRefresh, offlineReady, updateStatus, update, dismiss }
}
