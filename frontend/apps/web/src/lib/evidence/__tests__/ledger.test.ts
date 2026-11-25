/**
 * The anti-hallucination guard, and the keyless report.
 *
 * The central test in this file feeds the model layer a FABRICATED citation —
 * a yoga that is not in the chart — and asserts the statement never reaches the
 * document. It is the guard the whole feature rests on: without it, an Evidence
 * block is a device for making invented prose look derived.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildEvidenceLedger } from '../ledger';
import { validateAnnotations } from '../annotations';
import { buildObservations } from '../observations';
import { buildEvidenceSection } from '../../../components/report-pdf/buildEvidenceSection';
import { maximalReportT } from '../../../components/report-pdf/__tests__/maximalReportFixture';
import { formatPredictiveDate } from '../../predictive';
import { nearCuspChart, secureLagnaChart } from './evidenceFixtures';

function legacyNearCuspChart() {
  const chart = nearCuspChart();
  return {
    ...chart,
    lagna: {
      ...chart.lagna,
      lagna_cusp_distance_deg: undefined,
      lagna_adjacent_sign: undefined,
      is_near_cusp: undefined,
    },
  };
}

const REAL_YOGA_OBSERVATION = 'yoga:Test House Yoga';
const FABRICATED_YOGA_OBSERVATION = 'yoga:Gaja Kesari Yoga';
const HALLUCINATED_PROSE =
  'Protect your time, energy and money rather than giving them away too freely.';

describe('the citation validator fails closed', () => {
  it('REJECTS a statement citing a yoga that is not in this chart', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [
        { observation_id: FABRICATED_YOGA_OBSERVATION, interpretation: HALLUCINATED_PROSE },
      ],
    });

    // The prose does not render anywhere: not as a row, not as general guidance,
    // not with a warning. A statement asserting a derivation that did not happen
    // has forfeited its place.
    const rendered = JSON.stringify(ledger);
    expect(rendered).not.toContain(HALLUCINATED_PROSE);
    expect(ledger.rows.every((row) => row.interpretation === null)).toBe(true);
    expect(ledger.generalGuidance).toEqual([]);

    // But the drop is COUNTED, so provenance can say it happened.
    expect(ledger.rejectedCount).toBe(1);
    expect(ledger.rejectedCitations).toEqual([FABRICATED_YOGA_OBSERVATION]);
  });

  it('REJECTS a statement whose SUPPORTING citation is fabricated', () => {
    // Three real citations and one invented one is not 75% true.
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [
        {
          observation_id: REAL_YOGA_OBSERVATION,
          interpretation: HALLUCINATED_PROSE,
          also_cites: ['dignity:venus', 'dignity:pluto'],
        },
      ],
    });
    expect(JSON.stringify(ledger)).not.toContain(HALLUCINATED_PROSE);
    expect(ledger.rejectedCount).toBe(1);
    expect(ledger.rejectedCitations).toEqual(['dignity:pluto']);
  });

  it('ACCEPTS a statement citing only factors this chart computed', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [
        {
          observation_id: REAL_YOGA_OBSERVATION,
          interpretation: 'Wealth accrues through partnership rather than salary.',
          also_cites: ['dignity:venus', 'combustion:venus'],
        },
      ],
    });
    const row = ledger.rows.find((candidate) => candidate.observation.id === REAL_YOGA_OBSERVATION);
    expect(row?.interpretation).toBe('Wealth accrues through partnership rather than salary.');
    expect(row?.alsoCites).toEqual(['dignity:venus', 'combustion:venus']);
    expect(ledger.rejectedCount).toBe(0);
    expect(ledger.annotated).toBe(true);
  });

  it('keeps DECLARED-ungrounded prose, apart, with no evidence attached to it', () => {
    // The model saying "this one is not from the chart" is honest, so the
    // statement survives — in its own section, with no Evidence, Confidence or
    // Alternative beside it. Deleting it would hide from the reader that the
    // model was talking rather than the chart.
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      general_guidance: [HALLUCINATED_PROSE],
    });
    expect(ledger.generalGuidance).toEqual([HALLUCINATED_PROSE]);
    expect(ledger.rows.every((row) => row.interpretation === null)).toBe(true);
    expect(ledger.rejectedCount).toBe(0);
  });

  it('rejects malformed rows without throwing on untrusted input', () => {
    const observations = buildObservations(nearCuspChart());
    const result = validateAnnotations(
      {
        readings: [
          null,
          'a bare string',
          { observation_id: 42, interpretation: 'x' },
          { observation_id: 'lagna', interpretation: '   ' },
          { observation_id: 'lagna', interpretation: 'ok', also_cites: 'not-an-array' },
        ],
      },
      observations.observationIds,
      observations.factorIds,
    );
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'malformed',
      'malformed',
      'malformed',
      'empty-interpretation',
    ]);
    // `also_cites: 'not-an-array'` degrades to no extra citations, not a throw.
    expect(result.accepted).toHaveLength(1);
  });

  // Northstar, PR #366: annotation prose is user-facing reading text, so it passes the same
  // reflection check as chat and the readings. A statement that foretells or guesses what the
  // person lived through is rejected (counted), in any app language.
  it('rejects an interpretation or guidance that foretells or guesses lived experience', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [{ observation_id: 'lagna', interpretation: 'You will get married in 2027.' }],
      general_guidance: ['Vas a conseguir un ascenso.', 'Patience with paperwork is a theme here.'],
    });
    expect(ledger.rows.find((row) => row.observation.id === 'lagna')?.interpretation).toBeNull();
    expect(ledger.generalGuidance).toEqual(['Patience with paperwork is a theme here.']);
    expect(ledger.rejectedCount).toBe(2);
  });

  it('rejects a second interpretation of the same observation', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [
        { observation_id: 'lagna', interpretation: 'first' },
        { observation_id: 'lagna', interpretation: 'second' },
      ],
    });
    expect(ledger.rows.find((row) => row.observation.id === 'lagna')?.interpretation).toBe('first');
    expect(ledger.rejectedCount).toBe(1);
    expect(ledger.otherRejectedCount).toBe(1);
    expect(ledger.unsupportedCount).toBe(0);
    expect(ledger.rejectedCitations).toEqual([]);
  });

  it('never accuses valid factors rejected for non-reflective prose of being absent from the chart', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [
        { observation_id: 'lagna', interpretation: 'You will get married in 2027.' },
        { observation_id: REAL_YOGA_OBSERVATION, interpretation: 'You will receive a windfall next year.' },
      ],
    });
    expect(ledger.rejectedCount).toBe(2);
    expect(ledger.reflectionRejectedCount).toBe(2);
    expect(ledger.unsupportedCount).toBe(0);
    expect(ledger.rejectedCitations).toEqual([]);

    const section = buildEvidenceSection(ledger, maximalReportT());
    expect(section.rejectedNote).toContain('non-reflective phrasing');
    expect(section.rejectedNote).not.toContain('does not contain');
    expect(section.rejectedNote).not.toContain('lagna');
    expect(section.rejectedNote).not.toContain(REAL_YOGA_OBSERVATION);
  });

  it('classifies rolled-over classical dasha citations as stale-dasha and explains the rollover on empty dasha rows', () => {
    const base = nearCuspChart();
    const rolledChart = {
      ...base,
      dashas: {
        ...base.dashas,
        current_pratyantar: {
          lord: 'ketu',
          start_date: '2026-11-24T18:57:22.961049Z',
          end_date: '2027-01-31T06:13:52.961049Z',
          duration_years: 0.18472222222222223,
        },
      },
    };
    const ledger = buildEvidenceLedger(rolledChart, {
      readings: [
        { observation_id: 'lagna', interpretation: 'Aquarius ascendant emphasizes systems thinking.' },
        {
          observation_id: 'dasha:pratyantar:saturn/venus/mercury',
          interpretation: 'Prior pratyantar period reflection.',
        },
        {
          observation_id: REAL_YOGA_OBSERVATION,
          interpretation: 'Partnership themes are highlighted.',
          also_cites: ['dasha:pratyantar:saturn/venus/mercury'],
        },
      ],
    });
    expect(ledger.annotated).toBe(true);
    expect(ledger.staleDashaCount).toBe(2);
    expect(ledger.unsupportedCount).toBe(0);
    expect(ledger.rejectedCitations).toEqual([]);

    const section = buildEvidenceSection(ledger, maximalReportT());
    expect(section.rejectedNote).toContain('expired after a period rollover');
    expect(section.rejectedNote).not.toContain('does not contain');
    const pratyantarRow = section.rows.find((r) => r.observationId === 'dasha:pratyantar:saturn/venus/ketu');
    const mahaRow = section.rows.find((r) => r.observationId === 'dasha:maha:saturn');
    expect(pratyantarRow?.interpretation).toContain('regenerate the reading to annotate this period');
    expect(mahaRow?.interpretation).not.toContain('regenerate the reading to annotate this period');
  });

  it('keeps hallucinated or future dasha lords fail-closed as unsupported citations (never stale-dasha)', () => {
    const ledger = buildEvidenceLedger(nearCuspChart(), {
      readings: [
        { observation_id: 'dasha:maha:mars', interpretation: 'Hallucinated Mars mahadasha.' },
        {
          observation_id: 'dasha:pratyantar:saturn/venus/sun',
          interpretation: 'Future or wrong pratyantar lord.',
        },
      ],
    });
    expect(ledger.unsupportedCount).toBe(2);
    expect(ledger.staleDashaCount).toBe(0);
    expect(ledger.rejectedCitations).toEqual([
      'dasha:maha:mars',
      'dasha:pratyantar:saturn/venus/sun',
    ]);
  });

  it('keeps non-reflective prose on a rolled-over dasha classified as not-reflection and records all multi-level rollover ids', () => {
    const base = nearCuspChart();
    const dualRolledChart = {
      ...base,
      dashas: {
        ...base.dashas,
        maha_dasha_sequence: base.dashas.maha_dasha_sequence.map(({ antar_sequence: _omit, ...m }) => m),
        current_antar: {
          lord: 'sun',
          start_date: '2027-01-31T06:13:52.961049Z',
          end_date: '2028-01-13T00:00:00Z',
          duration_years: 0.95,
        },
        current_pratyantar: {
          lord: 'sun',
          start_date: '2027-01-31T06:13:52.961049Z',
          end_date: '2027-02-17T00:00:00Z',
          duration_years: 0.05,
        },
      },
    };
    const ledger = buildEvidenceLedger(dualRolledChart, {
      readings: [
        { observation_id: 'lagna', interpretation: 'Aquarius ascendant reflects systematic effort.' },
        {
          observation_id: 'dasha:antar:saturn/venus',
          interpretation: 'You will get promoted next month.',
        },
        {
          observation_id: REAL_YOGA_OBSERVATION,
          interpretation: 'Partnership themes are active.',
          also_cites: ['dasha:antar:saturn/venus', 'dasha:pratyantar:saturn/venus/ketu'],
        },
      ],
    });
    expect(ledger.reflectionRejectedCount).toBe(1);
    expect(ledger.staleDashaCount).toBe(1);
    expect(ledger.staleDashaLevels).toEqual(['antar', 'pratyantar']);
    // Birth Mahā has no prior Mahā in maha_dasha_sequence, so citing previous cyclic maha stays unsupported.
    const birthMahaHallucination = buildEvidenceLedger(base, {
      readings: [
        { observation_id: 'dasha:maha:jupiter', interpretation: 'Prior Jupiter mahadasha.' },
      ],
    });
    expect(birthMahaHallucination.unsupportedCount).toBe(1);
    expect(birthMahaHallucination.staleDashaCount).toBe(0);
  });

  it('still fails closed as unknown-factor when a fabricated factor accompanies a stale dasha in also_cites', () => {
    const base = nearCuspChart();
    const rolledChart = {
      ...base,
      dashas: {
        ...base.dashas,
        current_pratyantar: {
          lord: 'ketu',
          start_date: '2026-11-24T18:57:22.961049Z',
          end_date: '2027-01-31T06:13:52.961049Z',
          duration_years: 0.18472222222222223,
        },
      },
    };
    const ledger = buildEvidenceLedger(rolledChart, {
      readings: [
        {
          observation_id: REAL_YOGA_OBSERVATION,
          interpretation: 'Partnership themes are highlighted.',
          also_cites: ['dasha:pratyantar:saturn/venus/mercury', 'dignity:pluto'],
        },
      ],
    });
    expect(ledger.unsupportedCount).toBe(1);
    expect(ledger.staleDashaCount).toBe(0);
    expect(ledger.rejectedCitations).toEqual(['dignity:pluto']);
  });
});

describe('evidence section dasha date timezone parity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { zone: 'America/Los_Angeles', expectedIso: '2027-01-30', expectedDisplay: 'Jan 30, 2027' },
    { zone: 'Asia/Kolkata', expectedIso: '2027-01-31', expectedDisplay: 'Jan 31, 2027' },
  ])(
    'matches formatPredictiveDate calendar day in $zone for an instant crossing UTC midnight',
    ({ zone, expectedIso, expectedDisplay }) => {
      vi.stubEnv('TZ', zone);
      const chart = nearCuspChart();
      const handoverIso = chart.dashas.current_antar!.end_date;
      const section = buildEvidenceSection(buildEvidenceLedger(chart), maximalReportT());
      const antarRow = section.rows.find((r) => r.observationId === 'dasha:antar:saturn/venus');
      expect(antarRow?.observation).toContain(expectedIso);
      expect(formatPredictiveDate(handoverIso)).toBe(expectedDisplay);
    },
  );
});

describe('the keyless report is complete without any model', () => {
  it('gives every row Observation, Evidence, Confidence and Alternative', () => {
    const ledger = buildEvidenceLedger(nearCuspChart());
    expect(ledger.rows.length).toBeGreaterThan(0);
    expect(ledger.annotated).toBe(false);
    for (const row of ledger.rows) {
      expect(row.observation.id).toBeTruthy();
      expect(row.observation.supporting.length).toBeGreaterThan(0);
      expect(['high', 'moderate', 'low']).toContain(row.observation.confidence.level);
      expect(row.observation.alternative.kind).toBeTruthy();
      expect(row.interpretation).toBeNull();
    }
  });

  it('offers the second chart only where the ascendant is genuinely near a boundary', () => {
    expect(buildEvidenceLedger(nearCuspChart()).alternateLagna).not.toBeNull();
    expect(buildEvidenceLedger(secureLagnaChart()).alternateLagna).toBeNull();
  });

  it('gives a near-cusp house claim the ACTUAL second chart, not a hedge', () => {
    const ledger = buildEvidenceLedger(nearCuspChart());
    const row = ledger.rows.find((candidate) => candidate.observation.id === 'rulership:venus');
    expect(row?.observation.alternative).toEqual({
      kind: 'lagnaFork',
      alternateSign: 'Pisces',
      cuspDistanceDeg: 1.183,
      shifts: [{ planet: 'venus', from: 2, to: 1 }],
    });
  });

  it('keeps legacy near-cusp charts consistent across evidence, confidence and alternatives', () => {
    const ledger = buildEvidenceLedger(legacyNearCuspChart());
    const lagna = ledger.rows.find((candidate) => candidate.observation.id === 'lagna');
    const rulership = ledger.rows.find(
      (candidate) => candidate.observation.id === 'rulership:venus',
    );
    const houseYoga = ledger.rows.find(
      (candidate) => candidate.observation.id === 'yoga:Test House Yoga',
    );
    const signYoga = ledger.rows.find(
      (candidate) => candidate.observation.id === 'yoga:Test Sign Yoga',
    );

    expect(ledger.lagnaSensitivity).toEqual({
      currentSign: 'Aquarius',
      alternateSign: 'Pisces',
      cuspDistanceDeg: expect.closeTo(1.183, 6),
    });
    expect(ledger.alternateLagna?.alternateSign).toBe('Pisces');
    expect(lagna?.observation.primary).toMatchObject({
      cuspDistanceDeg: expect.closeTo(1.183, 6),
      adjacentSign: 'Pisces',
    });
    expect(lagna?.observation.alternative.kind).toBe('lagnaFork');

    expect(rulership?.observation.confidence.level).toBe('low');
    expect(rulership?.observation.confidence.deductions).toEqual([
      { code: 'lagna-fork', subject: 'lagna', marginDeg: expect.closeTo(1.183, 6) },
    ]);
    expect(rulership?.observation.alternative.kind).toBe('lagnaFork');

    expect(houseYoga?.observation.confidence.deductions.map((item) => item.code)).toContain(
      'lagna-fork',
    );
    expect(houseYoga?.observation.alternative.kind).toBe('lagnaFork');
    expect(signYoga?.observation.confidence.deductions).toEqual([]);
    expect(signYoga?.observation.alternative).toEqual({
      kind: 'none',
      reason: 'dignity-by-sign',
    });
  });

  it('never calls a near-cusp chart secure when alternate projection fails closed', () => {
    const chart = legacyNearCuspChart();
    const inconsistent = {
      ...chart,
      planets: {
        ...chart.planets,
        sun: { ...chart.planets.sun, house: 7 },
      },
    };
    const ledger = buildEvidenceLedger(inconsistent);
    const rulership = ledger.rows.find(
      (candidate) => candidate.observation.id === 'rulership:venus',
    );
    const houseYoga = ledger.rows.find(
      (candidate) => candidate.observation.id === 'yoga:Test House Yoga',
    );

    expect(ledger.lagnaSensitivity).not.toBeNull();
    expect(ledger.alternateLagna).toBeNull();
    expect(rulership?.observation.confidence.deductions.map((item) => item.code)).toContain(
      'lagna-fork',
    );
    expect(rulership?.observation.alternative.kind).toBe('lagnaForkUnavailable');
    expect(houseYoga?.observation.alternative.kind).toBe('lagnaForkUnavailable');
  });

  it('says plainly when a claim has NO material alternative, instead of hedging', () => {
    const ledger = buildEvidenceLedger(nearCuspChart());
    const row = ledger.rows.find((candidate) => candidate.observation.id === 'retrograde:saturn');
    expect(row?.observation.alternative).toEqual({ kind: 'none', reason: 'apparent-motion' });
  });

  it('quantifies the dasha alternative from the engine OWN convention vocabulary', () => {
    const ledger = buildEvidenceLedger(nearCuspChart());
    const row = ledger.rows.find((candidate) => candidate.observation.id === 'dasha:maha:saturn');
    const alternative = row?.observation.alternative;
    expect(alternative?.kind).toBe('dashaConvention');
    if (alternative?.kind !== 'dashaConvention') {
      throw new Error('expected a convention alternative');
    }
    // A 19-year period under the savana (360-day) year ends 99.75 days earlier.
    const savana = alternative.shifts.find((shift) => shift.convention === 'savana_360');
    expect(savana?.deltaDays).toBeCloseTo(-99.75, 6);
  });
});

describe('observations must distinguish THIS chart from any other', () => {
  it('omits the shadow nodes from retrogradation — they are retrograde always', () => {
    const chart = nearCuspChart();
    const withNodes = {
      ...chart,
      planets: {
        ...chart.planets,
        rahu: {
          ...chart.planets.saturn,
          name: 'rahu',
          sign: 'Sagittarius',
          house: 11,
          is_retrograde: true,
          combustion_separation_deg: null,
          houses_ruled: [],
          dignity: 'neutral',
        },
      },
    };
    const ids = buildEvidenceLedger(withNodes).rows.map((row) => row.observation.id);
    expect(ids).not.toContain('retrograde:rahu');
    // A genuinely retrograde graha still earns its row.
    expect(ids).toContain('retrograde:saturn');
  });
});
