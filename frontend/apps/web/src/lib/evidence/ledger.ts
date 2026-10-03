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

import { validateAnnotations, type RawAnnotationPayload } from './annotations';
import { buildObservations, type Observation } from './observations';

import type { AlternateLagna, LagnaSensitivity } from './alternateLagna';
import type { SiderealChart } from '@almamesh/browser/types';

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
   * How many model statements were rejected for citing something this chart
   * does not contain. Surfaced in Assumptions & Provenance so a drop is
   * counted, never silent.
   */
  readonly rejectedCount: number;
  /** The distinct bogus ids, for the provenance line. Bounded for display. */
  readonly rejectedCitations: readonly string[];
  /** True when a model reading was applied to at least one row. */
  readonly annotated: boolean;
}

const MAX_REPORTED_REJECTIONS = 8;

/**
 * Build the ledger. `payload` is UNTRUSTED model output; pass null (or omit it)
 * for the keyless / deterministic-only report.
 */
export function buildEvidenceLedger(
  chart: SiderealChart,
  payload?: RawAnnotationPayload | null,
): EvidenceLedger {
  const ledger = buildObservations(chart);
  const validated = validateAnnotations(payload, ledger.observationIds, ledger.factorIds);
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

  return {
    rows,
    alternateLagna: ledger.alternateLagna,
    lagnaSensitivity: ledger.lagnaSensitivity,
    generalGuidance: validated.generalGuidance,
    rejectedCount: validated.rejected.length,
    rejectedCitations: [...new Set(validated.rejected.map((r) => r.citedId))]
      .filter((id) => id !== '')
      .slice(0, MAX_REPORTED_REJECTIONS),
    annotated: validated.accepted.length > 0,
  };
}
