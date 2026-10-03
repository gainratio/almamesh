/**
 * The confidence model.
 *
 * A "Confidence: High" that a model asserted, or that a rule type carries as a
 * hardcoded label, is FAKE PRECISION: it looks more rigorous than a bare claim
 * while being LESS checkable, because a reader cannot reproduce it. So nothing
 * here is assigned. Confidence is DERIVED, in two steps, from values the report
 * already prints beside the claim.
 *
 * STEP 1 - THE CEILING, from how the cited factors were computed.
 *
 *   arithmetic -> High      The number IS the computation. A dasha period is the
 *                           Moon's nakshatra fraction scaled by a declared year
 *                           length; a second implementation gets the same answer.
 *   rule       -> Moderate  Exact arithmetic, but WHICH rule is a classical
 *                           choice: which sign exalts a graha, what orb makes it
 *                           combust, which house system counts. Schools differ.
 *   model      -> Low       A calibrated STRUCTURAL estimate over the +-1 mark
 *                           lattice - a quantity this engine defined, not one
 *                           the tradition hands down. The report already labels
 *                           these STRUCTURAL ESTIMATE, and this is the same
 *                           admission expressed as a number.
 *
 * A claim's ceiling is the MINIMUM over everything it cites. Citing one exact
 * fact and one estimate gets you the estimate's ceiling: a conclusion is only as
 * good as its weakest support.
 *
 * STEP 2 - DEDUCTIONS, from what is fragile IN THIS CHART.
 *
 * Each deduction is one named, measured condition that must be TRUE OF THIS
 * CHART and must TOUCH THIS CLAIM's cited factors. That is what makes the model
 * chart-specific rather than a label per rule type: the identical conclusion
 * scores differently in a chart with a securely-placed ascendant.
 *
 *   lagna-fork          The ascendant is within CUSP_THRESHOLD_DEG of a sign
 *                       boundary AND this claim cites something house-dependent.
 *                       Under whole-sign houses the flip is total - every house
 *                       moves at once - so the claim's whole basis forks.
 *   sign-boundary       A cited dignity or position sits within
 *                       BOUNDARY_MARGIN_DEG of a sign edge, where dignity and
 *                       sign-lord both change.
 *   combustion-boundary A cited combustion verdict sits within
 *                       BOUNDARY_MARGIN_DEG of its own orb, so the verdict is
 *                       one convention away from flipping.
 *   net-zero-marks      A cited structural strength has net_marks = 0, which the
 *                       lattice produces BOTH when favourable and unfavourable
 *                       factors genuinely cancel AND when nothing fired at all.
 *                       The number cannot tell those apart.
 *
 * level = clamp(ceiling - (number of deductions), Low, High).
 *
 * Every input to that arithmetic is printed next to the claim: the cited ids
 * with their class, the ceiling, and each deduction with its measured margin. A
 * reader can recompute the level. That is the whole point - reproducible beats
 * authoritative.
 */

import type { LagnaSensitivity } from './alternateLagna';
import type { ChartFactor, FactorClass } from './factors';

export type ConfidenceLevel = 'high' | 'moderate' | 'low';

/**
 * Degrees from a sign boundary within which the ascendant gets a second chart.
 * Mirrors `CUSP_THRESHOLD_DEG` in `backend/src/almamesh/calculations.py`;
 * `__tests__/combustionOrbs.test.ts` holds the two in step.
 */
export const CUSP_THRESHOLD_DEG = 3;

/** Degrees from any other boundary (sign edge, combustion orb) counted as near. */
export const BOUNDARY_MARGIN_DEG = 1;

const CEILING_BY_CLASS: Readonly<Record<FactorClass, ConfidenceLevel>> = {
  arithmetic: 'high',
  rule: 'moderate',
  model: 'low',
};

const LEVEL_VALUE: Readonly<Record<ConfidenceLevel, number>> = {
  high: 3,
  moderate: 2,
  low: 1,
};

const LEVEL_BY_VALUE: readonly ConfidenceLevel[] = ['low', 'low', 'moderate', 'high'];

