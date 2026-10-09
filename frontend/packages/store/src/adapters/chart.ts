// Pure translation layer between the in-browser AlmaMesh engine
// (`@almamesh/browser`) and the existing UI contract (`@almamesh/shared-types`).
//
// The engine emits a flat `SiderealChart` (a TS mirror of the Python
// `SiderealContext`). The UI consumes the richer, nested `ChartData`. The two
// functions here RESHAPE and convert timezones ONLY — they compute no
// astrology. Per the project rule, divisional-chart and dasha-level math stay
// in the Python engine; we never reimplement them in TypeScript.

import dayjs from "dayjs";
import tzPlugin from "dayjs/plugin/timezone";
import utcPlugin from "dayjs/plugin/utc";

import type {
  BirthInput,
  DashaPeriod,
  MahaDashaPeriod,
  SiderealChart,
  YogaData as EngineYogaData,
} from "@almamesh/browser/types";
import type {
  ChartData,
  DashaData,
  MahaDashaData,
  PlanetName,
  ProcessedBirthData,
  SiderealContext,
  VargaChartData,
  VargaContext,
  VargaPlanetData,
  VimshottariDashaData,
  YogaCategory,
  YogaData,
  ZodiacSign,
} from "@almamesh/shared-types";
import type { TimeConfidence } from "@almamesh/constants";

import {
  chartReferenceInstantAsDate,
  requireChartReferenceInstant,
} from "../chartReferenceInstant";
import {
  toDomainsCtx,
  toStrengthCtx,
  toTransitCtx,
  toVargaCtx as toVargaCtxFull,
} from "./predictive";
import { type DstFold, localTimeToInstant, resolveLocalTime } from "./localBirthTime";

dayjs.extend(utcPlugin);
dayjs.extend(tzPlugin);

/** Local birth coordinates + clock + IANA zone the engine needs to compute a chart. */
export interface LocalBirthInput {
  /** Local civil date, `YYYY-MM-DD`. */
  readonly date: string;
  /** Local civil time, `HH:MM` (the originally-entered time). */
  readonly time: string;
  /**
   * A rectified local civil time (`HH:MM`) that OVERRIDES `time` for the
   * computation. When set, the chart is computed from this instant; the
   * originally-entered `time` is still preserved on the stored chart. Changing
   * it changes the `chartId`, so Phase-5 change-detection naturally regenerates.
   */
  readonly rectifiedTime?: string;
  /** Confidence in the (entered) birth time. A `TIME_CONFIDENCE` key. */
  readonly timeConfidence?: TimeConfidence;
  readonly latitude: number;
  readonly longitude: number;
  /** IANA timezone name (e.g. `Asia/Kolkata`). The engine has no geocoder. */
  readonly timezone: string;
  /**
   * Which occurrence the user chose when the effective clock happened twice
   * (DST fall-back). Required for such a time — `toBirthInput` refuses to pick
   * one silently — and ignored for every other time.
   */
  readonly dstFold?: DstFold;
  // NO `referenceDate` here, deliberately. The instant that pins the "current"
  // dasha is not birth data — it is a parameter of the computation, and mixing
  // it into the birth record is exactly what let it go missing: an optional
  // field nobody set, silently replaced by the wall clock. It is now a required
  // ARGUMENT of `toBirthInput`, so the type system asks every call site for it.
}

/** The clock the engine should use: the rectified time when set, else entered. */
function effectiveTime(input: LocalBirthInput): string {
  return input.rectifiedTime ?? input.time;
}

/** Display metadata layered on top of the raw birth coordinates for `ChartData`. */
export interface BirthMeta extends LocalBirthInput {
  readonly name: string;
  readonly location_name: string;
}

/** The label a chart stored before snapshots existed keeps: no version is known. */
const LEGACY_SOFTWARE_VERSION = "almamesh-browser-engine";

/**
 * Mirrors the engine's `validate_coordinates` (InvalidBirthInputError) so a bad
 * coordinate fails here with the SAME message instead of crossing the worker
 * boundary. `Number.isFinite` (not `isNaN`) so ±Infinity is rejected too.
 * Latitude is the OPEN interval (-90, 90): the Ascendant is undefined at a pole.
 * Longitude is the CLOSED interval [-180, 180].
 */
