/**
 * AlmaMesh Shared Types
 * Browser computation, persisted store, and UI boundary contracts
 *
 * @packageDocumentation
 */

// `PlanetName` lives in ./energy (single source). Import it locally so the
// interfaces below can reference it; it is also re-exported via `export *`.
import type { PlanetName } from './energy';

// `MemberRelationship` lives in ./mesh (single source, backend-aligned).
// Imported locally for the mesh-edge contract below; re-exported via `export *`.
import type { MemberRelationship } from './mesh';

export * from './safeDiagnostics';

// Animation types for 3D Dasha visualization
export type {
  GrahaName,
  GrahaDef,
  DashaLevel,
  Segment,
  CameraTrack,
  TimeRange,
  AnimationScript,
} from './animation';

// Energy / force-field types + lowercase planet constant tables.
// Includes `PlanetName` (canonical lowercase planet id) — the single source.
export * from './energy';

// Backup & Restore envelope contract (export/import all user data — Spec 061).
export * from './backup';

// Mesh relationship vocabulary (anchor "self" + backend-aligned member values).
export * from './mesh';

// Chat types for Assistant UI integration
export type {
  ChatThread,
  ChatThreadAsOf,
  ChatMessage,
  ChatSummaryDraft,
  ChatSummaryGenerator,
  ChatSummaryItem,
  ChatThreadSummary,
  ChatThreadWithMessages,
  StreamingToken,
  StreamingDone,
  StreamingError,
} from './chat';

// (Energy exports are defined above; avoid duplicate re-exports.)

// ============================================================================
// Base Types
// ============================================================================

export interface BaseResponse {
  success: boolean;
  message: string;
}

// ============================================================================
// Birth and Location Types
// ============================================================================

/**
 * Location details from geocoding
 * Matches backend LocationDetails class
 */
export interface LocationDetails {
  city: string;
  state?: string | null;
  country?: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
  timezone_offset_hours?: number | null;
  location_name?: string;
}

/**
 * Processed birth data stored in backend
 * Matches backend ProcessedBirthData class
 */
export interface ProcessedBirthData {
  name?: string;
  name_token?: string;
  safe_name?: string;
  birth_datetime_utc: string;
  birth_datetime_local: string;
  birth_location_details: LocationDetails;
  transit_location_details?: LocationDetails | null;
  pii_reference_id?: string | null;
  /**
   * The originally-entered birth time (`HH:MM`) when the chart was computed from
   * a *rectified* time instead. Absent when no rectification was applied. The
   * effective (rectified) instant drives `birth_datetime_utc`/`_local`.
   */
  birth_time_original?: string;
  /** Confidence in the birth time (a `TIME_CONFIDENCE` key from @almamesh/constants). */
  birth_time_confidence?: string;
}

// ============================================================================
// Chart Types
// ============================================================================

// `PlanetName` (lowercase 'sun'..'ketu') is exported from './energy' via the
// `export * from './energy'` above — single source of truth.

export type ZodiacSign =
  | 'aries' | 'taurus' | 'gemini' | 'cancer'
  | 'leo' | 'virgo' | 'libra' | 'scorpio'
  | 'sagittarius' | 'capricorn' | 'aquarius' | 'pisces';

export interface PlanetPosition {
  name: PlanetName;
  longitude: number;
  latitude?: number;
  sign: ZodiacSign;
  sign_degrees: number;
  house: number;
  nakshatra: string;
  nakshatra_pada: number;
  nakshatra_lord: PlanetName;
  sign_lord: PlanetName;
  is_retrograde: boolean;
  is_combust: boolean;
  /** Angular separation to the Sun (deg); null for the Sun and the nodes. */
  combustion_separation_deg?: number | null;
  /** Whole-sign houses this graha lords from the lagna; [] for Rahu/Ketu. */
  houses_ruled?: number[];
  /** Lords both a kendra and a trikona from the lagna (BPHS Yogakaraka). */
  is_yogakaraka?: boolean;
  dignity?: 'exalted' | 'own_sign' | 'debilitated' | 'neutral';
  // NOTE: no per-planet numeric strength exists on the natal contract. Real
  // Shadbala / Ashtakavarga live ONLY in the predictive `StrengthCtx`.
}

// ============================================================================
// Varga (Divisional Chart) Types
// ============================================================================

/**
 * Planet data in a divisional chart
 * Matches backend VargaPlanetData class
 */
export interface VargaPlanetData {
  sign: ZodiacSign;
  house: number;
  sign_lord: PlanetName;
  nakshatra?: string;
}

/**
 * Data for a single divisional chart
 * Matches backend VargaChartData class
 */
export interface VargaChartData {
  name: string;  // D1, D9, D10, etc.
  lagna_sign: ZodiacSign;
  planets: Record<string, VargaPlanetData>;
}

/**
 * Complete divisional charts context
 * Matches backend VargaContext class
 */
export interface VargaContext {
  D1: VargaChartData;   // Rasi chart (required)
  D2?: VargaChartData;  // Hora
  D3?: VargaChartData;  // Drekkana
  D4?: VargaChartData;  // Chaturthamsa
  D7?: VargaChartData;  // Saptamsa
  D9: VargaChartData;   // Navamsa (required)
  D10?: VargaChartData; // Dasamsa
  D12?: VargaChartData; // Dwadasamsa
  D16?: VargaChartData; // Shodasamsa
  D20?: VargaChartData; // Vimsamsa
  D24?: VargaChartData; // Chaturvimsamsa
  D27?: VargaChartData; // Saptavimsamsa
  D30?: VargaChartData; // Trimsamsa
  D40?: VargaChartData; // Khavedamsa
  D45?: VargaChartData; // Akshavedamsa
  D60?: VargaChartData; // Shashtyamsa
}

export interface DashaData {
  lord: PlanetName;
  start_date: string;
  end_date: string;
  level: 'maha' | 'antar' | 'pratyantar' | 'sookshma' | 'prana';
  duration_years: number;
}

