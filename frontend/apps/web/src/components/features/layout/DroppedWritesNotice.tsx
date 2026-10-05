import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { readDroppedWrites, subscribeDroppedWrites } from '@almamesh/store';

interface DroppedWritesNoticeProps {
  /** Test seam; production reloads the page to show the current data. */
  readonly reload?: () => void;
}

function reloadPage(): void {
  window.location.reload();
}

/**
 * Says when a change on screen was not saved because another tab was replacing
 * or repairing the data. Renders nothing while every write has been saved.
 */
export function DroppedWritesNotice({ reload = reloadPage }: DroppedWritesNoticeProps) {
  const { t } = useTranslation('common');
  const dropped = useSyncExternalStore(subscribeDroppedWrites, readDroppedWrites, readDroppedWrites);
  if (dropped.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="dropped-writes-notice"
      className="mb-4 rounded-xl border border-ui-border bg-background-secondary p-4 text-sm text-text-secondary"
    >
      <p className="mb-2 text-text-primary">{t('dropped_writes.body')}</p>
      <button
        type="button"
        onClick={reload}
        className="text-accent-gold hover:text-accent-gold-bright"
      >
        {t('dropped_writes.reload')}
      </button>
    </div>
  );
}
