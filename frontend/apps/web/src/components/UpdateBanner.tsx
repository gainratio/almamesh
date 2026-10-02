import { useTranslation } from 'react-i18next'
import { useServiceWorker } from '../hooks/useServiceWorker'
import { useVersionCheck } from '../hooks/useVersionCheck'
import { reloadPage, type UpdateStatus } from '../lib/swUpdate'

/**
 * Banner shown when a new version of the app is available.
 *
 * Two signals, one prompt:
 *   - `/version.json` changed (polled by {@link useVersionCheck}) — in practice
 *     the ONLY trigger that fires for a returning visitor;
 *   - the Service Worker has a freshly precached shell waiting (`needRefresh`).
 *     This was assumed to be the authoritative trigger, and is not: Chromium
 *     does not re-check sw.js on these navigations, so nothing ever reaches
 *     `waiting` on its own. Measured, see lib/swUpdate.ts.
 *
 * BOTH triggers must therefore take the SAME action, and that action has to
 * re-check for a new worker itself. They used to differ: a banner raised by the
 * poller ran a bare `window.location.reload()`, which cannot activate a waiting
 * worker — so the reload landed on the same stale build, forever. Since the
 * poller was the only trigger that ever fired, there was no working path at all.
 *
 * After the click the banner stays up and reports what the update is doing.
 * Activation can wait up to five minutes for the previous service worker to
 * finish an engine download (see lib/swUpdate.ts); a banner that vanished
 * there, or a reload that landed on the old build, read as a failed update.
 * "Reload now" is always offered while we wait, so the click is never a trap.
 *
 * The cached engine data in OPFS is untouched by an update.
 */

// z-[60] on purpose. The app chrome — LandingNav's `sticky top-0 z-50` header,
// dialogs, the chat panel — all sit at z-50 and come LATER in the DOM, so an
// equal z-index loses the tie and paints over this banner: on the landing route
// it was invisible AND unclickable, which is why "clicking the banner did
// nothing". A prompt nobody can reach is not a prompt. Keep new chrome below 60.
const BANNER_CLASS =
  'fixed top-0 left-0 right-0 z-[60] bg-accent-gold text-background-primary ' +
  'px-4 py-2 flex items-center justify-center gap-4 animate-fade-in'

const BUTTON_CLASS =
  'px-3 py-1 bg-background-primary text-accent-gold rounded-md text-sm font-semibold ' +
  'hover:bg-background-secondary transition-colors'

const STATUS_KEY: Record<UpdateStatus, string> = {
  activating: 'update.activating',
  'finishing-previous': 'update.finishing_previous',
  stalled: 'update.stalled',
}

/** The banner after the click: what the update is doing, plus the escape hatch. */
function UpdateProgress({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation()
  return (
    <div role="status" aria-live="polite" className={BANNER_CLASS}>
      <span className="text-sm font-medium">{t(STATUS_KEY[status])}</span>
      <button onClick={reloadPage} className={BUTTON_CLASS}>
        {t('update.reload_now')}
      </button>
    </div>
  )
}

export function UpdateBanner() {
  const { t } = useTranslation()
  const { needRefresh, updateStatus, update, dismiss: dismissSw } = useServiceWorker()
  const { hasNewVersion, dismissUpdate: dismissVersion } = useVersionCheck({
    pollInterval: 5 * 60 * 1000,
    checkOnFocus: true,
  })

  if (updateStatus) {
    return <UpdateProgress status={updateStatus} />
  }

  const show = needRefresh || hasNewVersion
  if (!show) {
    return null
  }

  // One action, whichever signal raised the banner. `update()` re-checks for a
  // new worker, activates it, and reloads — a plain reload cannot do any of it.
  const reload = () => {
    dismissVersion()
    update()
  }

  const dismiss = () => {
    dismissSw()
    dismissVersion()
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={BANNER_CLASS}
    >
      <span className="text-sm font-medium">{t('update.available')}</span>
      <button
        onClick={reload}
        className={BUTTON_CLASS}
      >
        {t('update.reload_cta')}
      </button>
      <button
        onClick={dismiss}
        className="text-background-primary/70 hover:text-background-primary transition-colors"
        aria-label={t('update.dismiss_aria')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  )
}