/**
 * A maha-dasha sequence row carrying its own dated antardasha tree. Additive:
 * `antar_sequence` is absent on charts computed by older engine bundles, so
 * old persisted charts keep loading unchanged.
 */
export interface MahaDashaData extends DashaData {
  /** That maha's 9 dated antardashas (level 'antar'), engine-computed. */
  antar_sequence?: DashaData[];
}

/**
 * Which dasha-year length built every Vimshottari period (engine
 * DashaYearConvention). Surfaced so the UI/report/LLM can cite it and the
 * convention is never silently switched.
 */
export type DashaYearConvention =
  | 'savana_360'
  | 'gregorian_365_2425'
  | 'julian_365_25';

export interface VimshottariDashaData {
  maha_dasha: DashaData;
  // The engine emits null antar/pratyantar legs when the reference instant falls
  // outside a computed sub-period, so these are genuinely optional (not a lie the
  // adapter casts away). Renderers guard each leg.
  antar_dasha?: DashaData;
  pratyantar_dasha?: DashaData;
  sookshma_dasha?: DashaData;
  prana_dasha?: DashaData;
  full_sequence: MahaDashaData[];
  /**
   * The CURRENT antar's 9 dated pratyantardashas (level 'pratyantar').
   * Absent on older bundles and when the engine emitted null (no current antar).
   */
  pratyantar_sequence?: DashaData[];
  /** Declared dasha-year convention. Absent on older engine bundles. */
  convention?: DashaYearConvention;
}

// ============================================================================
// Predictive Contexts (additive; engine-computed, adapter-reshaped)
//
// UI mirrors of the four optional predictive contexts the Python engine emits
// (backend/src/almamesh/schemas/{transits,vargas,strength,domains}.py). Same
// reshape contract as the rest of this file: planet names are the canonical
// lowercase `PlanetName`, signs are the lowercase `ZodiacSign`, datetimes are
// ISO-8601 UTC strings, and every number/citation is the engine's verbatim.
// ============================================================================

export type TransitSeverity = 'supportive' | 'neutral' | 'challenging';

export type SadeSatiPhase = 'rising' | 'peak' | 'setting' | 'none';

export type TransitEventKind =
  | 'sign_ingress'
  | 'sade_sati_phase'
  | 'return'
  | 'dasha_change'
  | 'station';

/** The 16 Shodasavarga divisional charts, keyed by their BPHS D-number. */
export type DivisionalChartId =
  | 'D1' | 'D2' | 'D3' | 'D4' | 'D7' | 'D9' | 'D10' | 'D12'
  | 'D16' | 'D20' | 'D24' | 'D27' | 'D30' | 'D40' | 'D45' | 'D60';

export type LifeDomain =
  | 'career'
  | 'finances'
  | 'health'
  | 'relationships'
  | 'spiritual'
  | 'education'
  | 'family';

export type StrengthBand = 'strong' | 'moderate' | 'weak';

export type DomainWindowSource = 'dasha' | 'transit';

/** Engine `Dignity` values (constants/astrology.py), serialized lowercase. */
export type DignityName =
  | 'exalted'
  | 'debilitated'
  | 'own'
  | 'great_friend'
  | 'friend'
  | 'neutral'
  | 'enemy'
  | 'bitter_enemy';

// --- transits (gochara) ---

export interface TransitPlacementData {
  graha: PlanetName;
  longitude: number;
  sign: ZodiacSign;
  sign_degrees: number;
  nakshatra: string;
  nakshatra_pada: number;
  is_retrograde: boolean;
  house_from_lagna: number;
  house_from_moon: number;
  natal_sign_occupied: ZodiacSign;
}

export interface GocharaData {
  instant: string;
  transit_ayanamsa: number;
  placements: Partial<Record<PlanetName, TransitPlacementData>>;
}

export interface SadeSatiSegmentData {
  phase: SadeSatiPhase;
  saturn_sign: ZodiacSign;
  start: string;
  end: string;
}

export interface SadeSatiData {
  is_active: boolean;
  current_phase: SadeSatiPhase;
  natal_moon_sign: ZodiacSign;
  cycle: SadeSatiSegmentData[];
  cycle_start: string | null;
  cycle_end: string | null;
}

export interface SlowTransitHitData {
  graha: PlanetName;
  kind: TransitEventKind;
  /** "moon" | "lagna" | "natal_<graha>" (open vocabulary by schema). */
  natal_point: string;
  exact: string;
  severity: TransitSeverity;
}

export interface DashaTransitFusionData {
  instant: string;
  maha_lord: PlanetName;
  antar_lord: PlanetName | null;
  maha_lord_transit_house_from_moon: number;
  maha_lord_transit_house_from_lagna: number;
  reinforcing: PlanetName[];
  afflicting: PlanetName[];
  net_weight: number;
  severity: TransitSeverity;
}

export type StationDirection = 'retrograde' | 'direct';

export interface TransitTimelineEventData {
  date: string;
  kind: TransitEventKind;
  graha: PlanetName | null;
  from_sign: ZodiacSign | null;
  to_sign: ZodiacSign | null;
  from_lord: PlanetName | null;
  to_lord: PlanetName | null;
  sade_sati_phase: SadeSatiPhase | null;
  severity: TransitSeverity;
  /** STABLE machine key, e.g. "saturn.ingress.aries" (LLM/i18n narrates it). */
  descriptor: string;
  /** Station events: which way the graha turns, and the sign it turns in. */
  station_direction: StationDirection | null;
  station_sign: ZodiacSign | null;
}

export interface TransitTimelineData {
  window_start: string;
  window_end: string;
  events: TransitTimelineEventData[];
}

/** Everything the transit layer emits for one chart + instant. */
export interface TransitCtx {
  instant: string;
  gochara: GocharaData;
  sade_sati: SadeSatiData;
  slow_hits: SlowTransitHitData[];
  fusion: DashaTransitFusionData;
  timeline: TransitTimelineData;
}

