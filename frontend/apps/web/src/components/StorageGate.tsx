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
 *   app runs on an in-memory database. When IndexedDB works it keeps a copy
 *   there, so a reload keeps the chart but the browser may erase it with the
 *   window; otherwise the data goes with the next reload. Either way say so,
 *   and where to export it;
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
  if (persistence === 'memory' || persistence === 'session-mirror') {
    return (
      <>
        <EphemeralStorageNotice durability={persistence} />
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

const EPHEMERAL_COPY: Record<'memory' | 'session-mirror', { title: string; body: string }> = {
  memory: { title: 'storage_ephemeral.title', body: 'storage_ephemeral.body' },
  'session-mirror': {
    title: 'storage_ephemeral.mirror_title',
    body: 'storage_ephemeral.mirror_body',
  },
}

function EphemeralStorageNotice({ durability }: { durability: 'memory' | 'session-mirror' }) {
  const { t } = useTranslation()
  const copy = EPHEMERAL_COPY[durability]
  return (
    <div
      role="status"
      data-testid="ephemeral-storage-notice"
      data-durability={durability}
      className="mx-4 mt-4 rounded-lg border border-ui-border bg-background-secondary px-4 py-3 text-sm text-text-secondary"
    >
      <strong className="text-text-primary">{t(copy.title)}</strong>{' '}
      {t(copy.body)}{' '}
      <Link to="/settings/data" className="underline text-text-primary">
        {t('storage_ephemeral.export')}
      </Link>
    </div>
  )
}
