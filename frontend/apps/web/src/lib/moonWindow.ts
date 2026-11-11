/**
 * Inputs for the engine's moon window (spec 2026-10-08 Part 2). Calendar and
 * zone arithmetic only: a place's local midnights, local civil noons and a local
 * time of day become UTC instants here, so the Python engine needs no tz database
 * (plan Ruling 9). Coordinates go to the on-device worker only; nothing here is
 * model-facing.
 */
import type {
  DayPanchangMark,
  MoonWindow,
  MoonWindowDayInput,
  MoonWindowInput,
  MoonWindowNatalMoonInput,
} from '@almamesh/browser';
import type { ToolContext } from '@almamesh/llm/toolLoop';
import { localTimeToInstant, resolveLocalTime } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { readyEngine } from './periodChart';

export type { DayPanchangMark, MoonWindowNatalMoonInput };

export interface MoonWindowRequest {
  readonly start: string;
  readonly end: string;
  readonly zone: string;
  readonly place?: { readonly latitude: number; readonly longitude: number };
  readonly time?: string;
  readonly days?: readonly string[];
  readonly natalMoon?: MoonWindowNatalMoonInput;
}

export type MoonWindowLoader = (request: MoonWindowRequest, context: ToolContext) => Promise<MoonWindow>;

const MAX_DAILY_DAYS = 15;

export function nextCivilDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function civilDaysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let cur = start; cur <= end && days.length < MAX_DAILY_DAYS; cur = nextCivilDay(cur)) {
    days.push(cur);
  }
  return days;
}

/** The first instant of `day` at `zone`: local 00:00, or 01:00 when midnight was skipped. */
function firstInstant(day: string, zone: string): string {
  for (const time of ['00:00', '01:00']) {
    const resolved = resolveLocalTime(day, time, zone);
    if (resolved.kind === 'unique') return resolved.instant.utc;
    if (resolved.kind === 'ambiguous') return resolved.earlier.utc;
  }
  throw new RangeError(`no start of day for ${day} in ${zone}`);
}

/** Civil noon instant at `zone` for daily Panchang / Moon / Tarabala sampling. */
function noonInstant(day: string, zone: string): string {
  for (const time of ['12:00', '13:00']) {
    const resolved = resolveLocalTime(day, time, zone);
    if (resolved.kind === 'unique') return resolved.instant.utc;
    if (resolved.kind === 'ambiguous') return resolved.earlier.utc;
  }
  return `${day}T12:00:00.000Z`;
}

function localWeekday(day: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

export function localPeriodBounds(
  start: string,
  end: string,
  zone: string,
): { readonly startUtc: string; readonly endUtc: string } {
  return { startUtc: firstInstant(start, zone), endUtc: firstInstant(nextCivilDay(end), zone) };
}

export function eventInstantUtc(day: string, time: string, zone: string): string {
  return localTimeToInstant(day, time, zone).utc;
}

export function moonWindowInput(request: MoonWindowRequest): MoonWindowInput {
  const { startUtc, endUtc } = localPeriodBounds(request.start, request.end, request.zone);
  const days: readonly MoonWindowDayInput[] | undefined =
    request.days && request.days.length > 0
      ? request.days.map((date) => ({
          date,
          datetimeUtc: noonInstant(date, request.zone),
          vara: localWeekday(date),
        }))
      : undefined;
  const base: MoonWindowInput = {
    placeStartUtc: startUtc,
    placeEndUtc: endUtc,
    ...(days ? { days } : {}),
    ...(request.natalMoon ? { natalMoon: request.natalMoon } : {}),
  };
  if (!request.time || !request.place) return base;
  const datetimeUtc = eventInstantUtc(request.start, request.time, request.zone);
  return { ...base, event: { datetimeUtc, ...request.place } };
}

export function createMoonWindowLoader(
  engine: ChartEngineContextValue | null,
  natalMoon?: MoonWindowNatalMoonInput,
): MoonWindowLoader {
  return async (request, context) => {
    const enriched: MoonWindowRequest = natalMoon
      ? {
          ...request,
          days: request.days ?? civilDaysBetween(request.start, request.end),
          natalMoon: request.natalMoon ?? natalMoon,
        }
      : request;
    const input = moonWindowInput(enriched);
    const runtime = await readyEngine(engine);
    // A read cancelled (turn stopped or its deadline passed) while the engine booted never starts.
    context.signal.throwIfAborted();
    return runtime.computeMoonWindow(input);
  };
}
