import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TitledPersona } from '@almamesh/shared-types';
import { validateTimelineDates } from '@almamesh/llm';

import '../../../../i18n/config';
import { DashboardCurrentTimeline } from '../DashboardInterpretation';

/**
 * What the user sees when the date guard removes EVERY sentence of a timeline
 * field. The guard returns "" for such a field (it never returns null or
 * undefined), so these tests run the real guard and render its output.
 */
const ENGINE_MONTHS: ReadonlySet<string> = new Set(['2027-03']);

function guard(items: TitledPersona[]): TitledPersona[] {
  return validateTimelineDates(items, ENGINE_MONTHS).section;
}

const INVENTED: TitledPersona = {
  title: 'Saturn Antardasha',
  layman: 'You rise in 2031. Act on March 14, 2027.',
  technical: 'Antardasha ends 2031-02-11.',
};
const KEPT: TitledPersona = {
  title: 'Jupiter Window',
  layman: 'A steady, building phase.',
  technical: 'Jupiter transits the 9th house.',
};

describe('DashboardCurrentTimeline with date-guarded fields', () => {
  it('the guard leaves an emptied field as empty strings, not null or undefined', () => {
    const [emptied] = guard([INVENTED]);
    expect(emptied).toEqual({ title: 'Saturn Antardasha', layman: '', technical: '' });
  });

  it('renders nothing at all when every item of every field was emptied', () => {
    const { container } = render(
      <DashboardCurrentTimeline currentSky={guard([INVENTED])} upcomingPeriods={guard([INVENTED])} audience="you" />,
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('current-timeline-section')).toBeNull();
  });

  it('shows no title or blank body for an emptied item beside a kept one', () => {
    const { container } = render(
      <DashboardCurrentTimeline currentSky={guard([INVENTED, KEPT])} upcomingPeriods={[]} audience="you" />,
    );
    expect(screen.getByText('A steady, building phase.')).toBeTruthy();
    expect(screen.getByText('Jupiter Window')).toBeTruthy();
    expect(screen.queryByText('Saturn Antardasha')).toBeNull();
    expect(container.querySelectorAll('h4')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/undefined|null|NaN/);
  });

  it('hides the Road Ahead card when all its items were emptied', () => {
    render(
      <DashboardCurrentTimeline currentSky={guard([KEPT])} upcomingPeriods={guard([INVENTED])} audience="astrologer" />,
    );
    expect(screen.getByTestId('dashboard-current-sky')).toBeTruthy();
    expect(screen.queryByTestId('dashboard-road-ahead')).toBeNull();
  });
});
