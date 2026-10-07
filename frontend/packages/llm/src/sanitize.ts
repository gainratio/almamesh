// The privacy boundary. A pure, dependency-free port of the backend's
// `_sanitize_context_for_llm` / `_sanitize_canonical_for_llm`
// (backend/src/almamesh/llm.py): the ONLY chart data permitted to leave the
// device in an interpretation call passes through here first.
//
// Contract (mirrored exactly from the Python reference):
//   - Strip correlatable identifier fields (chart_id, generated_at, timestamps).
//   - Relativize absolute dasha dates so birth-identifying calendar dates never
//     leak: maha periods -> a "current/future/past" status; the current period
//     -> months_remaining. The dasha LORD and ordering (the astrology) stay.
//   - The dasha TREE (each maha's antar_sequence + the current antar's
//     pratyantar_sequence) crosses at MONTH precision ("YYYY-MM" — the same
//     granularity as the predictive contexts) and ONLY for non-past periods,
//     so birth-adjacent calendar dates still never leak.
//   - Keep all astrological content: planets, signs, houses, lagna, yogas.
//
// Anything not explicitly relativized is passed through structurally unchanged.

import type {
  DashaPeriod,
  DashaYearConvention,
  MahaDashaPeriod,
  LifeDomainsContext,
  NavamsaChart,
  ShadvargaOwnSign,
  SiderealChart,
  StrengthContext,
  TransitContext,
  VargaContextFull,
  VargottamaFlag,
  VimshopakaScore,
  VimshottariDasha,
} from "@almamesh/browser/types";

// Identifier fields that correlate to a specific user/chart and are never needed
// to render an interpretation. Mirrors `_CANONICAL_IDENTIFIER_FIELDS` plus the
// timestamp the adapter stamps onto chart payloads. The allowlist rebuild in
// `sanitizeChartForLlm` drops these (and anything else) by construction; this is
// kept as the documented, testable contract of what must never leave the device.
export const IDENTIFIER_FIELDS: readonly string[] = [
  "chart_id",
  "generated_at",
  "calculation_timestamp",
];

// Per-planet lordship enrichments (`houses_ruled`, `is_yogakaraka`,
// `is_combust`) are REQUIRED, typed `PlanetPosition` fields — pure astrology,
// nothing identifying — so the allowlist rebuild passes them through verbatim
// as part of `planets`. The facts block reads them for the engine-computed
// "House lordships" line. Likewise each yoga's qualitative trace (grade +
// strength_factors + formation_rules) is engine prose with no dates, passed
// through verbatim via `yogas`.

const DAYS_PER_YEAR = 365;
const DAYS_PER_MONTH = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** One dated sequence row at the LLM-bound month precision ("YYYY-MM"). */
export interface SanitizedDatedPeriod {
  readonly lord: string;
  readonly duration_years: number;
  readonly start_month: string;
  readonly end_month: string;
}

/** A maha period after relativization: absolute dates replaced by a status. */
export interface SanitizedMahaPeriod {
  readonly lord: string;
  readonly duration_years: number;
  readonly status: string;
  /** Month-precision window; present on NON-PAST rows of tree-bearing charts. */
  readonly start_month?: string;
  readonly end_month?: string;
  /** The CURRENT maha's dated antardashas (month precision); absent otherwise. */
  readonly antar_sequence?: readonly SanitizedDatedPeriod[];
}

/** The current period after relativization: end_date replaced by months left. */
export interface SanitizedCurrentPeriod {
  readonly lord: string;
  readonly duration_years: number;
  readonly months_remaining: number;
  /** Month-precision window; present when the chart carries the dasha tree. */
  readonly start_month?: string;
  readonly end_month?: string;
}

export interface SanitizedDashas {
  readonly maha_dasha_sequence: readonly SanitizedMahaPeriod[];
  readonly current_maha: SanitizedCurrentPeriod | null;
  readonly current_antar: SanitizedCurrentPeriod | null;
  readonly current_pratyantar: SanitizedCurrentPeriod | null;
  /**
   * The CURRENT antar's dated pratyantardashas (month precision). Absent when
   * the engine emitted none (older bundles) or null (no current antar).
   */
  readonly pratyantar_sequence?: readonly SanitizedDatedPeriod[];
  /** Engine-declared dasha-year convention; surfaced so narration can state it. */
  readonly convention?: DashaYearConvention;
}