function requireCoordinate(value: number, field: "latitude" | "longitude"): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`toBirthInput: invalid coordinate: ${field} must be a finite number`);
  }
  if (field === "latitude" && !(value > -90 && value < 90)) {
    throw new Error("toBirthInput: invalid coordinate: latitude out of range (-90, 90)");
  }
  if (field === "longitude" && !(value >= -180 && value <= 180)) {
    throw new Error("toBirthInput: invalid coordinate: longitude out of range [-180, 180]");
  }
}

/** The birth instant as UTC. Pure birth data — no reference instant involved. */
function birthDatetimeUtc(input: LocalBirthInput): string {
  if (!input.timezone) {
    throw new Error(
      "toBirthInput: timezone (IANA) is required (the engine has no geocoder)",
    );
  }
  requireCoordinate(input.latitude, "latitude");
  requireCoordinate(input.longitude, "longitude");

  const clock = effectiveTime(input);
  let instant;
  try {
    instant = localTimeToInstant(input.date, clock, input.timezone, input.dstFold);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(
        `toBirthInput: could not parse local datetime "${input.date}T${clock}" in zone "${input.timezone}"`,
      );
    }
    throw error; // LocalTimeError: a DST gap/overlap the caller must resolve.
  }
  return instant.utc;
}

/** The fold that matters for this birth: only an ambiguous clock carries one. */
function effectiveFold(birth: LocalBirthInput): DstFold | undefined {
  if (!birth.dstFold) return undefined;
  try {
    const resolution = resolveLocalTime(birth.date, effectiveTime(birth), birth.timezone);
    return resolution.kind === "ambiguous" ? birth.dstFold : undefined;
  } catch {
    return undefined; // an unreadable draft clock has no fold; ids never throw
  }
}

/**
 * Convert a local civil date+time in an IANA timezone into the engine's
 * `BirthInput` (UTC instant + coordinates + reference instant).
 *
 * Fails closed on every input the engine cannot guess: it has no geocoder, so
 * `timezone`/`latitude`/`longitude` are mandatory — and it has no clock, so
 * `referenceInstant` is mandatory too. Mint that one with
 * `newChartReferenceInstant()` and pass the SAME value to
 * `siderealChartToChartData`, so the chart's stamped `calculation_timestamp` is
 * the key that reproduces it.
 */
export function toBirthInput(
  input: LocalBirthInput,
  referenceInstant: string,
): BirthInput {
  return {
    datetimeUtc: birthDatetimeUtc(input),
    latitude: input.latitude,
    longitude: input.longitude,
    referenceDate: requireChartReferenceInstant(referenceInstant, "toBirthInput: referenceInstant"),
  };
}

function toSiderealCtx(chart: SiderealChart): SiderealContext {
  // The engine emits no julian_day / sidereal_time, and fixes ayanamsa=lahiri,
  // houses=whole_sign upstream, so those four are deterministic defaults. No UI
  // renderer reads them (ChartVisualization reads only sidereal_ctx.planets and
  // sidereal_ctx.lagna.sign), so the defaults are display-safe.
  return {
    ayanamsa_value: chart.ayanamsa_value,
    ayanamsa_type: "lahiri",
    house_system: "whole_sign",
    julian_day: 0,
    sidereal_time: 0,
    lagna: { ...chart.lagna },
    // Engine PlanetPosition is a superset of UI SiderealPlanet; extra fields
    // (distance, speed, shadbala, ...) are simply ignored by the UI type.
    planets: chart.planets as SiderealContext["planets"],
  };
}

function toDashaData(
  period: DashaPeriod,
  level: DashaData["level"] = "maha",
): DashaData {
  // The engine's DashaPeriod carries no `level`; the CALLER knows which active
  // slot (maha/antar/pratyantar) the period came from — pure labeling, not math.
  return {
    lord: period.lord as DashaData["lord"],
    start_date: period.start_date,
    end_date: period.end_date,
    duration_years: period.duration_years,
    level,
  };
}

/**
 * One maha sequence row + its dated antar tree, passed through VERBATIM
 * (lord/start/end/duration; nested rows labeled level 'antar'). The key stays
 * entirely absent for older bundles whose rows carry no `antar_sequence` —
 * pure reshape, no dates invented.
 */
