import type { ChatThreadAsOf } from '@almamesh/shared-types';

/** What a pinned answer is about, as a comparable string; 'today' when unpinned. */
export function asOfKey(asOf: ChatThreadAsOf | undefined): string {
  if (!asOf) return 'today';
  const place = asOf.place ? JSON.stringify([asOf.place.timezone, asOf.place.latitude, asOf.place.longitude]) : '';
  return `${asOf.granularity}:${asOf.start}..${asOf.end}:${place}`;
}
