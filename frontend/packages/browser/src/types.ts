// Pure type-only entrypoint for the engine's data contracts.
//
// These modules import nothing from the runtime/sync tier (`@gainratio/browser`),
// so consumers that only need the engine's *shapes* (e.g. the store's pure
// translation layer) can depend on this barrel without pulling the Pyodide
// worker, OPFS sync, or the edge-proc path dependency into their type graph.

export type {
  ChartSnapshot,
  HouseCusp,
  LagnaData,
  PlanetPosition,
  DashaPeriod,
  MahaDashaPeriod,
  SiderealChart,
  VimshottariDasha,
  YogaData,
  YogaFormationRule,
  YogaGrade,
  YogaStrengthFactor,
  NavamsaChart,
  VargaPlanet,
} from "./pyodide/chart";
export type {
  BirthInput,
  BootConfig,
  MeshBirthInput,
  MeshEdgeInput,
  PredictiveInput,
  PyodideAsset,
} from "./pyodide/protocol";
// Additive predictive contexts (transits, full vargas, strength, life domains)
// — the exact serialized shapes of the optional `*_context` keys above.
export type {
  PredictiveContexts,
  AshtakavargaContext,
  BalaValue,
  BhinnashtakavargaChart,
  CurrentEmphasis,
  DashaTransitFusion,
  DashaYearConvention,
  DivisionalChartId,
  DomainWindow,
  DomainWindowSource,
  GocharaContext,
  HouseSignificator,
  KalaBala,
  KarakaSignificator,
  LifeDomainForecast,
  LifeDomainName,
  LifeDomainsContext,
  PlanetShadbala,
  SadeSatiContext,
  SadeSatiPhase,
  SadeSatiSegment,
  SarvashtakavargaChart,
  ShadbalaContext,
  ShadvargaOwnSign,
  SlowTransitHit,
  SthanaBala,
  StrengthBand,
  StrengthContext,
  StrengthSummary,
  DomainStrengthAssayResult,
  TimelineEvent,
  TransitContext,
  TransitEventKind,
  TransitPlacement,
  TransitSeverity,
  TransitTimeline,
  VargaChartFull,
  VargaContextFull,
  VargaPlacementFull,
  VargaPlacementSummary,
  VargottamaFlag,
  VimshopakaScore,
} from "./pyodide/predictive";
// The Ed25519-sealed strength-summary receipt (tamper-evidence, not
// attestation — see ./pyodide/strengthReceipt for the honesty covenant).
export type { DomainStrengthReceipt, DomainStrengthSubject } from "./pyodide/strengthReceipt";
// The relational MESH edge between two charts — the exact serialized shape of
// the worker's `computeMeshEdge` result (backend schemas/mesh.py).
export type {
  AshtakootaResult,
  ChartOverlay,
  CompatibilityBand,
  ContactKind,
  DashaSynchronyResult,
  DoshaCancellation,
  DoshaFlag,
  DoshaMatchResult,
  GrahaCondition,
  KarakaAssessment,
  KootaName,
  KootaResult,
  MangalDoshaResult,
  MangalReference,
  MangalReferenceResult,
  MatchRole,
  MeshDoshaName,
  MeshEdgeContext,
  MeshRelationship,
  MoonSummary,
  NatalPoint,
  OverlayContact,
  OverlayPair,
  OverlayPlacement,
  RelationSignificators,
  SynchronySegment,
} from "./pyodide/mesh";
// Rectification wire shapes: the camelCase input and the snake_case raw result
// emitted by `model_dump(mode="json")` on the backend Pydantic models.
export type {
  EventEvidenceRaw,
  RectificationCandidateRaw,
  RectificationInput,
  RectificationResultRaw,
} from "./pyodide/rectification";

import type { BirthInput, MeshEdgeInput, PredictiveInput } from "./pyodide/protocol";
import type { SiderealChart } from "./pyodide/chart";
import type { MeshEdgeContext } from "./pyodide/mesh";
import type { PredictiveContexts } from "./pyodide/predictive";
import type { RectificationInput, RectificationResultRaw } from "./pyodide/rectification";

/**
 * The ready-engine surface a consumer calls. Declared here (not re-exported from
 * `./pyodide/runtime`) so type-only consumers — e.g. the hooks layer — get the
 * shape WITHOUT pulling the runtime/sync graph (`@gainratio/browser`) into their
 * build. Kept structurally identical to the `ChartEngine` the runtime returns.
 */
export interface ChartEngine {
  generateChart(birth: BirthInput): Promise<SiderealChart>;
  /** LAZY predictive payload at an EXPLICIT instant (~35s under Pyodide). */
  computePredictive(input: PredictiveInput): Promise<PredictiveContexts>;
  /** Relational MESH edge between two birth inputs (explicit instants only). */
  computeMeshEdge(input: MeshEdgeInput): Promise<MeshEdgeContext>;
  /** Birth-time rectification: score life events against candidate times. */
  computeRectification(input: RectificationInput): Promise<RectificationResultRaw>;
}
