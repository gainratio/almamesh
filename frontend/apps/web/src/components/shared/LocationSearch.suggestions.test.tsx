/**
 * The birthplace box lists places the way every other place box does: the
 * city plainly, "State, Country" muted on the same row, no coordinates, at
 * most six rows.
 */
import '../../i18n/config';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { CityMatch } from '../../lib/geo/cityLookup';

function springfield(state: string, population: number): CityMatch {
  return {
    displayName: `Springfield, ${state}, United States`, city: 'Springfield', state, country: 'United States',
    countryCode: 'US', latitude: 39.8, longitude: -89.6, timezone: 'America/Chicago', population,
  };
}

const STATES = ['Missouri', 'Massachusetts', 'Illinois', 'Oregon', 'Ohio', 'Virginia', 'Pennsylvania', 'Tennessee'];
const searchCities = vi.fn(async (_query: string, limit = 8) => STATES.map((state, i) => springfield(state, 200_000 - i)).slice(0, limit));

vi.mock('../../lib/geo/cityLookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/geo/cityLookup')>()),
  searchCities: (query: string, limit?: number) => searchCities(query, limit),
}));

const { LocationSearch } = await import('./LocationSearch');

describe('LocationSearch suggestions', () => {
  it('reads "Springfield, Illinois, United States" with the region muted, and no coordinates', async () => {
    const user = userEvent.setup();
    render(<LocationSearch value={null} onChange={vi.fn()} />);
    await user.type(screen.getByRole('combobox'), 'Springfield');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(6);
    const illinois = options[2];
    expect(illinois.textContent).toBe('Springfield, Illinois, United States');
    expect(illinois.querySelector('[data-part="region"]')?.textContent).toBe(', Illinois, United States');
    expect(illinois.textContent).not.toMatch(/\d/);
  });
});
