/**
 * Chart factors — every computed thing a report conclusion is allowed to cite.
 *
 * WHY IDs EXIST. An "Evidence" block makes any sentence LOOK derived. That is
 * the danger: a structure that launders plausible wisdom into apparent
 * chart-derivation is worse than plain prose, because it is wrong AND
 * rigorous-looking. So a conclusion may not merely *mention* the chart — it must
 * cite factors by stable id, and `annotations.ts` checks every id against this
 * index before anything renders. A citation to a yoga, dignity or period the
 * engine did not compute is rejected outright.
 *
 * WHY EACH FACTOR CARRIES ITS CLASS AND ITS CUSP-DEPENDENCE. Those two fields
 * are the entire input to the confidence model (`confidence.ts`). Confidence is
 * never asserted; it is derived from how a factor was computed and from whether
 * this particular chart can fork underneath it.
 *
 * This module computes NO astrology. Every value is mirrored from the engine's
 * `SiderealChart`; the only arithmetic here is picking a nearest boundary.
 */

import type { SiderealChart, YogaData } from '@almamesh/browser/types';

import { combustionOrbDeg } from './combustionOrbs';
import { resolveCuspProximity } from '../lagnaCusp';

/**
 * How a factor was computed. This sets the CEILING on any confidence resting
 * on it — see `confidence.ts` for the ceiling table and why it is ordered so.
 */
export type FactorClass = 'arithmetic' | 'rule' | 'model';

interface FactorMeta {
  /** Stable citation id, e.g. `dignity:venus`, `dasha:maha:saturn`. */
  readonly id: string;
  readonly factorClass: FactorClass;
  /**
   * False when this factor's value changes if the rising sign flips. Under
   * whole-sign houses that is a single binary, so the split is clean: positions,
   * dignities, combustion and dasha are byte-identical in both candidate charts;
   * every house number, every lordship-from-lagna, and every house-referencing
   * yoga forks entirely.
   */
  readonly cuspInvariant: boolean;
}

export type ChartFactor =
  | (FactorMeta & {
      readonly kind: 'lagna';
      readonly sign: string;
      readonly signDegrees: number;
      readonly cuspDistanceDeg: number | null;
      readonly adjacentSign: string | null;
    })
  | (FactorMeta & {
      readonly kind: 'position';
      readonly planet: string;
      readonly sign: string;
      readonly signDegrees: number;
      readonly nakshatra: string;
      readonly pada: number;
    })
  | (FactorMeta & {
      readonly kind: 'dignity';
      readonly planet: string;
      readonly dignity: string;
      readonly sign: string;
      readonly signDegrees: number;
    })
  | (FactorMeta & {
      readonly kind: 'combustion';
      readonly planet: string;
      readonly combust: boolean;
      readonly separationDeg: number;
      readonly orbDeg: number;
      readonly retrograde: boolean;
    })
  | (FactorMeta & {
      readonly kind: 'retrograde';
      readonly planet: string;
      readonly speedDegPerDay: number;
    })
  | (FactorMeta & {
      readonly kind: 'housePlacement';
      readonly planet: string;
      readonly house: number;
      readonly sign: string;
    })
  | (FactorMeta & {
      readonly kind: 'rulership';
      readonly planet: string;
      readonly housesRuled: readonly number[];
      readonly yogakaraka: boolean;
    })
  | (FactorMeta & {
      readonly kind: 'dasha';
      readonly level: 'maha' | 'antar' | 'pratyantar';
      readonly lord: string;
      readonly startIso: string;
      readonly endIso: string;
      readonly durationYears: number;
      readonly convention: string;
      readonly current: boolean;
    })
  | (FactorMeta & {
      readonly kind: 'yoga';
      readonly name: string;
      readonly grade: string;
      readonly category: string;
      readonly housesInvolved: readonly number[];
      readonly planetsInvolved: readonly string[];
    })
  | (FactorMeta & {
      readonly kind: 'yogaStrength';
      readonly name: string;
      readonly netMarks: number;
      readonly maxFavorable: number;
      readonly maxUnfavorable: number;
      readonly strengthPct: number;
    });

