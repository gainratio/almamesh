/**
 * Where a new time-travel trip starts (plan 2026-10-13 §2, "Place is part of every
 * trip"): the place of the profile's pin nearest the new date, else the birth place.
 * Pure: calendar strings and the chart's stored birth location only. No device
 * location, no clock, no lookups.
 */
import type { ChatThread, ChatThreadAsOf, LocationDetails } from '@almamesh/shared-types';

export type TripPlace = NonNullable<ChatThreadAsOf['place']>;

/** A thread as the prefill sees it: its pin (if any) and when it last changed. */
export type TripPin = Partial<Pick<ChatThread, 'as_of' | 'updated_at'>>;

interface DayRange {
  readonly start: string;
  readonly end: string;
}

/** The store's own bound on a pin label (`chatAsOf.ts` MAX_LABEL). */
const MAX_LABEL = 120;
const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

/** Whole days between two ranges; 0 when they overlap. */
function gapDays(a: DayRange, b: DayRange): number {
  return Math.max(0, dayNumber(a.start) - dayNumber(b.end), dayNumber(b.start) - dayNumber(a.end));
}

interface Candidate {
  readonly place: TripPlace;
  readonly gap: number;
  readonly updatedAt: string;
}

function closer(a: Candidate, b: Candidate): Candidate {
  if (a.gap !== b.gap) return a.gap < b.gap ? a : b;
  return b.updatedAt > a.updatedAt ? b : a;
}

function candidatesFor(range: DayRange, pins: readonly TripPin[]): Candidate[] {
  return pins.flatMap(({ as_of: asOf, updated_at: updatedAt }) =>
    asOf?.place ? [{ place: asOf.place, gap: gapDays(range, asOf), updatedAt: updatedAt ?? '' }] : [],
  );
}

/** The nearest pinned place to `range` (ties: the most recently updated pin), else the birth place. */
export function prefillTripPlace(range: DayRange | undefined, pins: readonly TripPin[], birthPlace: TripPlace | undefined): TripPlace | undefined {
  const nearest = range ? candidatesFor(range, pins).reduce<Candidate | undefined>((best, next) => (best ? closer(best, next) : next), undefined) : undefined;
  return nearest?.place ?? birthPlace;
}

function isZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value !== '';
  } catch {
    return false;
  }
}

function inRange(value: number, limit: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= limit;
}

function labelOf(location: LocationDetails): string {
  const named = location.location_name?.trim();
  if (named) return named;
  return [location.city, location.state, location.country].map((part) => part?.trim()).filter(Boolean).join(', ');
}

/** The chart's birth location (`birth_data.birth_location_details`) as a trip place, or undefined if the store would refuse it. */
export function birthPlaceOf(location: LocationDetails | undefined): TripPlace | undefined {
  if (!location) return undefined;
  const label = labelOf(location);
  if (label === '' || label.length > MAX_LABEL || !isZone(location.timezone)) return undefined;
  if (!inRange(location.latitude, 90) || !inRange(location.longitude, 180)) return undefined;
  return { label, timezone: location.timezone, latitude: location.latitude, longitude: location.longitude };
}
