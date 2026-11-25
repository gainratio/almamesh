/**
 * The evidence ledger — the ONE way a rendered evidence table gets built.
 *
 * This is the un-bypassable seam. `buildEvidenceLedger` is the only exported
 * path from raw model output to something a renderer can draw, and it runs
 * `validateAnnotations` internally. There is no "skip validation" argument and
 * no second constructor: to render an interpretation beside an Evidence block,
 * that interpretation must have named an observation this chart actually
 * produced.
 *
 * With no model output at all (no API key, a failed call, a user who never asked
 * for a reading) the ledger is still complete: every row keeps its Observation,
 * Evidence, Confidence and Alternative, and only the Interpretation cell is
 * empty. The deterministic report loses nothing by having no model.
 */

import { validateAnnotations, type RawAnnotationPayload, type RejectedAnnotation } from './annotations';
import { buildObservations, type Observation } from './observations';

import type { AlternateLagna, LagnaSensitivity } from './alternateLagna';
import type { SiderealChart } from '@almamesh/browser/types';

export type DashaLevel = 'maha' | 'antar' | 'pratyantar';

/** One rendered row: the computed observation plus, maybe, the model's prose. */
export interface EvidenceRow {
  readonly observation: Observation;
  /** The model's interpretation, or null when nothing valid was attached. */
  readonly interpretation: string | null;
  /** Extra factor ids the model cited, all verified present in this chart. */
  readonly alsoCites: readonly string[];
}

export interface EvidenceLedger {
  readonly rows: readonly EvidenceRow[];
  readonly alternateLagna: AlternateLagna | null;
  /** Canonical near-cusp state, independent of alternate projection success. */
  readonly lagnaSensitivity: LagnaSensitivity | null;
  /**
   * Statements the model DECLARED ungrounded. Rendered in their own section
   * with no evidence, confidence or alternative beside them.
   */
  readonly generalGuidance: readonly string[];
  /**
   * Total model statements discarded across all validation gates. Surfaced in
   * Assumptions & Provenance so no drop is ever silent.
   */
  readonly rejectedCount: number;
  /** Distinct ids rejected as genuinely unsupported / fabricated factors. */
  readonly rejectedCitations: readonly string[];
  /** Statements rejected for citing an observation or factor absent from this chart. */
  readonly unsupportedCount: number;
  /** Statements withheld for predictive or non-reflective phrasing. */
  readonly reflectionRejectedCount: number;
  /** Prior-period daśā statements expired by a period rollover since generation. */
  readonly staleDashaCount: number;
  /** The specific daśā level(s) (`maha` / `antar` / `pratyantar`) that rolled over. */
  readonly staleDashaLevels: readonly DashaLevel[];
  /** Malformed, empty, or duplicate statements discarded. */
  readonly otherRejectedCount: number;
  /** True when a model reading was applied to at least one row. */
  readonly annotated: boolean;
}

const MAX_REPORTED_REJECTIONS = 8;

/** Fixed universal Vimśottarī 9-lord cyclic sequence. */
const VIMSHOTTARI_CYCLE = [
  'ketu',
  'venus',
  'sun',
  'moon',
  'mars',
  'rahu',
  'jupiter',
  'saturn',
  'mercury',
] as const;

function previousLord(lord: string): string | null {
  const index = VIMSHOTTARI_CYCLE.indexOf(lord.toLowerCase() as (typeof VIMSHOTTARI_CYCLE)[number]);
  if (index < 0) return null;
  return VIMSHOTTARI_CYCLE[(index + VIMSHOTTARI_CYCLE.length - 1) % VIMSHOTTARI_CYCLE.length]!;
}

function parseInstantMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Collect strictly prior Vimśottarī dasha observation ids verified against THIS
 * chart's own timeline (completed periods in `maha_dasha_sequence` plus the
 * immediately preceding cyclic leg of each active level). Hallucinated or
 * future dasha lords are NEVER included, so they stay fail-closed as unsupported.
 */