/** The planets a factor is about — used to target the alternate-chart diff. */
export function factorPlanets(factor: ChartFactor): readonly string[] {
  switch (factor.kind) {
    case 'lagna':
      return [];
    case 'yoga':
      return factor.planetsInvolved;
    case 'yogaStrength':
      return [];
    case 'dasha':
      return [];
    default:
      return [factor.planet];
  }
}

/**
 * A yoga forks with the ascendant when ANY house appears in its definition —
 * either in `houses_involved` or as a `house_class` strength factor. A yoga
 * defined purely by sign dignity (e.g. an exaltation) reads identically in both
 * candidate charts and must not be penalised for a cusp it does not touch.
 */
export function yogaDependsOnHouses(yoga: YogaData): boolean {
  return (
    yoga.houses_involved.length > 0 ||
    yoga.strength_factors.some((factor) => factor.factor_type === 'house_class')
  );
}

/** The engine's yoga claim-id namespace, shared with `lib/stability.ts`. */
export function yogaFactorId(name: string): string {
  return `yoga:${name}`;
}

function lagnaFactor(chart: SiderealChart): ChartFactor {
  const { lagna } = chart;
  const proximity = resolveCuspProximity(lagna.sign, lagna.sign_degrees, lagna);
  return {
    kind: 'lagna',
    id: 'lagna',
    // The ascendant degree is ephemeris arithmetic; what it IMPLIES about houses
    // is the part that forks, and that is carried by cuspInvariant.
    factorClass: 'arithmetic',
    cuspInvariant: false,
    sign: lagna.sign,
    signDegrees: lagna.sign_degrees,
    cuspDistanceDeg: proximity?.degrees ?? null,
    adjacentSign: proximity?.neighbourSign ?? null,
  };
}

function planetFactors(chart: SiderealChart): ChartFactor[] {
  const factors: ChartFactor[] = [];
  for (const [key, planet] of Object.entries(chart.planets)) {
    factors.push({
      kind: 'position',
      id: `position:${key}`,
      factorClass: 'arithmetic',
      cuspInvariant: true,
      planet: key,
      sign: planet.sign,
      signDegrees: planet.sign_degrees,
      nakshatra: planet.nakshatra,
      pada: planet.nakshatra_pada,
    });
    factors.push({
      kind: 'dignity',
      id: `dignity:${key}`,
      // Which sign exalts which graha is a classical table, not a measurement.
      factorClass: 'rule',
      cuspInvariant: true,
      planet: key,
      dignity: planet.dignity,
      sign: planet.sign,
      signDegrees: planet.sign_degrees,
    });
    factors.push({
      kind: 'housePlacement',
      id: `house:${key}`,
      factorClass: 'rule',
      cuspInvariant: false,
      planet: key,
      house: planet.house,
      sign: planet.sign,
    });

    const orb = combustionOrbDeg(key, planet.is_retrograde);
    if (orb !== null && typeof planet.combustion_separation_deg === 'number') {
      factors.push({
        kind: 'combustion',
        id: `combustion:${key}`,
        factorClass: 'rule',
        cuspInvariant: true,
        planet: key,
        combust: planet.is_combust,
        separationDeg: planet.combustion_separation_deg,
        orbDeg: orb,
        retrograde: planet.is_retrograde,
      });
    }
    if (planet.is_retrograde) {
      factors.push({
        kind: 'retrograde',
        id: `retrograde:${key}`,
        factorClass: 'arithmetic',
        cuspInvariant: true,
        planet: key,
        speedDegPerDay: planet.speed,
      });
    }
    if (planet.houses_ruled.length > 0) {
      factors.push({
        kind: 'rulership',
        id: `rulership:${key}`,
        factorClass: 'rule',
        cuspInvariant: false,
        planet: key,
        housesRuled: planet.houses_ruled,
        yogakaraka: planet.is_yogakaraka,
      });
    }
  }
  return factors;
}

