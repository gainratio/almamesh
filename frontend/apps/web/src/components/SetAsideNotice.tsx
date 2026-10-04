import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { interpretationWriteRefusal, interpretationsWereSetAside } from '@almamesh/store'

/**
 * Non-fatal boot notice: saved interpretations that could not be read were
 * moved to a quarantine instead of blanking the app or being silently dropped.
 * Read once at mount; boot finishes hydration before the first render.
 */
export function SetAsideNotice() {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(interpretationsWereSetAside)
  // A row that could not be held was NOT set aside: say so, and that saving is paused.
  const [paused] = useState(() => interpretationWriteRefusal() !== undefined)

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="interpretations-set-aside-notice"
      className="fixed bottom-4 left-4 right-4 z-[60] mx-auto max-w-xl rounded-lg border border-ui-border bg-background-secondary px-4 py-3 text-sm text-text-primary shadow-lg flex items-start justify-between gap-4"
    >
      <span>
        {t(paused ? 'storage.interpretations_unreadable_paused' : 'storage.interpretations_set_aside')}
      </span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        className="text-text-secondary hover:text-text-primary transition-colors"
        aria-label={t('storage.dismiss_aria')}
      >
        ×
      </button>
    </div>
  )
}
