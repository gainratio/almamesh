/**
 * The first item in a trip thread (plan 2026-10-13, "Context card"): the facts
 * the trip reads, not its period or place again (the header row names those).
 * The dashas come from the same tripContext the trip-bound tools return; the key
 * transits are the slow planets from the AI's own get_timing transits call, so
 * the card shows exactly what the AI pulled.
 */
import { useTranslation } from 'react-i18next';

import { tripDashaLine, type TripContext } from '../../../lib/tripContext';

interface TripContextCardProps {
  readonly trip: TripContext;
  /** "Saturn in Sagittarius" rows from the thread's first transits lookup, if any. */
  readonly keyTransits?: readonly string[];
}

export function TripContextCard({ trip, keyTransits = [] }: TripContextCardProps) {
  const { t } = useTranslation('chat');
  const dasha = tripDashaLine(trip);
  return (
    <section data-testid="trip-context-card" aria-label={t('trip.card_label')}
      className="mb-4 space-y-1 rounded-xl border border-accent-gold/40 bg-accent-gold/5 px-4 py-3 text-sm text-text-secondary">
      {dasha && <p data-testid="trip-context-dasha">{t('trip.dasha', { dasha })}</p>}
      {keyTransits.length > 0 && <p data-testid="trip-context-transits">{t('trip.transits', { transits: keyTransits.join(' · ') })}</p>}
      {trip.place.source === 'birth_place' && (
        <p className="text-xs text-text-muted">{t('trip.birth_place_fallback', { place: trip.place.display || trip.place.timezone })}</p>
      )}
    </section>
  );
}
