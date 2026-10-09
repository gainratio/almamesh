// Detect charts saved through the old Settings `timezone || 'UTC'` fallback.
//
// Such a chart carries an explicit 'UTC' zone, so it computes without error,
// silently shifted by the birthplace's real offset. We cannot tell a genuine
// UTC birthplace from the fallback by the stored zone alone, so we ask the
// birth coordinates (offline tz-lookup, already bundled): if the zone at those
// coordinates was not at UTC+0 at the birth instant, the stored 'UTC' is
// suspect and Settings offers a one-click repair. Never an automatic rewrite.
import { offsetMinutesAtInstant } from '@almamesh/store';

import { timezoneForCoordinates } from '../../lib/geo/cityLookup';

interface ZonedPlace {
  readonly lat: number;
  readonly lon: number;
  readonly timezone?: string;
}

/** The birth instant if the stored clock is read as UTC (what the chart used). */
function instantAsUtc(date: string, time: string): string | null {
  const ms = Date.parse(`${date}T${time}:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The birthplace's own zone at its coordinates, or null when tz-lookup cannot place it. */
function zoneAt(place: ZonedPlace): string | null {
  try {
    return timezoneForCoordinates(place.lat, place.lon);
  } catch {
    return null; // no zone for the point: nothing honest to suggest
  }
}

/**
 * The IANA zone to suggest when a chart stored as 'UTC' was really born
 * somewhere that was not at UTC+0 at that instant; null when nothing is
 * suspect (the zone is not 'UTC', the place genuinely was at UTC+0 — Reykjavik,
 * Accra, London in winter — or the inputs cannot be read).
 */
export function suggestBirthplaceZone(place: ZonedPlace, date: string, time: string): string | null {
  if (place.timezone !== 'UTC') return null;
  const instant = instantAsUtc(date, time);
  const zone = zoneAt(place);
  if (!instant || !zone) return null;
  return offsetMinutesAtInstant(instant, zone) === 0 ? null : zone;
}
