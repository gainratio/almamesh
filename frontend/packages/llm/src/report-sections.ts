// The four timeline sections of the report (Section 2 of the 2026-10-10
// reading-in-onboarding spec): their keys, their output types, and the slice
// of the ALREADY-SANITIZED chart each one may see. Slices are reshapes of
// sanitize.ts output only: no astrology is computed here.

import type { LifeDomain, Persona, TitledPersona } from "@almamesh/shared-types";

import { asLayman, asPersona, asRecord, asString, parsePersona, parseTitledPersonas } from "./persona-parse";
import { computeQuarters, type Quarter, type QuarterKey } from "./quarters";
import type {
  SanitizedChart,
  SanitizedCurrentPeriod,
  SanitizedDatedPeriod,
  SanitizedDomainForecast,
  SanitizedFusion,
  SanitizedHouseLord,
  SanitizedSadeSati,
} from "./sanitize";

export type ReportTimelineSectionKey = "current_period" | "year_ahead" | "life_outlook_1" | "life_outlook_2";

/** Run order: the two life-outlook calls go last (owner ruling 7). */
export const REPORT_TIMELINE_SECTIONS = [
  "current_period",
  "year_ahead",
  "life_outlook_1",
  "life_outlook_2",
] as const satisfies readonly ReportTimelineSectionKey[];

export function isReportTimelineSection(key: string): key is ReportTimelineSectionKey {
  return (REPORT_TIMELINE_SECTIONS as readonly string[]).includes(key);
}

export interface CurrentPeriodSection {
  readonly maha: Persona;
  readonly antar: Persona;
  readonly activates: TitledPersona[];
  readonly next_change: Persona;
}

export interface QuarterProse {
  readonly key: QuarterKey;
  readonly layman: string;
  readonly technical: string;
}

export interface YearAheadSection {
  readonly headline: Persona;
  readonly quarters: QuarterProse[];
  readonly focus?: Persona;
}

export interface LifeOutlookDomain {
  readonly domain: LifeDomain;
  readonly outlook: Persona;
  readonly lean_into?: string;
  readonly watch_for?: string;
}

export interface LifeOutlookSection {
  readonly domains: LifeOutlookDomain[];
}

/** What `streamReportTimeline` completes with (PR 3 stores it as timeline `shape: 'v2'`). */
export interface ReportTimelineContent {
  readonly current_period: CurrentPeriodSection | null;
  readonly year_ahead: YearAheadSection | null;
  /** One entry per outlook call; null = that call failed or never ran. Cards render in LIFE_DOMAIN_ORDER. */
  readonly life_outlook: {
    readonly life_outlook_1: LifeOutlookSection | null;
    readonly life_outlook_2: LifeOutlookSection | null;
  };
}

export const LIFE_OUTLOOK_GROUPS = {
  life_outlook_1: ["career", "finances", "relationships", "family"],
  life_outlook_2: ["health", "education", "spiritual"],
} as const satisfies Record<"life_outlook_1" | "life_outlook_2", readonly LifeDomain[]>;

export type LifeOutlookSectionKey = keyof typeof LIFE_OUTLOOK_GROUPS;

/** The life-area card order on screen. */
export const LIFE_DOMAIN_ORDER: readonly LifeDomain[] = [
  ...LIFE_OUTLOOK_GROUPS.life_outlook_1,
  ...LIFE_OUTLOOK_GROUPS.life_outlook_2,
];

// --- input slices --------------------------------------------------------------

export function reportAsOfMonth(chart: SanitizedChart): string {
  return chart.as_of.date.slice(0, 7);
}

interface LordFacts {
  readonly lord: string;
  readonly sign?: string;
  readonly house?: number;
  readonly dignity?: string;
  readonly houses_ruled?: readonly number[];
  readonly is_yogakaraka?: boolean;
  readonly is_combust?: boolean;
  readonly is_retrograde?: boolean;
  /** Names of LISTED yogas this graha takes part in. */
  readonly yogas: readonly string[];
}

function lordFacts(chart: SanitizedChart, lord: string): LordFacts {
  const yogas = chart.yogas.filter((yoga) => yoga.planets_involved.includes(lord)).map((yoga) => yoga.name);
  const planet = chart.planets[lord];
  if (!planet) return { lord, yogas };
  return {
    lord,
    sign: planet.sign,
    house: planet.house,
    dignity: planet.dignity,
    houses_ruled: planet.houses_ruled,
    is_yogakaraka: planet.is_yogakaraka,
    is_combust: planet.is_combust,
    is_retrograde: planet.is_retrograde,
    yogas,
  };
}

