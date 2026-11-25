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

  const mahaSeq = dashas.maha_dasha_sequence ?? [];
  const pratyantarSeq = dashas.pratyantar_sequence ?? [];
  let currentMahaHasAntars = false;

  for (const m of mahaSeq) {
    const mLord = m.lord.toLowerCase();
    const mEnd = parseInstantMs(m.end_date);
    if (mahaStart !== null && mEnd !== null && mEnd <= mahaStart) {
      prior.add(`dasha:maha:${mLord}`);
    }
    const antars = m.antar_sequence ?? [];
    if (maha && mLord === maha.lord.toLowerCase() && antars.length > 0) {
      currentMahaHasAntars = true;
    }
    for (const a of antars) {
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
    for (const p of pratyantarSeq) {
      const pLord = p.lord.toLowerCase();
      const pEnd = parseInstantMs(p.end_date);
      if (pratyantarStart !== null && pEnd !== null && pEnd <= pratyantarStart) {
        prior.add(`dasha:pratyantar:${mLord}/${aLord}/${pLord}`);
      }
    }
  }

  // Gate each cyclic fallback leg on its corresponding sequence being absent so
  // a chart carrying explicit timelines (e.g. a child still in their birth Mahā)
  // never synthesizes an unelapsed prior period.
  if (maha) {
    const mLord = maha.lord.toLowerCase();
    const prevMaha = previousLord(mLord);
    if (mahaSeq.length === 0 && prevMaha) {
      prior.add(`dasha:maha:${prevMaha}`);
    }
    if (antar) {
      const aLord = antar.lord.toLowerCase();
      const prevAntar = previousLord(aLord);
      if (!currentMahaHasAntars && prevAntar) {
        if (aLord === mLord) {
          const lastAntarOfPrevMaha = prevMaha ? previousLord(prevMaha) : null;
          if (
            prevMaha &&
            lastAntarOfPrevMaha &&
            (mahaSeq.length === 0 || prior.has(`dasha:maha:${prevMaha}`))
          ) {
            prior.add(`dasha:antar:${prevMaha}/${lastAntarOfPrevMaha}`);
          }
        } else {
          prior.add(`dasha:antar:${mLord}/${prevAntar}`);
        }
      }
      if (pratyantar && pratyantarSeq.length === 0) {
        const pLord = pratyantar.lord.toLowerCase();
        if (pLord === aLord) {
          // A new antar starts with `aLord/aLord`, so the immediately preceding
          // pratyantar was the LAST pratyantar (`previousLord(prevAntar)`) of
          // the immediately preceding antar (`prevAntar`).
          const prevParentMaha = aLord === mLord && prevMaha ? prevMaha : mLord;
          const prevParentAntar =
            aLord === mLord && prevMaha ? previousLord(prevMaha) : prevAntar;
          const lastPratyantar = prevParentAntar ? previousLord(prevParentAntar) : null;
          if (prevParentAntar && lastPratyantar) {
            const prevAntarId = `dasha:antar:${prevParentMaha}/${prevParentAntar}`;
            if (!currentMahaHasAntars || prior.has(prevAntarId)) {
              prior.add(`dasha:pratyantar:${prevParentMaha}/${prevParentAntar}/${lastPratyantar}`);
            }
          }
        } else {
          const prevPratyantar = previousLord(pLord);
          if (prevPratyantar) {
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
        for (const id of item.staleIds ?? [item.citedId]) {
          const level = dashaLevelOfId(id);
          if (level !== null) staleLevels.add(level);
        }
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
