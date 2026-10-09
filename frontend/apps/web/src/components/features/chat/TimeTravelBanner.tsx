/** "⏳ Time travel · 2027 · answers are about this period · Change · Back to today" (plan Ruling 1). */
import { useTranslation } from 'react-i18next';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { formatPinLabel } from '../../../lib/timeTravelSheet';

interface TimeTravelBannerProps {
  readonly asOf: ChatThreadAsOf;
  readonly language: string;
  readonly onChange: () => void;
  readonly onBack: () => void;
  /** The Back to today save is in flight. */
  readonly backBusy?: boolean;
  /** The Back to today save failed; the banner stays. */
  readonly backFailed?: boolean;
}

export function TimeTravelBanner({ asOf, language, onChange, onBack, backBusy = false, backFailed = false }: TimeTravelBannerProps) {
  const { t } = useTranslation('chat');
  const period = formatPinLabel(asOf, language);
  return (
    <div data-testid="time-travel-banner"
      className="mx-4 mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-accent-gold/40 bg-accent-gold/5 px-3 py-2 text-xs text-text-secondary">
      <span role="status" className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-x-1">
        <span data-testid="time-travel-badge" aria-hidden="true">⏳</span>
        <span data-testid="time-travel-title" className="font-semibold text-text-primary">{t('time_travel.title', { period })}</span>
        {asOf.place && <span>· {asOf.place.label}</span>}
        <span>· {t('time_travel.banner.about')}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
        <button type="button" data-testid="time-travel-change" onClick={onChange} className="underline">{t('time_travel.banner.change')}</button>
        <span aria-hidden="true">·</span>
        <button type="button" data-testid="time-travel-back" onClick={onBack} disabled={backBusy} className="underline disabled:opacity-50">{t('time_travel.banner.back')}</button>
      </span>
      {backFailed && (
        <span role="alert" data-testid="time-travel-back-failed" className="basis-full text-status-error">{t('time_travel.sheet.save_failed')}</span>
      )}
    </div>
  );
}
