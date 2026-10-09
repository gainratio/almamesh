// TS mirror of the Python PREDICTIVE contexts as emitted by
// `model_dump(mode="json")`:
//
//   TransitContext      backend/src/almamesh/schemas/transits.py
//   VargaContextFull    backend/src/almamesh/schemas/vargas.py   (class VargaContext)
//   StrengthContext     backend/src/almamesh/schemas/strength.py
//   LifeDomainsContext  backend/src/almamesh/schemas/domains.py
//
// These are ADDITIVE, optional top-level keys on the chart payload
// (`transit_context` / `varga_context_full` / `strength_context` /
// `domains_context` on `SiderealChart`); older bundles omit them entirely.
//
// Same conventions as ./chart.ts: open-vocabulary enum fields (planet / sign /
// nakshatra names) are typed `string` at this JSON boundary; the SMALL closed
// sets the schemas document ("closed sets serialized as their .value") are
// typed as literal unions so the contract is self-describing. Datetimes are
// ISO-8601 UTC strings. Dict-keyed collections serialize with string keys.

import type { DomainStrengthReceipt } from "./strengthReceipt";

// --- closed-set enum values (serialized `.value`s of the Python enums) ---

export type SadeSatiPhase = "rising" | "peak" | "setting" | "none";

export type TransitEventKind =
  | "sign_ingress"
  | "sade_sati_phase"
  | "return"
  | "dasha_change"
  | "station";

export type TransitSeverity = "supportive" | "neutral" | "challenging";

/** The 16 Shodasavarga divisional charts, keyed by their BPHS D-number. */
export type DivisionalChartId =
  | "D1"
  | "D2"
  | "D3"
  | "D4"
  | "D7"
  | "D9"
  | "D10"
  | "D12"
  | "D16"
  | "D20"
  | "D24"
  | "D27"
  | "D30"
  | "D40"
  | "D45"
  | "D60";

export type LifeDomainName =
  | "career"
  | "finances"
  | "health"
  | "relationships"
  | "spiritual"
  | "education"
  | "family";

export type StrengthBand = "strong" | "moderate" | "weak";

export type DomainWindowSource = "dasha" | "transit";

/** Which dasha-year length built every period (schemas/astrology.py). */
export type DashaYearConvention =
  | "savana_360"
  | "gregorian_365_2425"
  | "julian_365_25";

// --- transit (gochara) context: schemas/transits.py ---

export interface TransitPlacement {
  readonly graha: string;
  readonly longitude: number;
  readonly sign: string;
  readonly sign_degrees: number;
  readonly nakshatra: string;
  readonly nakshatra_pada: number;
  readonly is_retrograde: boolean;
  readonly house_from_lagna: number;
  readonly house_from_moon: number;
  readonly natal_sign_occupied: string;
}

export interface GocharaContext {
  readonly instant: string;
  readonly transit_ayanamsa: number;
  readonly placements: Readonly<Record<string, TransitPlacement>>;
}

export interface SadeSatiSegment {
  readonly phase: SadeSatiPhase;
  readonly saturn_sign: string;
  readonly start: string;
  readonly end: string;
}

export interface SadeSatiContext {
  readonly is_active: boolean;
  readonly current_phase: SadeSatiPhase;
  readonly natal_moon_sign: string;
  readonly cycle: readonly SadeSatiSegment[];
  readonly cycle_start: string | null;
  readonly cycle_end: string | null;
}

export interface SlowTransitHit {
  readonly graha: string;
  readonly kind: TransitEventKind;
  readonly natal_point: string;
  readonly exact: string;
  readonly severity: TransitSeverity;
}

export interface DashaTransitFusion {
  readonly instant: string;
  readonly maha_lord: string;
  readonly antar_lord: string | null;
  readonly maha_lord_transit_house_from_moon: number;
  readonly maha_lord_transit_house_from_lagna: number;
  readonly reinforcing: readonly string[];
  readonly afflicting: readonly string[];
  readonly net_weight: number;
  readonly severity: TransitSeverity;
}

export type StationDirection = "retrograde" | "direct";

export interface TimelineEvent {
  readonly date: string;
  readonly kind: TransitEventKind;
  readonly graha: string | null;
  readonly from_sign: string | null;
  readonly to_sign: string | null;
  readonly from_lord: string | null;
  readonly to_lord: string | null;
  readonly sade_sati_phase: SadeSatiPhase | null;
  readonly severity: TransitSeverity;
  readonly descriptor: string;
  /** Station events only (Inc B). Absent on payloads saved by older builds. */
  readonly station_direction?: StationDirection | null;
  readonly station_sign?: string | null;
}