// --- full Shodasavarga (distinct from the legacy D9-only VargaContext above) ---

export interface VargaPlacementFullData {
  graha: PlanetName;
  sign: ZodiacSign;
  sign_lord: PlanetName;
  /** D1 combustion (asta) carried onto this divisional placement by the engine. */
  is_combust: boolean;
}

export interface VargaChartFullData {
  chart: DivisionalChartId;
  lagna_sign: ZodiacSign;
  lagna_sign_lord: PlanetName;
  placements: Partial<Record<PlanetName, VargaPlacementFullData>>;
}

export interface VargottamaFlagData {
  /** A `PlanetName` value or the literal "lagna". */
  point: string;
  sign: ZodiacSign;
}

export interface ShadvargaOwnSignData {
  graha: PlanetName;
  own_sign_count: number;
  charts_in_own_sign: DivisionalChartId[];
}

export interface VimshopakaScoreData {
  graha: PlanetName;
  score: number;
  approximated: boolean;
}

/** All 16 divisional charts + classical strength tallies. */
export interface VargaCtxFull {
  charts: Partial<Record<DivisionalChartId, VargaChartFullData>>;
  vargottama: VargottamaFlagData[];
  shadvarga_own_sign: ShadvargaOwnSignData[];
  vimshopaka: VimshopakaScoreData[];
}

// --- strength (Ashtakavarga + Shadbala) ---

export interface BhinnashtakavargaData {
  planet: PlanetName;
  bindus: Record<ZodiacSign, number>;
  total: number;
}

export interface SarvashtakavargaData {
  bindus: Record<ZodiacSign, number>;
  /** Canonical 337 for every chart. */
  total: number;
}

export interface AshtakavargaData {
  bhinna: Partial<Record<PlanetName, BhinnashtakavargaData>>;
  sarva: SarvashtakavargaData;
}

export interface BalaValueData {
  virupas: number;
  citation: string;
  approximated: boolean;
  note: string | null;
}

export interface SthanaBalaData {
  uccha: BalaValueData;
  saptavargaja: BalaValueData;
  ojayugma: BalaValueData;
  kendradi: BalaValueData;
  drekkana: BalaValueData;
  total_virupas: number;
}

export interface KalaBalaData {
  nathonnatha: BalaValueData;
  paksha: BalaValueData;
  tribhaga: BalaValueData;
  abda: BalaValueData;
  masa: BalaValueData;
  vara: BalaValueData;
  hora: BalaValueData;
  ayana: BalaValueData;
  yuddha: BalaValueData;
  total_virupas: number;
}

export interface PlanetShadbalaData {
  planet: PlanetName;
  sthana: SthanaBalaData;
  dig: BalaValueData;
  kala: KalaBalaData;
  cheshta: BalaValueData;
  naisargika: BalaValueData;
  drik: BalaValueData;
  total_virupas: number;
  total_rupas: number;
  required_rupas: number;
  meets_minimum: boolean;
}

export interface ShadbalaData {
  /** The seven classical grahas (nodes excluded by Parashari Shadbala). */
  planets: Partial<Record<PlanetName, PlanetShadbalaData>>;
}

export interface StrengthCtx {
  /** ISO-8601 UTC civil sunrise preceding birth (Kalabala basis). */
  sunrise_utc_iso: string;
  ashtakavarga: AshtakavargaData;
  shadbala: ShadbalaData;
}

// --- per-life-domain synthesis ---

export interface HouseSignificatorData {
  house: number;
  sign: ZodiacSign;
  lord: PlanetName;
  lord_house: number;
  lord_sign: ZodiacSign;
  lord_dignity: DignityName;
  rule: string;
}

export interface KarakaSignificatorData {
  graha: PlanetName;
  house: number;
  sign: ZodiacSign;
  dignity: DignityName;
  is_retrograde: boolean;
  rule: string;
}

export interface VargaPlacementSummaryData {
  chart: DivisionalChartId;
  graha: PlanetName;
  sign: ZodiacSign;
  sign_lord: PlanetName;
  /** Generalized D1-sign-repeat marker (any varga). */
  same_sign_as_d1: boolean;
  /** Classical BPHS vargottama — claimed ONLY when the varga is the D9. */
  vargottama: boolean;
  rule: string;
}

export interface StrengthSummaryData {
  key_graha: PlanetName;
  key_graha_rupas: number;
  key_graha_meets_minimum: boolean;
  sav_bindus: number;
  band: StrengthBand;
  // Calibrated Tier-M strength %s (rigor spec §A.1/§A.2): two anchored, monotonic
  // axes (Shadbala pass-line 60%, SAV midpoint 50%) + their min()-combiner
  // headline. `strength_tier` is a Layer-2 model over exact BPHS inputs.
  shadbala_pct: number;
  sav_pct: number;
  strength_pct: number;
  strength_tier: 'model';
  approximated: boolean;
  note: string;
}

export interface StrengthAssayComponentData {
  id: string;
  raw: number;
  normalized: number | null;
  declared_weight: number | null;
  operation: 'add' | 'subtract';
  coefficient: number;
  contribution: number;
  contribution_interval: { low: number; high: number } | null;
}

/** Assay's typed minimum-composition result for one domain-strength headline. */
export interface StrengthAssayData {
  schema: 'assay.result/v1';
  method: { id: 'minimum'; version: string };
  score: number;
  interval: { low: number; high: number } | null;
  clamp: 'reject' | 'clamp';
  intercept: null;
  weight_total: null;
  components: ReadonlyArray<StrengthAssayComponentData>;
  inputs_hash: string;
  selected_component_id: string;
}

export interface CurrentEmphasisData {
  active_dasha_significator: boolean;
  /** Subset of "maha" / "antar" / "pratyantar" (schema types it as str). */
  dasha_levels: string[];
  matched_dasha_lords: PlanetName[];
  under_sade_sati: boolean;
  transit_severity: TransitSeverity;
  /** transit_severity is a coarse vote-sum heuristic, flagged explicitly. */
  approximated: boolean;
  note: string;
  rule: string;
}

