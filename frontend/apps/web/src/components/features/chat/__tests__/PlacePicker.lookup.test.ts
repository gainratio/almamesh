import { describe, expect, it } from 'vitest';

import { installCityTestDatabase } from '../../../../lib/geo/__tests__/cityTestDb';
import { lookupPlaceLazily } from '../PlacePicker';

installCityTestDatabase();

function labels(result: Awaited<ReturnType<typeof lookupPlaceLazily>>): string[] {
  if (result.status === 'found') return [result.place.summary.label];
  return result.status === 'ambiguous' ? result.candidates.map((c) => c.summary.label) : [];
}

describe('the "Where?" box lookup', () => {
  it('lists every match, so Paris, Texas is there under Paris, France', async () => {
    expect(labels(await lookupPlaceLazily('Paris'))).toContain('Paris, Texas, United States');
  });

  it('a state qualifier leaves only that state: "novato, ca"', async () => {
    expect(labels(await lookupPlaceLazily('novato, ca'))).toEqual(['Novato, California, United States']);
  });

  it('a qualifier that names nothing finds nothing', async () => {
    expect(await lookupPlaceLazily('Portland, ZZ')).toEqual({ status: 'not_found' });
  });
});
