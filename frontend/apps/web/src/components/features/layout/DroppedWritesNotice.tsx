import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { readDroppedWrites, retryFailedDiscards, subscribeDroppedWrites } from '@almamesh/store';

interface DroppedWritesNoticeProps {
  /** Test seam; production reloads the page to show the current data. */
  readonly reload?: () => void;
  /** Test seam; production re-tries removing the cancelled people. */
  readonly retryDiscards?: () => Promise<void>;
}

function reloadPage(): void {
  window.location.reload();
}

const NOTICE_CLASS =
  'mb-4 rounded-xl border border-ui-border bg-background-secondary p-4 text-sm text-text-secondary';
const ACTION_CLASS = 'text-accent-gold hover:text-accent-gold-bright';

/**
 * Says when a change on screen was not saved: another tab was replacing or
 * repairing the data, or a person the user cancelled could not be removed
 * from this device (a reload would bring them back, so that case offers a
 * retry instead). Renders nothing while every write has been saved.
 */
export function DroppedWritesNotice({
  reload = reloadPage,
  retryDiscards = retryFailedDiscards,
}: DroppedWritesNoticeProps) {
  const { t } = useTranslation('common');
  const dropped = useSyncExternalStore(subscribeDroppedWrites, readDroppedWrites, readDroppedWrites);
  const discardFailed = dropped.some((write) => write.reason === 'discard-failed');
  const otherDropped = dropped.some((write) => write.reason !== 'discard-failed');
  return (
    <>
      {discardFailed && (
        <div role="alert" data-testid="discard-failed-notice" className={NOTICE_CLASS}>
          <p className="mb-2 text-text-primary">{t('dropped_writes.discard_failed_body')}</p>
          <button type="button" onClick={() => void retryDiscards()} className={ACTION_CLASS}>
            {t('dropped_writes.try_again')}
          </button>
        </div>
      )}
      {otherDropped && (
        <div role="alert" data-testid="dropped-writes-notice" className={NOTICE_CLASS}>
          <p className="mb-2 text-text-primary">{t('dropped_writes.body')}</p>
          <button type="button" onClick={reload} className={ACTION_CLASS}>
            {t('dropped_writes.reload')}
          </button>
        </div>
      )}
    </>
  );
}