export interface DomainWindowData {
  date: string;
  source: DomainWindowSource;
  kind: TransitEventKind;
  trigger: PlanetName | null;
  severity: TransitSeverity;
  descriptor: string;
}

export interface LifeDomainForecastData {
  domain: LifeDomain;
  houses: HouseSignificatorData[];
  karakas: KarakaSignificatorData[];
  varga: VargaPlacementSummaryData;
  strength_summary: StrengthSummaryData;
  /** Present on current Worker results; absent only on an older cached payload. */
  strength_assay?: StrengthAssayData;
  current_emphasis: CurrentEmphasisData;
  upcoming_windows: DomainWindowData[];
}

/** All seven life-domain forecasts for one chart + instant. */
export interface DomainsCtx {
  instant: string;
  forecasts: Record<LifeDomain, LifeDomainForecastData>;
}

// ============================================================================
// Mesh Edge (relational context between two charts; engine-computed,
// adapter-reshaped)
//
// UI mirror of the backend `MeshEdgeContext` (schemas/mesh.py). INTEGRITY
// FRAME: relations are computed FROM two finished natal charts (read-only
// inputs); neither chart is recomputed, reweighted or mutated by the other.
// Same reshape contract as the rest of this file: planet names are the
// canonical lowercase `PlanetName`, signs the lowercase `ZodiacSign`,
// datetimes ISO-8601 UTC strings, every number/citation engine-verbatim.
// In every `MeshEdgeCtx`, `a` is the ANCHOR's chart and `b` the MEMBER's.
// ============================================================================

/** Explicit Melapaka role — stated by the caller, never guessed by the engine. */
export type MatchRole = 'bride' | 'groom';

/** The eight kootas of Ashtakoota Guna Milan (1+2+3+4+5+6+7+8 = 36). */
export type KootaName =
  | 'varna'
  | 'vashya'
  | 'tara'
  | 'yoni'
  | 'graha_maitri'
  | 'gana'
  | 'bhakoot'
  | 'nadi';

/** Classical-convention reading of the /36 total (labels, not verdicts). */
export type CompatibilityBand = 'not_recommended' | 'average' | 'good' | 'excellent';

/** The dosha flags Guna Milan raises (closed set). */
export type MeshDoshaName = 'bhakoot_dosha' | 'nadi_dosha';

/** Reference point Mars's dosha houses are counted from (per school). */
export type MangalReferencePoint = 'lagna' | 'moon' | 'venus';

/** How a guest graha touches a host natal point in the overlay. */
export type OverlayContactKind = 'close_conjunction' | 'same_sign' | 'graha_drishti';

/** A host chart's natal points the overlay targets (lagna + the 9 grahas). */
export type NatalPointName = 'lagna' | PlanetName;

/** The Moon facts Guna Milan reads — verbatim from the natal context. */
export interface MeshMoonData {
  nakshatra: string;
  nakshatra_index: number;
  nakshatra_pada: number;
  sign: ZodiacSign;
  sign_degrees: number;
}

/** One koota's score with its human-readable basis and table citation. */
export interface KootaResultData {
  koota: KootaName;
  earned: number;
  maximum: number;
  basis: string;
  source: string;
}

/** A classical cancellation rule that fired, with its citation. */
export interface DoshaCancellationData {
  rule: string;
  description: string;
  source: string;
}

/** A dosha verdict: present / cancelled, with the rules that decided it. */
export interface DoshaFlagData {
  name: MeshDoshaName;
  present: boolean;
  cancelled: boolean;
  cancellations: DoshaCancellationData[];
  basis: string;
  source: string;
}

/** The full 8-koota / 36-guna Melapaka match between two Moons. */
export interface AshtakootaData {
  bride_moon: MeshMoonData;
  groom_moon: MeshMoonData;
  kootas: KootaResultData[];
  total: number;
  maximum: number;
  band: CompatibilityBand;
  band_basis: string;
  bhakoot_dosha: DoshaFlagData;
  nadi_dosha: DoshaFlagData;
  source: string;
}

/** Mars's dosha verdict counted from ONE reference point (one school). */
export interface MangalReferenceData {
  reference: MangalReferencePoint;
  school: string;
  mars_sign: ZodiacSign;
  mars_house: number;
  in_dosha_house: boolean;
  cancellations: DoshaCancellationData[];
  net_dosha: boolean;
  source: string;
}

/** Mangal dosha for one chart across the three classical references. */
export interface MangalDoshaData {
  references: MangalReferenceData[];
  has_dosha: boolean;
  convention: string;
}

/** Mutual Mangal-dosha comparison between two charts. */
export interface DoshaMatchData {
  a: MangalDoshaData;
  b: MangalDoshaData;
  mutually_cancelled: boolean;
  compatible: boolean;
  basis: string;
  source: string;
}

/** A guest graha placed (read-only) into a host whole-sign house. */
export interface OverlayPlacementData {
  planet: PlanetName;
  sign: ZodiacSign;
  host_house: number;
}

/** One guest-graha -> host-natal-point contact. */
export interface OverlayContactData {
  planet: PlanetName;
  target: NatalPointName;
  kind: OverlayContactKind;
  host_house: number;
  orb_degrees: number | null;
  heuristic: boolean;
  source: string;
}

/** Guest grahas overlaid on a host chart: placements + typed contacts. */
export interface ChartOverlayData {
  host_lagna_sign: ZodiacSign;
  placements: OverlayPlacementData[];
  contacts: OverlayContactData[];
  conjunction_orb_degrees: number;
  convention: string;
}

/** Both overlay directions for a pair of charts (`a` anchor, `b` member). */
export interface OverlayPairData {
  b_in_a: ChartOverlayData;
  a_in_b: ChartOverlayData;
}

