/**
 * The evidence layer — Observation · Evidence · Confidence · Alternative.
 *
 * Read `confidence.ts` first: it explains why confidence is derived rather than
 * assigned, and `annotations.ts` explains why a model may annotate observations
 * but never author them. `ledger.ts` is the only entry point a renderer needs.
 */

export { alternateLagna, wholeSignHouse } from './alternateLagna';
export type { AlternateLagna, HouseShift, LagnaSensitivity } from './alternateLagna';

export { alternativeFor, DASHA_YEAR_DAYS } from './alternatives';
export type { Alternative, ConventionShift } from './alternatives';

export { validateAnnotations } from './annotations';
export type {
  AcceptedAnnotation,
  RawAnnotationPayload,
  RejectedAnnotation,
  RejectionReason,
  ValidatedAnnotations,
} from './annotations';

export { COMBUSTION_ORBS_DEG, RETROGRADE_COMBUSTION_ORBS_DEG, combustionOrbDeg } from './combustionOrbs';

export { assessConfidence, BOUNDARY_MARGIN_DEG, CUSP_THRESHOLD_DEG } from './confidence';
export type { ConfidenceDeduction, ConfidenceLevel, ConfidenceVerdict, DeductionCode } from './confidence';

export {
  chartFactors,
  factorIndex,
  factorPlanets,
  yogaDependsOnHouses,
  yogaFactorId,
} from './factors';
export type { ChartFactor, FactorClass } from './factors';

export { buildEvidenceLedger } from './ledger';
export type { EvidenceLedger, EvidenceRow } from './ledger';

export { buildObservations } from './observations';
export type { Observation, ObservationLedger } from './observations';
