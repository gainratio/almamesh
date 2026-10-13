import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '../../../../i18n/config';
import { DashboardTimeTravelSheet } from '../DashboardTimeTravelSheet';

const CHENNAI = {
  city: 'Chennai', state: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27, timezone: 'Asia/Kolkata',
  location_name: 'Chennai, Tamil Nadu, India',
};
const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.29, longitude: 103.85 };

const whereValue = () => (screen.getByTestId('time-travel-where-input') as HTMLInputElement).value;

describe('DashboardTimeTravelSheet', () => {
  // Contract reversed 2026-10-13: with no earlier trip the birth place is a suggestion to confirm, not a prefill.
  it('hands the pins and the birth location to the sheet: a pin prefills "Where?", the birth place is only suggested', () => {
    const pins = [{ as_of: { start: '2019-05-01', end: '2019-05-31', granularity: 'month' as const, place: SINGAPORE }, updated_at: '2026-10-01T00:00:00Z' }];
    const view = render(<DashboardTimeTravelSheet open today="2019-06-10" birthLocation={CHENNAI} pins={pins} onGo={vi.fn()} onClose={vi.fn()} />);
    expect(whereValue()).toBe('Singapore');
    view.rerender(<DashboardTimeTravelSheet open={false} today="2019-06-10" birthLocation={CHENNAI} onGo={vi.fn()} onClose={vi.fn()} />);
    view.rerender(<DashboardTimeTravelSheet open today="2019-06-10" birthLocation={CHENNAI} onGo={vi.fn()} onClose={vi.fn()} />);
    expect(whereValue()).toBe('');
    expect(screen.getByTestId('time-travel-where-suggestion').textContent).toBe('Use Chennai, Tamil Nadu, India (your birth place)');
  });

  it('keeps Go disabled with nothing to prefill', () => {
    render(<DashboardTimeTravelSheet open today="2019-06-10" onGo={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByTestId('time-travel-go') as HTMLButtonElement).disabled).toBe(true);
  });
});
