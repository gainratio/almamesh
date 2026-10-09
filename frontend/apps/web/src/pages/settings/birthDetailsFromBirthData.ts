import type { ProcessedBirthData } from '@almamesh/shared-types';
import { TIME_CONFIDENCE, type TimeConfidence } from '@almamesh/constants';
import { type DstFold, dstFoldFromStoredUtc } from '@almamesh/store';
import type { LocationResult } from '../../components/shared/LocationSearch';

/** Editable birth details backing the ProfileSettings form. */
export interface BirthDetails {
  name: string;
  birth_date: string;
  birth_time: string;
  location: LocationResult | null;
  rectified_time: string;
  time_confidence: TimeConfidence;
  /** Which occurrence of a repeated (DST fall-back) hour the effective clock is. */
  dst_fold?: DstFold;
}

/**
 * Reconstruct the editable form state from a stored chart's birth data.
 *
 * `birth_datetime_local` carries the EFFECTIVE (rectified) wall-clock, while the
 * originally-ENTERED clock lives in `birth_time_original` (present only when a
 * rectification was applied). Splitting them back out keeps the entered time and
 * the rectified time DISTINCT exactly when a rectification exists — without this,
 * a reload collapses both fields onto the rectified clock and the next save
 * silently reverts the rectification. Symmetric with the store's `toBirthData()`.
 */
export function birthDetailsFromBirthData(
  birthData: ProcessedBirthData,
  personName: string,
): BirthDetails {
  let birth_date = '';
  let effective_time = '';
  let location: LocationResult | null = null;

  if (birthData.birth_datetime_local) {
    const [datePart, timePart = ''] = birthData.birth_datetime_local.split('T');
    birth_date = datePart;
    effective_time = timePart.slice(0, 5);
  }

  // The entered time is `birth_time_original` when a rectification was stored;
  // otherwise the effective clock IS the entered clock.
  const birth_time = birthData.birth_time_original ?? effective_time;

  const loc = birthData.birth_location_details;
  if (loc) {
    location = {
      displayName: [loc.city, loc.state, loc.country].filter(Boolean).join(', '),
      city: loc.city || '',
      state: loc.state || '',
      country: loc.country || '',
      lat: loc.latitude || 0,
      lon: loc.longitude || 0,
      // No `|| 'UTC'`: a missing zone stays missing, and the save path refuses
      // it (requireBirthTimeZone) rather than recomputing the chart in UTC.
      timezone: loc.timezone || undefined,
    };
  }

  const loadedConfidence = birthData.birth_time_confidence;
  const time_confidence: TimeConfidence =
    loadedConfidence && loadedConfidence in TIME_CONFIDENCE
      ? (loadedConfidence as TimeConfidence)
      : 'exact';

  return {
    name: personName,
    birth_date,
    birth_time,
    location,
    // Empty unless a rectification was stored. Never prefill it with the entered
    // time: a prefilled copy outlives a later birth-time edit and silently pins
    // the chart to the old clock (production bug, 2026-10-05).
    rectified_time:
      birthData.birth_time_original && birthData.birth_time_original !== effective_time ? effective_time : '',
    time_confidence,
    ...storedFold(birthData, birth_date, effective_time),
  };
}

/** The DST occurrence the stored chart used, read back from its UTC instant. */
function storedFold(
  birthData: ProcessedBirthData,
  date: string,
  time: string,
): { dst_fold?: DstFold } {
  const zone = birthData.birth_location_details?.timezone;
  if (!zone || !birthData.birth_datetime_utc) return {};
  const fold = dstFoldFromStoredUtc(date, time, zone, birthData.birth_datetime_utc);
  return fold ? { dst_fold: fold } : {};
}
