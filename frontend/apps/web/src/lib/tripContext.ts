/**
 * A time-travel trip's context (plan 2026-10-13, "Context bootstrap"): the natal
 * summary, the place the user lived then, the period and its dashas, built from
 * (chart, as_of) alone. The trip-bound tools, the trip brief and the context
 * card all read this one module, so what the AI pulls and what the card shows
 * cannot drift. Pure and deterministic: the period's sky (transits, strength,
 * domains) comes from get_timing, which caches it per period.
 *
 * Privacy: the model-facing shapes (natalSummary, tripToolResult) carry signs,
 * houses, nakshatras, lords, a place label and a zone. Never a birth date, time,
 * coordinate or degree. A birth-place fallback is labelled generically; only
 * the local card shows the city.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import { pinRelative, selectDashasForPeriod, type PeriodDashas } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';

import { birthYearOf } from './periodChart';
import { formatPinLabel } from './timeTravelSheet';

/**
 * What the model reads when an old trip has no place of its own. Its tools then
 * read the birth place's sky, but the model is never told that: no birth-place
 * marker, coordinate or birth_location_details field reaches a request.
 */
export const DEFAULT_PLACE_LABEL = 'unspecified place';

export type TripTense = 'past' | 'present' | 'future';

export interface TripPeriod {
  readonly start: string;
  readonly end: string;
  readonly granularity: ChatThreadAsOf['granularity'];
  readonly tense: TripTense;
  /** The period in the UI language, e.g. "May 2019". */
  readonly label: string;
}

export interface TripPlace {
  /** Model-facing label: the trip's city, or DEFAULT_PLACE_LABEL. */
  readonly label: string;
  readonly timezone: string;
  /** Local only (the card): 'birth_place' when an old trip has no place of its own. */
  readonly source: 'trip' | 'birth_place';
  /** Local display only (the card): the city, even for the birth-place fallback. */
  readonly display: string;
}

export interface NatalPoint {
  readonly sign: string;
  readonly nakshatra: string;
  readonly pada: number;
  readonly sign_lord: string;
}

export interface NatalPlanet {
  readonly name: string;
  readonly sign: string;
  readonly house: number;
  readonly nakshatra: string;
  readonly dignity: string;
  readonly retrograde: boolean;
}

export interface NatalSummary {
  readonly lagna: NatalPoint;
  readonly moon: NatalPoint | null;
  readonly planets: readonly NatalPlanet[];
  readonly yogas: readonly { readonly name: string; readonly category: string }[];
}

export interface TripContext {
  readonly period: TripPeriod;
  readonly place: TripPlace;
  readonly today: string;
  readonly natal: NatalSummary;
  readonly dashas: PeriodDashas;
}

export interface TripContextInput {
  readonly chart: SiderealChart;
  readonly asOf: ChatThreadAsOf;
  /** The viewer's day, YYYY-MM-DD. */
  readonly today: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly language: string;
}

const TENSE = { past: 'past', future: 'future', contains_today: 'present' } as const;

function point(source: { sign: string; nakshatra: string; nakshatra_pada: number; sign_lord: string }): NatalPoint {
  return { sign: source.sign, nakshatra: source.nakshatra, pada: source.nakshatra_pada, sign_lord: source.sign_lord };
}

/** Lagna, Moon, planets by sign and house, yogas: no degrees, dates or coordinates. */
export function natalSummary(chart: SiderealChart): NatalSummary {
  const planets = Object.values(chart.planets ?? {}).map((planet) => ({
    name: planet.name,
    sign: planet.sign,
    house: planet.house,
    nakshatra: planet.nakshatra,
    dignity: planet.dignity,
    retrograde: planet.is_retrograde,
  }));
  const moon = chart.planets?.moon;
  return {
    lagna: point(chart.lagna),
    moon: moon ? point(moon) : null,
    planets,
    yogas: (chart.yogas ?? []).map((yoga) => ({ name: yoga.display_name, category: yoga.category })),
  };
}

/** The pin the tools read: an old trip with no place borrows the birth place. */
export function tripPin(asOf: ChatThreadAsOf, birth: ProcessedBirthData | undefined): ChatThreadAsOf {
  const home = birth?.birth_location_details;
  if (asOf.place || !home) return asOf;
  return {
    ...asOf,
    place: { label: DEFAULT_PLACE_LABEL, timezone: home.timezone, latitude: home.latitude, longitude: home.longitude },
  };
}

function tripPlace(asOf: ChatThreadAsOf, birth: ProcessedBirthData | undefined): TripPlace {
  if (asOf.place) {
    return { label: asOf.place.label, timezone: asOf.place.timezone, source: 'trip', display: asOf.place.label };
  }
  const home = birth?.birth_location_details;
  return { label: DEFAULT_PLACE_LABEL, timezone: home?.timezone ?? 'UTC', source: 'birth_place', display: home?.city ?? '' };
}

export function tripContext(input: TripContextInput): TripContext {
  const { asOf } = input;
  const range = { start: asOf.start, end: asOf.end };
  return {
    period: {
      ...range,
      granularity: asOf.granularity,
      tense: TENSE[pinRelative(range, input.today)],
      label: formatPinLabel(asOf, input.language),
    },
    place: tripPlace(asOf, input.birth),
    today: input.today,
    natal: natalSummary(input.chart),
    // A chart stored without a dasha tree still has a trip; it just has no dasha rows.
    dashas: input.chart.dashas
      ? selectDashasForPeriod(input.chart.dashas, range, birthYearOf(input.birth))
      : { maha: [], antar: [], notes: [] },
  };
}

/** get_trip_context's value: the trip as the model sees it. The place is a label and a zone, nothing else. */
export interface TripToolResult {
  readonly period: TripPeriod;
  readonly place: { readonly label: string; readonly timezone: string };
  readonly today: string;
  readonly dashas: Pick<PeriodDashas, 'maha' | 'antar' | 'notes'>;
}

export function tripToolResult(trip: TripContext): TripToolResult {
  return {
    period: trip.period,
    place: { label: trip.place.label, timezone: trip.place.timezone },
    today: trip.today,
    dashas: { maha: trip.dashas.maha, antar: trip.dashas.antar, notes: trip.dashas.notes },
  };
}

const title = (lord: string) => lord.charAt(0).toUpperCase() + lord.slice(1);

/** 'Jupiter–Saturn → Jupiter–Mercury': the maha–antar rows that cover the trip. */
export function tripDashaLine(trip: TripContext): string {
  const rows = trip.dashas.antar.length > 0
    ? trip.dashas.antar.map((row) => `${title(row.maha_lord)}–${title(row.lord)}`)
    : trip.dashas.maha.map((row) => title(row.lord));
  return rows.join(' → ');
}