export interface TransitTimeline {
  readonly window_start: string;
  readonly window_end: string;
  readonly events: readonly TimelineEvent[];
}

export interface TransitContext {
  readonly instant: string;
  readonly gochara: GocharaContext;
  readonly sade_sati: SadeSatiContext;
  readonly slow_hits: readonly SlowTransitHit[];
  readonly fusion: DashaTransitFusion;
  readonly timeline: TransitTimeline;
}

// --- full Shodasavarga context: schemas/vargas.py (class VargaContext) ---

export interface VargaPlacementFull {
  readonly graha: string;
  readonly sign: string;
  readonly sign_lord: string;
  /**
   * Combustion (asta): the D1 graha-level flag the engine CARRIES onto every
   * divisional placement. Additive — older bundles omit it; treat absent as
   * `false`.
   */
  readonly is_combust?: boolean;
}

export interface VargaChartFull {
  readonly chart: DivisionalChartId;
  readonly lagna_sign: string;
  readonly lagna_sign_lord: string;
  readonly placements: Readonly<Record<string, VargaPlacementFull>>;
}

export interface VargottamaFlag {
  readonly point: string; // a graha name or the literal "lagna"
  readonly sign: string;
}

export interface ShadvargaOwnSign {
  readonly graha: string;
  readonly own_sign_count: number;
  readonly charts_in_own_sign: readonly DivisionalChartId[];
}

export interface VimshopakaScore {
  readonly graha: string;
  readonly score: number;
  readonly approximated: boolean;
}

export interface VargaContextFull {
  readonly charts: Readonly<Record<string, VargaChartFull>>;
  readonly vargottama: readonly VargottamaFlag[];
  readonly shadvarga_own_sign: readonly ShadvargaOwnSign[];
  readonly vimshopaka: readonly VimshopakaScore[];
}

// --- strength context (Ashtakavarga + Shadbala): schemas/strength.py ---

export interface BhinnashtakavargaChart {
  readonly planet: string;
  readonly bindus: Readonly<Record<string, number>>; // sign -> 0..8
  readonly total: number;
}

export interface SarvashtakavargaChart {
  readonly bindus: Readonly<Record<string, number>>;
  readonly total: number; // canonical 337
}

export interface AshtakavargaContext {
  readonly bhinna: Readonly<Record<string, BhinnashtakavargaChart>>;
  readonly sarva: SarvashtakavargaChart;
}

export interface BalaValue {
  readonly virupas: number;
  readonly citation: string;
  readonly approximated: boolean;
  readonly note: string | null;
}

export interface SthanaBala {
  readonly uccha: BalaValue;
  readonly saptavargaja: BalaValue;
  readonly ojayugma: BalaValue;
  readonly kendradi: BalaValue;
  readonly drekkana: BalaValue;
  readonly total_virupas: number;
}

export interface KalaBala {
  readonly nathonnatha: BalaValue;
  readonly paksha: BalaValue;
  readonly tribhaga: BalaValue;
  readonly abda: BalaValue;
  readonly masa: BalaValue;
  readonly vara: BalaValue;
  readonly hora: BalaValue;
  readonly ayana: BalaValue;
  readonly yuddha: BalaValue;
  readonly total_virupas: number;
}

export interface PlanetShadbala {
  readonly planet: string;
  readonly sthana: SthanaBala;
  readonly dig: BalaValue;
  readonly kala: KalaBala;
  readonly cheshta: BalaValue;
  readonly naisargika: BalaValue;
  readonly drik: BalaValue;
  readonly total_virupas: number;
  readonly total_rupas: number;
  readonly required_rupas: number;
  readonly meets_minimum: boolean;
}

export interface ShadbalaContext {
  readonly planets: Readonly<Record<string, PlanetShadbala>>;
}

export interface StrengthContext {
  readonly sunrise_utc_iso: string;
  readonly ashtakavarga: AshtakavargaContext;
  readonly shadbala: ShadbalaContext;
}

// --- per-life-domain synthesis: schemas/domains.py ---

export interface HouseSignificator {
  readonly house: number;
  readonly sign: string;
  readonly lord: string;
  readonly lord_house: number;
  readonly lord_sign: string;
  readonly lord_dignity: string;
  readonly rule: string;
}

