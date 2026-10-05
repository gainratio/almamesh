import { useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  portableStatePersistence,
  siteStorageBlocked,
  subscribePortableStatePersistence,
} from '@almamesh/store'

/**
 * AlmaMesh keeps durable product data in one OPFS SQLite database. Three
 * browser states need saying out loud rather than a page that can only hang:
 *
 * - all site storage refused (Safari "Block all cookies" throws SecurityError
 *   on every storage API): nothing can be saved, explain how to allow it;
 * - only OPFS refused (Safari Private Browsing, older iOS, some WebViews): the
 *   app runs on an in-memory SQLite database, so keep the page and say the
 *   data goes away on reload or when the tab closes, and where to export it.
 *   The engine's bundle cache is in-memory SQLite too (@gainratio/browser
 *   0.3.0), so the note also says a reload needs a connection to start again.
 *   Nothing falls back to IndexedDB or localStorage: SQLite is the only store;
 * - no on-device database can start at all: explain instead of hydrating forever.
 */
export function StorageGate({ children }: { children: ReactNode }) {
  const persistence = useSyncExternalStore(
    subscribePortableStatePersistence,
    portableStatePersistence,
    portableStatePersistence,
  )
  if (siteStorageBlocked()) return <StorageBlockedNotice reason="site-storage-blocked" />
  if (persistence === 'unavailable') return <StorageBlockedNotice reason="database-unavailable" />
  if (persistence === 'memory') {
    return (
      <>
        <EphemeralStorageNotice />
        {children}
      </>
    )
  }
  return <>{children}</>
}

type BlockedReason = 'site-storage-blocked' | 'database-unavailable'

const BLOCKED_COPY: Record<BlockedReason, { title: string; body: string; fix: string }> = {
  'site-storage-blocked': {
    title: 'storage_blocked.title',
    body: 'storage_blocked.body',
    fix: 'storage_blocked.fix',
  },
  'database-unavailable': {
    title: 'storage_unavailable.title',
    body: 'storage_unavailable.body',
    fix: 'storage_unavailable.fix',
  },
}

function StorageBlockedNotice({ reason }: { reason: BlockedReason }) {
  const { t } = useTranslation()
  const copy = BLOCKED_COPY[reason]
  return (
    <div className="flex items-center justify-center p-4 py-16">
      <div
        role="alert"
        data-testid="storage-blocked-notice"
        data-reason={reason}
        className="max-w-md w-full bg-background-secondary border border-ui-border rounded-xl shadow-lg p-6 text-center"
      >
        <h1 className="text-xl font-semibold text-text-primary mb-2">{t(copy.title)}</h1>
        <p className="text-text-secondary mb-4">{t(copy.body)}</p>
        <p className="text-text-secondary">{t(copy.fix)}</p>
      </div>
    </div>
  )
}

function EphemeralStorageNotice() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      data-testid="ephemeral-storage-notice"
      data-durability="memory"
      className="mx-4 mt-4 rounded-lg border border-ui-border bg-background-secondary px-4 py-3 text-sm text-text-secondary"
    >
      <strong className="text-text-primary">{t('storage_ephemeral.title')}</strong>{' '}
      {t('storage_ephemeral.body')}{' '}
      <Link to="/settings/data" className="underline text-text-primary">
        {t('storage_ephemeral.export')}
      </Link>{' '}
      {t('storage_ephemeral.engine')}
    </div>
  )
}
