/**
 * "Move to May 2019?": the one-line button under an answer when the AI called travel without being
 * asked (lib/travelTool.ts offer). The tap is the user's explicit request. It belongs to exactly the
 * move the hook holds (useChatThread.ts travelOffer): this component carries no `to` of its own.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatPinLabel } from '../../../lib/timeTravelSheet';
import type { TravelAction } from '../../../lib/travelSlot';

interface TravelOfferProps {
  readonly action: TravelAction;
  readonly language: string;
  readonly onConfirm: () => Promise<void>;
}

export function TravelOffer({ action, language, onConfirm }: TravelOfferProps) {
  const { t } = useTranslation('chat');
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const label = action.kind === 'travel'
    ? t('time_travel.offer', { period: formatPinLabel(action.asOf, language) })
    : t('time_travel.offer_today');
  const confirm = async () => {
    if (state === 'busy') return;
    setState('busy');
    try {
      await onConfirm();
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="mb-4 flex flex-col items-start gap-1" data-testid="travel-offer">
      <button type="button" data-testid="travel-offer-button" onClick={() => void confirm()} disabled={state === 'busy'}
        className="min-h-11 rounded-lg border border-accent-gold/40 px-3 text-sm text-accent-gold hover:bg-accent-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold disabled:opacity-50">
        {label}
      </button>
      {state === 'failed' && <span role="alert" className="text-xs text-status-error">{t('time_travel.sheet.save_failed')}</span>}
    </div>
  );
}
