import { useTranslation } from 'react-i18next';
import { EngineStorageBlockedError } from '@almamesh/browser';
import { useChartEngine } from '../providers/chartEngineContext';

function heldByAnotherTab(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof EngineStorageBlockedError) return current.reason === 'pool-in-use';
    current = current.cause;
  }
  return false;
}

/**
 * The engine's on-device cache is open in another AlmaMesh tab (one owner at a
 * time). Say so plainly and offer a retry, instead of the generic engine error.
 */
export function EngineOtherTabNotice() {
  const { t } = useTranslation();
  const { error, reboot } = useChartEngine();
  if (!heldByAnotherTab(error)) return null;
  return (
    <div
      role="alert"
      data-testid="engine-other-tab-notice"
      className="mx-4 mt-4 rounded-lg border border-ui-border bg-background-secondary px-4 py-3 text-sm text-text-secondary"
    >
      <strong className="block text-text-primary">{t('engine_other_tab.title')}</strong>
      <span>{t('engine_other_tab.body')}</span>{' '}
      <button
        type="button"
        onClick={() => void reboot().catch(() => undefined)}
        className="mt-2 inline-block rounded-md border border-ui-border px-3 py-1 font-medium text-text-primary hover:bg-background-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold"
      >
        {t('engine_other_tab.retry')}
      </button>
    </div>
  );
}