interface NextMaha {
  readonly lord: string;
  readonly start_month: string | null;
  readonly end_month: string | null;
}

export interface CurrentPeriodInput {
  readonly as_of_month: string;
  readonly current_maha: SanitizedCurrentPeriod | null;
  readonly current_antar: SanitizedCurrentPeriod | null;
  readonly current_pratyantar: SanitizedCurrentPeriod | null;
  readonly antar_sequence: readonly SanitizedDatedPeriod[];
  readonly pratyantar_sequence: readonly SanitizedDatedPeriod[];
  readonly next_maha: NextMaha | null;
  readonly fusion: SanitizedFusion | null;
  readonly lord_facts: readonly LordFacts[];
}

function currentMahaIndex(chart: SanitizedChart): number {
  return (chart.dashas?.maha_dasha_sequence ?? []).findIndex((row) => row.status.startsWith("current"));
}

export function currentPeriodSlice(chart: SanitizedChart): CurrentPeriodInput {
  const dashas = chart.dashas;
  const sequence = dashas?.maha_dasha_sequence ?? [];
  const index = currentMahaIndex(chart);
  const current = index >= 0 ? sequence[index] : undefined;
  const next = index >= 0 ? sequence[index + 1] : undefined;
  const lords = [dashas?.current_maha?.lord, dashas?.current_antar?.lord, dashas?.current_pratyantar?.lord, next?.lord]
    .filter((lord): lord is string => typeof lord === "string");
  return {
    as_of_month: reportAsOfMonth(chart),
    current_maha: dashas?.current_maha ?? null,
    current_antar: dashas?.current_antar ?? null,
    current_pratyantar: dashas?.current_pratyantar ?? null,
    antar_sequence: current?.antar_sequence ?? [],
    pratyantar_sequence: dashas?.pratyantar_sequence ?? [],
    next_maha: next ? { lord: next.lord, start_month: next.start_month ?? null, end_month: next.end_month ?? null } : null,
    fusion: chart.predictive?.transits?.fusion ?? null,
    lord_facts: [...new Set(lords)].map((lord) => lordFacts(chart, lord)),
  };
}

export interface QuarterEvent {
  readonly month: string;
  readonly source: "dasha" | "transit" | "slow_hit" | "sade_sati";
  readonly what: string;
  readonly severity: string | null;
}

function dashaEvents(chart: SanitizedChart): QuarterEvent[] {
  const slice = currentPeriodSlice(chart);
  const antars = slice.antar_sequence.map((row) => ({
    month: row.start_month, source: "dasha" as const, what: `${row.lord} antardasha begins`, severity: null,
  }));
  const next = slice.next_maha?.start_month
    ? [{ month: slice.next_maha.start_month, source: "dasha" as const, what: `${slice.next_maha.lord} mahadasha begins`, severity: null }]
    : [];
  return [...antars, ...next];
}

function transitEvents(chart: SanitizedChart): QuarterEvent[] {
  const transits = chart.predictive?.transits;
  if (!transits) return [];
  const timeline = transits.timeline.map((event) => ({
    month: event.month,
    source: "transit" as const,
    what: [event.kind, event.graha, event.from_sign && event.to_sign ? `${event.from_sign} -> ${event.to_sign}` : null, event.descriptor]
      .filter(Boolean)
      .join(" "),
    severity: event.severity,
  }));
  const slow = transits.slow_hits.map((hit) => ({
    month: hit.month, source: "slow_hit" as const, what: `${hit.graha} ${hit.kind} on natal ${hit.natal_point}`, severity: hit.severity,
  }));
  const sadeSati = transits.sade_sati.is_active && transits.sade_sati.until_month
    ? [{ month: transits.sade_sati.until_month, source: "sade_sati" as const, what: `Sade Sati (${transits.sade_sati.current_phase} phase) ends`, severity: null }]
    : [];
  return [...timeline, ...slow, ...sadeSati];
}

