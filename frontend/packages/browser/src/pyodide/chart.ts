// TS mirror of the Python `SiderealContext` as emitted by `model_dump(mode="json")`
// (backend/src/almamesh/schemas/astrology.py). The Pyodide worker returns exactly
// this shape; it is the browser engine's output contract.
//
// Enum-valued fields (planet / sign / dignity names) serialize to their lowercase
// enum *values*, so they are typed as `string` at this JSON boundary. Dict-keyed
// collections serialize with string keys (planet name; house number "1".."12").

import type {
  DashaYearConvention,
  LifeDomainsContext,
  StrengthContext,
  TransitContext,
  VargaContextFull,
} from "./predictive";

export interface PlanetPosition {
  readonly name: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly distance: number;
  readonly speed: number;
  readonly is_retrograde: boolean;
  readonly sign: string;
  readonly sign_degrees: number;
  readonly sign_lord: string;
  readonly nakshatra: string;
  readonly nakshatra_pada: number;
  readonly nakshatra_lord: string;
  readonly house: number;
  readonly dignity: string;
  /** Asta (combustion) within the classical orb of the Sun. */
  readonly is_combust: boolean;
  /** Angular separation to the Sun (deg); null for the Sun and the nodes. */
  readonly combustion_separation_deg: number | null;
  /** Whole-sign houses this graha lords from the lagna; [] for Rahu/Ketu. */
  readonly houses_ruled: readonly number[];
  /** Lords both a kendra (4/7/10) and a trikona (5/9) — BPHS Yogakaraka. */
  readonly is_yogakaraka: boolean;
  // NOTE: the engine emits NO per-planet numeric strength here. Real Shadbala /
  // Ashtakavarga live ONLY in the lazy predictive `strength_context` below.
}

export interface LagnaData {
  readonly longitude: number;
  readonly sign: string;
  readonly sign_degrees: number;
  readonly sign_lord: string;
  readonly nakshatra: string;
  readonly nakshatra_pada: number;
  readonly nakshatra_lord: string;
  /**
   * Degrees from the Lagna to the NEAREST sign boundary — the engine's cusp
   * single-source-of-truth for the UI's near-cusp banner. Additive: older
   * bundles omit it (the UI falls back to its own measurement).
   */
  readonly lagna_cusp_distance_deg?: number;
  /** The sign across that nearest boundary (engine Title-Case). Additive. */
  readonly lagna_adjacent_sign?: string | null;
  /** True when within the engine's near-cusp threshold (~3°). Additive. */
  readonly is_near_cusp?: boolean;
}

export interface HouseCusp {
  readonly house: number;
  readonly longitude: number;
  readonly sign: string;
  readonly sign_lord: string;
}

export interface DashaPeriod {
  readonly lord: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly duration_years: number;
}

/**
 * One maha-dasha sequence row: the period itself plus its 9 dated antardashas
 * (engine `MahaDashaPeriod`). `antar_sequence` is additive — absent on charts
 * computed by older engine bundles.
 */
export interface MahaDashaPeriod extends DashaPeriod {
  readonly antar_sequence?: readonly DashaPeriod[];
}

export interface VimshottariDasha {
  readonly maha_dasha_sequence: readonly MahaDashaPeriod[];
  readonly current_maha: DashaPeriod | null;
  readonly current_antar: DashaPeriod | null;
  readonly current_pratyantar: DashaPeriod | null;
  /**
   * The CURRENT antar's 9 dated pratyantardashas; null exactly when
   * `current_antar` is null. Additive; the key is absent on older bundles.
   */
  readonly pratyantar_sequence?: readonly DashaPeriod[] | null;
  /**
   * The declared dasha-year convention that built every period above
   * (schemas/astrology.py). Additive; absent on older bundles.
   */
  readonly convention?: DashaYearConvention;
}

/**
 * The engine's qualitative yoga grade — a bucketing of the SAME `strength_pct`
 * emitted alongside it (backend `yogas/factors.band_for_pct`: >=75% strong,
 * >=40% moderate, else weak). Mirror this field; never re-derive a band from
 * the percentage, or the word and the number drift apart.
 */
export type YogaGrade = "strong" | "moderate" | "weak";

/**
 * One real, observed factor behind a yoga's qualitative grade.
 * `factor_type` is the engine's closed vocabulary: "dignity" | "combustion" |
 * "retrograde" | "house_class" (string at this JSON boundary).
 */
export interface YogaStrengthFactor {
  readonly factor_type: string;
  readonly planet: string;
  /** The observed value, e.g. "exalted", "combust (2.76 deg from the Sun)". */
  readonly value: string;
  /** Human-readable classical basis for counting this factor. */
  readonly basis: string;
  /**
   * The signed ±1 this factor contributes to the yoga's net marks (0 = neutral).
   * Additive; absent on bundles stored before the calibrated-strength upgrade.
   * The marks across a yoga's factors sum EXACTLY to `YogaData.net_marks`.
   */
  readonly mark?: number;
}