function toMahaDashaData(period: MahaDashaPeriod): MahaDashaData {
  return {
    ...toDashaData(period),
    ...(period.antar_sequence
      ? { antar_sequence: period.antar_sequence.map((a) => toDashaData(a, "antar")) }
      : {}),
  };
}

/**
 * Select the maha-dasha period that contains `now`, falling back to the first
 * entry when `now` precedes the whole sequence (and the last when it follows).
 * This is pure UI SELECTION over the engine's own `maha_dasha_sequence` — the
 * same thing DashaTimeline does to highlight the current row — NOT astrology:
 * we never invent a lord, a date, or a period the engine did not compute.
 */
function selectActiveMaha(
  sequence: readonly DashaPeriod[],
  now: Date,
): DashaPeriod | undefined {
  if (sequence.length === 0) return undefined;
  const t = now.getTime();
  const active = sequence.find(
    (p) => new Date(p.start_date).getTime() <= t && t < new Date(p.end_date).getTime(),
  );
  if (active) return active;
  // `now` outside the computed span: clamp to the nearest end.
  const first = sequence[0];
  return t < new Date(first.start_date).getTime() ? first : sequence[sequence.length - 1];
}

/**
 * Reshape the engine's Vimshottari dashas into the UI `VimshottariDashaData`.
 *
 * The engine reliably emits a non-null `current_maha` (the period containing its
 * reference instant), but to harden the dashboard's "Current Life Phase" card we
 * fall back to selecting the active maha by date-range over the engine's own
 * `maha_dasha_sequence` when `current_maha` is absent (older bundles / an
 * out-of-span reference). `asOf` is the chart's analysis instant (REQUIRED, never
 * the wall clock), so the fallback picks the period running when the chart was
 * computed. Returns undefined ONLY when the engine emitted
 * no sequence at all — we never fabricate periods. The antar/pratyantar legs are
 * surfaced as-is (undefined when the engine emitted null); renderers guard them.
 */
export function toDashaCtx(
  chart: SiderealChart,
  asOf: Date,
): VimshottariDashaData | undefined {
  const {
    current_maha,
    current_antar,
    current_pratyantar,
    maha_dasha_sequence,
    pratyantar_sequence,
    convention,
  } = chart.dashas;
  const maha = current_maha ?? selectActiveMaha(maha_dasha_sequence, asOf);
  if (!maha) {
    return undefined;
  }
  return {
    maha_dasha: toDashaData(maha),
    ...(current_antar ? { antar_dasha: toDashaData(current_antar, "antar") } : {}),
    ...(current_pratyantar
      ? { pratyantar_dasha: toDashaData(current_pratyantar, "pratyantar") }
      : {}),
    // Each maha row keeps its dated antar tree (absent on older bundles).
    full_sequence: maha_dasha_sequence.map((p) => toMahaDashaData(p)),
    // The CURRENT antar's dated pratyantardashas. The engine emits null exactly
    // when current_antar is null; null and absent both fold to an absent key.
    ...(pratyantar_sequence
      ? {
          pratyantar_sequence: pratyantar_sequence.map((p) =>
            toDashaData(p, "pratyantar"),
          ),
        }
      : {}),
    // The declared dasha-year convention (additive; absent on older bundles).
    ...(convention ? { convention } : {}),
  };
}

/** Aries..Pisces in zodiacal order; index is the sign's 0..11 index. */
const ZODIAC_ORDER: readonly string[] = [
  "Aries",
  "Taurus",
  "Gemini",
  "Cancer",
  "Leo",
  "Virgo",
  "Libra",
  "Scorpio",
  "Sagittarius",
  "Capricorn",
  "Aquarius",
  "Pisces",
];

/** Whole-sign house (1..12) of a sign given the lagna sign (both engine names). */
function wholeSignHouse(sign: string, lagnaSign: string): number {
  const signIndex = ZODIAC_ORDER.indexOf(sign);
  const lagnaIndex = ZODIAC_ORDER.indexOf(lagnaSign);
  return ((signIndex - lagnaIndex + 12) % 12) + 1;
}

/** Engine Title-Case sign ("Aries") -> the UI's lowercase `ZodiacSign` ("aries"). */
function toUiSign(sign: string): ZodiacSign {
  return sign.toLowerCase() as ZodiacSign;
}

