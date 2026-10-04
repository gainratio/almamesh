/**
 * ReportYogas — the calibrated STRUCTURAL strength slot (rigor-upgrade Stage 1)
 * AND the per-yoga birth-time stability chip (Stage-4 stable-vs-lagna).
 *
 * Both suites drive the real component with the real i18n config (English), so
 * the assertions target the rendered report exactly as a reader sees it.
 *
 * Stage 1: the "NN% · band" headline, the "structural estimate" tier label, and
 * the signed factor ledger. Bundles stored before the upgrade (no strength
 * fields) must render NO strength block — the presence guard, verified.
 *
 * Stage 4: when a per-claim stability marker is supplied, each yoga shows an
 * honest "birth-time stable / sensitive" WORD (never a number). Absent a marker
 * (older stored payloads), no chip renders and the grade still shows. Synthetic
 * data only.
 */
import '../../../../i18n/config';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { YogaData, YogaStrengthFactor } from '@almamesh/browser/types';

import { ReportYogas } from '../ReportYogas';
import { reportStabilityMarkers, yogaClaimId } from '../../../../lib/stability';

const factor = (
  factor_type: string,
  planet: string,
  value: string,
  mark: number,
): YogaStrengthFactor => ({ factor_type, planet, value, basis: 'BPHS', mark });

const baseYoga: YogaData = {
  name: 'Gajakesari Yoga',
  display_name: 'Gajakesari Yoga',
  category: 'auspicious',
  description: 'Jupiter in a kendra from the Moon.',
  effects: 'Lasting reputation.',
  grade: 'strong',
  strength_factors: [factor('dignity', 'jupiter', 'exalted', 1)],
  planets_involved: ['jupiter', 'moon'],
  houses_involved: [1, 4],
  planetary_signature: 'jupiter_moon_h1_h4',
  formation_rules: [
    { rule: 'gajakesari', description: 'Jupiter in the 1st from the Moon', source: 'BPHS', planets: [], houses: [] },
  ],
};

const strongYoga: YogaData = {
  ...baseYoga,
  net_marks: 4,
  max_favorable: 5,
  max_unfavorable: 6,
  strength_pct: 90.91,
  strength_tier: 'structural',
  strength_factors: [
    factor('dignity', 'jupiter', 'exalted', 1),
    factor('house_class', 'jupiter', 'kendra (house 1)', 1),
    factor('retrograde', 'jupiter', 'retrograde', 1),
    factor('house_class', 'moon', 'kendra (house 4)', 1),
  ],
};

describe('ReportYogas — calibrated structural strength', () => {
  it('renders the NN% · band headline, the tier label, and the signed ledger', () => {
    const { getByTestId } = render(<ReportYogas yogas={[strongYoga]} audience="you" />);
    const block = getByTestId('report-yoga-strength');
    const text = block.textContent ?? '';
    expect(text).toContain('91%'); // 90.91 rounds to the whole-number headline
    expect(text).toContain('strong'); // band word (>=75%)
    expect(text).toContain('structural estimate'); // epistemic tier — never over-claims
    expect(text).toContain('Jupiter exalted +1'); // signed factor ledger, engine words
    expect(text).toContain('Moon kendra (house 4) +1');
    // INVERTED, deliberately: this line used to assert 'net +4 of max +5' — ONE
    // bound — while the engine's percentage divides by max_favorable +
    // max_unfavorable (5 + 6 = 11). A reader checking 4/5 got 80%, not the 91%
    // printed above it. The old assertion pinned that unreproducible display as
    // correct, so it is replaced by one that requires BOTH bounds.
    expect(text).toContain('net +4 on the −6…+5 scale');
    // And the arithmetic the printed line now supports must land on the headline:
    expect(Math.round((100 * (4 - -6)) / (5 - -6))).toBe(91);
  });

  it('renders NO strength block for a pre-upgrade bundle (presence guard)', () => {
    const { queryByTestId, getByTestId } = render(<ReportYogas yogas={[baseYoga]} audience="you" />);
    expect(getByTestId('report-yogas')).toBeTruthy(); // the section still renders
    expect(queryByTestId('report-yoga-strength')).toBeNull(); // but no fabricated %
  });

  it('shows the SAME two-ended scale when the net is unfavorable (it does not flip)', () => {
    const weak: YogaData = {
      ...baseYoga,
      grade: 'weak',
      net_marks: -2,
      max_favorable: 2,
      max_unfavorable: 2,
      strength_pct: 0,
      strength_tier: 'structural',
      strength_factors: [
        factor('dignity', 'sun', 'debilitated', -1),
        factor('house_class', 'sun', 'dusthana (house 6)', -1),
      ],
    };
    const { getByTestId } = render(<ReportYogas yogas={[weak]} audience="you" />);
    // Was /net −2 of min −2/ — the display switched which single bound it showed
    // depending on the sign of the net, which made the denominator look like it
    // changed too. It never did: the scale is always [−max_unfavorable, +max_favorable].
    const text = within(getByTestId('report-yoga-strength')).getByText(/net −2 on the −2…\+2 scale/);
    expect(text).toBeTruthy();
  });
});

const YOGA = {
  name: 'gaja_kesari',
  display_name: 'Gaja-Kesari',
  category: 'raja',
  description: 'A benefic Moon–Jupiter configuration.',
  effects: 'Wisdom and standing.',
  grade: 'strong',
  strength_factors: [],
  planets_involved: ['Jupiter', 'Moon'],
  houses_involved: [1],
  planetary_signature: 'gk-sig',
  formation_rules: [{ rule: 'r', description: 'd', source: 'BPHS', planets: [], houses: [] }],
} as unknown as YogaData;

describe('ReportYogas — stability chip', () => {
  it('marks a yoga birth-time STABLE when the lagna is clear of a cusp', () => {
    const stability = reportStabilityMarkers(
      [{ claimId: yogaClaimId('gaja_kesari'), houseDependent: true }],
      false,
    );
    render(<ReportYogas yogas={[YOGA]} audience="you" stability={stability} />);
    const chip = screen.getByTestId('report-stability-chip');
    expect(chip.getAttribute('data-variant')).toBe('stable');
    expect(chip.textContent).toContain('stable');
  });

  it('marks a yoga birth-time SENSITIVE when the lagna sits on a cusp', () => {
    const stability = reportStabilityMarkers(
      [{ claimId: yogaClaimId('gaja_kesari'), houseDependent: true }],
      true,
    );
    render(<ReportYogas yogas={[YOGA]} audience="you" stability={stability} />);
    const chip = screen.getByTestId('report-stability-chip');
    expect(chip.getAttribute('data-variant')).toBe('sensitive');
    expect(chip.textContent).toContain('sensitive');
  });

  it('renders no chip when no stability marker is supplied', () => {
    render(<ReportYogas yogas={[YOGA]} audience="you" />);
    expect(screen.queryByTestId('report-stability-chip')).toBeNull();
    // the grade still renders
    expect(screen.getByTestId('report-yogas').textContent).toContain('strong');
  });
});