/** One window slice where both charts' maha+antar legs are constant. */
export interface SynchronySegmentData {
  start: string;
  end: string;
  a_maha: PlanetName;
  a_antar: PlanetName;
  b_maha: PlanetName;
  b_antar: PlanetName;
  shared_lords: PlanetName[];
  simultaneous_boundary: boolean;
}

/** Two charts' dated Vimshottari timelines joined over an explicit window. */
export interface DashaSynchronyData {
  window_start: string;
  window_end: string;
  segments: SynchronySegmentData[];
  convention_a: DashaYearConvention;
  convention_b: DashaYearConvention;
  basis: string;
}

/** A graha's observable natal condition (verbatim engine facts). */
export interface GrahaConditionData {
  planet: PlanetName;
  sign: ZodiacSign;
  house: number;
  dignity: DignityName;
  is_retrograde: boolean;
  is_combust: boolean;
}

/** One karaka graha's condition, with the karakatva citation. */
export interface KarakaAssessmentData {
  condition: GrahaConditionData;
  source: string;
}

/** The classical house + karaka corroboration for one relation, one chart. */
export interface RelationSignificatorsData {
  relationship: MemberRelationship;
  karaka_house: number;
  house_basis: string;
  house_sign: ZodiacSign;
  house_lord: PlanetName;
  lord_condition: GrahaConditionData;
  occupants: PlanetName[];
  karakas: KarakaAssessmentData[];
}

/**
 * The full relation context between two READ-ONLY natal charts. `a` is the
 * ANCHOR profile's chart and `b` the MEMBER's (the store's `ensureMeshEdge`
 * fixes this order); `significators_a` belongs to the anchor, `b_in_a`
 * overlays the member's grahas on the anchor's houses, and so on.
 */
export interface MeshEdgeCtx {
  relationship: MemberRelationship;
  role_a: MatchRole;
  role_b: MatchRole;
  ashtakoota: AshtakootaData;
  mangal_match: DoshaMatchData;
  overlay: OverlayPairData;
  synchrony: DashaSynchronyData;
  significators_a: RelationSignificatorsData;
  significators_b: RelationSignificatorsData;
  /** The engine's read-only integrity statement, verbatim. */
  integrity_note: string;
}

/**
 * The engine's qualitative yoga grade — a bucketing of the SAME `strength_pct`
 * the report prints beside it (backend `yogas/factors.band_for_pct`: >=75%
 * strong, >=40% moderate, else weak). Never re-derive it from the percentage;
 * mirror this field, so the word and the number can never contradict.
 */
export type YogaGrade = 'strong' | 'moderate' | 'weak';

/** The engine's closed yoga-category vocabulary. */
export type YogaCategory =
  | 'mahapurusha'
  | 'raja'
  | 'dhana'
  | 'chandra'
  | 'surya'
  | 'auspicious'
  | 'dosha'
  | 'special';

/** The closed vocabulary of observed factors behind a yoga's grade. */
export type YogaFactorType = 'dignity' | 'combustion' | 'retrograde' | 'house_class';

/**
 * One real, observed factor behind a yoga's qualitative grade — the engine's
 * own words (`value` like "exalted", `basis` a classical citation), verbatim.
 */
export interface YogaStrengthFactorData {
  factor_type: YogaFactorType;
  planet: PlanetName;
  value: string;
  basis: string;
  /**
   * The signed ±1 this factor contributes to the yoga's net marks (0 = neutral).
   * Additive; absent on bundles stored before the calibrated-strength upgrade.
   */
  mark?: number;
}

/** An explicit formation clause that fired, with its classical source. */
export interface YogaFormationRuleData {
  rule: string;
  description: string;
  source: string;
  planets: PlanetName[];
  houses: number[];
}

/**
 * A detected yoga with a complete, honest trace (engine YogaData verbatim).
 * Every trace list is min-length-1 by backend schema; only FORMED yogas are
 * emitted. The old `strength` / `effective_strength` / `is_active` numeric
 * fields no longer exist anywhere in the contract.
 */
export interface YogaData {
  name: string;
  display_name: string;
  category: YogaCategory;
  description: string;
  effects: string;
  grade: YogaGrade;
  strength_factors: YogaStrengthFactorData[];
  /**
   * Calibrated STRUCTURAL strength (rigor-upgrade §A.1, Tier S) — a Layer-2
   * MODEL output over the ±1 mark lattice, never a measured fact. All additive;
   * absent on bundles stored before the upgrade. `strength_pct` is anchored to
   * this yoga's OWN max-favorable/max-unfavorable achievable range.
   */
  net_marks?: number;
  max_favorable?: number;
  max_unfavorable?: number;
  strength_pct?: number;
  strength_tier?: 'structural';
  planets_involved: PlanetName[];
  houses_involved: number[];
  planetary_signature: string;
  formation_rules: YogaFormationRuleData[];
}

/**
 * Base persona type with dual-mode content (layman + technical)
 * Matches backend Persona class
 */
export interface Persona {
  layman?: string;
  technical?: string;
}

/**
 * Titled persona with dual-mode content
 * Matches backend TitledPersona, Strength, Challenge, LifeTheme classes
 */
export interface TitledPersona extends Persona {
  title?: string;
}

/**
 * Health guidance with dual-mode content
 * Matches backend HealthGuidance class
 */
export interface HealthGuidance extends Persona {}

/** Natal family guidance (report-v2 prompts); same dual-mode shape. */
export interface FamilyGuidance extends Persona {}

/**
 * Education guidance with dual-mode content
 * Matches backend EducationGuidance class
 */
export interface EducationGuidance extends Persona {}

/**
 * Career guidance with dual-mode content
 * Matches backend CareerGuidance class
 */
export interface CareerGuidance extends Persona {}

/**
 * Relationship guidance with dual-mode content
 * Matches backend RelationshipGuidance class
 */
export interface RelationshipGuidance extends Persona {}

/**
 * Finance guidance with dual-mode content
 * Matches backend FinanceGuidance class
 */