/**
 * Reshape the engine's D9 navamsa into the UI `VargaContext` (D1 + D9). The D9
 * houses are whole-sign from the navamsa lagna, mirroring how the rasi (D1)
 * houses derive from the rasi lagna. Pure: no astrology computed here — the
 * engine already did the navamsa math. Returns undefined when the engine
 * emitted no navamsa (older bundles), so the UI section simply no-ops.
 */
function toNavamsaVargaCtx(chart: SiderealChart): VargaContext | undefined {
  const nav = chart.navamsa;
  if (!nav) return undefined;
  const d1Planets: Record<string, VargaPlanetData> = {};
  for (const [key, p] of Object.entries(chart.planets)) {
    d1Planets[key] = {
      sign: toUiSign(p.sign),
      house: p.house,
      sign_lord: p.sign_lord as PlanetName,
    };
  }
  const d9Planets: Record<string, VargaPlanetData> = {};
  for (const [key, p] of Object.entries(nav.planets)) {
    d9Planets[key] = {
      sign: toUiSign(p.sign),
      house: wholeSignHouse(p.sign, nav.lagna_sign),
      sign_lord: p.sign_lord as PlanetName,
    };
  }
  const d1: VargaChartData = {
    name: "D1",
    lagna_sign: toUiSign(chart.lagna.sign),
    planets: d1Planets,
  };
  const d9: VargaChartData = {
    name: "D9",
    lagna_sign: toUiSign(nav.lagna_sign),
    planets: d9Planets,
  };
  return { D1: d1, D9: d9 };
}

/**
 * Reshape one engine yoga into the UI `YogaData` — field-for-field, verbatim.
 * The engine emits ONLY formed yogas with a qualitative `grade`, the numeric
 * `strength_pct` that `grade` is a bucketing of, and a complete trace (strength
 * factors + formation rules, each min-length-1 by schema). All of it is carried
 * verbatim. Pure relabeling of the enum strings onto the UI unions — no
 * astrology, and nothing re-derived.
 */
function toYogaData(yoga: EngineYogaData): YogaData {
  return {
    name: yoga.name,
    display_name: yoga.display_name,
    category: yoga.category as YogaCategory,
    description: yoga.description,
    effects: yoga.effects,
    grade: yoga.grade,
    strength_factors: yoga.strength_factors.map((factor) => ({
      factor_type: factor.factor_type as YogaData["strength_factors"][number]["factor_type"],
      planet: factor.planet as PlanetName,
      value: factor.value,
      basis: factor.basis,
      mark: factor.mark,
    })),
    // Calibrated structural strength — carried verbatim; the engine anchors and
    // computes it (backend yogas/factors.favorability), the UI never re-derives.
    net_marks: yoga.net_marks,
    max_favorable: yoga.max_favorable,
    max_unfavorable: yoga.max_unfavorable,
    strength_pct: yoga.strength_pct,
    strength_tier: yoga.strength_tier,
    planets_involved: yoga.planets_involved.map((p) => p as PlanetName),
    houses_involved: [...yoga.houses_involved],
    planetary_signature: yoga.planetary_signature,
    formation_rules: yoga.formation_rules.map((rule) => ({
      rule: rule.rule,
      description: rule.description,
      source: rule.source,
      planets: rule.planets.map((p) => p as PlanetName),
      houses: [...rule.houses],
    })),
  };
}

export function toBirthData(birth: BirthMeta): ProcessedBirthData {
  const utc = birthDatetimeUtc(birth);
  // The local wall-clock reflects the EFFECTIVE (rectified) time the chart used.
  const local = dayjs.tz(`${birth.date}T${effectiveTime(birth)}`, birth.timezone);
  return {
    name: birth.name,
    birth_datetime_utc: utc,
    // No timezone designator: this is a local wall-clock value, matching how the
    // backend stored birth_datetime_local. UI surfaces parse it as local.
    birth_datetime_local: local.format("YYYY-MM-DDTHH:mm:ss"),
    birth_location_details: {
      city: birth.location_name,
      latitude: birth.latitude,
      longitude: birth.longitude,
      timezone: birth.timezone,
      location_name: birth.location_name,
    },
    // Preserve the originally-entered time + confidence when a rectified time
    // overrode it, so the UI can show "rectified from HH:MM".
    ...(birth.rectifiedTime ? { birth_time_original: birth.time } : {}),
    ...(birth.timeConfidence ? { birth_time_confidence: birth.timeConfidence } : {}),
  };
}

