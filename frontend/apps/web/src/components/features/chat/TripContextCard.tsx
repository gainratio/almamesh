/**
 * The first item in a trip thread (plan 2026-10-13, "Context card"): the period,
 * the place the user lived then, and the dashas that cover it. It reads the same
 * tripContext the trip-bound tools return, so the card and the AI cannot drift.
 */
import { useTranslation } from 'react-i18next';

import { tripDashaLine, type TripContext } from '../../../lib/tripContext';

interface TripContextCardProps {
  readonly trip: TripContext;
}

export function TripContextCard({ trip }: TripContextCardProps) {
  const { t } = useTranslation('chat');
  const dasha = tripDashaLine(trip);
  const place = trip.place.source === 'birth_place'
    ? t('trip.birth_place_fallback', { place: trip.place.display || trip.place.timezone })
    : trip.place.display;
  return (
    <section data-testid="trip-context-card" aria-label={t('trip.card_label')}
      className="mb-4 rounded-xl border border-accent-gold/40 bg-accent-gold/5 px-4 py-3 text-sm text-text-secondary">
      <p className="font-semibold text-text-primary">
        <span aria-hidden="true">⏳ </span>{trip.period.label}<span aria-hidden="true">{' ·'}</span> {place}
      </p>
      {dasha && <p className="mt-1" data-testid="trip-context-dasha">{t('trip.dasha', { dasha })}</p>}
      <p className="mt-1 text-xs text-text-muted">{t(`trip.tense.${trip.period.tense}`)}</p>
    </section>
  );
}
