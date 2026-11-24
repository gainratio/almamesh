/**
 * Report data formatters — pure helpers for the print-first Vedic report.
 *
 * These are presentation-only transforms over the engine's own values; they never
 * recompute astrology (calculation integrity). They also fix three print bugs the
 * old dark-dashboard export carried:
 *  - the cover "Generated on" date rendering the Unix epoch (Dec 31 1969);
 *  - the location string yielding trailing commas ("Bengaluru, India, ,");
 *  - technical labels with no engine value ("Julian Day", "Sidereal Time").
 *
 * Birth date/time formatting REUSES the canonical timezone-safe helpers in
 * `./dates` (`formatBirthDateForDisplay`, `formatBirthTimeForDisplay`) so the
 * report renders the birth-local wall clock exactly as stored — never reparsed
 * through `Date`, which would roll the date/time to the viewer's timezone.
 */

import type { ProcessedBirthData } from '@almamesh/shared-types';

import { activeLocale, formatBirthDateForDisplay, formatBirthTimeForDisplay } from './dates';

/** The minimal chart shape the technical-field selector reads (engine-emitted). */
export interface ReportChartFields {
  /** Sidereal ayanamsa in degrees, as emitted by the engine. */
  readonly ayanamsa_value: number;
  /** Optional engine ayanamsa convention identifier (e.g. 'LAHIRI', 'KP'). */
  readonly ayanamsa_type?: string;
  /** Optional chart snapshot carrying the stamped ayanamsa convention. */
  readonly snapshot?: { readonly ayanamsa?: string };
}

const AYANAMSA_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  LAHIRI: 'Lahiri',
  TRUE_CHITRA: 'True Chitra',
  KP: 'KP',
  RAMAN: 'B.V. Raman',
  FAGAN_BRADLEY: 'Fagan-Bradley',
};

/** Human-readable display name for an ayanamsa enum code (defaults to Lahiri). */
export function ayanamsaDisplayName(code?: string): string {
  const key = (code ?? 'LAHIRI').toUpperCase();
  return AYANAMSA_DISPLAY_NAMES[key] ?? key;
}

/** A formatted birth date/time, each part in the BIRTH timezone. */
export interface BirthDateTimeParts {
  readonly date: string;
  readonly time: string;
  readonly tzLabel: string;
}

/** A single technical readout: a label and its formatted engine value. */
export interface TechnicalField {
  readonly label: string;
  readonly value: string;
}

/**
 * A human "Generated on" date formatter, built fresh per call in the ACTIVE UI
 * locale (en→en-US, es→es-ES, pt→pt-BR) so the report cover follows the user's
 * chosen language. Long month + full year in the locale's own order (en-US
 * "June 5, 2026"; es-ES "5 de junio de 2026").
 */
function humanDateFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(activeLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** True when a value parses to a real, finite calendar instant. */
function isRealDate(date: Date): boolean {
  // The epoch (value 0 / "1970-..." / falsy inputs) is treated as "no date":
  // a report's "Generated on" must never read December 31, 1969.
  return !Number.isNaN(date.getTime()) && date.getTime() !== 0;
}

/**
 * Resolve a stored value to a real calendar instant, or `null` when it is absent,
 * epoch-shaped, or unparseable — WITHOUT falling back to the clock.
 *
 * `formatReportDate` below deliberately falls back to "now", which is right for
 * the on-screen report but is a determinism leak in the PDF: the exported file
 * must be reproducible from its inputs alone (README "same input, same file
 * every time"). The PDF builder resolves its one instant through here instead
 * and simply omits the date when there isn't one.
 */
export function reportInstant(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === 0 || value === '') return null;
  const candidate = value instanceof Date ? value : new Date(value);
  return isRealDate(candidate) ? candidate : null;
}

/**
 * A human date in the active UI locale. Guards null / 0 / invalid inputs by falling
 * back to the current date (the cover/"Generated on" date), never the epoch.
 */
export function formatReportDate(value: Date | string | number | null | undefined): string {
  const human = humanDateFormatter();
  if (value === null || value === undefined || value === 0 || value === '') {
    return human.format(new Date());
  }
  const candidate = value instanceof Date ? value : new Date(value);
  return human.format(isRealDate(candidate) ? candidate : new Date());
}

/**
 * Format the birth date + time in the BIRTH timezone, reusing the tz-safe
 * `./dates` helpers (the stored value is a tz-naive birth-local wall clock).
 */
export function formatBirthDateTime(birth: ProcessedBirthData): BirthDateTimeParts {
  const local = birth.birth_datetime_local;
  return {
    date: local ? formatBirthDateForDisplay(local) : '',
    time: local ? formatBirthTimeForDisplay(local) : '',
    tzLabel: birth.birth_location_details.timezone ?? '',
  };
}

/** True when a location part is a non-empty, non-whitespace string. */
function isPopulated(part: string | null | undefined): part is string {
  return typeof part === 'string' && part.trim().length > 0;
}

/**
 * Join only the populated location parts (city, region/state, country) with
 * commas, so the place string never yields "Bengaluru, India, ," for absent parts.
 */
export function buildPlaceString(birth: ProcessedBirthData): string {
  const { city, state, country } = birth.birth_location_details;
  return [city, state, country]
    .filter(isPopulated)
    .map((part) => part.trim())
    .join(', ');
}

/** "15°41′" — whole degrees + arcminutes from the fractional part. */
export function formatDegree(signDegrees: number): string {
  let degrees = Math.floor(signDegrees);
  // Round (not floor) the arcminutes so float noise like 0.6833*60 = 40.999…
  // resolves to 41′ rather than 40′; carry a 60′ result up to the next degree.
  let minutes = Math.round((signDegrees - degrees) * 60);
  if (minutes === 60) {
    degrees += 1;
    minutes = 0;
  }
  return `${degrees}°${String(minutes).padStart(2, '0')}′`;
}

/**
 * Format a daśā span in years for DISPLAY only — never recompute the engine
 * value. Whole numbers render bare ("18"); fractional spans (e.g. the running
 * balance period 4.329716303220536) collapse to one decimal ("4.3") so a raw
 * float never leaks into the report. Non-finite inputs degrade to "0".
 */
export function formatDurationYears(years: number): string {
  if (!Number.isFinite(years)) {
    return '0';
  }
  return Number.isInteger(years) ? String(years) : years.toFixed(1);
}

/**
 * Return ONLY the technical fields the engine actually emits. The in-browser
 * engine emits `ayanamsa_value` (Lahiri, in degrees) and fixes the house system
 * to whole-sign; it emits NO Julian Day or Sidereal Time, so those labels are
 * omitted entirely (rather than rendered blank).
 */
export function selectTechnicalFields(chart: ReportChartFields): ReadonlyArray<TechnicalField> {
  const ayanamsaName = ayanamsaDisplayName(chart.snapshot?.ayanamsa ?? chart.ayanamsa_type);
  return [
    { label: 'Ayanamsa', value: `${chart.ayanamsa_value.toFixed(2)}° (${ayanamsaName})` },
    { label: 'House System', value: 'Whole Sign' },
  ];
}