export interface FinanceGuidance extends Persona {}

/**
 * Spiritual guidance with dual-mode content
 * Matches backend SpiritualGuidance class
 */
export interface SpiritualGuidance extends Persona {}

/**
 * Life evolution guidance with dual-mode content
 * Matches backend LifeEvolutionGuidance class
 */
export interface LifeEvolutionGuidance extends Persona {}

/**
 * Remedial measures with dual-mode content
 * Matches backend RemedialMeasures class
 */
export interface RemedialMeasures extends Persona {}

/**
 * Integrated yoga narrative with dual-mode content
 * Matches backend IntegratedYogaNarrative class
 */
export interface IntegratedYogaNarrative extends Persona {}

/**
 * Current period guidance (for dasha timing)
 * Used for displaying current astrological period information
 */
export interface CurrentPeriodGuidance {
  current_period?: string;
  period_summary?: string;
  guidance?: string;
  key_themes?: string[];
  opportunities?: string[];
  challenges?: string[];
  timing_advice?: Record<string, string>;
}

/**
 * Vedic interpretation with dual-mode persona-based content
 * Matches backend VedicInterpretation class
 */
export interface VedicInterpretation {
  // Dual-voice headline: `layman` is jargon-free ("For You"), `technical` names
  // the actual placements ("For Astrologer"). Renders pick a voice via
  // `personaText` at the boundary, so toggling re-renders without an LLM call.
  summary: Persona;
  strengths: TitledPersona[];
  challenges: TitledPersona[];
  life_themes: TitledPersona[];

  // Integrated yoga narrative (MANDATORY per backend)
  integrated_yoga_narrative?: IntegratedYogaNarrative;

  // Life area guidance - now Persona objects for dual-mode content
  health_guidance?: HealthGuidance | null;
  education_guidance?: EducationGuidance | null;
  career_guidance?: CareerGuidance | null;
  relationship_guidance?: RelationshipGuidance | null;
  finances_guidance?: FinanceGuidance | null;
  spiritual_guidance?: SpiritualGuidance | null;
  life_evolution_guidance?: LifeEvolutionGuidance | null;
  // Family (natal): added with the report-v2 prompts. Optional: readings saved
  // before it have none, and the family card then shows engine data only.
  family_guidance?: FamilyGuidance | null;

  // Remedial measures
  remedial_measures?: RemedialMeasures | null;

  // The Road Ahead — upcoming engine-dated dasha windows (6th interpretation
  // section). Optional: readings saved before period intelligence landed have
  // no such section and must keep loading/rendering their 5 sections.
  upcoming_periods?: TitledPersona[] | null;

  // The "What's active now & next" predictive section (7th). Optional: absent
  // on natal-only readings (predictive not yet computed) and on older readings.
  current_sky?: TitledPersona[] | null;

  // Current period guidance (for UI display, may be populated from dasha data)
  current_period_guidance?: CurrentPeriodGuidance | null;
}

// ============================================================================
// Astronomical Calculation Types (from chart_data)
// ============================================================================

/**
 * Sidereal planet data from backend calculations
 * Matches backend SiderealPlanet class
 */
export interface SiderealPlanet {
  name: string;
  longitude: number;
  sign: string;
  sign_lord: string;
  nakshatra: string;
  nakshatra_lord: string;
  nakshatra_pada: number;
  house: number;
  is_retrograde: boolean;
  /** Engine combustion flag (asta). Optional: older stored charts omit it. */
  is_combust?: boolean;
  /** Whole-sign houses this graha lords; [] for Rahu/Ketu. Optional (older charts). */
  houses_ruled?: readonly number[];
  /** BPHS Yogakaraka flag. Optional (older charts). */
  is_yogakaraka?: boolean;
}

/**
 * The Lagna (Ascendant) as carried on `SiderealContext`. Historically an
 * untyped `Record<string, unknown>`; the named fields below document what the
 * engine actually emits while the `[key: string]: unknown` index signature
 * keeps it permissive (partial test fixtures like `lagna: {}` still type-check).
 *
 * The three `lagna_*` / `is_near_cusp` fields are the engine's CUSP-PROXIMITY
 * single-source-of-truth — additive, so older stored charts/bundles omit them
 * (the UI's lib/lagnaCusp.ts then falls back to its own measurement).
 */
