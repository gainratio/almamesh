/**
 * Places on `get_timing` (spec 2026-10-08 Part 2). A place_ref is re-read
 * offline; its coordinates go only to the on-device Moon loader. What the model
 * sees is the label and zone the user already saw, plus Moon signs and an event
 * lagna sign: never a latitude, a longitude or a number derived from them.
 */
import type { MoonEnds, MoonMark, MoonWindow } from '@almamesh/browser';
import { periodEcho, SEGMENT_GAP_NOTE, type AgentToolContext, type PeriodRange, type TimingSegment } from '@almamesh/llm';
import { LocalTimeError } from '@almamesh/store';

import type { ResolvedPlace } from './geo/placeLookup';
import { eventInstantUtc, type MoonWindowLoader } from './moonWindow';

export const PLACE_DOES_NOT_CHANGE_NOTE =
  "Place doesn't change readings for periods of a week or longer: dashas come from the birth chart and slow-planet positions are the same from anywhere on Earth.";
export const PLACE_MOON_UNAVAILABLE_NOTE = "Couldn't read the Moon at that place on this device; the rest of the answer stands.";
/** Adjacent segments' echo spans 2 days (end, next start); more leaves a day uncovered. */
const ADJACENT_SPAN_DAYS = 2;

/**
 * How long all of one call's Moon reads may take. The tool has 150 s
 * (TIMING_TOOL_TIMEOUT_MS) and the period sky before it up to 140 s
 * (PERIOD_SKY_TIMEOUT_MS), so 8 s keeps a hung Moon read from losing the sky
 * answer at the tool timeout. One read is a few positions on a warm engine.
 */
export const PLACE_MOON_DEADLINE_MS = 8_000;

export type PlaceReader = (ref: string) => Promise<ResolvedPlace | undefined>;

/** The place arguments of one period call (parseTimingArgs). */
export interface PlaceRequest {
  readonly placeRef?: string;
  readonly time?: string;
  readonly segments?: readonly TimingSegment[];
}

export interface PlaceRow {
  readonly start: string;
  readonly end: string;
  readonly label: string;
  readonly timezone: string;
  readonly moon?: MoonEnds;
}

export interface PlaceEvent {
  readonly local_time: string;
  readonly lagna_sign: string;
  readonly moon: MoonMark;
}

/** The fields a timing result carries that the place step adds to. */
export interface PlacedResult {
  readonly notes: readonly string[];
  readonly places?: readonly PlaceRow[];
  readonly event?: PlaceEvent;
}

interface PlacedSpan {
  readonly start: string;
  readonly end: string;
  readonly place: ResolvedPlace;
}

/** The spans to read: the single place_ref over the whole period, or each placed segment. */
export async function placedSpans(
  read: PlaceReader | undefined,
  period: PeriodRange,
  places: PlaceRequest,
): Promise<readonly PlacedSpan[] | 'unknown'> {
  const wanted = places.segments ?? (places.placeRef ? [{ ...period, place_ref: places.placeRef }] : []);
  const spans: PlacedSpan[] = [];
  for (const segment of wanted) {
    if (!segment.place_ref) continue;
    const place = await read?.(segment.place_ref);
    if (!place) return 'unknown';
    spans.push({ start: segment.start, end: segment.end, place });
  }
  return spans;
}

/** A time of day that never happened (or happened twice) at the place, as the tool error to return. */
export function impossibleTime(spans: readonly PlacedSpan[], time: string | undefined): string | undefined {
  const first = spans[0];
  if (!time || !first) return undefined;
  try {
    eventInstantUtc(first.start, time, first.place.summary.timezone);
    return undefined;
  } catch (error) {
    if (error instanceof LocalTimeError) return error.message;
    throw error;
  }
}

function labelRow(span: PlacedSpan): PlaceRow {
  return { start: span.start, end: span.end, label: span.place.summary.label, timezone: span.place.summary.timezone };
}

function hasGap(segments: readonly TimingSegment[] | undefined): boolean {
  return (segments ?? []).some((segment, i) => {
    const previous = segments?.[i - 1];
    return previous !== undefined && periodEcho({ start: previous.end, end: segment.start }, 'period').days > ADJACENT_SPAN_DAYS;
  });
}

/** A week or longer: echo the places, say place doesn't change the reading, note any gap. */
export function longPlaces<T extends PlacedResult>(
  result: T,
  spans: readonly PlacedSpan[],
  places: PlaceRequest,
): T {
  if (spans.length === 0 && !places.segments) return result;
  const notes = [...result.notes, PLACE_DOES_NOT_CHANGE_NOTE, ...(hasGap(places.segments) ? [SEGMENT_GAP_NOTE] : [])];
  return { ...result, places: spans.map(labelRow), notes };
}

const moonMark = (mark: MoonMark): MoonMark => ({
  sign: mark.sign,
  nakshatra: mark.nakshatra,
  tithi: mark.tithi,
  paksha: mark.paksha,
});

async function readWindows(
  load: MoonWindowLoader,
  spans: readonly PlacedSpan[],
  time: string | undefined,
  context: AgentToolContext,
): Promise<MoonWindow[]> {
  const windows: MoonWindow[] = [];
  for (const { start, end, place } of spans) {
    const { latitude, longitude } = place;
    const request = { start, end, zone: place.summary.timezone, place: { latitude, longitude } };
    windows.push(await load(time ? { ...request, time } : request, context));
  }
  return windows;
}

/** Run `work` with a signal that aborts on the turn's cancellation or after PLACE_MOON_DEADLINE_MS. */
async function withDeadline<T>(context: AgentToolContext, work: (bounded: AgentToolContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(context.signal.reason);
  context.signal.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('The Moon read passed its deadline.');
      controller.abort(error);
      reject(error);
    }, PLACE_MOON_DEADLINE_MS);
  });
  try {
    return await Promise.race([work({ ...context, signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', cancel);
  }
}

function withMoons<T extends PlacedResult>(
  result: T,
  spans: readonly PlacedSpan[],
  windows: readonly MoonWindow[],
  time: string | undefined,
): T {
  const places = spans.map((span, i) => {
    const ends = (windows[i] as MoonWindow).at_place;
    return { ...labelRow(span), moon: { at_start: moonMark(ends.at_start), at_end: moonMark(ends.at_end) } };
  });
  const event = time ? windows[0]?.event : null;
  if (!time || !event) return { ...result, places };
  return { ...result, places, event: { local_time: time, lagna_sign: event.lagna_sign, moon: moonMark(event.moon) } };
}

/** Under a week: the Moon at each place for its own days, and the event if a time was sent. */
export async function shortPlaces<T extends PlacedResult>(
  load: MoonWindowLoader | undefined,
  result: T,
  spans: readonly PlacedSpan[],
  time: string | undefined,
  context: AgentToolContext,
): Promise<T> {
  const unavailable = { ...result, places: spans.map(labelRow), notes: [...result.notes, PLACE_MOON_UNAVAILABLE_NOTE] };
  if (!load) return unavailable;
  try {
    const windows = await withDeadline(context, (bounded) => readWindows(load, spans, time, bounded));
    return withMoons(result, spans, windows, time);
  } catch (error) {
    // A cancelled turn is not a Moon failure: let the agent see the cancellation.
    if (context.signal.aborted) throw error;
    return unavailable;
  }
}
