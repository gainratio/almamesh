// Pure translation layer for the engine's ADDITIVE predictive contexts
// (`@almamesh/browser` raw shapes -> `@almamesh/shared-types` UI shapes).
//
// Per the project rule, these functions RESHAPE AND RENAME ONLY — no astrology
// is computed in TypeScript. The single transformation applied is the existing
// adapter convention: engine Title-Case zodiac signs ("Aries") become the UI's
// lowercase `ZodiacSign` ("aries"); planet names are already the canonical
// lowercase `PlanetName`; every number, citation, and descriptor is verbatim.
//
// Each adapter tolerates an absent input (returns undefined): older signed
// bundles do not emit the predictive contexts at all.

import type {
  BalaValue,
  BhinnashtakavargaChart,
  CurrentEmphasis,
  DashaTransitFusion,
  DomainWindow,
  DomainStrengthAssayResult,
  GocharaContext,
  HouseSignificator,
  KalaBala,
  KarakaSignificator,
  LifeDomainForecast,
  LifeDomainsContext,
  PlanetShadbala,
  SadeSatiContext,
  SadeSatiSegment,
  SarvashtakavargaChart,
  ShadvargaOwnSign,
  SlowTransitHit,
  SthanaBala,
  StrengthContext,
  TimelineEvent,
  TransitContext,
  TransitPlacement,
  VargaChartFull,
  VargaContextFull,
  VargaPlacementSummary,
  StrengthSummary,
  VargottamaFlag,
  VimshopakaScore,
} from "@almamesh/browser/types";
import type {
  AshtakavargaData,
  BalaValueData,
  BhinnashtakavargaData,
  CurrentEmphasisData,
  DashaTransitFusionData,
  DignityName,
  DivisionalChartId,
  DomainWindowData,
  DomainsCtx,
  GocharaData,
  HouseSignificatorData,
  KalaBalaData,
  KarakaSignificatorData,
  LifeDomain,
  LifeDomainForecastData,
  PlanetName,
  PlanetShadbalaData,
  SadeSatiData,
  SadeSatiSegmentData,
  SarvashtakavargaData,
  ShadbalaData,
  ShadvargaOwnSignData,
  SlowTransitHitData,
  SthanaBalaData,
  StrengthCtx,
  StrengthSummaryData,
  StrengthAssayData,
  TransitCtx,
  TransitPlacementData,
  TransitTimelineData,
  TransitTimelineEventData,
  VargaChartFullData,
  VargaCtxFull,
  VargaPlacementFullData,
  VargaPlacementSummaryData,
  VargottamaFlagData,
  VimshopakaScoreData,
  ZodiacSign,
} from "@almamesh/shared-types";

/** Engine Title-Case sign ("Aries") -> the UI's lowercase `ZodiacSign`. */
function toUiSign(sign: string): ZodiacSign {
  return sign.toLowerCase() as ZodiacSign;
}

/** Nullable variant for fields the engine emits as `sign | null`. */
function toUiSignOrNull(sign: string | null): ZodiacSign | null {
  return sign === null ? null : toUiSign(sign);
}

function asPlanet(name: string): PlanetName {
  return name as PlanetName;
}

function asPlanetOrNull(name: string | null): PlanetName | null {
  return name === null ? null : asPlanet(name);
}