export interface SiderealLagna {
  readonly sign?: string;
  readonly sign_degrees?: number;
  readonly longitude?: number;
  readonly sign_lord?: string;
  readonly nakshatra?: string;
  readonly nakshatra_pada?: number;
  readonly nakshatra_lord?: string;
  /** Degrees from the Lagna to the NEAREST sign boundary (engine cusp SoT). */
  readonly lagna_cusp_distance_deg?: number;
  /** The sign across that nearest boundary (engine Title-Case). */
  readonly lagna_adjacent_sign?: string | null;
  /** True when within the engine's near-cusp threshold (~3°). */
  readonly is_near_cusp?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Sidereal context containing all planet positions
 * Matches backend SiderealContext class
 */
export interface SiderealContext {
  julian_day: number;
  ayanamsa_value: number;
  ayanamsa_type: string;
  house_system: string;
  sidereal_time: number;
  lagna: SiderealLagna;
  planets: Record<string, SiderealPlanet>;
}

/**
 * The identity of one computed chart, stamped by the engine
 * (`backend/src/almamesh/snapshot.py`) and verified at the worker boundary.
 * `snapshot_id` = SHA-256 of the canonical JSON of the other ten fields.
 */
export interface ChartSnapshot {
  readonly snapshot_schema: string;
  readonly engine_version: string;
  readonly ephemeris_file: string;
  readonly data_hash: string;
  readonly ayanamsa: string;
  readonly node_type: string;
  readonly house_system: string;
  readonly dasha_year_convention: string;
  readonly birth_utc: string;
  /** The analysis instant: the chart's "as of" and its "current" dasha. */
  readonly reference_date: string;
  readonly snapshot_id: string;
}

/**
 * Astronomical calculations from chart data
 * Matches backend AstronomicalCalculations class
 */
export interface AstronomicalCalculations {
  sidereal_ctx: SiderealContext;
  varga_ctx?: VargaContext;
  dasha_ctx?: VimshottariDashaData;
  yoga_ctx?: YogaData[];
  /** Ashtakavarga + Shadbala (engine strength_context). Absent on older bundles. */
  strength_ctx?: StrengthCtx;
  /** Transits/Gochara + Sade Sati + 12-month timeline. Absent on older bundles. */
  transit_ctx?: TransitCtx;
  /** All 16 Shodasavarga charts (the D9-only varga_ctx above stays as-is). */
  varga_ctx_full?: VargaCtxFull;
  /** Per-life-domain deterministic synthesis (7 forecasts). */
  domains_ctx?: DomainsCtx;
  calculation_timestamp: string;
  /** The engine version that computed THIS chart (a legacy label when unstamped). */
  software_version: string;
  /** The snapshot this chart was computed with. Absent on charts stored before snapshots. */
  snapshot?: ChartSnapshot;
}

// Note: LocationDetails and ProcessedBirthData are defined above (lines 133-154)
// to avoid duplicate interface declarations

/**
 * Complete chart data structure
 * Matches backend ComprehensiveAstrologicalData class
 */
export interface ChartData {
  birth_data?: ProcessedBirthData;
  astronomical_calculations: AstronomicalCalculations;
  interpretation?: VedicInterpretation | null;
  dual_mode_interpretation?: Record<string, unknown> | null;
  current_conditions_for_query_date?: Record<string, unknown> | null;
}

/**
 * Birth chart generation response
 * Matches backend BirthChartGenerationResponse class
 */
export interface BirthChartGenerationResponse extends BaseResponse {
  person_name: string;
  chart_id?: string | null;
  storage_key?: string | null;
  interpretation?: VedicInterpretation | null;
  chart_data?: ChartData | null;
  chart_data_stored: boolean;
  processing_time_seconds?: number | null;
  generated_at: string;
  llm_metadata?: Record<string, unknown> | null;
  /** Token usage summary for real-time UI updates (populated when user is authenticated) */
  token_usage?: TokenUsageSummary | null;
}

// ============================================================================
// Rectification Types
// ============================================================================

// Life event category vocabulary for birth-time rectification (Phase 2)
export type LifeEventCategory =
  | 'marriage'
  | 'engagement'
  | 'breakup'
  | 'childbirth'
  | 'career_change'
  | 'promotion'
  | 'job_loss'
  | 'business_start'
  | 'relocation'
  | 'property_purchase'
  | 'windfall'
  | 'expense_shock'
  | 'health_issue'
  | 'surgery'
  | 'higher_studies'
  | 'litigation'
  | 'family_rupture';

/** All 17 life-event categories for rectification (Spec 062 E6 added family_rupture). */
export const LIFE_EVENT_CATEGORIES: readonly LifeEventCategory[] = [
  'marriage',
  'engagement',
  'breakup',
  'childbirth',
  'career_change',
  'promotion',
  'job_loss',
  'business_start',
  'relocation',
  'property_purchase',
  'windfall',
  'expense_shock',
  'health_issue',
  'surgery',
  'higher_studies',
  'litigation',
  'family_rupture',
];

// Rectification result mode (cusp-based or window-based time-fitting)
export type RectificationMode = 'cusp' | 'window';

// Confidence band for a rectification result (how near the tie between candidates)
export type RectificationBand = 'near_tie' | 'leans' | 'consistent';

// How precisely the user knows an event's date (drives engine weighting).
export type EventDatePrecision = 'exact' | 'month' | 'year' | 'approx';

/**
 * How much the recorded birth time anchors the E5 prior (Spec 062).
 *
 * 'about': a weak triangular prior around the recorded time (max bonus ~0.5 —
 * about half of one primary signal; it can break a true tie, never outvote an
 * event). 'unknown': flat, no prior at all. Engine defaults per mode: 'about'
 * for cusp (a recorded time exists), 'unknown' for window.
 */
export type AnchorConfidence = 'about' | 'unknown';

/** Life event input for rectification analysis. */
export interface RectificationEventInput {
  readonly date: string;
  readonly category: LifeEventCategory;
  readonly precision: EventDatePrecision;
}

/** Validated local/review event draft; summaries never enter engine payloads. */
export interface CanonicalLifeEventDraft extends RectificationEventInput {
  /**
   * Optional human-readable description of what happened, in the user's own
   * words. Potentially identifying: keep on-device and project it out before
   * engine, chat, or interpretation egress.
   */
  readonly summary?: string;
}

/**
 * Supporting evidence for a life event in the rectification result.
 *
 * `signals` are opaque engine keys following the Spec 062 grammar documented in
 * `backend/src/almamesh/rectification/scorer.py` (and mirrored in
 * `@almamesh/browser` `pyodide/rectification.ts`): depth-keyed
 * `md_/ad_/pd_lord_rules|in_h{n}`, `slow_transit_h{n}`, D9 keys
 * (`d9_lord_rules_d9_h7`, `d9_lord_in_d9_h7`, `d9_lord_is_d9_lagna_lord`),
 * valence suffixes `#afflicted_fit`/`#dignified_fit`, the `prior_anchor`
 * pseudo-signal, and `miss_unexplained`.
 *
 * `contribution` is the NET per-event contribution and CAN BE NEGATIVE (an
 * event that fired nothing for this candidate counts against it).
 */
export interface EventEvidence {
  readonly eventIndex: number;
  readonly category: LifeEventCategory;
  readonly date: string;
  readonly signals: readonly string[];
  readonly contribution: number;
}

/**
 * One candidate rectified time with supporting event evidence.
 *
 * Spec 062: `fitScore = positiveTotal - penaltyTotal + priorBonus`; the split
 * is exposed so the UI can render honest per-part storytelling (the prior as
 * its own labeled row, penalties as "counting against"). `misses` lists the
 * candidate-level silent-activation penalty keys
 * (`miss_silent_{category}_h{n}`); per-event unexplained misses live in the
 * evidence `signals` as `miss_unexplained`.
 */
export interface RectificationCandidate {
  readonly ascendantSign: string;
  readonly representativeTimeLocal: string;
  readonly lagnaLongitudeDeg: number;
  readonly lagnaCuspDistanceDeg: number;
  readonly isNearCusp: boolean;
  readonly fitScore: number;
  /** D9 navamsa lagna sign at the candidate time (Spec 062 E2), or null. */
  readonly navamsaLagnaSign: string | null;
  /** De-correlated positive evidence total (Spec 062 E7). */
  readonly positiveTotal: number;
  /** Clamped miss-penalty total (Spec 062 E4/E7). */
  readonly penaltyTotal: number;
  /** Weak recorded-time anchor prior bonus (Spec 062 E5). */
  readonly priorBonus: number;
  /** Candidate-level silent-activation miss keys (`miss_silent_{category}_h{n}`). */
  readonly misses: readonly string[];
  readonly supportingEvents: readonly EventEvidence[];
}

/**
 * The complete rectification result: mode, candidates, margin, band, honesty note.
 *
 * `honestyNoteKey` is `rectify.honesty.{band}` or a Spec 062 variant
 * `rectify.honesty.{band}.prior_influenced` / `.penalty_driven`.
 */
export interface RectificationResult {
  readonly mode: RectificationMode;
  readonly candidates: readonly RectificationCandidate[];
  readonly margin: number;
  readonly band: RectificationBand;
  readonly discriminatingEventCount: number;
  /**
   * Rigor Stage 3 (Tier E): the AGGREGATE event-fit confidence = margin*100,
   * or `null` when gated below the minimum-evidence bar (render "inconclusive").
   * "How much better the best-fit birth time explains the user's dated events
   * than the runner-up" — NEVER "the probability the time is correct." The
   * per-signal contributions stay words+polarity only; only THIS aggregate is a
   * calibrated number. Optional: freshly-adapted results always carry it, but
   * records persisted BEFORE Stage 3 have no field (undefined) — renderers must
   * treat undefined as "no calibrated %", distinct from null (gated/inconclusive).
   */
  readonly confidencePct?: number | null;
  readonly recordedTimeSign: string | null;
  readonly honestyNoteKey: string;
}

/**
 * One structured life event as remembered on a confirmed rectification record
 * (v2): its opaque id, date, category, and the user's OWN optional summary
 * text. Display-only and fully on-device — never fed to the engine and never
 * sent anywhere.
 */
export interface RectificationRecordEventSummary {
  /** Opaque id of the structured life event (matches `supportingEventIds`). */
  readonly id: string;
  /** ISO `YYYY-MM-DD` date of the event. */
  readonly date: string;
  /** Life-event category the engine scored. */
  readonly category: LifeEventCategory;
  /** The user's own optional "what happened" text (on-device display only). */
  readonly summary?: string;
}

/**
 * A persisted, display-only record of a CONFIRMED birth-time rectification.
 *
 * Written when the user confirms a candidate in the `/rectify` wizard so
 * Settings can show "you rectified your birth time on <date>: was X, now Y".
 * It is pure metadata for display — it NEVER feeds the engine and stays fully
 * on-device (IndexedDB, local-first; nothing here ever leaves the device).
 * Reuses the engine's own `RectificationMode`/`RectificationBand` so the band
 * stays a convention, never a verdict.
 *
 * v2 (Spec 062): optionally carries `resultSnapshot` (the full adapted engine
 * result at confirmation time, so the evidence story survives revisits) and
 * `eventSummaries` (the structured events that informed the fit, in the user's
 * own words). Both are optional so v1 records keep loading unchanged.
 */
export interface RectificationRecord {
  /** Owning profile id (also the persisted store map key). */
  readonly profileId: string;
  /** ISO-8601 timestamp the user confirmed this rectification. */
  readonly confirmedAt: string;
  /** Engine fit mode that produced the chosen candidate. */
  readonly mode: RectificationMode;
  /** Qualitative confidence band of the result (a convention, never a verdict). */
  readonly band: RectificationBand;
  /** Numeric margin between the leading candidates (display-only). */
  readonly margin: number;
  /** The originally-entered birth time (`HH:MM`), or "" when the time was unknown. */
  readonly originalTime: string;
  /** Rising sign at the originally-entered time, or null when no time was recorded. */
  readonly originalSign: string | null;
  /** The chosen rectified birth time (`HH:MM`, local). */
  readonly rectifiedTime: string;
  /** Rising sign of the chosen candidate. */
  readonly rectifiedSign: string;
  /** Opaque ids of the structured life events that informed the fit (no PII). */
  readonly supportingEventIds: readonly string[];
  /**
   * v2: the full adapted engine result captured at confirmation time
   * (display-only snapshot; absent on v1 records).
   */
  readonly resultSnapshot?: RectificationResult;
  /**
   * v2: the structured events that informed the fit, with the user's own
   * summaries for on-device display (absent on v1 records).
   */
  readonly eventSummaries?: readonly RectificationRecordEventSummary[];
}

// ============================================================================
// Token Usage Types
// ============================================================================

/**
 * Token usage summary included in API responses (chart generation, Q&A)
 * Enables real-time token usage updates without separate API calls
 * Matches backend TokenUsageSummary class
 */
export interface TokenUsageSummary {
  /** Tokens used for input in this operation */
  operation_input_tokens: number;
  /** Tokens used for output in this operation */
  operation_output_tokens: number;
  /** Total tokens used in this operation */
  operation_total_tokens: number;
  /** User's total tokens used this billing period */
  total_used: number;
  /** User's token limit for this billing period */
  limit: number;
  /** Estimated cost in USD for this operation */
  estimated_cost_usd: number;
}
