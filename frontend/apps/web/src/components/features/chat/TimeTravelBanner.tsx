/**
 * "⏳ Time travel · 2027 · answers are about this period · Change · Back to today" (plan Ruling 1).
 * The Dashboard reuses it with its own testid prefix and "about" line (plan Ruling 3).
 */
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
  /** Testid prefix. Default 'time-travel' (chat). The Dashboard passes 'dashboard-time-travel'. */
  readonly testIdPrefix?: string;
  /** The "about" line. Default: chat's "answers are about this period". */
  readonly about?: string;
}

/**
 * A "·" glued by a no-break space to the item before it, so when the row wraps
 * a separator ends a line and never starts one.
 */
function Separator() {
  return <span aria-hidden="true">{'\u00a0·'}</span>;
}

export function TimeTravelBanner({ asOf, language, onChange, onBack, backBusy = false, backFailed = false, testIdPrefix = 'time-travel', about }: TimeTravelBannerProps) {
  const { t } = useTranslation('chat');
  const id = (part: string) => `${testIdPrefix}-${part}`;
  const period = formatPinLabel(asOf, language);
  return (
    <div data-testid={id('banner')}
      className="mx-4 mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-accent-gold/40 bg-accent-gold/5 px-3 py-2 text-xs text-text-secondary">
      <span role="status" className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-x-1">
        <span data-testid={id('badge')} aria-hidden="true">⏳</span>
        <span>
          <span data-testid={id('title')} className="font-semibold text-text-primary">{t('time_travel.title', { period })}</span>
          <Separator />
        </span>
        {asOf.place && <span>{asOf.place.label}<Separator /></span>}
        <span>{about ?? t('time_travel.banner.about')}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
        <button type="button" data-testid={id('change')} onClick={onChange} className="underline">{t('time_travel.banner.change')}</button>
        <span aria-hidden="true">·</span>
        <button type="button" data-testid={id('back')} onClick={onBack} disabled={backBusy} className="underline disabled:opacity-50">{t('time_travel.banner.back')}</button>
      </span>
      {backFailed && (
        <span role="alert" data-testid={id('back-failed')} className="basis-full text-status-error">{t('time_travel.sheet.save_failed')}</span>
      )}
    </div>
  );
}
