import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { siteStorageBlocked } from '@almamesh/store'

/**
 * AlmaMesh keeps the chart on this device (OPFS SQLite + IndexedDB). When the
 * browser refuses all site storage (Safari "Block all cookies" throws
 * SecurityError on every storage API), nothing can be saved, so say so and
 * say how to fix it rather than rendering a page that can only hang.
 */
export function StorageGate({ children }: { children: ReactNode }) {
  if (!siteStorageBlocked()) return <>{children}</>
  return <StorageBlockedNotice />
}

function StorageBlockedNotice() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-center p-4 py-16">
      <div
        role="alert"
        data-testid="storage-blocked-notice"
        className="max-w-md w-full bg-background-secondary border border-ui-border rounded-xl shadow-lg p-6 text-center"
      >
        <h1 className="text-xl font-semibold text-text-primary mb-2">
          {t('storage_blocked.title')}
        </h1>
        <p className="text-text-secondary mb-4">{t('storage_blocked.body')}</p>
        <p className="text-text-secondary">{t('storage_blocked.fix')}</p>
      </div>
    </div>
  )
}
