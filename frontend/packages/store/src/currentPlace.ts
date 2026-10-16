/**
 * "Where do you live now?" — the one place a person sets once in Settings, so a
 * question about today can name the city ("Novato, California") instead of
 * only the zone. Optional and never derived: an unset place means the app
 * behaves as before (zone only), and nothing ever copies the birthplace here.
 *
 * It lives on the person's `Profile` in the canonical SQLite profiles row, so it
 * stays on the device and travels only in the user's own export. It has the
 * same shape and the same checks as a time-travel trip place.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { isPinPlace } from './chatAsOf';

/** Label ("Novato, California, United States"), IANA zone and coordinates. */
export type CurrentPlace = NonNullable<ChatThreadAsOf['place']>;

/** Only the four place fields, label trimmed; undefined when the store would refuse it. */
export function normalizeCurrentPlace(place: CurrentPlace): CurrentPlace | undefined {
  const { label, timezone, latitude, longitude } = place;
  const kept = { label: typeof label === 'string' ? label.trim() : label, timezone, latitude, longitude };
  return isPinPlace(kept) ? kept : undefined;
}

/**
 * Where the person lives now, or undefined when they never said (or a corrupt
 * or hand-edited backup holds something the store would refuse). The chat
 * layer reads this; it never falls back to the birthplace.
 */
export function getCurrentPlace(profile: { readonly currentPlace?: CurrentPlace } | undefined): CurrentPlace | undefined {
  const stored: unknown = profile?.currentPlace;
  return isPinPlace(stored) ? stored : undefined;
}
