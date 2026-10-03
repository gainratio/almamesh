/**
 * Alternative readings — real ones, or an explicit admission that there is none.
 *
 * The brief this implements is blunt: "Alternatives must be REAL — genuine
 * classical disagreement, or genuine expression-variance — not filler hedging.
 * If a claim has no meaningful alternative reading, say so rather than
 * manufacturing one." A column of "expression varies depending on transits and
 * choices" under every row is decoration; it teaches a reader nothing and trains
 * them to skip the column.
 *
 * So every alternative here is COMPUTED from the chart, and each is one of two
 * honest shapes:
 *
 *  1. A COUNTERFACTUAL THE READER CAN CHECK. The strongest is `lagnaFork`: under
 *     whole-sign houses a near-cusp ascendant does not blur the houses, it
 *     REPLACES them wholesale. So the alternative is the actual second chart —
 *     "Mercury moves 1st -> 12th, Sun and Venus 2nd -> 1st" — and a reader who
 *     doubts the birth time knows exactly what hangs on it.
 *
 *  2. A ROBUSTNESS MEASUREMENT. `orbRobustness` says how far a combustion
 *     verdict sits from flipping; `dashaConvention` says how many days the
 *     period boundaries move under each OTHER year length the engine itself
 *     enumerates. Neither asserts anything about literature this codebase cannot
 *     back — they are arithmetic on printed numbers.
 *
 * And where neither applies, `kind: 'none'` carries a REASON, so the report can
 * print "no material alternative reading: retrogradation is apparent motion"
 * rather than inventing a hedge.
 */

import type { AlternateLagna, HouseShift, LagnaSensitivity } from './alternateLagna';
import { BOUNDARY_MARGIN_DEG } from './confidence';
import type { ChartFactor } from './factors';

/**
 * Days in one dasha-year under each convention the ENGINE enumerates
 * (`DashaYearConvention` in @almamesh/browser/types). This is not a claim about
 * schools of thought — it is the engine's own declared vocabulary, so the
 * alternative is checkable against the codebase rather than against a citation.
 */
export const DASHA_YEAR_DAYS: Readonly<Record<string, number>> = {
  savana_360: 360,
  gregorian_365_2425: 365.2425,
  julian_365_25: 365.25,
};

/** One rival convention and the exact shift it would put on this period. */
export interface ConventionShift {
  readonly convention: string;
  readonly deltaDays: number;
}

export type Alternative =
  | {
      readonly kind: 'lagnaFork';
      readonly alternateSign: string;
      readonly cuspDistanceDeg: number;
      /** Only the grahas this claim actually rests on. */
      readonly shifts: readonly HouseShift[];
    }
  | {
      /** Near-cusp is measured, but exact shifts failed the whole-sign self-check. */
      readonly kind: 'lagnaForkUnavailable';
      readonly alternateSign: string;
      readonly cuspDistanceDeg: number;
    }
  | {
      readonly kind: 'orbRobustness';
      readonly planet: string;
      readonly combust: boolean;
      readonly separationDeg: number;
      readonly orbDeg: number;
    }
  | {
      readonly kind: 'dashaConvention';
      readonly convention: string;
      readonly durationYears: number;
      readonly shifts: readonly ConventionShift[];
    }
  | {
      readonly kind: 'signEdge';
      readonly planet: string;
      readonly marginDeg: number;
    }
  | {
      readonly kind: 'latticeAmbiguity';
      readonly name: string;
      readonly netMarks: number;
      readonly maxFavorable: number;
      readonly maxUnfavorable: number;
    }
  | {
      readonly kind: 'none';
      readonly reason:
        | 'apparent-motion'
        | 'ascendant-secure'
        | 'dignity-by-sign'
        | 'structural-declared';
    };

function degreesToSignEdge(signDegrees: number): number {
  return Math.min(signDegrees, 30 - signDegrees);
}