/**
 * Deterministic, collision-resistant-enough id from the birth inputs (FNV-1a
 * hex). Keyed on the EFFECTIVE (rectified) time so a rectification yields a new
 * id, which Phase-5 change-detection uses to trigger a regeneration.
 */
export function chartId(birth: BirthMeta): string {
  // Only the LATER occurrence of a repeated hour marks the seed. Before DST
  // folds were explicit, dayjs resolved every repeated hour to the EARLIER
  // occurrence, so every stored chart in one is an 'earlier' chart: leaving
  // 'earlier' unmarked keeps those ids stable, while the two occurrences still
  // get distinct ids (switching between them must regenerate).
  const laterMark = effectiveFold(birth) === "later" ? "|later" : "";
  const seed = `${birth.name}|${birth.date}T${effectiveTime(birth)}|${birth.timezone}|${birth.latitude}|${birth.longitude}${laterMark}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The instant-dependent half of a stored chart: the engine output reshaped for
 * the UI, stamped with the instant it was computed as of. Split out so a chart
 * re-anchored to a new day (`reanchorChart`) is reshaped by the SAME code as a
 * freshly generated one.
 */
export function chartCalculations(
  chart: SiderealChart,
  referenceInstant: string,
): ChartData["astronomical_calculations"] {
  const stampedAt = chartReferenceInstantAsDate(
    referenceInstant,
    "siderealChartToChartData: referenceInstant",
  );
  // Additive predictive contexts: each adapter returns undefined when the
  // engine payload omits its raw context (older bundles), and the conditional
  // spreads keep the keys entirely absent in that case.
  const transitCtx = toTransitCtx(chart.transit_context);
  const vargaCtxFull = toVargaCtxFull(chart.varga_context_full);
  const strengthCtx = toStrengthCtx(chart.strength_context);
  const domainsCtx = toDomainsCtx(chart.domains_context);
  return {
    sidereal_ctx: toSiderealCtx(chart),
    // D9 Navamsa from the Python engine (never reimplemented in TS). Kept
    // byte-compatible for the kundli renderers; the FULL 16-varga set rides
    // separately as varga_ctx_full.
    varga_ctx: toNavamsaVargaCtx(chart),
    dasha_ctx: toDashaCtx(chart, stampedAt),
    // Engine yogas reshaped field-for-field (grade + honest trace; the old
    // numeric strength/is_active fields no longer exist in the contract).
    yoga_ctx: chart.yogas.map(toYogaData),
    ...(transitCtx ? { transit_ctx: transitCtx } : {}),
    ...(vargaCtxFull ? { varga_ctx_full: vargaCtxFull } : {}),
    ...(strengthCtx ? { strength_ctx: strengthCtx } : {}),
    ...(domainsCtx ? { domains_ctx: domainsCtx } : {}),
    // The chart's reference instant — the SAME value passed to the engine as
    // `referenceDate`, not a second, independent clock read. That identity is
    // what makes the claim checkable: this printed timestamp is the input
    // that reproduces the chart, so a reader can regenerate it from what the
    // report shows. It used to be its own `new Date()`, which meant the cover
    // date and the "current" dasha came from two different instants.
    // NEVER `new Date(0)`: the epoch leaked through as "Generated on Dec 31 1969".
    calculation_timestamp: stampedAt.toISOString(),
    // The engine that COMPUTED this chart, from its snapshot, never the
    // engine running today. A chart stored before snapshots keeps the label.
    software_version: chart.snapshot?.engine_version ?? LEGACY_SOFTWARE_VERSION,
    ...(chart.snapshot ? { snapshot: chart.snapshot } : {}),
  };
}

/**
 * Reshape the engine's flat `SiderealChart` into the nested `ChartData` the UI
 * renders. Pure: no astrology is computed here. `varga_ctx` carries the D9
 * Navamsa the Python engine computed (undefined for older bundles); the
 * `interpretation` is left absent (engine emits none).
 */
export function siderealChartToChartData(
  chart: SiderealChart,
  birth: BirthMeta,
  referenceInstant: string,
): ChartData & { readonly chart_id: string } {
  return {
    chart_id: chartId(birth),
    birth_data: toBirthData(birth),
    astronomical_calculations: chartCalculations(chart, referenceInstant),
    interpretation: undefined,
  };
}