// --- compact, date-relativized predictive contexts (transits/strength/vargas/
// domains). The raw engine contexts carry absolute day-precision dates and
// bulky tables (full gochara placements, BAV bindu tables, 16 varga charts);
// the sanitizer rebuilds ONLY the narration-grade summary, reducing every date
// to MONTH precision ("YYYY-MM") — the same granularity as months_remaining. ---

/** One transiting graha's current placement (engine fields, positions dropped). */
export interface SanitizedGocharaPlacement {
  readonly graha: string;
  readonly sign: string;
  readonly house_from_lagna: number;
  readonly house_from_moon: number;
  readonly is_retrograde: boolean;
}

export interface SanitizedSadeSati {
  readonly is_active: boolean;
  readonly current_phase: string;
  readonly natal_moon_sign: string;
  /** The cycle end at month precision, or null when no cycle is in scope. */
  readonly until_month: string | null;
}

export interface SanitizedFusion {
  readonly maha_lord: string;
  readonly antar_lord: string | null;
  readonly maha_lord_transit_house_from_moon: number;
  readonly maha_lord_transit_house_from_lagna: number;
  readonly reinforcing: readonly string[];
  readonly afflicting: readonly string[];
  readonly severity: string;
}

export interface SanitizedSlowHit {
  readonly graha: string;
  readonly kind: string;
  readonly natal_point: string;
  readonly month: string;
  readonly severity: string;
}

export interface SanitizedTransitEvent {
  readonly month: string;
  readonly kind: string;
  readonly graha: string | null;
  readonly from_sign: string | null;
  readonly to_sign: string | null;
  readonly severity: string;
  readonly descriptor: string;
}

export interface SanitizedTransits {
  readonly gochara: readonly SanitizedGocharaPlacement[];
  readonly sade_sati: SanitizedSadeSati;
  readonly fusion: SanitizedFusion;
  readonly slow_hits: readonly SanitizedSlowHit[];
  readonly timeline: readonly SanitizedTransitEvent[];
}

export interface SanitizedShadbalaLine {
  readonly planet: string;
  readonly total_rupas: number;
  readonly required_rupas: number;
  readonly meets_minimum: boolean;
}

export interface SanitizedStrength {
  /** Sarvashtakavarga total bindus (canonically 337). */
  readonly sav_total: number;
  readonly shadbala: readonly SanitizedShadbalaLine[];
}

/** The engine's own varga SUMMARIES; the 16 full charts stay on-device. */
export interface SanitizedVargaSummary {
  readonly vargottama: readonly VargottamaFlag[];
  readonly shadvarga_own_sign: readonly ShadvargaOwnSign[];
  readonly vimshopaka: readonly VimshopakaScore[];
}

export interface SanitizedDomainWindow {
  readonly month: string;
  readonly source: string;
  readonly kind: string;
  readonly trigger: string | null;
  readonly severity: string;
  readonly descriptor: string;
}

export interface SanitizedDomainForecast {
  readonly domain: string;
  readonly band: string;
  readonly key_graha: string;
  readonly key_graha_rupas: number;
  readonly key_graha_meets_minimum: boolean;
  readonly sav_bindus: number;
  readonly strength_note: string;
  readonly active_dasha_significator: boolean;
  readonly dasha_levels: readonly string[];
  readonly matched_dasha_lords: readonly string[];
  readonly under_sade_sati: boolean;
  readonly transit_severity: string;
  readonly windows: readonly SanitizedDomainWindow[];
}

/** All present predictive contexts, compacted; each key absent when not emitted. */
export interface SanitizedPredictive {
  readonly transits?: SanitizedTransits;
  readonly strength?: SanitizedStrength;
  readonly vargas?: SanitizedVargaSummary;
  readonly domains?: readonly SanitizedDomainForecast[];
}