/** Every OTHER convention the engine knows, with the exact days it would move. */
function conventionShifts(convention: string, durationYears: number): ConventionShift[] {
  const base = DASHA_YEAR_DAYS[convention];
  if (base === undefined) {
    return [];
  }
  return Object.entries(DASHA_YEAR_DAYS)
    .filter(([name]) => name !== convention)
    .map(([name, days]) => ({
      convention: name,
      deltaDays: (days - base) * durationYears,
    }));
}

function forkFor(
  alternate: AlternateLagna,
  planets: readonly string[],
): Extract<Alternative, { kind: 'lagnaFork' }> {
  const wanted = new Set(planets.map((planet) => planet.toLowerCase()));
  const shifts =
    wanted.size === 0
      ? alternate.shifts
      : alternate.shifts.filter((shift) => wanted.has(shift.planet.toLowerCase()));
  return {
    kind: 'lagnaFork',
    alternateSign: alternate.alternateSign,
    cuspDistanceDeg: alternate.cuspDistanceDeg,
    shifts,
  };
}

function unavailableFork(
  sensitivity: LagnaSensitivity,
): Extract<Alternative, { kind: 'lagnaForkUnavailable' }> {
  return {
    kind: 'lagnaForkUnavailable',
    alternateSign: sensitivity.alternateSign,
    cuspDistanceDeg: sensitivity.cuspDistanceDeg,
  };
}

function houseDependentAlternative(
  sensitivity: LagnaSensitivity | null,
  alternate: AlternateLagna | null,
  planets: readonly string[],
): Alternative {
  if (sensitivity === null) {
    return { kind: 'none', reason: 'ascendant-secure' };
  }
  return alternate === null
    ? unavailableFork(sensitivity)
    : forkFor(alternate, planets);
}

/**
 * The alternative reading for one observation, chosen by its PRIMARY factor.
 * `sensitivity` answers whether the lagna can fork; `alternate` separately
 * answers whether exact house shifts passed the whole-sign self-check.
 */
export function alternativeFor(
  primary: ChartFactor,
  sensitivity: LagnaSensitivity | null,
  alternate: AlternateLagna | null,
): Alternative {
  switch (primary.kind) {
    case 'lagna':
      return houseDependentAlternative(sensitivity, alternate, []);

    case 'housePlacement':
      return houseDependentAlternative(sensitivity, alternate, [primary.planet]);

    case 'rulership':
      return houseDependentAlternative(sensitivity, alternate, [primary.planet]);

    case 'dasha':
      return {
        kind: 'dashaConvention',
        convention: primary.convention,
        durationYears: primary.durationYears,
        shifts: conventionShifts(primary.convention, primary.durationYears),
      };

    case 'combustion':
      return {
        kind: 'orbRobustness',
        planet: primary.planet,
        combust: primary.combust,
        separationDeg: primary.separationDeg,
        orbDeg: primary.orbDeg,
      };

    case 'dignity':
    case 'position':
      return degreesToSignEdge(primary.signDegrees) <= BOUNDARY_MARGIN_DEG
        ? {
            kind: 'signEdge',
            planet: primary.planet,
            marginDeg: degreesToSignEdge(primary.signDegrees),
          }
        : { kind: 'none', reason: 'dignity-by-sign' };

    case 'retrograde':
      // Retrogradation is apparent motion — a sign on the speed the ephemeris
      // already prints. No school disputes the direction; what varies is what
      // it is taken to MEAN, which is interpretation, not an alternative fact.
      return { kind: 'none', reason: 'apparent-motion' };

    case 'yoga':
      return primary.cuspInvariant
        ? { kind: 'none', reason: 'dignity-by-sign' }
        : houseDependentAlternative(sensitivity, alternate, primary.planetsInvolved);

    case 'yogaStrength':
      if (primary.netMarks === 0) {
        return {
          kind: 'latticeAmbiguity',
          name: primary.name,
          netMarks: primary.netMarks,
          maxFavorable: primary.maxFavorable,
          maxUnfavorable: primary.maxUnfavorable,
        };
      }
      if (!primary.cuspInvariant) {
        return houseDependentAlternative(sensitivity, alternate, []);
      }
      return { kind: 'none', reason: 'structural-declared' };
  }
}
