/**
 * SynchronySection — the "Together in time" dates, under a negative-offset zone.
 *
 * Two kinds of date, two rules. The window bounds are UTC midnight (the app
 * pins the window to a UTC day), so they print as that UTC calendar day — a
 * local render would roll them back a day. The interior cuts are antar start
 * INSTANTS with a real time of day, so they print in the viewer's zone, the
 * same rule PeriodsPanel uses: the mesh and Periods must agree on the day.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useLanguageStore } from '@almamesh/store';

import '../../../../i18n/config';
import { SynchronySection } from '../SynchronySection';
import type { VimshottariDasha } from '@almamesh/browser/types';
import { PeriodsPanel } from '../../predictive/PeriodsPanel';
import { MESH_EDGE_SPOUSE } from '../../../../test/meshFixtures';
import { FOUNDER_DASHAS_NO_DEPTH } from '../../../../test/dashaFixtures';

/** The fixture's interior cut: an antar start instant, 20:52 on Jan 07 in Los Angeles. */
const CUT = '2027-01-08T04:52:00Z';

function renderSection(): void {
  render(
    <SynchronySection
      edge={MESH_EDGE_SPOUSE}
      memberName="Dev"
      years={2}
      onYearsChange={() => undefined}
    />,
  );
}

describe('SynchronySection in a timezone west of UTC (America/Los_Angeles)', () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
    useLanguageStore.setState({ language: 'en' });
  });
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('shows the window bounds as their UTC calendar day', () => {
    // Prove the pin applied: UTC midnight is the previous evening in Los Angeles.
    expect(new Date('2026-06-11T00:00:00Z').getDate()).toBe(10);
    renderSection();
    const card = screen.getByTestId('mesh-synchrony');
    expect(card.textContent).toContain('Jun 11, 2026 → Jun 11, 2028');
    expect(card.textContent).not.toContain('Jun 10');
  });

  it('shows an interior cut in the viewer\'s zone and the bounds as their UTC day', () => {
    renderSection();
    const rows = screen.getAllByTestId('mesh-synchrony-segment');
    expect(within(rows[0]!).getByText('Jun 11, 2026 → Jan 07, 2027')).toBeTruthy();
    expect(within(rows[1]!).getByText('Jan 07, 2027 → Jun 11, 2028')).toBeTruthy();
  });

  it('puts an antar boundary on the same day as the Periods panel', () => {
    const dashas = {
      ...FOUNDER_DASHAS_NO_DEPTH,
      maha_dasha_sequence: [
        { lord: 'venus', start_date: CUT, end_date: '2047-01-08T04:52:00Z', duration_years: 20 },
      ],
      current_maha: null,
      current_antar: null,
      current_pratyantar: null,
    } as VimshottariDasha;
    render(<PeriodsPanel dashas={dashas} />);
    const periods = screen.getByTestId('dasha-tree-maha-venus').textContent ?? '';
    renderSection();
    const meshCut = within(screen.getAllByTestId('mesh-synchrony-segment')[1]!)
      .getByText(/→/)
      .textContent?.split(' → ')[0];
    expect(meshCut).toBe('Jan 07, 2027');
    expect(periods).toContain(`${meshCut} –`);
  });
});
