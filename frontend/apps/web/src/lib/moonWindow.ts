/**
 * Inputs for the engine's moon window (spec 2026-10-08 Part 2). Calendar and
 * zone arithmetic only: a place's local midnights and a local time of day become
 * UTC instants here, so the Python engine needs no tz database (plan Ruling 9).
 * Coordinates go to the on-device worker only; nothing here is model-facing.
 */
import type { MoonWindow, MoonWindowInput } from '@almamesh/browser';
import type { AgentToolContext } from '@almamesh/llm';
import { localTimeToInstant, resolveLocalTime } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { readyEngine } from './periodChart';

export interface MoonWindowRequest {
  readonly start: string;
  readonly end: string;
  readonly zone: string;
  readonly place: { readonly latitude: number; readonly longitude: number };
  readonly time?: string;
}

export type MoonWindowLoader = (request: MoonWindowRequest, context: AgentToolContext) => Promise<MoonWindow>;

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
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

export function localPeriodBounds(
  start: string,
  end: string,
  zone: string,
): { readonly startUtc: string; readonly endUtc: string } {
  return { startUtc: firstInstant(start, zone), endUtc: firstInstant(nextDay(end), zone) };
}

export function eventInstantUtc(day: string, time: string, zone: string): string {
  return localTimeToInstant(day, time, zone).utc;
}

export function moonWindowInput(request: MoonWindowRequest): MoonWindowInput {
  const { startUtc, endUtc } = localPeriodBounds(request.start, request.end, request.zone);
  const base = { placeStartUtc: startUtc, placeEndUtc: endUtc };
  if (!request.time) return base;
  const datetimeUtc = eventInstantUtc(request.start, request.time, request.zone);
  return { ...base, event: { datetimeUtc, ...request.place } };
}

export function createMoonWindowLoader(engine: ChartEngineContextValue | null): MoonWindowLoader {
  return async (request, context) => {
    const input = moonWindowInput(request);
    const runtime = await readyEngine(engine);
    // A read cancelled (turn stopped or its deadline passed) while the engine booted never starts.
    context.signal.throwIfAborted();
    return runtime.computeMoonWindow(input);
  };
}
