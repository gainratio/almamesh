/**
 * A time-travel thread's pin, as the chat tools see it (spec Part 3; plan
 * Rulings 3, 4 and 9). The pinned place travels under a reserved ref the model
 * cannot send (step C refs match ^city:\d{1,6}$); its coordinates stay here.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import type { ResolvedPlace } from './geo/placeLookup';
import type { PlaceReader } from './timingPlaces';
import type { PinnedTiming } from './timingTool';

export const PINNED_PLACE_REF = 'pinned';

export function pinnedTiming(asOf: ChatThreadAsOf): PinnedTiming {
  const period = { start: asOf.start, end: asOf.end };
  return asOf.place ? { period, placeRef: PINNED_PLACE_REF } : { period };
}

export function pinnedPlaceReader(asOf: ChatThreadAsOf, base: PlaceReader): PlaceReader {
  const place = asOf.place;
  if (!place) return base;
  const pinned: ResolvedPlace = {
    summary: { place_ref: PINNED_PLACE_REF, label: place.label, timezone: place.timezone },
    latitude: place.latitude,
    longitude: place.longitude,
  };
  return async (ref) => (ref === PINNED_PLACE_REF ? pinned : base(ref));
}

/** What a pinned answer is about, as a comparable string; 'today' when unpinned. */
export function asOfKey(asOf: ChatThreadAsOf | undefined): string {
  if (!asOf) return 'today';
  const place = asOf.place ? `${asOf.place.timezone}@${asOf.place.latitude},${asOf.place.longitude}` : '';
  return `${asOf.granularity}:${asOf.start}..${asOf.end}:${place}`;
}