function dashaFactors(chart: SiderealChart): ChartFactor[] {
  const { dashas } = chart;
  const convention = dashas.convention ?? 'unspecified';
  const factors: ChartFactor[] = [];
  const currentMahaLord = dashas.current_maha?.lord;

  for (const maha of dashas.maha_dasha_sequence) {
    factors.push({
      kind: 'dasha',
      id: `dasha:maha:${maha.lord}`,
      // Vimshottari periods are arithmetic from the Moon's nakshatra fraction.
      factorClass: 'arithmetic',
      cuspInvariant: true,
      level: 'maha',
      lord: maha.lord,
      startIso: maha.start_date,
      endIso: maha.end_date,
      durationYears: maha.duration_years,
      convention,
      current: maha.lord === currentMahaLord,
    });
    for (const antar of maha.antar_sequence ?? []) {
      factors.push({
        kind: 'dasha',
        id: `dasha:antar:${maha.lord}/${antar.lord}`,
        factorClass: 'arithmetic',
        cuspInvariant: true,
        level: 'antar',
        lord: antar.lord,
        startIso: antar.start_date,
        endIso: antar.end_date,
        durationYears: antar.duration_years,
        convention,
        current:
          maha.lord === currentMahaLord && antar.lord === dashas.current_antar?.lord,
      });
    }
  }

  const { current_pratyantar: pratyantar, current_antar: antar } = dashas;
  if (pratyantar != null && antar != null && currentMahaLord !== undefined) {
    factors.push({
      kind: 'dasha',
      id: `dasha:pratyantar:${currentMahaLord}/${antar.lord}/${pratyantar.lord}`,
      factorClass: 'arithmetic',
      cuspInvariant: true,
      level: 'pratyantar',
      lord: pratyantar.lord,
      startIso: pratyantar.start_date,
      endIso: pratyantar.end_date,
      durationYears: pratyantar.duration_years,
      convention,
      current: true,
    });
  }
  return factors;
}

function yogaFactors(chart: SiderealChart): ChartFactor[] {
  const factors: ChartFactor[] = [];
  for (const yoga of chart.yogas) {
    const forks = yogaDependsOnHouses(yoga);
    factors.push({
      kind: 'yoga',
      id: yogaFactorId(yoga.name),
      factorClass: 'rule',
      cuspInvariant: !forks,
      name: yoga.name,
      grade: yoga.grade,
      category: yoga.category,
      housesInvolved: yoga.houses_involved,
      planetsInvolved: yoga.planets_involved,
    });
    // The calibrated percentage is a Layer-2 MODEL output over the +-1 mark
    // lattice, never a measured fact — the engine says so with `strength_tier`.
    if (typeof yoga.strength_pct === 'number' && yoga.strength_tier === 'structural') {
      factors.push({
        kind: 'yogaStrength',
        id: `${yogaFactorId(yoga.name)}:strength`,
        factorClass: 'model',
        cuspInvariant: !forks,
        name: yoga.name,
        netMarks: yoga.net_marks ?? 0,
        maxFavorable: yoga.max_favorable ?? 0,
        maxUnfavorable: yoga.max_unfavorable ?? 0,
        strengthPct: yoga.strength_pct,
      });
    }
  }
  return factors;
}

/** Every citable factor in this chart, in a stable order. */
export function chartFactors(chart: SiderealChart): readonly ChartFactor[] {
  return [
    lagnaFactor(chart),
    ...planetFactors(chart),
    ...dashaFactors(chart),
    ...yogaFactors(chart),
  ];
}

/** The citation index: id -> factor. This set IS the validator's allowlist. */
export function factorIndex(chart: SiderealChart): ReadonlyMap<string, ChartFactor> {
  return new Map(chartFactors(chart).map((factor) => [factor.id, factor]));
}
