/**
 * CandidateCard — Spec 062 evidence storytelling on one candidate.
 *
 * Anti-scam invariants under test:
 *  - fit summary is COUNTS ONLY (no scores, no %)
 *  - D9 lagna chip labeled "Navamsa rising" (absent when null)
 *  - prior rendered as a labeled qualitative row ONLY when priorBonus > 0
 *  - misses[] listed qualitatively; raw miss keys never surface
 *
 * All fixtures are synthetic — no real birth data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useLanguageStore } from '@almamesh/store';
import type { RectificationCandidate } from '@almamesh/shared-types';

import '../../../i18n/config';
import { CandidateCard } from './CandidateCard';

const BASE: RectificationCandidate = {
  ascendantSign: 'Pisces',
  representativeTimeLocal: '07:45',
  lagnaLongitudeDeg: 333.8,
  lagnaCuspDistanceDeg: 3.8,
  isNearCusp: false,
  fitScore: 3.4,
  navamsaLagnaSign: 'Leo',
  positiveTotal: 3.55,
  penaltyTotal: 0.15,
  priorBonus: 0.35,
  misses: ['miss_silent_marriage_h7'],
  supportingEvents: [
    {
      eventIndex: 0,
      category: 'marriage',
      date: '2011-06-01',
      signals: ['ad_lord_rules_h7', 'd9_lord_rules_d9_h7'],
      contribution: 1.85,
    },
    {
      eventIndex: 1,
      category: 'career_change',
      date: '2016-02-01',
      signals: ['pd_lord_in_h10', 'slow_transit_h10'],
      contribution: 1.7,
    },
    {
      eventIndex: 2,
      category: 'relocation',
      date: '2019-09-01',
      signals: ['miss_unexplained'],
      contribution: -0.25,
    },
  ],
};

function renderCard(candidate: RectificationCandidate) {
  return render(<CandidateCard candidate={candidate} rank={1} onConfirm={vi.fn()} />);
}

describe('CandidateCard — Spec 062 storytelling', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('shows the D9 lagna chip labeled "Navamsa rising"', () => {
    renderCard(BASE);
    const chip = screen.getByTestId('d9-chip');
    expect(chip.textContent).toMatch(/navamsa rising/i);
    expect(chip.textContent).toContain('Leo');
  });

  it('omits the D9 chip when navamsaLagnaSign is null (older payloads)', () => {
    renderCard({ ...BASE, navamsaLagnaSign: null });
    expect(screen.queryByTestId('d9-chip')).toBeNull();
  });

  it('renders the compact fit summary as COUNTS ONLY', () => {
    renderCard(BASE);
    const summary = screen.getByTestId('fit-summary');
    // 4 positive signals, 1 miss_unexplained event, 1 quiet-period miss
    expect(summary.textContent).toContain('4 supporting fits');
    expect(summary.textContent).toContain('1 unexplained event');
    expect(summary.textContent).toContain('1 quiet-period miss');
  });

  it('omits the zero-count summary parts (only supporting when clean)', () => {
    renderCard({
      ...BASE,
      misses: [],
      supportingEvents: BASE.supportingEvents.slice(0, 2),
    });
    const summary = screen.getByTestId('fit-summary');
    expect(summary.textContent).toContain('4 supporting fits');
    expect(summary.textContent).not.toMatch(/unexplained/);
    expect(summary.textContent).not.toMatch(/quiet-period/);
  });

  it('shows the prior as a labeled qualitative row when priorBonus > 0', () => {
    renderCard(BASE);
    const prior = screen.getByTestId('prior-row');
    expect(prior.textContent).toMatch(/recorded-time nudge/i);
    expect(prior.textContent).toMatch(/closest to the recorded time/i);
    // NEVER the number itself
    expect(prior.textContent).not.toContain('0.35');
  });

  it('hides the prior row when priorBonus is 0', () => {
    renderCard({ ...BASE, priorBonus: 0 });
    expect(screen.queryByTestId('prior-row')).toBeNull();
  });

  it('lists misses qualitatively — localized category, no raw keys', () => {
    renderCard(BASE);
    const misses = screen.getByTestId('miss-list');
    expect(misses.textContent).toMatch(/showed a strong marriage window with nothing reported/i);
    expect(misses.textContent).not.toContain('miss_silent');
    expect(misses.textContent).not.toContain('_h7');
  });

  it('hides the miss list when misses is empty', () => {
    renderCard({ ...BASE, misses: [] });
    expect(screen.queryByTestId('miss-list')).toBeNull();
  });

  it('marks the unexplained event row as counting-against (polarity styling)', () => {
    renderCard(BASE);
    const table = screen.getByTestId('evidence-table');
    const againstRows = table.querySelectorAll('tr[data-polarity="against"]');
    const supportRows = table.querySelectorAll('tr[data-polarity="support"]');
    expect(againstRows).toHaveLength(1);
    expect(supportRows).toHaveLength(2);
    expect(againstRows[0].textContent).toMatch(/counts against/i);
  });

  it('renders NO "%" and NO fitScore/positiveTotal/penaltyTotal/priorBonus numbers', () => {
    const { container } = renderCard(BASE);
    expect(container.textContent).not.toContain('%');
    expect(container.textContent).not.toContain('3.4');
    expect(container.textContent).not.toContain('3.55');
    expect(container.textContent).not.toContain('0.15');
    expect(container.textContent).not.toContain('0.35');
    expect(container.textContent).not.toContain('1.85');
  });

  it('renders valence-qualified signals as a phrase, never the raw #suffix', () => {
    renderCard({
      ...BASE,
      supportingEvents: [
        {
          eventIndex: 0,
          category: 'job_loss',
          date: '2013-03-01',
          signals: ['ad_lord_rules_h8#afflicted_fit'],
          contribution: 0.9,
        },
      ],
    });
    const table = screen.getByTestId('evidence-table');
    expect(table.textContent).toMatch(/afflicted/i);
    expect(table.textContent).not.toContain('#afflicted_fit');
    expect(table.textContent).not.toContain('ad_lord_rules_h8');
  });
});