function priorChartDashaIds(chart: SiderealChart): ReadonlySet<string> {
  const prior = new Set<string>();
  const dashas = chart.dashas;
  if (!dashas) return prior;

  const maha = dashas.current_maha;
  const antar = dashas.current_antar;
  const pratyantar = dashas.current_pratyantar;
  const mahaStart = parseInstantMs(maha?.start_date);
  const antarStart = parseInstantMs(antar?.start_date);
  const pratyantarStart = parseInstantMs(pratyantar?.start_date);

  for (const m of dashas.maha_dasha_sequence ?? []) {
    const mLord = m.lord.toLowerCase();
    const mEnd = parseInstantMs(m.end_date);
    if (mahaStart !== null && mEnd !== null && mEnd <= mahaStart) {
      prior.add(`dasha:maha:${mLord}`);
    }
    for (const a of m.antar_sequence ?? []) {
      const aLord = a.lord.toLowerCase();
      const aEnd = parseInstantMs(a.end_date);
      if (antarStart !== null && aEnd !== null && aEnd <= antarStart) {
        prior.add(`dasha:antar:${mLord}/${aLord}`);
      }
    }
  }

  if (maha && antar) {
    const mLord = maha.lord.toLowerCase();
    const aLord = antar.lord.toLowerCase();
    for (const p of dashas.pratyantar_sequence ?? []) {
      const pLord = p.lord.toLowerCase();
      const pEnd = parseInstantMs(p.end_date);
      if (pratyantarStart !== null && pEnd !== null && pEnd <= pratyantarStart) {
        prior.add(`dasha:pratyantar:${mLord}/${aLord}/${pLord}`);
      }
    }
  }

  // Also include the deterministic immediately preceding cyclic leg when a
  // payload omits nested sub-sequences (e.g. pratyantar_sequence absent).
  if (maha) {
    const mLord = maha.lord.toLowerCase();
    const prevMaha = previousLord(mLord);
    if (prevMaha) prior.add(`dasha:maha:${prevMaha}`);
    if (antar) {
      const aLord = antar.lord.toLowerCase();
      const prevAntar = previousLord(aLord);
      if (prevAntar) {
        if (aLord === mLord && prevMaha) {
          prior.add(`dasha:antar:${prevMaha}/${prevAntar}`);
        } else {
          prior.add(`dasha:antar:${mLord}/${prevAntar}`);
        }
      }
      if (pratyantar) {
        const pLord = pratyantar.lord.toLowerCase();
        const prevPratyantar = previousLord(pLord);
        if (prevPratyantar) {
          if (pLord === aLord && prevAntar) {
            const parentMaha = aLord === mLord && prevMaha ? prevMaha : mLord;
            prior.add(`dasha:pratyantar:${parentMaha}/${prevAntar}/${prevPratyantar}`);
          } else {
            prior.add(`dasha:pratyantar:${mLord}/${aLord}/${prevPratyantar}`);
          }
        }
      }
    }
  }

  return prior;
}

function dashaLevelOfId(id: string): DashaLevel | null {
  if (id.startsWith('dasha:maha:')) return 'maha';
  if (id.startsWith('dasha:antar:')) return 'antar';
  if (id.startsWith('dasha:pratyantar:')) return 'pratyantar';
  return null;
}

interface RejectionCounts {
  readonly unsupported: readonly RejectedAnnotation[];
  readonly reflectionRejectedCount: number;
  readonly staleDashaCount: number;
  readonly staleDashaLevels: readonly DashaLevel[];
  readonly otherRejectedCount: number;
}

function partitionRejections(rejected: readonly RejectedAnnotation[]): RejectionCounts {
  const unsupported: RejectedAnnotation[] = [];
  let reflectionRejectedCount = 0;
  let staleDashaCount = 0;
  const staleLevels = new Set<DashaLevel>();
  let otherRejectedCount = 0;

  for (const item of rejected) {
    switch (item.reason) {
      case 'unknown-observation':
      case 'unknown-factor':
        unsupported.push(item);
        break;
      case 'not-reflection':
        reflectionRejectedCount += 1;
        break;
      case 'stale-dasha': {
        staleDashaCount += 1;
        const level = dashaLevelOfId(item.citedId);
        if (level !== null) staleLevels.add(level);
        break;
      }
      case 'malformed':
      case 'empty-interpretation':
      case 'duplicate-observation':
        otherRejectedCount += 1;
        break;
      default: {
        const _exhaustive: never = item.reason;
        throw new Error(`Unhandled rejection reason: ${String(_exhaustive)}`);
      }
    }
  }

  return {
    unsupported,
    reflectionRejectedCount,
    staleDashaCount,
    staleDashaLevels: [...staleLevels],
    otherRejectedCount,
  };
}

/**
 * Build the ledger. `payload` is UNTRUSTED model output; pass null (or omit it)
 * for the keyless / deterministic-only report.
 */
export function buildEvidenceLedger(
  chart: SiderealChart,
  payload?: RawAnnotationPayload | null,
): EvidenceLedger {
  const ledger = buildObservations(chart);
  const priorDashas = priorChartDashaIds(chart);
  const validated = validateAnnotations(payload, ledger.observationIds, ledger.factorIds, priorDashas);
  const byObservation = new Map(
    validated.accepted.map((annotation) => [annotation.observationId, annotation]),
  );

  const rows: EvidenceRow[] = ledger.observations.map((observation) => {
    const annotation = byObservation.get(observation.id);
    return {
      observation,
      interpretation: annotation?.interpretation ?? null,
      alsoCites: annotation?.alsoCites ?? [],
    };
  });

  const counts = partitionRejections(validated.rejected);

  return {
    rows,
    alternateLagna: ledger.alternateLagna,
    lagnaSensitivity: ledger.lagnaSensitivity,
    generalGuidance: validated.generalGuidance,
    rejectedCount: validated.rejected.length,
    rejectedCitations: [...new Set(counts.unsupported.map((r) => r.citedId))]
      .filter((id) => id !== '')
      .slice(0, MAX_REPORTED_REJECTIONS),
    unsupportedCount: counts.unsupported.length,
    reflectionRejectedCount: counts.reflectionRejectedCount,
    staleDashaCount: counts.staleDashaCount,
    staleDashaLevels: counts.staleDashaLevels,
    otherRejectedCount: counts.otherRejectedCount,
    annotated: validated.accepted.length > 0,
  };
}
