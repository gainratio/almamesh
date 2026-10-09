/**
 * When Open-Meteo omits a zone AND the on-device tz-lookup throws, the match
 * carries NO timezone (never a made-up 'UTC'), so the engine path's
 * requireBirthTimeZone refuses it instead of computing the chart in UTC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('tz-lookup', () => ({
  default: () => {
    throw new Error('tz-lookup: no zone for this point');
  },
}));

import { requireBirthTimeZone } from '@almamesh/store';
import { geocodeCitiesOnline } from './onlineGeocoder';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('geocodeCitiesOnline — no silent UTC zone', () => {
  it('leaves the zone undefined when neither the API nor tz-lookup knows it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [{ name: 'Nowhere', latitude: 0, longitude: -160, feature_code: 'PPL' }],
          }),
      }),
    );
    const [match] = await geocodeCitiesOnline('nowhere');
    expect(match?.timezone).toBeUndefined();
    expect(() => requireBirthTimeZone(match?.timezone, 'birth')).toThrow(/timezone is missing/);
  });
});
