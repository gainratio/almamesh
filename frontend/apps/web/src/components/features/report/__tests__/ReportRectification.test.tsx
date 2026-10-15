/**
 * ReportRectification — Section "Birth Time Authority".
 *
 * Contract: entered vs working time + rising sign, mode, qualitative band,
 * confirm date, resolved events, and the honest caveat. A min-evidence-gated
 * aggregate confidence percentage may accompany the band with its provenance
 * and ledger; raw margins, fit scores, and per-event numbers never render.
 *
 * All data is SYNTHETIC (a "Reference Native") — never real birth data.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { LifeEvent } from '@almamesh/store';
import type { RectificationRecord } from '@almamesh/shared-types';

import '../../../../i18n/config';
import { ReportRectification } from '../ReportRectification';

const RECORD: RectificationRecord = {
  profileId: 'profile-1',
  confirmedAt: '2026-05-01T12:00:00.000Z',
  mode: 'cusp',
  band: 'leans',
  margin: 0.7341, // display-only in the store — must NEVER render here
  originalTime: '07:30',
  originalSign: 'aquarius',
  rectifiedTime: '07:45',
  rectifiedSign: 'pisces',
  supportingEventIds: ['evt-1', 'evt-2'],
};

const EVENTS: readonly LifeEvent[] = [
  {
    id: 'evt-1',
    date: '2015-06-20',
    category: 'marriage',
    summary: 'Married in Bengaluru',
    createdAt: '2026-04-01T00:00:00.000Z',
  },
  {
    id: 'evt-2',
    date: '2019-02-11',
    category: 'career_change',
    summary: 'Switched to teaching',
    createdAt: '2026-04-02T00:00:00.000Z',
  },
];

describe('ReportRectification — Birth Time Authority', () => {
  it('shows entered vs working time with their rising signs', () => {
    render(<ReportRectification record={RECORD} events={EVENTS} />);
    const facts = screen.getByTestId('report-rectification-facts');
    expect(facts.textContent).toContain('07:30');
    expect(facts.textContent).toContain('Aquarius');
    expect(facts.textContent).toContain('07:45');
    expect(facts.textContent).toContain('Pisces');
  });

  it('renders the legacy qualitative-only band when aggregate confidence is absent', () => {
    render(<ReportRectification record={RECORD} events={EVENTS} />);
    const section = screen.getByTestId('report-rectification');
    expect(screen.getByTestId('report-rectification-band').textContent).toBe('Leans Toward');
    expect(section.textContent).not.toContain('%');
    expect(section.textContent).not.toContain('0.7341');
    expect(section.textContent).not.toContain('0.73');
  });

  it('lists the resolved supporting events with date, category and summary', () => {
    render(<ReportRectification record={RECORD} events={EVENTS} />);
    const table = screen.getByTestId('report-rectification-events');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 events
    expect(rows[1].textContent).toContain('Marriage');
    expect(rows[1].textContent).toContain('Married in Bengaluru');
    expect(rows[2].textContent).toContain('Switched to teaching');
    // Date-only strings print as the WRITTEN calendar date — never rolled back
    // a day by a UTC reparse west of GMT (2015-06-20 must stay June 20).
    expect(rows[1].textContent).toContain('06/20/2015');
  });

  it('closes with the honest "resolves the sign, not the minute" caveat', () => {
    render(<ReportRectification record={RECORD} events={EVENTS} />);
    expect(screen.getByTestId('report-rectification-caveat').textContent).toContain(
      'resolves the rising sign, not the exact minute',
    );
  });

  it('handles an unknown entered time and zero resolved events honestly', () => {
    const record: RectificationRecord = {
      ...RECORD,
      originalTime: '',
      originalSign: null,
      supportingEventIds: [],
    };
    render(<ReportRectification record={record} events={[]} />);
    expect(screen.getByTestId('report-rectification-facts').textContent).toContain('Not recorded');
    expect(screen.queryByTestId('report-rectification-events')).toBeNull();
    expect(screen.getByTestId('report-rectification').textContent).toContain(
      'No dated life events are attached',
    );
  });

  it('v1 fallback: renders NO phase-2 tables when resultSnapshot is absent', () => {
    render(<ReportRectification record={RECORD} events={EVENTS} />);
    expect(screen.queryByTestId('report-rectification-candidates')).toBeNull();
    expect(screen.queryByTestId('report-rectification-evidence')).toBeNull();
    expect(screen.queryByTestId('report-rectification-misses')).toBeNull();
    expect(screen.queryByTestId('report-rectification-prior')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (Spec 062): the full evidence story from the v2 resultSnapshot
// ---------------------------------------------------------------------------

const SNAPSHOT_RECORD: RectificationRecord = {
  ...RECORD,
  rectifiedSign: 'Pisces',
  resultSnapshot: {
    mode: 'cusp',
    band: 'leans',
    margin: 0.7341, // must NEVER render
    discriminatingEventCount: 2,
    recordedTimeSign: 'Aquarius',
    honestyNoteKey: 'rectify.honesty.leans',
    candidates: [
      {
        ascendantSign: 'Pisces',
        representativeTimeLocal: '07:45',
        lagnaLongitudeDeg: 333.8,
        lagnaCuspDistanceDeg: 3.8,
        isNearCusp: false,
        fitScore: 3.4,
        navamsaLagnaSign: 'leo',
        positiveTotal: 3.55,
        penaltyTotal: 0.15,
        priorBonus: 0.35,
        misses: ['miss_silent_marriage_h7'],
        supportingEvents: [
          {
            eventIndex: 0,
            category: 'marriage',
            date: '2015-06-20',
            signals: ['ad_lord_rules_h7', 'd9_lord_rules_d9_h7'],
            contribution: 1.85,
          },
          {
            eventIndex: 1,
            category: 'relocation',
            date: '2019-09-01',
            signals: ['miss_unexplained'],
            contribution: -0.25,
          },
        ],
      },
      {
        ascendantSign: 'Aquarius',
        representativeTimeLocal: '07:30',
        lagnaLongitudeDeg: 328.8,
        lagnaCuspDistanceDeg: 1.2,
        isNearCusp: true,
        fitScore: 2.1,
        navamsaLagnaSign: null,
        positiveTotal: 2.1,
        penaltyTotal: 0,
        priorBonus: 0,
        misses: [],
        supportingEvents: [],
      },
    ],
  },
};

describe('ReportRectification — phase 2 result snapshot', () => {
  it('renders the candidate table with sign, time, navamsa rising and a qualitative reading', () => {
    render(<ReportRectification record={SNAPSHOT_RECORD} events={EVENTS} />);
    const table = screen.getByTestId('report-rectification-candidates');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 candidates
    expect(rows[1].textContent).toContain('Pisces');
    expect(rows[1].textContent).toContain('07:45');
    expect(rows[1].textContent).toContain('Leo'); // navamsa rising, localized
    expect(rows[1].textContent).toContain('Confirmed choice');
    expect(rows[2].textContent).toContain('Aquarius');
    expect(rows[2].textContent).toContain('Alternative');
    expect(rows[2].textContent).toContain('—'); // null navamsa lagna
  });

  it('renders per-event evidence with depth labels + polarity readings, never raw keys', () => {
    render(<ReportRectification record={SNAPSHOT_RECORD} events={EVENTS} />);
    const table = screen.getByTestId('report-rectification-evidence');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 evidence rows
    expect(rows[1].textContent).toMatch(/antar/i);
    expect(rows[1].textContent).toMatch(/navamsa/i);
    expect(rows[1].textContent).toContain('Supports');
    expect(rows[2].textContent).toContain('Counts against');
    expect(table.textContent).not.toContain('ad_lord_rules_h7');
    expect(table.textContent).not.toContain('miss_unexplained');
    // Evidence dates stay date-safe (2015-06-20 never rolls back a day).
    expect(rows[1].textContent).toContain('06/20/2015');
  });

  it('lists the quiet-period misses qualitatively and prints the prior note', () => {
    render(<ReportRectification record={SNAPSHOT_RECORD} events={EVENTS} />);
    expect(screen.getByTestId('report-rectification-misses').textContent).toMatch(
      /showed a strong marriage window with nothing reported/i,
    );
    expect(screen.getByTestId('report-rectification-prior').textContent).toMatch(
      /closest to the recorded time/i,
    );
  });

  it('QUALITATIVE ONLY: no %, no margin, no fit-score fragments anywhere', () => {
    render(<ReportRectification record={SNAPSHOT_RECORD} events={EVENTS} />);
    const text = screen.getByTestId('report-rectification').textContent ?? '';
    expect(text).not.toContain('%');
    expect(text).not.toContain('0.7341');
    expect(text).not.toContain('3.55');
    expect(text).not.toContain('1.85');
    expect(text).not.toContain('0.35');
  });
});

// ---------------------------------------------------------------------------
// Rigor Stage 3: aggregate confidence % (Tier E) + opposing vectors.
// The AGGREGATE margin*100 becomes a calibrated %; per-signal evidence stays
// words + polarity only (the honesty covenant, amended in rectifySignals.ts).
// ---------------------------------------------------------------------------

const CONFIDENT_RECORD: RectificationRecord = {
  ...SNAPSHOT_RECORD,
  band: 'consistent',
  resultSnapshot: {
    ...SNAPSHOT_RECORD.resultSnapshot!,
    band: 'consistent',
    margin: 0.42,
    discriminatingEventCount: 5,
    confidencePct: 42,
    honestyNoteKey: 'rectify.honesty.consistent',
  },
};

const INCONCLUSIVE_RECORD: RectificationRecord = {
  ...SNAPSHOT_RECORD,
  band: 'near_tie',
  resultSnapshot: {
    ...SNAPSHOT_RECORD.resultSnapshot!,
    band: 'near_tie',
    margin: 0.08,
    discriminatingEventCount: 2,
    confidencePct: null,
    honestyNoteKey: 'rectify.honesty.near_tie',
  },
};

describe('ReportRectification — Stage 3 confidence % + opposing vectors', () => {
  it('shows the calibrated % and "confirmed by N of your events" beside the band', () => {
    render(<ReportRectification record={CONFIDENT_RECORD} events={EVENTS} />);
    const band = screen.getByTestId('report-rectification-band');
    expect(band.textContent).toContain('Consistent'); // the band word survives
    expect(band.textContent).toContain('42%');
    expect(band.textContent).toMatch(/confirmed by 5 of your events/i);
  });

  it('explains the % means best-fit-vs-runner-up, never "odds the time is right"', () => {
    render(<ReportRectification record={CONFIDENT_RECORD} events={EVENTS} />);
    const section = screen.getByTestId('report-rectification');
    expect(section.textContent).toMatch(/how much better your best-fit/i);
    // The raw margin decimal is NEVER shown — only its calibrated % form.
    expect(section.textContent).not.toContain('0.42');
  });

  it('surfaces supporting-vs-opposing totals as honest COUNTS (never raw score floats)', () => {
    render(<ReportRectification record={CONFIDENT_RECORD} events={EVENTS} />);
    const balance = screen.getByTestId('report-rectification-balance');
    expect(balance.textContent).toMatch(/supporting fit/i);
    expect(balance.textContent).toMatch(/quiet-period|unexplained/i);
    // Never the raw positive_total / penalty_total floats.
    expect(balance.textContent).not.toContain('3.55');
    expect(balance.textContent).not.toContain('0.15');
  });

  it('keeps per-signal evidence cells words-only — no %, no per-signal number', () => {
    render(<ReportRectification record={CONFIDENT_RECORD} events={EVENTS} />);
    const evidence = screen.getByTestId('report-rectification-evidence');
    expect(evidence.textContent).not.toContain('%');
    expect(evidence.textContent).not.toContain('1.85'); // the per-event contribution
    expect(evidence.textContent).toContain('Supports');
    expect(evidence.textContent).toContain('Counts against');
  });

  it('renders "inconclusive" (not a small %) below the min-evidence gate', () => {
    render(<ReportRectification record={INCONCLUSIVE_RECORD} events={EVENTS} />);
    const band = screen.getByTestId('report-rectification-band');
    expect(band.textContent).toMatch(/inconclusive|not enough/i);
    expect(band.textContent).not.toMatch(/\d+%/);
  });
});
