/**
 * buildEvidenceSection — the ONE reshaper from `EvidenceLedger` to the
 * pre-formatted "Evidence & Confidence" section, used by BOTH renderers.
 *
 * WHY ONE BUILDER. The screen and the PDF have drifted before, and the fix is
 * structural: they call this function with the same `t`, so there is no second
 * place where a sentence could be phrased differently, a number rounded
 * differently, or a cell quietly dropped. The only difference between the two
 * callers is `text` — the PDF passes `glyphSafe` (its embedded font subset has
 * no arrows or IAST diacritics), the screen passes nothing.
 *
 * WHAT IT MAY AND MAY NOT DO. It formats; it never computes. Every number below
 * is read straight off a `ChartFactor` the engine produced, printed to a fixed
 * precision (two decimal places for degrees) so a reader can recompute a
 * confidence level from the values sitting next to it. There is no branch that
 * invents an interpretation: a row with no model prose prints, in words, that it
 * has none.
 */

import type { TFunction } from 'i18next';
import {
  BOUNDARY_MARGIN_DEG,
  CUSP_THRESHOLD_DEG,
  type AlternateLagna,
  type Alternative,
  type ChartFactor,
  type ConfidenceDeduction,
  type ConfidenceVerdict,
  type EvidenceLedger,
  type EvidenceRow,
  type FactorClass,
  type LagnaSensitivity,
} from '../../lib/evidence';
import type {
  ReportPdfEvidence,
  ReportPdfEvidenceRow,
  ReportPdfLabeledValue,
} from './types';

/** A presentation-only string transform (`glyphSafe` for the PDF, identity on screen). */
export type EvidenceText = (value: string) => string;

interface Copy {
  readonly tr: TFunction;
  readonly text: EvidenceText;
}

/** Localize + transform in one step, so no leaf can skip the transform. */
function line(copy: Copy, key: string, vars?: Record<string, string | number>): string {
  return copy.text(copy.tr(`evidence.${key}`, vars ?? {}));
}

