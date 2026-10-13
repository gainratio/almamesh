import { useSyncExternalStore, type ReactElement } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { portableStatePersistence, subscribePortableStatePersistence } from '@almamesh/store'

/**
 * The browser refuses on-device storage (Safari Private Browsing), so the app
 * runs on SQLite in memory for this tab. Say plainly that nothing is kept
 * after the tab closes or reloads, and where to export a backup.
 */
export function InMemoryStorageNotice(): ReactElement | null {
  const { t } = useTranslation()
  const persistence = useSyncExternalStore(
    subscribePortableStatePersistence,
    portableStatePersistence,
    portableStatePersistence,
  )
  if (persistence !== 'memory') return null
  return (
    <div
      role="status"
      data-testid="in-memory-storage-notice"
      className="relative z-[60] mx-4 mt-4 rounded-lg border border-ui-border bg-background-secondary px-4 py-3 text-sm text-text-secondary"
    >
      <strong className="text-text-primary">{t('storage_in_memory.title')}</strong>{' '}
      {t('storage_in_memory.body')}{' '}
      <Link to="/settings/data" className="underline text-text-primary">
        {t('storage_in_memory.export')}
      </Link>{' '}
      {t('storage_in_memory.engine')}
    </div>
  )
}
