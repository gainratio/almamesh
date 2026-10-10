import '../../../../i18n/config';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { toTransitCtx } from '@almamesh/store';

import { SKY_CHART } from '../../../../lib/__tests__/timingFixtures';
import { FOUNDER_DASHAS } from '../../../../test/dashaFixtures';
import { DashboardMomentCard } from '../DashboardMomentCard';

const MARCH_2025 = { start: '2025-03-01', end: '2025-03-31', granularity: 'month' } as const;
// Crosses the Venus -> Sun antar boundary (2027-01-31) inside the Saturn maha.
const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

function text(testId: string): string {
  return screen.getByTestId(testId).textContent ?? '';
}

describe('DashboardMomentCard', () => {
  it('shows the maha and antar at the moment, from the chart dasha list', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-maha')).toContain('Saturn');
    expect(text('time-travel-moment-antar')).toContain('Venus');
  });

  it('a year that crosses an antar boundary shows both lords, in order', () => {
    render(<DashboardMomentCard asOf={YEAR_2027} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-maha')).toBe('Saturn');
    expect(text('time-travel-moment-antar')).toBe('Venus → Sun');
  });

  it('with no dasha list, shows a dash rather than a guess', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={undefined} birthYear={undefined}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-maha')).toBe('—');
    expect(text('time-travel-moment-antar')).toBe('—');
  });

  it('on a weak device, says dashas only (no transits table)', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-dashas-only')).toContain('dashas only');
    expect(screen.queryByTestId('time-travel-moment-transits')).toBeNull();
  });

  it('while working, names the period in the progress line', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'working' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-working').replace(/\s+/g, ' ')).toContain('Working out the sky for March 2025');
  });

  it('a failed compute offers Try again, and the button retries', () => {
    const onRetry = vi.fn();
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'failed' }} onRetry={onRetry} language="en" />);
    expect(text('time-travel-moment-failed')).toContain('Try again');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('when the sky is ready, shows the transits table and no progress line', () => {
    const transits = toTransitCtx(SKY_CHART.transit_context);
    if (!transits) throw new Error('fixture has no transits');
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'ready', transits }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-transits')).toContain('Planets in the sky then');
    expect(screen.queryByTestId('time-travel-moment-working')).toBeNull();
  });
});