/** Degrees, always to two decimal places — the report's stated precision. */
function degrees(value: number): string {
  return `${value.toFixed(2)}°`;
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value)}`;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/** The calendar day of an engine ISO instant — periods are dated, not clocked. */
function isoDay(value: string): string {
  return value.slice(0, 10);
}

function joinOr(copy: Copy, values: readonly (string | number)[]): string {
  return values.length > 0 ? values.join(', ') : line(copy, 'none');
}

function classLabel(copy: Copy, factorClass: FactorClass): string {
  return line(copy, `class_${factorClass}`);
}

function levelLabel(copy: Copy, level: string): string {
  return line(copy, `level_${level}`);
}

/* ── The Observation cell ─────────────────────────────────────────────────── */

/** One sentence stating what was computed. Never a judgement about it. */
function observationSentence(copy: Copy, primary: ChartFactor): string {
  switch (primary.kind) {
    case 'lagna':
      return line(copy, 'observation_lagna', {
        sign: primary.sign,
        degrees: degrees(primary.signDegrees),
      });
    case 'position':
      return line(copy, 'observation_position', {
        planet: titleCase(primary.planet),
        sign: primary.sign,
        degrees: degrees(primary.signDegrees),
        nakshatra: primary.nakshatra,
        pada: primary.pada,
      });
    case 'dignity':
      return line(copy, 'observation_dignity', {
        planet: titleCase(primary.planet),
        dignity: primary.dignity,
        sign: primary.sign,
      });
    case 'combustion':
      return line(copy, primary.combust ? 'observation_combust' : 'observation_not_combust', {
        planet: titleCase(primary.planet),
        separation: degrees(primary.separationDeg),
        orb: degrees(primary.orbDeg),
      });
    case 'retrograde':
      return line(copy, 'observation_retrograde', {
        planet: titleCase(primary.planet),
        speed: degrees(primary.speedDegPerDay),
      });
    case 'housePlacement':
      return line(copy, 'observation_house_placement', {
        planet: titleCase(primary.planet),
        house: primary.house,
        sign: primary.sign,
      });
    case 'rulership':
      return line(
        copy,
        primary.yogakaraka ? 'observation_rulership_yogakaraka' : 'observation_rulership',
        {
          planet: titleCase(primary.planet),
          houses: joinOr(copy, primary.housesRuled),
          // `count` drives i18next pluralization: "rules house 4" vs "rules
          // houses 4 and 9". A hardcoded "house(s)" would read as a form field.
          count: primary.housesRuled.length,
        },
      );
    case 'dasha':
      return line(copy, 'observation_dasha', {
        lord: titleCase(primary.lord),
        level: line(copy, `dasha_level_${primary.level}`),
        start: isoDay(primary.startIso),
        end: isoDay(primary.endIso),
      });
    case 'yoga':
      return line(copy, 'observation_yoga', {
        name: primary.name,
        grade: primary.grade,
        category: primary.category,
      });
    case 'yogaStrength':
      return line(copy, 'observation_yoga_strength', {
        name: primary.name,
        pct: percent(primary.strengthPct),
        net: signed(primary.netMarks),
      });
  }
}

/* ── The Evidence cell ────────────────────────────────────────────────────── */

/** The MEASURED values behind one cited factor. Never its meaning. */
function factorMeasure(copy: Copy, factor: ChartFactor): string {
  switch (factor.kind) {
    case 'lagna':
      return factor.cuspDistanceDeg === null || factor.adjacentSign === null
        ? line(copy, 'measure_lagna', {
            sign: factor.sign,
            degrees: degrees(factor.signDegrees),
          })
        : line(copy, 'measure_lagna_cusp', {
            sign: factor.sign,
            degrees: degrees(factor.signDegrees),
            distance: degrees(factor.cuspDistanceDeg),
            adjacent: factor.adjacentSign,
          });
    case 'position':
      return line(copy, 'measure_position', {
        sign: factor.sign,
        degrees: degrees(factor.signDegrees),
        nakshatra: factor.nakshatra,
        pada: factor.pada,
      });
    case 'dignity':
      return line(copy, 'measure_dignity', {
        dignity: factor.dignity,
        sign: factor.sign,
        degrees: degrees(factor.signDegrees),
      });
    case 'combustion':
      return line(copy, 'measure_combustion', {
        separation: degrees(factor.separationDeg),
        orb: degrees(factor.orbDeg),
        verdict: line(copy, factor.combust ? 'yes' : 'no'),
      });
    case 'retrograde':
      return line(copy, 'measure_retrograde', { speed: degrees(factor.speedDegPerDay) });
    case 'housePlacement':
      return line(copy, 'measure_house_placement', { house: factor.house, sign: factor.sign });
    case 'rulership':
      return line(copy, 'measure_rulership', {
        houses: joinOr(copy, factor.housesRuled),
        yogakaraka: line(copy, factor.yogakaraka ? 'yes' : 'no'),
        count: factor.housesRuled.length,
      });
    case 'dasha':
      return line(copy, 'measure_dasha', {
        lord: titleCase(factor.lord),
        level: line(copy, `dasha_level_${factor.level}`),
        start: isoDay(factor.startIso),
        end: isoDay(factor.endIso),
        years: factor.durationYears.toFixed(2),
        convention: factor.convention,
      });
    case 'yoga':
      return line(copy, 'measure_yoga', {
        grade: factor.grade,
        category: factor.category,
        houses: joinOr(copy, factor.housesInvolved),
        planets: joinOr(copy, factor.planetsInvolved.map(titleCase)),
      });
    case 'yogaStrength':
      return line(copy, 'measure_yoga_strength', {
        net: signed(factor.netMarks),
        favorable: factor.maxFavorable,
        unfavorable: factor.maxUnfavorable,
        pct: percent(factor.strengthPct),
      });
  }
}

/** `<id> · <measured values> · <how it was computed>` — the checkable triple. */
function factorLine(copy: Copy, factor: ChartFactor): string {
  return line(copy, 'factor_line', {
    id: factor.id,
    measure: factorMeasure(copy, factor),
    class: classLabel(copy, factor.factorClass),
  });
}

/* ── The Confidence cell ──────────────────────────────────────────────────── */

function deductionApplied(copy: Copy, deduction: ConfidenceDeduction): string {
  const margin = deduction.marginDeg === undefined ? '' : degrees(deduction.marginDeg);
  return line(copy, `applied_${deduction.code.replace(/-/g, '_')}`, {
    subject: titleCase(deduction.subject),
    margin,
  });
}

/** The level AND the arithmetic that produced it, so a reader can recompute it. */
function confidenceCell(copy: Copy, verdict: ConfidenceVerdict): string {
  const parts: string[] = [
    line(copy, 'confidence_line', {
      level: levelLabel(copy, verdict.level),
      class: classLabel(copy, verdict.ceilingClass),
      ceiling: levelLabel(copy, verdict.ceiling),
      factor: verdict.ceilingFactorId,
    }),
    verdict.deductions.length === 0
      ? line(copy, 'confidence_no_deductions')
      : verdict.deductions.map((deduction) => deductionApplied(copy, deduction)).join('; '),
  ];
  if (verdict.floored) {
    parts.push(line(copy, 'confidence_floored'));
  }
  return parts.join('; ');
}

/* ── The Alternative cell ─────────────────────────────────────────────────── */

function shiftLine(copy: Copy, shift: { planet: string; from: number; to: number }): string {
  return line(copy, 'alternate_shift', {
    planet: titleCase(shift.planet),
    from: shift.from,
    to: shift.to,
  });
}

/** A REAL counterfactual, a robustness measurement, or an honest "none". */
function alternativeCell(copy: Copy, alternative: Alternative): string {
  switch (alternative.kind) {
    case 'lagnaFork':
      return alternative.shifts.length === 0
        ? line(copy, 'alternative_lagna_fork_all', {
            sign: alternative.alternateSign,
            degrees: degrees(alternative.cuspDistanceDeg),
          })
        : line(copy, 'alternative_lagna_fork', {
            sign: alternative.alternateSign,
            degrees: degrees(alternative.cuspDistanceDeg),
            shifts: alternative.shifts.map((shift) => shiftLine(copy, shift)).join('; '),
          });
    case 'lagnaForkUnavailable':
      return line(copy, 'alternative_lagna_fork_unavailable', {
        sign: alternative.alternateSign,
        degrees: degrees(alternative.cuspDistanceDeg),
      });
    case 'orbRobustness':
      return line(copy, 'alternative_orb_robustness', {
        orb: degrees(alternative.orbDeg),
        separation: degrees(alternative.separationDeg),
        margin: degrees(Math.abs(alternative.separationDeg - alternative.orbDeg)),
      });
    case 'dashaConvention':
      return line(copy, 'alternative_dasha_convention', {
        shifts: joinOr(
          copy,
          alternative.shifts.map((shift) =>
            line(copy, 'convention_shift', {
              convention: shift.convention,
              days: `${shift.deltaDays >= 0 ? '+' : '-'}${Math.abs(shift.deltaDays).toFixed(2)}`,
            }),
          ),
        ),
      });
    case 'signEdge':
      return line(copy, 'alternative_sign_edge', {
        planet: titleCase(alternative.planet),
        margin: degrees(alternative.marginDeg),
      });
    case 'latticeAmbiguity':
      return line(copy, 'alternative_lattice_ambiguity', {
        name: alternative.name,
        net: signed(alternative.netMarks),
        favorable: alternative.maxFavorable,
        unfavorable: alternative.maxUnfavorable,
      });
    case 'none':
      return line(copy, 'alternative_none', {
        reason: line(copy, `reason_${alternative.reason.replace(/-/g, '_')}`),
      });
  }
}

/* ── Assembly ─────────────────────────────────────────────────────────────── */

function evidenceRow(copy: Copy, row: EvidenceRow): ReportPdfEvidenceRow {
  const { observation } = row;
  return {
    observationId: observation.id,
    observation: observationSentence(copy, observation.primary),
    evidence: observation.supporting.map((factor) => factorLine(copy, factor)),
    interpretation:
      row.interpretation === null
        ? line(copy, 'no_interpretation')
        : copy.text(row.interpretation),
    confidence: confidenceCell(copy, observation.confidence),
    alternative: alternativeCell(copy, observation.alternative),
  };
}

/** The ceiling table, verbatim from the reasons documented in `confidence.ts`. */
function ceilingTable(copy: Copy): readonly ReportPdfLabeledValue[] {
  return (['arithmetic', 'rule', 'model'] as const).map((factorClass) => ({
    label: line(copy, `ceiling_${factorClass}_label`),
    value: line(copy, `ceiling_${factorClass}_reason`),
  }));
}

/**
 * The deduction rules WITH their numeric thresholds, interpolated from the
 * exported constants — never retyped as prose, so the copy cannot drift from
 * the code that enforces it.
 */
function deductionRules(copy: Copy): readonly string[] {
  const cusp = degrees(CUSP_THRESHOLD_DEG);
  const margin = degrees(BOUNDARY_MARGIN_DEG);
  return [
    line(copy, 'deduction_lagna_fork', { cusp }),
    line(copy, 'deduction_sign_boundary', { margin }),
    line(copy, 'deduction_combustion_boundary', { margin }),
    line(copy, 'deduction_net_zero_marks'),
  ];
}

/** The verified second chart, or an explicit projection-unavailable disclosure. */
function alternateBlock(
  copy: Copy,
  sensitivity: LagnaSensitivity,
  alternate: AlternateLagna | null,
): Pick<
  ReportPdfEvidence,
  'alternateHeading' | 'alternateLead' | 'alternateShifts' | 'alternateMinutesNote'
> {
  if (alternate === null) {
    return {
      alternateHeading: line(copy, 'alternate_heading'),
      alternateLead: line(copy, 'alternate_lead_unavailable', {
        sign: sensitivity.alternateSign,
        degrees: degrees(sensitivity.cuspDistanceDeg),
      }),
      alternateShifts: [],
      alternateMinutesNote: line(copy, 'alternate_projection_unavailable'),
    };
  }
  return {
    alternateHeading: line(copy, 'alternate_heading'),
    alternateLead: line(copy, 'alternate_lead', {
      sign: alternate.alternateSign,
      degrees: degrees(alternate.cuspDistanceDeg),
    }),
    alternateShifts: alternate.shifts.map((shift) => shiftLine(copy, shift)),
    alternateMinutesNote: line(copy, 'alternate_minutes_note'),
  };
}

/** The rejected-statement provenance line, or nothing when none were dropped. */
function rejectedNote(copy: Copy, ledger: EvidenceLedger): { rejectedNote?: string } {
  if (ledger.rejectedCount === 0) {
    return {};
  }
  return {
    rejectedNote: line(copy, 'rejected_note', {
      count: ledger.rejectedCount,
      citations: joinOr(copy, ledger.rejectedCitations),
    }),
  };
}

/**
 * Reshape the evidence ledger into the section both renderers draw.
 *
 * `text` is the presentation-only transform applied to EVERY emitted string —
 * pass `glyphSafe` from the PDF, omit it on screen.
 */
export function buildEvidenceSection(
  ledger: EvidenceLedger,
  tr: TFunction,
  text: EvidenceText = (value) => value,
): ReportPdfEvidence {
  const copy: Copy = { tr, text };
  return {
    chrome: {
      eyebrow: text(tr('pdf.evidence_eyebrow')),
      title: line(copy, 'heading'),
      intro: text(tr('pdf.evidence_intro')),
    },
    methodHeading: line(copy, 'method_heading'),
    ceilingHeading: line(copy, 'ceiling_heading'),
    ceilings: ceilingTable(copy),
    ceilingNote: line(copy, 'ceiling_min_note'),
    deductionHeading: line(copy, 'deduction_heading'),
    deductionRules: deductionRules(copy),
    formula: line(copy, 'formula'),
    ...(ledger.lagnaSensitivity
      ? alternateBlock(copy, ledger.lagnaSensitivity, ledger.alternateLagna)
      : {}),
    cellLabels: {
      observation: line(copy, 'cell_observation'),
      evidence: line(copy, 'cell_evidence'),
      interpretation: line(copy, 'cell_interpretation'),
      confidence: line(copy, 'cell_confidence'),
      alternative: line(copy, 'cell_alternative'),
    },
    rows: ledger.rows.map((row) => evidenceRow(copy, row)),
    ...(ledger.generalGuidance.length > 0
      ? {
          guidanceHeading: line(copy, 'guidance_heading'),
          guidanceNote: line(copy, 'guidance_note'),
          guidance: ledger.generalGuidance.map((statement) => text(statement)),
        }
      : {}),
    ...rejectedNote(copy, ledger),
  };
}
