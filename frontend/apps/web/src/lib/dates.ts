/**
 * Date utilities for consistent local date handling
 *
 * IMPORTANT: Use formatLocalDate() instead of toISOString().split('T')[0]
 * toISOString() converts to UTC which can shift dates by a day depending on timezone
 *
 * DISPLAY formatting (formatBirthDateForDisplay, formatBirthTimeForDisplay,
 * formatDisplayDate, formatDisplayTime) is LOCALE-AWARE — it follows the user's
 * chosen UI language via `@almamesh/store`'s language store (en→en-US, es→es-ES,
 * pt→pt-BR). MACHINE formats (formatLocalDate / parseLocalDate, the YYYY-MM-DD
 * form-value round-trip) are intentionally NOT localized.
 */

import { type Language, useLanguageStore } from '@almamesh/store';

/** The BCP-47 display locale for each supported UI language. */
const LOCALE_BY_LANGUAGE: Record<Language, string> = {
  en: 'en-US',
  es: 'es-ES',
  pt: 'pt-BR',
  hi: 'hi-IN',
};

/** Map a supported UI language to its display locale (en→en-US, es→es-ES, pt→pt-BR, hi→hi-IN). */
export function localeForLanguage(lang: Language): string {
  return LOCALE_BY_LANGUAGE[lang];
}

/**
 * The active display locale, read from the language store's current value. Used
 * by the non-React display formatters below (no hooks — safe to call anywhere).
 */
export function activeLocale(): string {
  return localeForLanguage(useLanguageStore.getState().language);
}

/**
 * True when a value parses to a real, finite calendar instant. The epoch
 * (value 0 / "1970-…") is treated as "no date": a stored chart carrying the old
 * `new Date(0)` calculation_timestamp must never render as December 31, 1969.
 * Mirrors the guard in `lib/reportData.ts`.
 */
function isRealDate(date: Date): boolean {
  return !Number.isNaN(date.getTime()) && date.getTime() !== 0;
}

/**
 * Format a real `Date` in the active UI locale. Generic call-site helper for any
 * machine instant (e.g. a dasha start/end ISO date or `generated_at`).
 *
 * Defense-in-depth: an epoch / NaN `Date` falls back to the current date so the
 * UI never shows "1969"/"1970" or "Invalid Date" — it is the last line guarding
 * against a stored chart that carried the Unix-epoch calculation_timestamp.
 */
export function formatDisplayDate(date: Date, opts?: Intl.DateTimeFormatOptions): string {
  const options: Intl.DateTimeFormatOptions = opts ?? {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  };
  const safe = isRealDate(date) ? date : new Date();
  return new Intl.DateTimeFormat(activeLocale(), options).format(safe);
}

/**
 * Format the time-of-day of a real `Date` in the active UI locale. The 12h/24h
 * convention follows the locale (en→12h with AM/PM, es/pt→24h).
 */
export function formatDisplayTime(date: Date, opts?: Intl.DateTimeFormatOptions): string {
  const options: Intl.DateTimeFormatOptions = opts ?? {
    hour: 'numeric',
    minute: '2-digit',
  };
  return new Intl.DateTimeFormat(activeLocale(), options).format(date);
}

/**
 * Format a Date as YYYY-MM-DD in LOCAL timezone (not UTC)
 *
 * @example
 * // User in Pacific timezone (UTC-8)
 * const date = new Date('2024-08-16T00:00:00'); // Aug 16 midnight local
 * date.toISOString().split('T')[0] // '2024-08-15' - WRONG! (converted to UTC)
 * formatLocalDate(date) // '2024-08-16' - CORRECT! (uses local timezone)
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse a YYYY-MM-DD string as a local date (not UTC)
 *
 * Note: new Date('YYYY-MM-DD') parses as UTC midnight, which can appear
 * as the previous day in local timezone. This function creates the date
 * at local midnight.
 */
export function parseLocalDate(dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Format a stored tz-naive birth-local datetime ("YYYY-MM-DDTHH:mm:ss" or
 * "YYYY-MM-DD") in the active UI locale (en→MM/DD/YYYY, es/pt→DD/MM/YYYY).
 *
 * tz-naive guarantee: the stored value is a birth-local WALL CLOCK, never an
 * instant. We parse the integer Y/M/D parts and build the `Date` at LOCAL NOON
 * (`new Date(y, m-1, d, 12, 0, 0)`) — never `new Date("YYYY-MM-DD…")`, which
 * reparses as UTC and can roll the calendar date back a day west of GMT. Noon
 * keeps the date stable regardless of the viewer's timezone before Intl runs.
 */
export function formatBirthDateForDisplay(local: string): string {
  const datePart = local.split('T')[0];
  const [year, month, day] = datePart.split('-').map(Number);
  const safe = new Date(year, month - 1, day, 12, 0, 0);
  return new Intl.DateTimeFormat(activeLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(safe);
}

/**
 * Format the time component of a stored tz-naive birth-local datetime
 * ("YYYY-MM-DDTHH:mm:ss") in the active UI locale (en→12-hour "h:mm AM/PM",
 * es/pt→24-hour). Returns "" when there is no time component (date-only string).
 *
 * tz-naive guarantee: the hour/minute come straight from the stored wall clock;
 * we build the `Date` from those parsed integers (at an arbitrary fixed date) so
 * it is never reparsed via UTC, then let Intl pick the locale's clock convention.
 */
export function formatBirthTimeForDisplay(local: string): string {
  const timePart = local.split('T')[1];
  if (!timePart) return '';
  const [hourStr, minuteStr] = timePart.split(':');
  const hour24 = Number(hourStr);
  const minute = Number(minuteStr);
  const safe = new Date(2000, 0, 1, hour24, minute, 0);
  return new Intl.DateTimeFormat(activeLocale(), {
    hour: 'numeric',
    minute: '2-digit',
  }).format(safe);
}