/** The engine's events inside one quarter, by month (stable within a month). */
export function quarterEvents(chart: SanitizedChart, quarter: Quarter): readonly QuarterEvent[] {
  const months = new Set<string>(quarter.months);
  return [...dashaEvents(chart), ...transitEvents(chart)]
    .filter((event) => months.has(event.month))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export interface YearAheadInput {
  readonly as_of_month: string;
  readonly sade_sati: SanitizedSadeSati | null;
  readonly quarters: readonly { readonly key: QuarterKey; readonly months: Quarter["months"]; readonly events: readonly QuarterEvent[] }[];
}

export function yearAheadSlice(chart: SanitizedChart): YearAheadInput {
  const asOf = reportAsOfMonth(chart);
  return {
    as_of_month: asOf,
    sade_sati: chart.predictive?.transits?.sade_sati ?? null,
    quarters: computeQuarters(asOf).map((quarter) => ({
      key: quarter.key,
      months: quarter.months,
      events: quarterEvents(chart, quarter),
    })),
  };
}

interface LifeOutlookDomainInput extends SanitizedDomainForecast {
  readonly house_lords: readonly SanitizedHouseLord[];
}

export interface LifeOutlookInput {
  readonly as_of_month: string;
  readonly domains: readonly LifeOutlookDomainInput[];
}

export function lifeOutlookSlice(chart: SanitizedChart, section: LifeOutlookSectionKey): LifeOutlookInput {
  const forecasts = chart.predictive?.domains ?? [];
  const houses = chart.predictive?.domain_houses ?? {};
  const group: readonly string[] = LIFE_OUTLOOK_GROUPS[section];
  return {
    as_of_month: reportAsOfMonth(chart),
    domains: group.flatMap((domain) => {
      const forecast = forecasts.find((row) => row.domain === domain);
      return forecast ? [{ ...forecast, house_lords: houses[domain] ?? [] }] : [];
    }),
  };
}

export function reportSlice(
  section: ReportTimelineSectionKey,
  chart: SanitizedChart,
): CurrentPeriodInput | YearAheadInput | LifeOutlookInput {
  switch (section) {
    case "current_period":
      return currentPeriodSlice(chart);
    case "year_ahead":
      return yearAheadSlice(chart);
    case "life_outlook_1":
    case "life_outlook_2":
      return lifeOutlookSlice(chart, section);
  }
}

/** A model reply that names a quarter or a life area the app did not send. */
export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportParseError";
  }
}

export function parseCurrentPeriod(json: unknown): CurrentPeriodSection {
  const rec = asRecord(json);
  return {
    maha: asPersona(rec.maha),
    antar: asPersona(rec.antar),
    activates: parseTitledPersonas(rec.activates),
    next_change: asPersona(rec.next_change),
  };
}

function isSentQuarter(key: string, sent: readonly QuarterKey[]): key is QuarterKey {
  return (sent as readonly string[]).includes(key);
}

export function parseYearAhead(json: unknown, sent: readonly QuarterKey[]): YearAheadSection {
  const rec = asRecord(json);
  const rows = Array.isArray(rec.quarters) ? rec.quarters.map(asRecord) : [];
  const seen = new Set<QuarterKey>();
  const quarters = rows.map((row): QuarterProse => {
    const key = asString(row.key);
    if (!isSentQuarter(key, sent) || seen.has(key)) {
      throw new ReportParseError(`year_ahead: quarter key ${JSON.stringify(key)} was not sent (or repeated)`);
    }
    seen.add(key);
    return { key, layman: asLayman(row.layman), technical: asString(row.technical) };
  });
  const focus = parsePersona(rec.focus);
  return { headline: asPersona(rec.headline), quarters, ...(focus ? { focus } : {}) };
}

function isGroupDomain(domain: string, group: readonly LifeDomain[]): domain is LifeDomain {
  return (group as readonly string[]).includes(domain);
}

export function parseLifeOutlook(json: unknown, group: readonly LifeDomain[]): LifeOutlookDomain[] {
  const rows = asRecord(json).domains;
  return (Array.isArray(rows) ? rows.map(asRecord) : []).map((row) => {
    const domain = asString(row.domain);
    if (!isGroupDomain(domain, group)) {
      throw new ReportParseError(`life_outlook: domain ${JSON.stringify(domain)} is not in this section`);
    }
    const leanInto = asLayman(row.lean_into);
    const watchFor = asLayman(row.watch_for);
    return {
      domain,
      outlook: asPersona(row.outlook),
      ...(leanInto ? { lean_into: leanInto } : {}),
      ...(watchFor ? { watch_for: watchFor } : {}),
    };
  });
}
