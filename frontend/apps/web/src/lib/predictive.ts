/**
 * Predictive-layer presentation helpers — PURE, no astrology.
 *
 * Everything here reshapes or formats engine-emitted predictive data for the
 * UI: building the lazy `ensurePredictive` input from the stored chart,
 * pinning an explicit reference instant (never a silent wall-clock read deep
 * in a component), Title-Casing the adapter's lowercase tokens for the chart
 * geometry builder, and locale-aware date display for engine ISO values.
 */

import type {
  PlanetShadbalaData,
  ProcessedBirthData,
  VargaChartFullData,
} from '@almamesh/shared-types';
import {
  offsetMinutesAtInstant,
  type EnsurePredictiveInput,
  type StoredChart,
  type VargaChart,
  type VargaPlanet,
} from '@almamesh/store';
import { formatBirthDateForDisplay, formatDisplayDate, formatDisplayTime } from './dates';

/**
 * The EXPLICIT reference instant for "what's happening now": UTC midnight of
 * the given day. Pinning to the day start keeps the store's idempotency key
 * stable across re-renders and across the whole session day, and makes the
 * computed "current" dasha/transits reproducible.
 */
export function predictiveReferenceInstant(
  now: Date = new Date(),
  timeZone = 'UTC',
): string {
  if (Number.isNaN(now.valueOf())) throw new Error('A valid clock instant is required.');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T00:00:00Z`;
}

/**
 * Display one analysis day — a `predictiveReferenceInstant` value — as the
 * calendar day it names. It is UTC midnight of the chart-local day, so it is
 * formatted in UTC: formatting it in the viewer's zone printed the day BEFORE
 * for anyone west of Greenwich ("As of Oct 06" on Oct 07 in California). Every
 * "As of" on screen and in the PDF goes through here, so they cannot disagree.
 */
export function formatReferenceDay(day: string): string {
  return formatDisplayDate(new Date(day), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Build the lazy-compute input from the stored chart's birth data, or `null`
 * when the chart predates the fields the engine needs (no silent guesses).
 */
export function buildEnsurePredictiveInput(
  profileKey: string,
  birth: ProcessedBirthData | undefined,
  referenceInstant: string,
  windowMonths?: 24,
): EnsurePredictiveInput | null {
  const datetimeUtc = birth?.birth_datetime_utc;
  const location = birth?.birth_location_details;
  // No zone, no civil offset: the engine reads Vedic weekdays off the civil
  // date, so a missing zone is "incomplete birth data", never a UTC guess.
  if (!datetimeUtc || !location?.timezone) {
    return null;
  }
  let utcOffsetMinutes: number;
  try {
    utcOffsetMinutes = offsetMinutesAtInstant(datetimeUtc, location.timezone);
  } catch {
    return null; // an unknown zone or unreadable instant is incomplete birth data
  }
  return {
    profileKey,
    datetimeUtc,
    latitude: location.latitude,
    longitude: location.longitude,
    referenceInstant,
    utcOffsetMinutes,
    ...(windowMonths === undefined ? {} : { windowMonths }),
  };
}

/**
 * The active profile's primary stored chart (the explicit primary, else the
 * first) — the same rule `ReportView` and the chart-library store use.
 */
export function selectPrimaryStoredChart(
  charts: Readonly<Record<string, StoredChart>>,
  profileId?: string | null,
): StoredChart | undefined {
  const all = Object.values(charts);
  const scoped = profileId ? all.filter((chart) => chart.profile_id === profileId) : all;
  return scoped.find((chart) => chart.is_primary) ?? scoped[0];
}

/** "aries" → "Aries", "saturn" → "Saturn" (pure casing, no vocabulary). */
export function titleCaseToken(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/**
 * Reshape one engine Shodasavarga chart (adapter-lowercased signs) into the
 * `VargaChart` shape `buildVargaGeometry` consumes (engine Title-Case signs).
 * Pure case mapping — placements and lordships render verbatim.
 */
export function toVargaChart(data: VargaChartFullData): VargaChart {
  const planets: Record<string, VargaPlanet> = {};
  for (const [key, placement] of Object.entries(data.placements)) {
    if (!placement) continue;
    planets[key] = {
      name: placement.graha,
      sign: titleCaseToken(placement.sign),
      sign_lord: placement.sign_lord,
      // Carry the engine's D1 combustion flag so the varga dims combust grahas.
      is_combust: placement.is_combust,
    };
  }
  return {
    name: data.chart,
    lagna_sign: titleCaseToken(data.lagna_sign),
    lagna_sign_lord: data.lagna_sign_lord,
    planets,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Locale-aware display for an engine ISO value: a date-only string renders as
 * that CALENDAR date (never reparsed through UTC, which can roll it back a day
 * west of GMT), while a full instant renders in the viewer's local time.
 */
export function formatPredictiveDate(iso: string): string {
  if (DATE_ONLY.test(iso)) {
    return formatBirthDateForDisplay(iso);
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return formatBirthDateForDisplay(iso.split('T')[0] ?? iso);
  }
  return formatDisplayDate(parsed);
}

/**
 * Display date for an engine window bound. The bounds are UTC instants (often
 * UTC midnight), so they are formatted in UTC: west of Greenwich a local-time
 * render would show the previous day ("Oct 08" for a window starting 9 Oct).
 */
export function formatPredictiveWindowBound(iso: string): string {
  const parsed = new Date(iso);
  if (DATE_ONLY.test(iso) || Number.isNaN(parsed.getTime())) {
    return formatPredictiveDate(iso);
  }
  return formatDisplayDate(parsed, { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

/**
 * Display formatting for a Shadbala rupa value. The engine emits full-precision
 * floats (e.g. 6.128260954302394); the screen shows the conventional two
 * decimals. Pure presentation — the underlying engine value is untouched.
 */
export function formatRupas(value: number): string {
  return value.toFixed(2);
}

/**
 * Display formatting for a calibrated strength percentage (0..100). The engine
 * emits the full-precision, golden-locked value (e.g. 57.142857); the screen
 * shows a whole-number mark (`57%`) — readable, and no false precision. Pure
 * presentation — the exact engine value is untouched.
 */
export function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}

/** The `strength.sunrise_basis_zoned` interpolation values. */
export interface SunriseBasisParams {
  readonly date: string;
  readonly time: string;
  readonly zone: string;
}

/**
 * The Kalabala sunrise on the BIRTHPLACE's calendar and clock. The Vedic day
 * runs sunrise to sunrise at the birthplace, so a viewer in another zone must
 * not see it moved onto their own date. Without the birthplace zone the
 * instant is shown in UTC and labelled so — never the viewer's zone. Shared by
 * the Strength tab, the web report and the PDF.
 */
export function sunriseBasisParams(sunriseUtcIso: string, birthTimeZone?: string): SunriseBasisParams {
  const zone = birthTimeZone || 'UTC';
  const sunrise = new Date(sunriseUtcIso);
  return {
    date: formatDisplayDate(sunrise, { year: 'numeric', month: 'short', day: '2-digit', timeZone: zone }),
    time: formatDisplayTime(sunrise, { hour: 'numeric', minute: '2-digit', timeZone: zone }),
    zone,
  };
}

/** True when ANY Shadbala component of this graha carries the approx flag. */
export function hasApproximatedComponents(p: PlanetShadbalaData): boolean {
  const flat = [
    p.sthana.uccha, p.sthana.saptavargaja, p.sthana.ojayugma, p.sthana.kendradi, p.sthana.drekkana,
    p.dig,
    p.kala.nathonnatha, p.kala.paksha, p.kala.tribhaga, p.kala.abda, p.kala.masa,
    p.kala.vara, p.kala.hora, p.kala.ayana, p.kala.yuddha,
    p.cheshta, p.naisargika, p.drik,
  ];
  return flat.some((component) => component.approximated);
}