/** Remap a planet-keyed record's values (keys are already lowercase planets). */
function mapPlanetRecord<Raw, Ui>(
  record: Readonly<Record<string, Raw>>,
  map: (raw: Raw) => Ui,
): Partial<Record<PlanetName, Ui>> {
  const out: Partial<Record<PlanetName, Ui>> = {};
  for (const [planet, raw] of Object.entries(record)) {
    out[asPlanet(planet)] = map(raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
// toTransitCtx
// ---------------------------------------------------------------------------

function toTransitPlacement(raw: TransitPlacement): TransitPlacementData {
  return {
    graha: asPlanet(raw.graha),
    longitude: raw.longitude,
    sign: toUiSign(raw.sign),
    sign_degrees: raw.sign_degrees,
    nakshatra: raw.nakshatra,
    nakshatra_pada: raw.nakshatra_pada,
    is_retrograde: raw.is_retrograde,
    house_from_lagna: raw.house_from_lagna,
    house_from_moon: raw.house_from_moon,
    natal_sign_occupied: toUiSign(raw.natal_sign_occupied),
  };
}

function toGochara(raw: GocharaContext): GocharaData {
  return {
    instant: raw.instant,
    transit_ayanamsa: raw.transit_ayanamsa,
    placements: mapPlanetRecord(raw.placements, toTransitPlacement),
  };
}

function toSadeSatiSegment(raw: SadeSatiSegment): SadeSatiSegmentData {
  return {
    phase: raw.phase,
    saturn_sign: toUiSign(raw.saturn_sign),
    start: raw.start,
    end: raw.end,
  };
}

function toSadeSati(raw: SadeSatiContext): SadeSatiData {
  return {
    is_active: raw.is_active,
    current_phase: raw.current_phase,
    natal_moon_sign: toUiSign(raw.natal_moon_sign),
    cycle: raw.cycle.map(toSadeSatiSegment),
    cycle_start: raw.cycle_start,
    cycle_end: raw.cycle_end,
  };
}

function toSlowHit(raw: SlowTransitHit): SlowTransitHitData {
  return {
    graha: asPlanet(raw.graha),
    kind: raw.kind,
    natal_point: raw.natal_point,
    exact: raw.exact,
    severity: raw.severity,
  };
}

function toFusion(raw: DashaTransitFusion): DashaTransitFusionData {
  return {
    instant: raw.instant,
    maha_lord: asPlanet(raw.maha_lord),
    antar_lord: asPlanetOrNull(raw.antar_lord),
    maha_lord_transit_house_from_moon: raw.maha_lord_transit_house_from_moon,
    maha_lord_transit_house_from_lagna: raw.maha_lord_transit_house_from_lagna,
    reinforcing: raw.reinforcing.map(asPlanet),
    afflicting: raw.afflicting.map(asPlanet),
    net_weight: raw.net_weight,
    severity: raw.severity,
  };
}

function toTimelineEvent(raw: TimelineEvent): TransitTimelineEventData {
  return {
    date: raw.date,
    kind: raw.kind,
    graha: asPlanetOrNull(raw.graha),
    from_sign: toUiSignOrNull(raw.from_sign),
    to_sign: toUiSignOrNull(raw.to_sign),
    from_lord: asPlanetOrNull(raw.from_lord),
    to_lord: asPlanetOrNull(raw.to_lord),
    sade_sati_phase: raw.sade_sati_phase,
    severity: raw.severity,
    descriptor: raw.descriptor,
    station_direction: raw.station_direction ?? null,
    station_sign: toUiSignOrNull(raw.station_sign ?? null),
  };
}

function toTimeline(raw: TransitContext["timeline"]): TransitTimelineData {
  return {
    window_start: raw.window_start,
    window_end: raw.window_end,
    events: raw.events.map(toTimelineEvent),
  };
}

/**
 * Reshape the engine's `transit_context` into the UI `TransitCtx`. Returns
 * undefined when the engine payload omits it (older bundles).
 */
export function toTransitCtx(
  raw: TransitContext | null | undefined,
): TransitCtx | undefined {
  if (!raw) return undefined;
  return {
    instant: raw.instant,
    gochara: toGochara(raw.gochara),
    sade_sati: toSadeSati(raw.sade_sati),
    slow_hits: raw.slow_hits.map(toSlowHit),
    fusion: toFusion(raw.fusion),
    timeline: toTimeline(raw.timeline),
  };
}

// ---------------------------------------------------------------------------
// toVargaCtx (the FULL 16-chart Shodasavarga)
// ---------------------------------------------------------------------------

function toVargaPlacementFull(raw: VargaChartFull["placements"][string]): VargaPlacementFullData {
  return {
    graha: asPlanet(raw.graha),
    sign: toUiSign(raw.sign),
    sign_lord: asPlanet(raw.sign_lord),
    // D1 combustion carried by the engine; absent on older bundles -> false.
    is_combust: raw.is_combust ?? false,
  };
}

function toVargaChartFull(raw: VargaChartFull): VargaChartFullData {
  return {
    chart: raw.chart,
    lagna_sign: toUiSign(raw.lagna_sign),
    lagna_sign_lord: asPlanet(raw.lagna_sign_lord),
    placements: mapPlanetRecord(raw.placements, toVargaPlacementFull),
  };
}

function toVargottama(raw: VargottamaFlag): VargottamaFlagData {
  return { point: raw.point, sign: toUiSign(raw.sign) };
}

function toShadvarga(raw: ShadvargaOwnSign): ShadvargaOwnSignData {
  return {
    graha: asPlanet(raw.graha),
    own_sign_count: raw.own_sign_count,
    charts_in_own_sign: [...raw.charts_in_own_sign],
  };
}

function toVimshopaka(raw: VimshopakaScore): VimshopakaScoreData {
  return {
    graha: asPlanet(raw.graha),
    score: raw.score,
    approximated: raw.approximated,
  };
}

/**
 * Reshape the engine's `varga_context_full` (all 16 Shodasavarga charts +
 * strength tallies) into the UI `VargaCtxFull`. Distinct from — and additive
 * to — the legacy D9-only `varga_ctx` the chart adapter keeps emitting.
 * Returns undefined when the engine payload omits it.
 */
export function toVargaCtx(
  raw: VargaContextFull | null | undefined,
): VargaCtxFull | undefined {
  if (!raw) return undefined;
  const charts: Partial<Record<DivisionalChartId, VargaChartFullData>> = {};
  for (const [id, chart] of Object.entries(raw.charts)) {
    charts[id as DivisionalChartId] = toVargaChartFull(chart);
  }
  return {
    charts,
    vargottama: raw.vargottama.map(toVargottama),
    shadvarga_own_sign: raw.shadvarga_own_sign.map(toShadvarga),
    vimshopaka: raw.vimshopaka.map(toVimshopaka),
  };
}

// ---------------------------------------------------------------------------
// toStrengthCtx
// ---------------------------------------------------------------------------

/** Lowercase the Title-Case sign KEYS of a bindu table (values verbatim). */
function toSignKeyedBindus(
  raw: Readonly<Record<string, number>>,
): Record<ZodiacSign, number> {
  const out: Partial<Record<ZodiacSign, number>> = {};
  for (const [sign, bindus] of Object.entries(raw)) {
    out[toUiSign(sign)] = bindus;
  }
  return out as Record<ZodiacSign, number>;
}

function toBav(raw: BhinnashtakavargaChart): BhinnashtakavargaData {
  return {
    planet: asPlanet(raw.planet),
    bindus: toSignKeyedBindus(raw.bindus),
    total: raw.total,
  };
}

function toSav(raw: SarvashtakavargaChart): SarvashtakavargaData {
  return { bindus: toSignKeyedBindus(raw.bindus), total: raw.total };
}

function toBalaValue(raw: BalaValue): BalaValueData {
  return {
    virupas: raw.virupas,
    citation: raw.citation,
    approximated: raw.approximated,
    note: raw.note,
  };
}

function toSthana(raw: SthanaBala): SthanaBalaData {
  return {
    uccha: toBalaValue(raw.uccha),
    saptavargaja: toBalaValue(raw.saptavargaja),
    ojayugma: toBalaValue(raw.ojayugma),
    kendradi: toBalaValue(raw.kendradi),
    drekkana: toBalaValue(raw.drekkana),
    total_virupas: raw.total_virupas,
  };
}

function toKala(raw: KalaBala): KalaBalaData {
  return {
    nathonnatha: toBalaValue(raw.nathonnatha),
    paksha: toBalaValue(raw.paksha),
    tribhaga: toBalaValue(raw.tribhaga),
    abda: toBalaValue(raw.abda),
    masa: toBalaValue(raw.masa),
    vara: toBalaValue(raw.vara),
    hora: toBalaValue(raw.hora),
    ayana: toBalaValue(raw.ayana),
    yuddha: toBalaValue(raw.yuddha),
    total_virupas: raw.total_virupas,
  };
}

function toPlanetShadbala(raw: PlanetShadbala): PlanetShadbalaData {
  return {
    planet: asPlanet(raw.planet),
    sthana: toSthana(raw.sthana),
    dig: toBalaValue(raw.dig),
    kala: toKala(raw.kala),
    cheshta: toBalaValue(raw.cheshta),
    naisargika: toBalaValue(raw.naisargika),
    drik: toBalaValue(raw.drik),
    total_virupas: raw.total_virupas,
    total_rupas: raw.total_rupas,
    required_rupas: raw.required_rupas,
    meets_minimum: raw.meets_minimum,
  };
}

/**
 * Reshape the engine's `strength_context` (Ashtakavarga + Shadbala) into the
 * UI `StrengthCtx`. Returns undefined when the engine payload omits it.
 */
export function toStrengthCtx(
  raw: StrengthContext | null | undefined,
): StrengthCtx | undefined {
  if (!raw) return undefined;
  const shadbala: ShadbalaData = {
    planets: mapPlanetRecord(raw.shadbala.planets, toPlanetShadbala),
  };
  const ashtakavarga: AshtakavargaData = {
    bhinna: mapPlanetRecord(raw.ashtakavarga.bhinna, toBav),
    sarva: toSav(raw.ashtakavarga.sarva),
  };
  return { sunrise_utc_iso: raw.sunrise_utc_iso, ashtakavarga, shadbala };
}

// ---------------------------------------------------------------------------
// toDomainsCtx
// ---------------------------------------------------------------------------

function toHouseSignificator(raw: HouseSignificator): HouseSignificatorData {
  return {
    house: raw.house,
    sign: toUiSign(raw.sign),
    lord: asPlanet(raw.lord),
    lord_house: raw.lord_house,
    lord_sign: toUiSign(raw.lord_sign),
    lord_dignity: raw.lord_dignity as DignityName,
    rule: raw.rule,
  };
}

function toKaraka(raw: KarakaSignificator): KarakaSignificatorData {
  return {
    graha: asPlanet(raw.graha),
    house: raw.house,
    sign: toUiSign(raw.sign),
    dignity: raw.dignity as DignityName,
    is_retrograde: raw.is_retrograde,
    rule: raw.rule,
  };
}

function toVargaSummary(raw: VargaPlacementSummary): VargaPlacementSummaryData {
  return {
    chart: raw.chart,
    graha: asPlanet(raw.graha),
    sign: toUiSign(raw.sign),
    sign_lord: asPlanet(raw.sign_lord),
    same_sign_as_d1: raw.same_sign_as_d1,
    vargottama: raw.vargottama,
    rule: raw.rule,
  };
}

function toStrengthSummary(raw: StrengthSummary): StrengthSummaryData {
  return {
    key_graha: asPlanet(raw.key_graha),
    key_graha_rupas: raw.key_graha_rupas,
    key_graha_meets_minimum: raw.key_graha_meets_minimum,
    sav_bindus: raw.sav_bindus,
    band: raw.band,
    shadbala_pct: raw.shadbala_pct,
    sav_pct: raw.sav_pct,
    strength_pct: raw.strength_pct,
    strength_tier: raw.strength_tier,
    approximated: raw.approximated,
    note: raw.note,
  };
}

function toEmphasis(raw: CurrentEmphasis): CurrentEmphasisData {
  return {
    active_dasha_significator: raw.active_dasha_significator,
    dasha_levels: [...raw.dasha_levels],
    matched_dasha_lords: raw.matched_dasha_lords.map(asPlanet),
    under_sade_sati: raw.under_sade_sati,
    transit_severity: raw.transit_severity,
    approximated: raw.approximated,
    note: raw.note,
    rule: raw.rule,
  };
}

function toDomainWindow(raw: DomainWindow): DomainWindowData {
  return {
    date: raw.date,
    source: raw.source,
    kind: raw.kind,
    trigger: asPlanetOrNull(raw.trigger),
    severity: raw.severity,
    descriptor: raw.descriptor,
  };
}

function toStrengthAssay(raw: DomainStrengthAssayResult | undefined): StrengthAssayData | undefined {
  if (raw?.method.id !== "minimum" || raw.clamp === null || raw.selected_component_id === null) {
    return undefined;
  }
  return {
    schema: raw.schema,
    method: { id: raw.method.id, version: raw.method.version },
    score: raw.score,
    interval: raw.interval,
    clamp: raw.clamp,
    intercept: null,
    weight_total: null,
    components: raw.components.map((component) => ({ ...component })),
    inputs_hash: raw.inputs_hash,
    selected_component_id: raw.selected_component_id,
  };
}

function toForecast(
  raw: LifeDomainForecast,
  assay?: DomainStrengthAssayResult,
): LifeDomainForecastData {
  const strengthAssay = toStrengthAssay(assay);
  return {
    domain: raw.domain as LifeDomain,
    houses: raw.houses.map(toHouseSignificator),
    karakas: raw.karakas.map(toKaraka),
    varga: toVargaSummary(raw.varga),
    strength_summary: toStrengthSummary(raw.strength_summary),
    ...(strengthAssay ? { strength_assay: strengthAssay } : {}),
    current_emphasis: toEmphasis(raw.current_emphasis),
    upcoming_windows: raw.upcoming_windows.map(toDomainWindow),
  };
}

/**
 * Reshape the engine's `domains_context` (7 LifeDomainForecast entries) into
 * the UI `DomainsCtx`. Returns undefined when the engine payload omits it.
 */
export function toDomainsCtx(
  raw: LifeDomainsContext | null | undefined,
  assays?: Readonly<Record<string, DomainStrengthAssayResult>>,
): DomainsCtx | undefined {
  if (!raw) return undefined;
  const forecasts: Partial<Record<LifeDomain, LifeDomainForecastData>> = {};
  for (const [domain, forecast] of Object.entries(raw.forecasts)) {
    forecasts[domain as LifeDomain] = toForecast(forecast, assays?.[domain]);
  }
  return {
    instant: raw.instant,
    // The engine contract guarantees every member of LifeDomain is present.
    forecasts: forecasts as Record<LifeDomain, LifeDomainForecastData>,
  };
}