/** An explicit formation clause that fired, with its classical source. */
export interface YogaFormationRule {
  /** Machine id, e.g. "dhana.lord_placed". */
  readonly rule: string;
  readonly description: string;
  /** Classical citation, e.g. "BPHS, Dhana-yoga adhyaya: ...". */
  readonly source: string;
  readonly planets: readonly string[];
  readonly houses: readonly number[];
}

/**
 * A detected yoga with a complete, honest trace. Every list is min-length-1 by
 * backend schema (a trace-less yoga is schema-impossible). `category` is the
 * engine's closed vocabulary: "mahapurusha" | "raja" | "dhana" | "chandra" |
 * "surya" | "auspicious" | "dosha" | "special". The old numeric `strength` /
 * `effective_strength` / `is_active` fields no longer exist — only formed
 * yogas are emitted, graded qualitatively.
 */
export interface YogaData {
  readonly name: string;
  readonly display_name: string;
  readonly category: string;
  readonly description: string;
  readonly effects: string;
  readonly grade: YogaGrade;
  readonly strength_factors: readonly YogaStrengthFactor[];
  /**
   * Calibrated STRUCTURAL strength (a Layer-2 MODEL output over the ±1 mark
   * lattice — never a measured fact). All additive; absent on bundles stored
   * before the calibrated-strength upgrade, so render behind a presence guard.
   * `strength_pct` = 100·(net_marks + max_unfavorable)/(max_favorable +
   * max_unfavorable), anchored to this yoga's OWN achievable mark range.
   */
  readonly net_marks?: number;
  readonly max_favorable?: number;
  readonly max_unfavorable?: number;
  readonly strength_pct?: number;
  readonly strength_tier?: "structural";
  readonly planets_involved: readonly string[];
  readonly houses_involved: readonly number[];
  readonly planetary_signature: string;
  readonly formation_rules: readonly YogaFormationRule[];
}

/** One graha's placement in a divisional (varga) chart: sign + its lord only. */
export interface VargaPlanet {
  readonly name: string;
  readonly sign: string;
  readonly sign_lord: string;
  /**
   * Combustion (asta): a D1 graha-level fact (real longitude vs the Sun) the
   * engine CARRIES onto every varga placement. Additive — older signed bundles
   * omit it, so consumers must treat an absent value as `false`.
   */
  readonly is_combust?: boolean;
}

/** A divisional chart (e.g. D9 Navamsa): each graha's varga sign + the lagna. */
export interface NavamsaChart {
  readonly name: string; // "D9"
  readonly lagna_sign: string;
  readonly lagna_sign_lord: string;
  readonly planets: Readonly<Record<string, VargaPlanet>>;
}

/**
 * The identity of one computed chart, stamped by the engine
 * (`backend/src/almamesh/snapshot.py`). Every field is an ASCII string;
 * `snapshot_id` is the SHA-256 of the canonical JSON of the other ten.
 */
export interface ChartSnapshot {
  readonly snapshot_schema: string;
  readonly engine_version: string;
  readonly ephemeris_file: string;
  /** SHA-256 over the ephemeris + Lahiri table bytes the numbers came from. */
  readonly data_hash: string;
  readonly ayanamsa: string;
  readonly node_type: string;
  readonly house_system: string;
  readonly dasha_year_convention: string;
  readonly birth_utc: string;
  /** The analysis instant: which dasha is "current", and the chart's "as of". */
  readonly reference_date: string;
  readonly snapshot_id: string;
}

export interface SiderealChart {
  /**
   * The snapshot this chart was computed with. Every chart the worker returns
   * carries a verified one; OPTIONAL only because charts stored (or exported)
   * before snapshots existed have none, and they must still load.
   */
  readonly snapshot?: ChartSnapshot;
  readonly ayanamsa_value: number;
  readonly lagna: LagnaData;
  readonly planets: Readonly<Record<string, PlanetPosition>>;
  readonly houses: Readonly<Record<string, HouseCusp>>;
  readonly dashas: VimshottariDasha;
  readonly yogas: readonly YogaData[];
  /** D9 Navamsa divisional chart. Additive; null when the engine omits it. */
  readonly navamsa: NavamsaChart | null;

  // --- additive predictive contexts (each the exact model_dump(mode="json")
  // of its Pydantic context; see ./predictive.ts). OPTIONAL: older bundles
  // omit these keys entirely, and a composing engine may emit null. ---

  /** Transits/Gochara + Sade Sati + dasha-transit fusion + 12-month timeline. */
  readonly transit_context?: TransitContext | null;
  /** All 16 Shodasavarga divisional charts + classical strength tallies. */
  readonly varga_context_full?: VargaContextFull | null;
  /** Ashtakavarga (BAV/SAV) + Shadbala strength context. */
  readonly strength_context?: StrengthContext | null;
  /** Per-life-domain deterministic synthesis (7 LifeDomainForecast entries). */
  readonly domains_context?: LifeDomainsContext | null;
}
