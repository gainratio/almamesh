import { describe, expect, it } from 'vitest';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import type { BirthMeta } from '@almamesh/store';
import { toBirthData } from '@almamesh/store';
import { birthDetailsFromBirthData } from '../birthDetailsFromBirthData';

const LOCATION = {
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'India',
  latitude: 12.9716,
  longitude: 77.5946,
  timezone: 'Asia/Kolkata',
  location_name: 'Bengaluru, Karnataka, India',
};

function birthData(overrides: Partial<ProcessedBirthData>): ProcessedBirthData {
  return {
    birth_datetime_utc: '1988-08-08T01:14:00Z',
    birth_datetime_local: '1988-08-08T06:44:00',
    birth_location_details: LOCATION,
    ...overrides,
  };
}

describe('birthDetailsFromBirthData', () => {
  it('reconstructs the entered time and the rectified time as DISTINCT when a rectification exists', () => {
    // birth_datetime_local carries the EFFECTIVE (rectified) clock 06:14,
    // birth_time_original carries the originally-entered clock 06:44.
    const details = birthDetailsFromBirthData(
      birthData({
        birth_datetime_local: '1988-08-08T06:14:00',
        birth_time_original: '06:44',
      }),
      'Reference Native',
    );

    expect(details.name).toBe('Reference Native');
    expect(details.birth_date).toBe('1988-08-08');
    // The ENTERED time must come from birth_time_original, not the effective clock.
    expect(details.birth_time).toBe('06:44');
    // The RECTIFIED time must come from the effective birth_datetime_local.
    expect(details.rectified_time).toBe('06:14');
  });

  // CONTRACT REVERSED (2026-10-05). This test used to assert that rectified_time
  // is PREFILLED with the entered time when no rectification exists. That prefill
  // was the bug: after editing only the birth time, the stale prefill was sent as
  // a "rectification" that pinned the chart to the old time, the regeneration
  // no-oped, and Settings still said "Chart Updated!". No rectification now means
  // an EMPTY rectified field, so the entered birth time governs the chart.
  it('leaves rectified_time empty when no rectification exists (no prefill)', () => {
    const details = birthDetailsFromBirthData(
      birthData({ birth_datetime_local: '1988-08-08T06:44:00' }),
      'Reference Native',
    );

    expect(details.birth_time).toBe('06:44');
    expect(details.rectified_time).toBe('');
  });

  it('round-trips symmetrically with toBirthData() for a rectified profile (no silent reversion)', () => {
    const birth: BirthMeta = {
      name: 'Reference Native',
      date: '1988-08-08',
      time: '06:44',
      rectifiedTime: '06:14',
      timeConfidence: 'exact',
      latitude: LOCATION.latitude,
      longitude: LOCATION.longitude,
      timezone: LOCATION.timezone,
      location_name: LOCATION.location_name,
    };

    // Save path -> stored shape -> load path.
    const stored = toBirthData(birth);
    const details = birthDetailsFromBirthData(stored, birth.name);

    expect(details.birth_time).toBe('06:44');
    expect(details.rectified_time).toBe('06:14');

    // Re-saving the reconstructed editable state preserves the rectification:
    // the stored effective clock stays 06:14 and the original stays 06:44.
    const reBirth: BirthMeta = {
      name: details.name,
      date: details.birth_date,
      time: details.birth_time,
      rectifiedTime:
        details.rectified_time !== details.birth_time ? details.rectified_time : undefined,
      timeConfidence: details.time_confidence,
      latitude: details.location?.lat ?? 0,
      longitude: details.location?.lon ?? 0,
      timezone: details.location?.timezone ?? 'UTC',
      location_name: details.location?.displayName ?? '',
    };
    const reStored = toBirthData(reBirth);
    expect(reStored.birth_datetime_local).toBe(stored.birth_datetime_local);
    expect(reStored.birth_time_original).toBe('06:44');
  });
});