export type DeductionCode =
  | 'lagna-fork'
  | 'sign-boundary'
  | 'combustion-boundary'
  | 'net-zero-marks';

/** One named, measured reason THIS chart lowers confidence in THIS claim. */
export interface ConfidenceDeduction {
  readonly code: DeductionCode;
  /** The planet, yoga or 'lagna' the condition was measured on. */
  readonly subject: string;
  /** The measured margin in degrees, where the condition is a distance. */
  readonly marginDeg?: number;
}

export interface ConfidenceVerdict {
  readonly level: ConfidenceLevel;
  readonly ceiling: ConfidenceLevel;
  readonly ceilingClass: FactorClass;
  /** Which cited factor set the ceiling — printed so the reader can check it. */
  readonly ceilingFactorId: string;
  readonly deductions: readonly ConfidenceDeduction[];
  /** True when the deductions would have pushed below Low and were clamped. */
  readonly floored: boolean;
}

function degreesToSignEdge(signDegrees: number): number {
  return Math.min(signDegrees, 30 - signDegrees);
}

function ceilingOf(factors: readonly ChartFactor[]): {
  ceiling: ConfidenceLevel;
  ceilingClass: FactorClass;
  ceilingFactorId: string;
} {
  let weakest = factors[0];
  for (const factor of factors) {
    if (LEVEL_VALUE[CEILING_BY_CLASS[factor.factorClass]] < LEVEL_VALUE[CEILING_BY_CLASS[weakest.factorClass]]) {
      weakest = factor;
    }
  }
  return {
    ceiling: CEILING_BY_CLASS[weakest.factorClass],
    ceilingClass: weakest.factorClass,
    ceilingFactorId: weakest.id,
  };
}

function collectDeductions(
  factors: readonly ChartFactor[],
  sensitivity: LagnaSensitivity | null,
): ConfidenceDeduction[] {
  const deductions: ConfidenceDeduction[] = [];

  if (sensitivity !== null && factors.some((factor) => !factor.cuspInvariant)) {
    deductions.push({
      code: 'lagna-fork',
      subject: 'lagna',
      marginDeg: sensitivity.cuspDistanceDeg,
    });
  }

  for (const factor of factors) {
    if (
      (factor.kind === 'dignity' || factor.kind === 'position') &&
      degreesToSignEdge(factor.signDegrees) <= BOUNDARY_MARGIN_DEG
    ) {
      deductions.push({
        code: 'sign-boundary',
        subject: factor.planet,
        marginDeg: degreesToSignEdge(factor.signDegrees),
      });
    }
    if (
      factor.kind === 'combustion' &&
      Math.abs(factor.separationDeg - factor.orbDeg) <= BOUNDARY_MARGIN_DEG
    ) {
      deductions.push({
        code: 'combustion-boundary',
        subject: factor.planet,
        marginDeg: Math.abs(factor.separationDeg - factor.orbDeg),
      });
    }
    if (factor.kind === 'yogaStrength' && factor.netMarks === 0) {
      deductions.push({ code: 'net-zero-marks', subject: factor.name });
    }
  }
  return deductions;
}

/**
 * Derive a claim's confidence from the factors it cites and this chart's own
 * fragilities. Throws on an empty citation list: a claim with nothing to cite
 * has no confidence to compute, and must not be given one.
 */
export function assessConfidence(
  factors: readonly ChartFactor[],
  sensitivity: LagnaSensitivity | null,
): ConfidenceVerdict {
  if (factors.length === 0) {
    throw new Error('assessConfidence: a claim citing no factors has no derivable confidence');
  }
  const { ceiling, ceilingClass, ceilingFactorId } = ceilingOf(factors);
  const deductions = collectDeductions(factors, sensitivity);
  const raw = LEVEL_VALUE[ceiling] - deductions.length;
  return {
    level: LEVEL_BY_VALUE[Math.max(1, Math.min(3, raw))],
    ceiling,
    ceilingClass,
    ceilingFactorId,
    deductions,
    floored: raw < 1,
  };
}