/** The chart as it leaves the device: identifier-free, dasha dates relativized. */
/**
 * The instant every "current"/"remaining" statement in the prompt is relative
 * to. `chart` = the chart's own stored analysis instant (its snapshot's
 * `reference_date`), the default for everything that describes the chart.
 * `today` = the wall clock, ONLY where a caller genuinely asks about today
 * (the chat's current-timing tool), and labelled as such in the prompt.
 */
export interface AnalysisInstant {
  readonly basis: "chart" | "today";
  readonly instant: Date;
}

/** The "as of" stamp the prompt carries: a local calendar date and its basis. */
export interface SanitizedAsOf {
  readonly date: string;
  readonly basis: AnalysisInstant["basis"];
}

function requireInstant(value: string | Date, label: string): Date {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`analysis instant: ${label} is not a valid instant`);
  }
  return instant;
}

/**
 * The chart's analysis instant: its snapshot's `reference_date`, or, for a
 * chart stored before snapshots existed, the stored calculation instant the
 * caller passes. Never the wall clock: with neither, it refuses.
 */
export function chartAnalysisInstant(
  chart: SiderealChart,
  storedInstant?: string | Date,
): AnalysisInstant {
  const recorded = chart.snapshot?.reference_date ?? storedInstant;
  if (recorded === undefined) {
    throw new Error("analysis instant: the chart records none and no stored instant was given");
  }
  return { basis: "chart", instant: requireInstant(recorded, "chart reference") };
}

/** An explicit, labelled "today" basis, for questions genuinely about now. */
export function todayAnalysisInstant(now: Date): AnalysisInstant {
  return { basis: "today", instant: requireInstant(now, "today") };
}

