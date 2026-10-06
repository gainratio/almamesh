import type { TimeConfidence } from '@almamesh/constants';
import { chartId, type BirthMeta } from '@almamesh/store';

import type { BirthDetails } from './birthDetailsFromBirthData';

/**
 * What saving the Profile form will actually do to the chart.
 *
 * - `regenerate`: the chart identity changes, so the chart is recomputed.
 * - `rectification-governs`: only the birth time moved, but a stored rectified
 *   time still sets the clock, so the chart would not change. The page says so
 *   instead of claiming an update.
 * - `confidence-only`: only the birth-time confidence changed. It does not
 *   define the chart, so it is saved on the stored chart without regenerating.
 * - `unchanged`: nothing changed.
 */
export type ProfileSavePlan =
  | { readonly kind: 'regenerate'; readonly birth: BirthMeta }
  | { readonly kind: 'rectification-governs'; readonly rectifiedTime: string }
  | { readonly kind: 'confidence-only'; readonly timeConfidence: TimeConfidence }
  | { readonly kind: 'unchanged' };

export interface ProfileSaveInput {
  /** The form as loaded from the stored chart. */
  readonly initial: BirthDetails;
  /** The form as the user is about to save it. */
  readonly current: BirthDetails;
  /** The stored primary chart's id, or null when there is none. */
  readonly storedChartId: string | null;
}

/** A rectified time counts only when it is set and differs from the entered time. */
function effectiveRectifiedTime(details: BirthDetails): string | undefined {
  const { rectified_time: rectified, birth_time: entered } = details;
  return rectified && rectified !== entered ? rectified : undefined;
}

/** The engine input the form describes. Fails closed without a location. */
export function birthMetaFromDetails(details: BirthDetails): BirthMeta {
  const location = details.location;
  if (!location) {
    throw new Error('birthMetaFromDetails: a birth location is required');
  }
  const rectified = effectiveRectifiedTime(details);
  return {
    name: details.name.trim(),
    date: details.birth_date,
    time: details.birth_time,
    ...(rectified ? { rectifiedTime: rectified } : {}),
    timeConfidence: details.time_confidence,
    latitude: location.lat,
    longitude: location.lon,
    timezone: location.timezone || 'UTC',
    location_name: location.displayName || location.city,
  };
}

/**
 * Decide the save outcome with the SAME identity the regeneration handler uses
 * (`chartId`), so the page can never announce a change the handler will skip.
 */
export function planProfileSave({ initial, current, storedChartId }: ProfileSaveInput): ProfileSavePlan {
  const birth = birthMetaFromDetails(current);
  if (storedChartId === null || chartId(birth) !== storedChartId) {
    return { kind: 'regenerate', birth };
  }
  const rectifiedTime = effectiveRectifiedTime(current);
  if (rectifiedTime && current.birth_time !== initial.birth_time) {
    return { kind: 'rectification-governs', rectifiedTime };
  }
  if (current.time_confidence !== initial.time_confidence) {
    return { kind: 'confidence-only', timeConfidence: current.time_confidence };
  }
  return { kind: 'unchanged' };
}
