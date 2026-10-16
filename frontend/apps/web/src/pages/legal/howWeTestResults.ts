/**
 * The published retrodiction aggregates: the DEV half of the pre-registered
 * retrodiction eval, k = 3 months of a 73-month window, placebo-calibrated lift
 * with 95% CI. The eval runs offline against licensed data, so its runs and
 * pre-registration are not in this repository.
 *
 * The Astro-Databank licence allows aggregates only: totals and lifts, never a name,
 * a birth datum, an event row or an example. Nothing here identifies anyone.
 */

export type AreaKey = 'career' | 'relationships' | 'family' | 'health';

export type TechniqueKey = 'baseline' | 'exact_transits' | 'obstacles' | 'ashtakavarga' | 'vargas';

export interface TechniqueResult {
  readonly key: TechniqueKey;
  /** Placebo-calibrated lift over chance: 1.0 is chance. */
  readonly lift: number;
  /** 95% confidence interval of the lift. */
  readonly low: number;
  readonly high: number;
  /** Events scored for this technique. */
  readonly events: number;
}

/**
 * Classical dasha rules were scored by life area (amendment h of the pre-registration, DEV half,
 * k = 3): the run published no all-areas lift, so the page shows each area's lift with its 95% CI.
 */
export interface AreaResult {
  readonly area: AreaKey;
  readonly lift: number;
  readonly low: number;
  readonly high: number;
}

export interface AreaTechniqueResult {
  readonly key: 'classical_dasha';
  /** Events scored across the four areas. */
  readonly events: number;
  readonly areas: readonly AreaResult[];
}

export interface RetrodictionResults {
  /** The day the published run finished (YYYY-MM-DD). */
  readonly runDate: string;
  readonly events: number;
  readonly people: number;
  readonly windowMonths: number;
  readonly topMonths: number;
  readonly techniques: readonly TechniqueResult[];
  readonly classicalDasha: AreaTechniqueResult;
}

export const RETRODICTION_RESULTS: RetrodictionResults = {
  runDate: '2026-10-14',
  events: 6120,
  people: 5062,
  windowMonths: 73,
  topMonths: 3,
  techniques: [
    { key: 'baseline', lift: 1.03, low: 0.9, high: 1.16, events: 6120 },
    { key: 'exact_transits', lift: 1.03, low: 0.9, high: 1.18, events: 6120 },
    { key: 'obstacles', lift: 0.88, low: 0.56, high: 1.3, events: 772 },
    { key: 'ashtakavarga', lift: 0.98, low: 0.85, high: 1.11, events: 6120 },
    { key: 'vargas', lift: 0.99, low: 0.86, high: 1.12, events: 6120 },
  ],
  classicalDasha: {
    key: 'classical_dasha',
    events: 5098,
    areas: [
      { area: 'career', lift: 1.04, low: 0.74, high: 1.41 },
      { area: 'relationships', lift: 1.06, low: 0.85, high: 1.29 },
      { area: 'family', lift: 1.22, low: 0.87, high: 1.66 },
      { area: 'health', lift: 0.94, low: 0.49, high: 1.57 },
    ],
  },
};