export interface KarakaSignificator {
  readonly graha: string;
  readonly house: number;
  readonly sign: string;
  readonly dignity: string;
  readonly is_retrograde: boolean;
  readonly rule: string;
}

export interface VargaPlacementSummary {
  readonly chart: DivisionalChartId;
  readonly graha: string;
  readonly sign: string;
  readonly sign_lord: string;
  /** Generalized D1-sign-repeat marker (any varga). */
  readonly same_sign_as_d1: boolean;
  /** Classical BPHS vargottama — claimed ONLY when the varga is the D9. */
  readonly vargottama: boolean;
  readonly rule: string;
}

export interface StrengthSummary {
  readonly key_graha: string;
  readonly key_graha_rupas: number;
  readonly key_graha_meets_minimum: boolean;
  readonly sav_bindus: number;
  readonly band: StrengthBand;
  // Calibrated Tier-M strength %s (rigor spec §A.1/§A.2): two anchored, monotonic
  // axes + their min()-combiner headline. `strength_tier` is always "model" — a
  // Layer-2 model over exact BPHS inputs, never a measured fact.
  readonly shadbala_pct: number;
  readonly sav_pct: number;
  readonly strength_pct: number;
  readonly strength_tier: 'model';
  readonly approximated: boolean;
  readonly note: string;
}

export interface CurrentEmphasis {
  readonly active_dasha_significator: boolean;
  readonly dasha_levels: readonly string[]; // subset of maha/antar/pratyantar
  readonly matched_dasha_lords: readonly string[];
  readonly under_sade_sati: boolean;
  readonly transit_severity: TransitSeverity;
  /** transit_severity is a coarse vote-sum heuristic, flagged explicitly. */
  readonly approximated: boolean;
  readonly note: string;
  readonly rule: string;
}

export interface DomainWindow {
  readonly date: string;
  readonly source: DomainWindowSource;
  readonly kind: TransitEventKind;
  readonly trigger: string | null;
  readonly severity: TransitSeverity;
  readonly descriptor: string;
}

export interface LifeDomainForecast {
  readonly domain: string; // a LifeDomainName value
  readonly houses: readonly HouseSignificator[];
  readonly karakas: readonly KarakaSignificator[];
  readonly varga: VargaPlacementSummary;
  readonly strength_summary: StrengthSummary;
  readonly current_emphasis: CurrentEmphasis;
  readonly upcoming_windows: readonly DomainWindow[];
}

export interface LifeDomainsContext {
  readonly instant: string;
  readonly forecasts: Readonly<Record<string, LifeDomainForecast>>;
}

// --- the LAZY predictive payload: backend almamesh/predictive.py ---

export type { DomainStrengthReceipt } from "./strengthReceipt";
export type { DomainStrengthAssayResult } from "./strengthAssay";

/**
 * EXACTLY what the Python engine returns — the `model_dump(mode="json")` of the
 * backend `PredictiveContexts` model. Four contexts, no crypto: the engine
 * computes, it does not sign. Computed SEPARATELY from the natal chart (transits
 * take ~35s under Pyodide) at one EXPLICIT reference instant.
 */
export interface EnginePredictiveContexts {
  readonly transit_context: TransitContext;
  readonly varga_context_full: VargaContextFull;
  readonly strength_context: StrengthContext;
  readonly domains_context: LifeDomainsContext;
}

/**
 * What the Worker hands to app code: the engine's four contexts plus Assay's
 * minimum-composition results and the sealed per-domain strength receipts,
 * produced in TypeScript (see `strengthAssay.ts` / `strengthReceipt.ts`).
 *
 * A receipt introduces NO new number — `payload.summary` is the SAME
 * `StrengthSummary` already carried in `domains_context`. It makes a stored or
 * exported summary TAMPER-EVIDENT, nothing more: `strength_signer_public_key` is
 * generated per Worker boot and does not survive a reload, so a receipt proves
 * the summary was not altered after sealing — never who computed it.
 */
export interface PredictiveContexts extends EnginePredictiveContexts {
  /** Assay's deterministic minimum-composition explanation for each headline. */
  readonly domain_strength_assays: Readonly<Record<string, import("./strengthAssay").DomainStrengthAssayResult>>;
  /** Keyed by life domain; one receipt per `domains_context.forecasts` entry. */
  readonly domain_strength_receipts: Readonly<Record<string, DomainStrengthReceipt>>;
  /** The device-local, per-boot signer these receipts were sealed under. */
  readonly strength_signer_public_key: string;
}
