// Time travel Inc C (spec 2026-10-08 Part 2): places, times of day and split
// periods on the timing tool. Pure argument checks on strings; no astrology.
import { parsePeriodArgs, periodEcho, type PeriodArgs } from "./period";
import type { PeriodRange } from "./sanitize";

export const PLACE_REF_ARG_PATTERN = "^city:\\d{1,6}$";
const PLACE_REF = new RegExp(PLACE_REF_ARG_PATTERN);
export const TIME_OF_DAY_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";
const TIME_OF_DAY = new RegExp(TIME_OF_DAY_PATTERN);
export const MAX_SEGMENTS = 4;

export const SEGMENTS_WITH_DATES_ERROR = "send either start/end or segments, not both";
export const SEGMENTS_SHAPE_ERROR = `segments must be 1–${MAX_SEGMENTS} items of { start, end, place_ref? }`;
export const SEGMENTS_ORDER_ERROR = "segments must be in date order and must not overlap";
export const PLACE_REF_ERROR = "unknown place_ref: call resolve_place first";
export const TIME_FORMAT_ERROR = "time must be HH:MM, 24-hour, like 15:00";
export const TIME_NEEDS_DAY_ERROR = "a time of day needs a single day: send start only, or one one-day segment";
export const TIME_NEEDS_PLACE_ERROR = "a time of day needs a place: ask where, call resolve_place, then pass place_ref";
export const PLACE_CONFLICT_ERROR = "place_ref disagrees with the segment's place_ref for that day";
export const SEGMENTS_WITH_PLACE_ERROR = "with segments, put each place on its segment; a top-level place_ref is only for a single day";
export const SEGMENT_GAP_NOTE = "The places you gave leave some days uncovered; the reading still spans the whole period.";

export interface TimingSegment {
  readonly start: string;
  readonly end: string;
  readonly place_ref?: string;
}

export type TimingArgs =
  | { readonly kind: "today" }
  | {
      readonly kind: "period";
      readonly period: PeriodRange;
      readonly placeRef?: string;
      readonly time?: string;
      readonly segments?: readonly TimingSegment[];
    }
  | { readonly kind: "invalid"; readonly error: string };

type Parsed<T> = T | { readonly error: string };
const invalid = (error: string): TimingArgs => ({ kind: "invalid", error });
const failed = <T>(value: Parsed<T>): value is { readonly error: string } =>
  typeof value === "object" && value !== null && "error" in value;

function placeRefArg(value: unknown): Parsed<string | undefined> {
  if (value === undefined) return undefined;
  return typeof value === "string" && PLACE_REF.test(value) ? value : { error: PLACE_REF_ERROR };
}

function segmentArg(value: unknown): Parsed<TimingSegment> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: SEGMENTS_SHAPE_ERROR };
  const raw = value as Readonly<Record<string, unknown>>;
  if (raw.start === undefined || raw.end === undefined) return { error: SEGMENTS_SHAPE_ERROR };
  const dates = parsePeriodArgs(raw);
  if (dates.kind !== "period") return { error: dates.kind === "invalid" ? dates.error : SEGMENTS_SHAPE_ERROR };
  const placeRef = placeRefArg(raw.place_ref);
  if (failed(placeRef)) return placeRef;
  return { ...dates.period, ...(placeRef ? { place_ref: placeRef } : {}) };
}

function segmentsArg(value: unknown): Parsed<readonly TimingSegment[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEGMENTS) return { error: SEGMENTS_SHAPE_ERROR };
  const segments: TimingSegment[] = [];
  for (const item of value) {
    const segment = segmentArg(item);
    if (failed(segment)) return segment;
    const previous = segments[segments.length - 1];
    if (previous && segment.start <= previous.end) return { error: SEGMENTS_ORDER_ERROR };
    segments.push(segment);
  }
  return segments;
}

function datesFrom(args: Readonly<Record<string, unknown>>): Parsed<{ dates: PeriodArgs; segments?: readonly TimingSegment[] }> {
  if (args.segments === undefined) return { dates: parsePeriodArgs(args) };
  if (args.start !== undefined || args.end !== undefined) return { error: SEGMENTS_WITH_DATES_ERROR };
  const segments = segmentsArg(args.segments);
  if (failed(segments)) return segments;
  const first = segments[0] as TimingSegment;
  const last = segments[segments.length - 1] as TimingSegment;
  return { dates: { kind: "period", period: { start: first.start, end: last.end } }, segments };
}

function dayPlace(period: PeriodRange, segments: readonly TimingSegment[] | undefined, placeRef: string | undefined): Parsed<string | undefined> {
  if (segments && placeRef && period.start !== period.end) return { error: SEGMENTS_WITH_PLACE_ERROR };
  const fromSegment = period.start === period.end ? segments?.[0]?.place_ref : undefined;
  if (placeRef && fromSegment && placeRef !== fromSegment) return { error: PLACE_CONFLICT_ERROR };
  return placeRef ?? fromSegment;
}

/** A single-day segment takes the top-level place, so `needsPlace` can read the segments alone. */
function withDayPlace(segments: readonly TimingSegment[] | undefined, place: string | undefined): readonly TimingSegment[] | undefined {
  const only = segments?.length === 1 ? segments[0] : undefined;
  if (!only || !place || only.place_ref) return segments;
  return [{ ...only, place_ref: place }];
}

function timeArg(value: unknown, period: PeriodRange | undefined, place: string | undefined): Parsed<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TIME_OF_DAY.test(value)) return { error: TIME_FORMAT_ERROR };
  if (!period || period.start !== period.end) return { error: TIME_NEEDS_DAY_ERROR };
  return place ? value : { error: TIME_NEEDS_PLACE_ERROR };
}

/** Read get_timing's arguments: dates or segments, plus an optional place_ref and time. */
export function parseTimingArgs(args: Readonly<Record<string, unknown>>): TimingArgs {
  const read = datesFrom(args);
  if (failed(read)) return invalid(read.error);
  if (read.dates.kind === "invalid") return invalid(read.dates.error);
  const placeArg = placeRefArg(args.place_ref);
  if (failed(placeArg)) return invalid(placeArg.error);
  const period = read.dates.kind === "period" ? read.dates.period : undefined;
  const place = period ? dayPlace(period, read.segments, placeArg) : placeArg;
  if (failed(place)) return invalid(place.error);
  const time = timeArg(args.time, period, place);
  if (failed(time)) return invalid(time.error);
  if (!period) return { kind: "today" };
  const segments = withDayPlace(read.segments, place);
  return { kind: "period", period, ...(segments ? { segments } : {}), ...(place ? { placeRef: place } : {}), ...(time ? { time } : {}) };
}

export const NEEDS_PLACE_ERROR = "needs_place";
/** Under this many days a sky reading is day precision and needs a place; 7+ (a week or longer) never does. */
export const PLACE_NEEDED_BELOW_DAYS = 7;

export function needsPlace(
  period: PeriodRange,
  places: { readonly placeRef?: string; readonly segments?: readonly TimingSegment[] },
): boolean {
  if (periodEcho(period, "period").days >= PLACE_NEEDED_BELOW_DAYS) return false;
  if (!places.segments?.length) return !places.placeRef;
  return !places.segments.every((segment) => segment.place_ref);
}
