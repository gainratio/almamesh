/**
 * ReportDasha — the letterpress Vimśottarī section: current legs, convention
 * note, the 9-row mahā table, PLUS the antar-daśās of EVERY mahā (the
 * definitive reference tables — one 9-row table per mahā, in mahā order) and
 * the running antar's nine pratyantar-daśās nested after the running mahā.
 * Older payloads without depth render the classic section unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useLanguageStore } from '@almamesh/store';

import '../../../../i18n/config';
import { ReportDasha } from '../ReportDasha';
import { PeriodsPanel } from '../../predictive/PeriodsPanel';
import { FOUNDER_DASHAS, FOUNDER_DASHAS_NO_DEPTH } from '../../../../test/dashaFixtures';

describe('ReportDasha', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('keeps the classic section: current legs, convention note, 9-row mahā table', () => {
    render(<ReportDasha dashas={FOUNDER_DASHAS} />);
    expect(screen.getByTestId('report-dasha-current')).toBeTruthy();
    expect(screen.getByTestId('report-dasha-convention').textContent).toContain('Gregorian year');
    const mahaTable = screen.getByTestId('report-dasha-maha-table');
    expect(within(mahaTable).getAllByRole('row')).toHaveLength(10); // header + 9 mahās
    // The running mahā row carries the dot marker + aria-current.
    const runningRow = within(mahaTable)
      .getAllByRole('row')
      .find((row) => row.getAttribute('aria-current') === 'true');
    expect(runningRow?.textContent).toContain('Saturn');
  });

  it('prints the antar-daśās of EVERY mahā — one 9-row table per mahā, in order', () => {
    render(<ReportDasha dashas={FOUNDER_DASHAS} />);
    const tables = screen.getAllByTestId('report-dasha-antars');
    expect(tables).toHaveLength(9); // all nine mahās expand
    for (const table of tables) {
      expect(within(table).getAllByRole('row')).toHaveLength(10); // header + 9 antars
    }
    // Every mahā gets its own localized heading.
    expect(screen.getByText('Antar-daśās of the Saturn Mahā-daśā')).toBeTruthy();
    expect(screen.getByText('Antar-daśās of the Venus Mahā-daśā')).toBeTruthy();
  });

  it('highlights the running antar ONLY inside the running mahā', () => {
    render(<ReportDasha dashas={FOUNDER_DASHAS} />);
    const tables = screen.getAllByTestId('report-dasha-antars');
    const runningRows = tables.flatMap((table) =>
      within(table)
        .getAllByRole('row')
        .filter((row) => row.getAttribute('aria-current') === 'true'),
    );
    expect(runningRows).toHaveLength(1); // exactly one running antar overall
    expect(runningRows[0].textContent).toContain('Venus');
  });

  it('adds the pratyantar-daśās of the RUNNING antar (9 rows, running PD highlighted)', () => {
    render(<ReportDasha dashas={FOUNDER_DASHAS} />);
    expect(screen.getByText('Pratyantar-daśās of the Venus Antar-daśā')).toBeTruthy();
    const table = screen.getByTestId('report-dasha-pratyantars');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(10);
    const running = rows.find((row) => row.getAttribute('aria-current') === 'true');
    expect(running?.textContent).toContain('Saturn');
    expect(within(table).getByText('Mercury')).toBeTruthy(); // the next PD is on the page
    // Exactly one pratyantar drill-down — nested after the running mahā only.
    expect(screen.getAllByTestId('report-dasha-pratyantars')).toHaveLength(1);
  });

  it('renders the classic section unchanged (no sub-tables, no crash) on older payloads', () => {
    render(<ReportDasha dashas={FOUNDER_DASHAS_NO_DEPTH} />);
    expect(screen.getByTestId('report-dasha-maha-table')).toBeTruthy();
    expect(screen.queryByTestId('report-dasha-antars')).toBeNull();
    expect(screen.queryByTestId('report-dasha-pratyantars')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Regression (Spec 062 flagged bug): dasha boundary dates must render as the
  // WRITTEN calendar date. The old `formatReportDate` path reparsed date-only
  // strings through `new Date("YYYY-MM-DD")` (UTC midnight), which rolls the
  // displayed day back to the PREVIOUS day for every viewer west of GMT — the
  // same class as the life-event date bug. The date-safe path parses the Y/M/D
  // parts and formats at local noon, so the day is stable in ANY host zone.
  // -------------------------------------------------------------------------
  it('renders dasha boundary dates as written — never rolled back a day west of GMT', () => {
    render(<ReportDasha dashas={FOUNDER_DASHAS} />);
    // The running Saturn mahā starts 2017-01-09 (see test/dashaFixtures.ts);
    // en locale renders MM/DD/YYYY via the tz-safe local-noon formatter.
    const current = screen.getByTestId('report-dasha-current');
    expect(current.textContent).toContain('01/09/2017');
    // The day-early fingerprint must NEVER appear, in any host timezone.
    expect(current.textContent).not.toContain('01/08/2017');
    const mahaTable = screen.getByTestId('report-dasha-maha-table');
    expect(mahaTable.textContent).toContain('01/09/2017');
    expect(mahaTable.textContent).not.toContain('01/08/2017');
  });

  // CONTRACT REVERSED (PR #305): this test used to require the UTC calendar
  // day of an ISO instant ("written date"), while the on-screen Periods panel
  // shows the same instant in the viewer's zone, so print and screen disagreed
  // by a day west of GMT. The report now follows the Periods rule.
  describe('in a timezone west of UTC (America/Los_Angeles)', () => {
    const originalTz = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = 'America/Los_Angeles';
    });
    afterEach(() => {
      process.env.TZ = originalTz;
    });

    // 00:30 UTC on Jan 13 is the evening of Jan 12 in Los Angeles.
    const dashas = {
      ...FOUNDER_DASHAS_NO_DEPTH,
      maha_dasha_sequence: [
        {
          lord: 'mercury',
          start_date: '2020-01-13T00:30:00Z',
          end_date: '2037-01-13T00:30:00Z',
          duration_years: 17,
        },
      ],
      current_maha: null,
      current_antar: null,
      current_pratyantar: null,
    } as typeof FOUNDER_DASHAS_NO_DEPTH;

    it('prints an ISO instant boundary on the same day the Periods panel shows', () => {
      render(<PeriodsPanel dashas={dashas} />);
      const periods = screen.getByTestId('dasha-tree-maha-mercury').textContent ?? '';
      render(<ReportDasha dashas={dashas} />);
      const table = screen.getByTestId('report-dasha-maha-table');
      expect(periods).toContain('Jan 12, 2020');
      expect(table.textContent).toContain('Jan 12, 2020');
      expect(table.textContent).not.toContain('01/13/2020');
    });
  });
});
