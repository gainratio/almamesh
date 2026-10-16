import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../../../../i18n/config';
import type { TripContext } from '../../../../lib/tripContext';
import { TripContextCard } from '../TripContextCard';

const TRIP: TripContext = {
  period: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', tense: 'past', label: 'May 2019', short: 'May 2019' },
  place: { label: 'unspecified place', timezone: 'Asia/Kolkata', source: 'birth_place', display: 'Delhi' },
  today: '2026-10-13',
  natal: { lagna: { sign: 'scorpio', nakshatra: 'anuradha', pada: 1, sign_lord: 'mars' }, moon: null, planets: [], yogas: [] },
  dashas: { maha: [], antar: [], notes: [] },
};

describe('TripContextCard', () => {
  it('an old trip says it reads the birth place, and shows no dasha line when there are none', () => {
    render(<TripContextCard trip={TRIP} />);
    expect(screen.getByTestId('trip-context-card').textContent).toContain('No place was chosen for this trip: it reads Delhi, the birth place.');
    expect(screen.queryByTestId('trip-context-dasha')).toBeNull();
    // Contract changed 2026-10-13: the card shows facts only; the header row carries the period.
    expect(screen.queryByText('This period is over.')).toBeNull();
  });

  it('falls back to the zone when the birth place has no city', () => {
    render(<TripContextCard trip={{ ...TRIP, place: { ...TRIP.place, display: '' } }} />);
    expect(screen.getByTestId('trip-context-card').textContent).toContain('it reads Asia/Kolkata, the birth place');
  });
});
