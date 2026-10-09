/** "⏳ Time travel · 2027 · answers are about this period · Change · Back to today" (plan Ruling 1). */
import { useTranslation } from 'react-i18next';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { formatPinLabel } from '../../../lib/timeTravelSheet';

interface TimeTravelBannerProps {
  readonly asOf: ChatThreadAsOf;
  readonly language: string;
  readonly onChange: () => void;
  readonly onBack: () => void;
}

export function TimeTravelBanner({ asOf, language, onChange, onBack }: TimeTravelBannerProps) {
  const { t } = useTranslation('chat');
  const period = formatPinLabel(asOf, language);
  return (
    <div data-testid="time-travel-banner" role="status"
      className="mx-4 mt-3 flex flex-wrap items-center gap-x-1 rounded-lg border border-accent-gold/40 bg-accent-gold/5 px-3 py-2 text-xs text-text-secondary">
      <span data-testid="time-travel-badge" aria-hidden="true">⏳</span>
      <span data-testid="time-travel-title" className="font-semibold text-text-primary">{t('time_travel.title', { period })}</span>
      {asOf.place && <span>· {asOf.place.label}</span>}
      <span>· {t('time_travel.banner.about')} ·</span>
      <button type="button" data-testid="time-travel-change" onClick={onChange} className="underline">{t('time_travel.banner.change')}</button>
      <span>·</span>
      <button type="button" data-testid="time-travel-back" onClick={onBack} className="underline">{t('time_travel.banner.back')}</button>
    </div>
  );
}
