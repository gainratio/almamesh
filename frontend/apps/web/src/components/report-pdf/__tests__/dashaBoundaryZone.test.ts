/**
 * The PDF daśā tables label each boundary "Mon YYYY". They follow the Periods
 * panel's rule: a date-only boundary is its written day, and an ISO instant is
 * read in the viewer's zone. Before this, an instant was cut to its UTC date,
 * so an instant early on the 1st (UTC) printed the next month west of GMT
 * while the screen showed the previous one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiderealChart } from '@almamesh/browser/types';

import { buildDasha } from '../buildReportSections';
import { FOUNDER_DASHAS_NO_DEPTH } from '../../../test/dashaFixtures';

function chartWith(start: string, end: string): SiderealChart {
  return {
    dashas: {
      ...FOUNDER_DASHAS_NO_DEPTH,
      maha_dasha_sequence: [{ lord: 'mercury', start_date: start, end_date: end, duration_years: 17 }],
      current_maha: null,
      current_antar: null,
      current_pratyantar: null,
    },
  } as unknown as SiderealChart;
}

describe('PDF daśā boundary labels in America/Los_Angeles', () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('labels an ISO instant by its month in the viewer\'s zone', () => {
    // 03:00 UTC on Feb 1 is the evening of Jan 31 in Los Angeles.
    const [row] = buildDasha(chartWith('2020-02-01T03:00:00Z', '2037-02-01T03:00:00Z')).mahaSequence;
    expect(row?.start).toBe('Jan 2020');
    expect(row?.end).toBe('Jan 2037');
  });

  it('keeps a date-only boundary on its written month', () => {
    const [row] = buildDasha(chartWith('2020-02-01', '2037-02-01')).mahaSequence;
    expect(row?.start).toBe('Feb 2020');
    expect(row?.end).toBe('Feb 2037');
  });
});
