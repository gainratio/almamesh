/**
 * ReportEvidence — the on-screen half of "Evidence & Confidence".
 *
 * The property under test is SAMENESS OF SOURCE, not prettiness: the screen and
 * the exported PDF must print the same observation rows, from the same ledger,
 * with the same cited factor ids. So the assertions are written against
 * `buildEvidenceLedger` output directly — if the component ever starts inventing,
 * dropping or reordering rows, these go red by id.
 *
 * All charts are SYNTHETIC (`lib/evidence/__tests__/evidenceFixtures`) — no real
 * birth data lives in this repository.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import '../../../../i18n/config';
import { ReportEvidence } from '../ReportEvidence';
import { buildEvidenceLedger, buildObservations } from '../../../../lib/evidence';
import {
  nearCuspChart,
  secureLagnaChart,
} from '../../../../lib/evidence/__tests__/evidenceFixtures';

describe('ReportEvidence — the on-screen evidence ledger', () => {
  it('renders one labelled row per computed observation, keyed by factor id', () => {
    const chart = nearCuspChart();
    const ledger = buildEvidenceLedger(chart);
    render(<ReportEvidence chart={chart} />);

    const section = screen.getByTestId('report-evidence');
    expect(section).toBeTruthy();
    expect(ledger.rows.length).toBeGreaterThan(0);

    for (const row of ledger.rows) {
      const rendered = screen.getByTestId(`report-evidence-row-${row.observation.id}`);
      expect(rendered, `row ${row.observation.id} must render`).toBeTruthy();
      // Every cited factor id is PRINTED, so a reader can check the claim against
      // the chart rather than trusting the sentence beside it.
      for (const factor of row.observation.supporting) {
        expect(
          rendered.textContent ?? '',
          `row ${row.observation.id} must cite ${factor.id}`,
        ).toContain(factor.id);
      }
    }
  });

  it('prints the ceiling table and both deduction thresholds from the real constants', () => {
    render(<ReportEvidence chart={nearCuspChart()} />);
    const method = screen.getByTestId('report-evidence-method').textContent ?? '';
    // The ceiling table — the reader must be able to reproduce every level.
    expect(method).toContain('High');
    expect(method).toContain('Moderate');
    expect(method).toContain('Low');
    // The thresholds, interpolated from CUSP_THRESHOLD_DEG / BOUNDARY_MARGIN_DEG.
    expect(method).toContain('3.00°');
    expect(method).toContain('1.00°');
  });

  it('prints the full alternate-chart table when the ascendant is near a cusp', () => {
    const chart = nearCuspChart();
    const ledger = buildEvidenceLedger(chart);
    render(<ReportEvidence chart={chart} />);

    const alternate = screen.getByTestId('report-evidence-alternate').textContent ?? '';
    expect(ledger.alternateLagna).not.toBeNull();
    expect(alternate).toContain(ledger.alternateLagna?.alternateSign ?? '');
    expect(alternate).toContain('1.18°');
    for (const shift of ledger.alternateLagna?.shifts ?? []) {
      // Engine planet keys are lower-case; the report title-cases them for display.
      expect(alternate.toLowerCase(), `shift for ${shift.planet} must print`).toContain(
        `${shift.planet}: house ${shift.from}`,
      );
    }
    // The report must NOT imply a birth-time precision it never computed.
    expect(alternate.toLowerCase()).toContain('minute');
  });

  it('prints the same cusp fork and deduction for a legacy chart without cusp metadata', () => {
    const chart = nearCuspChart();
    const legacy = {
      ...chart,
      lagna: {
        ...chart.lagna,
        lagna_cusp_distance_deg: undefined,
        lagna_adjacent_sign: undefined,
        is_near_cusp: undefined,
      },
    };
    render(<ReportEvidence chart={legacy} />);

    const alternate = screen.getByTestId('report-evidence-alternate').textContent ?? '';
    const lagna = screen.getByTestId('report-evidence-row-lagna').textContent ?? '';
    const rulership = screen.getByTestId('report-evidence-row-rulership:venus').textContent ?? '';
    const houseYoga = screen.getByTestId('report-evidence-row-yoga:Test House Yoga').textContent ?? '';

    expect(alternate).toContain('Pisces');
    expect(alternate).toContain('1.18°');
    expect(lagna).not.toContain('well inside its sign');
    expect(rulership).toContain('Low');
    expect(rulership).toContain('lagna fork');
    expect(rulership).not.toContain('no deductions apply');
    expect(houseYoga).toContain('lagna fork');
    expect(houseYoga).not.toContain('sign placement alone');
  });

  it('keeps the cusp warning when exact alternate-house projection fails closed', () => {
    const chart = nearCuspChart();
    const inconsistent = {
      ...chart,
      planets: {
        ...chart.planets,
        sun: { ...chart.planets.sun, house: 7 },
      },
    };
    render(<ReportEvidence chart={inconsistent} />);

    const alternate = screen.getByTestId('report-evidence-alternate').textContent ?? '';
    const rulership = screen.getByTestId('report-evidence-row-rulership:venus').textContent ?? '';

    expect(alternate).toContain('every house-dependent finding must be recomputed');
    expect(alternate).toContain('Exact house shifts are withheld');
    expect(alternate).toContain('does not make the ascendant secure');
    expect(rulership).toContain('must be recomputed');
    expect(rulership).toContain('Exact shifts are withheld');
    expect(rulership).not.toContain('well inside its sign');
  });

  it('omits the alternate-chart table when the ascendant sits well inside its sign', () => {
    render(<ReportEvidence chart={secureLagnaChart()} />);
    expect(screen.queryByTestId('report-evidence-alternate')).toBeNull();
  });

  it('says plainly that a row has no written interpretation instead of inventing one', () => {
    const chart = secureLagnaChart();
    const ledger = buildEvidenceLedger(chart);
    render(<ReportEvidence chart={chart} />);
    const first = ledger.rows[0];
    expect(first?.interpretation).toBeNull();
    const rendered = screen.getByTestId(`report-evidence-row-${first?.observation.id}`);
    expect((rendered.textContent ?? '').toLowerCase()).toContain('no written interpretation');
  });
});

describe('ReportEvidence — model annotations on screen', () => {
  /**
   * The on-screen half of "wired, not just built". The PDF export already
   * threads stored annotations through; if the screen quietly ignores them, the
   * two surfaces disagree about the same reading — which is the exact drift the
   * shared builder exists to prevent.
   */
  it('renders VALIDATED model prose and drops a fabricated citation', () => {
    const chart = nearCuspChart();
    const observationId = buildObservations(chart).observations[0].id;
    render(
      <ReportEvidence
        chart={chart}
        annotations={{
          readings: [
            { observation_id: observationId, interpretation: 'GROUNDED_SENTINEL' },
            { observation_id: 'yoga:Not In This Chart', interpretation: 'HALLUCINATED_SENTINEL' },
          ],
          general_guidance: ['UNGROUNDED_SENTINEL'],
        }}
      />,
    );
    const section = screen.getByTestId('report-evidence');
    expect(section.textContent).toContain('GROUNDED_SENTINEL');
    expect(section.textContent).not.toContain('HALLUCINATED_SENTINEL');
    // Declared-ungrounded prose survives, apart, and the rejection is disclosed.
    expect(section.textContent).toContain('UNGROUNDED_SENTINEL');
    expect(section.textContent).toContain('Not In This Chart');
  });
});