/** The instant's calendar date in the display (runtime) timezone, as the UI prints it. */
function localIsoDate(instant: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

export interface SanitizedChart {
  /** Which instant "current"/"remaining" below are relative to. */
  readonly as_of: SanitizedAsOf;
  readonly ayanamsa_value: SiderealChart["ayanamsa_value"];
  readonly lagna: SiderealChart["lagna"];
  readonly planets: SiderealChart["planets"];
  readonly houses: SiderealChart["houses"];
  readonly yogas: SiderealChart["yogas"];
  readonly dashas?: SanitizedDashas;
  /** D9 Navamsa (signs + lords only — nothing date-bearing to relativize). */
  readonly navamsa?: NavamsaChart;
  /** Compact predictive contexts; absent when the engine emitted none. */
  readonly predictive?: SanitizedPredictive;
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** A dated sequence row reduced to month precision (the LLM-bound granularity). */
function toDatedPeriod(period: DashaPeriod): SanitizedDatedPeriod {
  return {
    lord: period.lord,
    duration_years: period.duration_years,
    start_month: monthOf(period.start_date),
    end_month: monthOf(period.end_date),
  };
}

/**
 * Relativize one maha period to a current/future/past status (mirrors Python).
 * Tree-bearing rows (new bundles emit `antar_sequence` on every row) ALSO keep
 * a month-precision window on NON-PAST rows, and the CURRENT row keeps its
 * dated antar tree. Past rows stay date-free — their windows chain back to the
 * birth instant, which must never leak.
 */
function relativizeMahaPeriod(period: MahaDashaPeriod, now: Date): SanitizedMahaPeriod {
  const start = new Date(period.start_date);
  const end = new Date(period.end_date);
  const base = { lord: period.lord, duration_years: period.duration_years };
  const window = period.antar_sequence
    ? { start_month: monthOf(period.start_date), end_month: monthOf(period.end_date) }
    : {};

  if (start <= now && now <= end) {
    const remaining = Math.floor(wholeDaysBetween(now, end) / DAYS_PER_YEAR);
    return {
      ...base,
      status: `current (${remaining} years remaining)`,
      ...window,
      ...(period.antar_sequence
        ? { antar_sequence: period.antar_sequence.map(toDatedPeriod) }
        : {}),
    };
  }
  if (now < start) {
    const untilStart = Math.floor(wholeDaysBetween(now, start) / DAYS_PER_YEAR);
    return { ...base, status: `future (starts in ${untilStart} years)`, ...window };
  }
  return { ...base, status: "past" };
}

/** Relativize the current period to months_remaining (mirrors Python). */
function relativizeCurrentPeriod(
  period: NonNullable<VimshottariDasha["current_maha"]>,
  now: Date,
  dated: boolean,
): SanitizedCurrentPeriod {
  const end = new Date(period.end_date);
  const remaining = Math.max(0, Math.floor(wholeDaysBetween(now, end) / DAYS_PER_MONTH));
  return {
    lord: period.lord,
    duration_years: period.duration_years,
    months_remaining: remaining,
    // Month-precision window — ONLY when the chart carries the dasha tree, so
    // older-bundle sanitization stays unchanged.
    ...(dated
      ? { start_month: monthOf(period.start_date), end_month: monthOf(period.end_date) }
      : {}),
  };
}

function relativizeCurrentOrNull(
  period: VimshottariDasha["current_maha"],
  now: Date,
  dated: boolean,
): SanitizedCurrentPeriod | null {
  return period ? relativizeCurrentPeriod(period, now, dated) : null;
}

function sanitizeDashas(dashas: VimshottariDasha, now: Date): SanitizedDashas {
  // The new-engine signal: maha rows carry their dated antar tree.
  const dated = dashas.maha_dasha_sequence.some((p) => p.antar_sequence !== undefined);
  return {
    maha_dasha_sequence: dashas.maha_dasha_sequence.map((p) => relativizeMahaPeriod(p, now)),
    current_maha: relativizeCurrentOrNull(dashas.current_maha, now, dated),
    current_antar: relativizeCurrentOrNull(dashas.current_antar, now, dated),
    current_pratyantar: relativizeCurrentOrNull(dashas.current_pratyantar, now, dated),
    // The CURRENT antar's dated pratyantardashas, reduced to month precision.
    // Engine-null (no current antar) and absent (older bundle) both fold to an
    // absent key.
    ...(dashas.pratyantar_sequence
      ? { pratyantar_sequence: dashas.pratyantar_sequence.map(toDatedPeriod) }
      : {}),
    ...(dashas.convention ? { convention: dashas.convention } : {}),
  };
}

/** Reduce an ISO-8601 date to month precision ("YYYY-MM"). */
function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function monthOrNull(iso: string | null): string | null {
  return iso === null ? null : monthOf(iso);
}

function sanitizeTransits(ctx: TransitContext): SanitizedTransits {
  return {
    gochara: Object.values(ctx.gochara.placements).map((p) => ({
      graha: p.graha,
      sign: p.sign,
      house_from_lagna: p.house_from_lagna,
      house_from_moon: p.house_from_moon,
      is_retrograde: p.is_retrograde,
    })),
    sade_sati: {
      is_active: ctx.sade_sati.is_active,
      current_phase: ctx.sade_sati.current_phase,
      natal_moon_sign: ctx.sade_sati.natal_moon_sign,
      until_month: monthOrNull(ctx.sade_sati.cycle_end),
    },
    fusion: {
      maha_lord: ctx.fusion.maha_lord,
      antar_lord: ctx.fusion.antar_lord,
      maha_lord_transit_house_from_moon: ctx.fusion.maha_lord_transit_house_from_moon,
      maha_lord_transit_house_from_lagna: ctx.fusion.maha_lord_transit_house_from_lagna,
      reinforcing: ctx.fusion.reinforcing,
      afflicting: ctx.fusion.afflicting,
      severity: ctx.fusion.severity,
    },
    slow_hits: ctx.slow_hits.map((hit) => ({
      graha: hit.graha,
      kind: hit.kind,
      natal_point: hit.natal_point,
      month: monthOf(hit.exact),
      severity: hit.severity,
    })),
    timeline: ctx.timeline.events.map((event) => ({
      month: monthOf(event.date),
      kind: event.kind,
      graha: event.graha,
      from_sign: event.from_sign,
      to_sign: event.to_sign,
      severity: event.severity,
      descriptor: event.descriptor,
    })),
  };
}

function sanitizeStrength(ctx: StrengthContext): SanitizedStrength {
  return {
    sav_total: ctx.ashtakavarga.sarva.total,
    shadbala: Object.values(ctx.shadbala.planets).map((p) => ({
      planet: p.planet,
      total_rupas: p.total_rupas,
      required_rupas: p.required_rupas,
      meets_minimum: p.meets_minimum,
    })),
  };
}

function sanitizeVargaSummary(ctx: VargaContextFull): SanitizedVargaSummary {
  return {
    vargottama: ctx.vargottama,
    shadvarga_own_sign: ctx.shadvarga_own_sign,
    vimshopaka: ctx.vimshopaka,
  };
}

function sanitizeDomains(ctx: LifeDomainsContext): readonly SanitizedDomainForecast[] {
  return Object.values(ctx.forecasts).map((forecast) => ({
    domain: forecast.domain,
    band: forecast.strength_summary.band,
    key_graha: forecast.strength_summary.key_graha,
    key_graha_rupas: forecast.strength_summary.key_graha_rupas,
    key_graha_meets_minimum: forecast.strength_summary.key_graha_meets_minimum,
    sav_bindus: forecast.strength_summary.sav_bindus,
    strength_note: forecast.strength_summary.note,
    active_dasha_significator: forecast.current_emphasis.active_dasha_significator,
    dasha_levels: forecast.current_emphasis.dasha_levels,
    matched_dasha_lords: forecast.current_emphasis.matched_dasha_lords,
    under_sade_sati: forecast.current_emphasis.under_sade_sati,
    transit_severity: forecast.current_emphasis.transit_severity,
    windows: forecast.upcoming_windows.map((window) => ({
      month: monthOf(window.date),
      source: window.source,
      kind: window.kind,
      trigger: window.trigger,
      severity: window.severity,
      descriptor: window.descriptor,
    })),
  }));
}

/** Compact every PRESENT predictive context, or undefined when none exist. */
function sanitizePredictive(chart: SiderealChart): SanitizedPredictive | undefined {
  const transits = chart.transit_context;
  const strength = chart.strength_context;
  const vargas = chart.varga_context_full;
  const domains = chart.domains_context;
  if (!transits && !strength && !vargas && !domains) {
    return undefined;
  }
  return {
    ...(transits ? { transits: sanitizeTransits(transits) } : {}),
    ...(strength ? { strength: sanitizeStrength(strength) } : {}),
    ...(vargas ? { vargas: sanitizeVargaSummary(vargas) } : {}),
    ...(domains ? { domains: sanitizeDomains(domains) } : {}),
  };
}

/**
 * Sanitize an engine `SiderealChart` before it is sent to any LLM endpoint.
 *
 * Pure: returns a fresh object and never mutates `chart`. `asOf` is REQUIRED:
 * pass `chartAnalysisInstant(chart)` so the prompt's "current" dasha is the one
 * the screen and the PDF show; pass `todayAnalysisInstant(now)` only where the
 * question is genuinely about today. There is no wall-clock default.
 */
export function sanitizeChartForLlm(
  chart: SiderealChart,
  asOf: AnalysisInstant,
): SanitizedChart {
  const now = asOf.instant;
  // Allowlist rebuild: we copy ONLY the astrological fields below, so any
  // identifier field a caller layered on (IDENTIFIER_FIELDS, or anything else)
  // is dropped by construction rather than by a fragile denylist.
  const predictive = sanitizePredictive(chart);
  const base: SanitizedChart = {
    as_of: { date: localIsoDate(now), basis: asOf.basis },
    ayanamsa_value: chart.ayanamsa_value,
    lagna: chart.lagna,
    planets: chart.planets,
    houses: chart.houses,
    yogas: chart.yogas,
    // D9 navamsa carries only signs + lords — no dates, nothing to relativize.
    ...(chart.navamsa ? { navamsa: chart.navamsa } : {}),
    // Predictive contexts compacted to month precision; absent when not emitted.
    ...(predictive ? { predictive } : {}),
  };

  if (!chart.dashas) {
    return base;
  }
  return { ...base, dashas: sanitizeDashas(chart.dashas, now) };
}
