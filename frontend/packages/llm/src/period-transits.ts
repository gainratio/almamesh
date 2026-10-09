// Transits for a period (spec 2026-10-08, "What each section returns").
// The engine runs once at the period's first day; this keeps what belongs to
// the period. Selection by name and by engine date only, no astrology.
import type { TransitContext } from "@almamesh/browser/types";

import type { PeriodRange } from "./sanitize";

/** Kept in multi-day results. Sun, Moon, Mercury and Venus move too fast for a period. */
export const SLOW_GRAHAS: readonly string[] = ["mars", "jupiter", "saturn", "rahu", "ketu"];

/**
 * The dated event kinds the engine timeline really checks until Inc B
 * (`_SLOW_GRAHAS` in transits/timeline.py is Jupiter and Saturn). The model
 * must not read "no Mars ingress" when Mars was never checked.
 */
export const COVERED_EVENTS = ["jupiter_ingress", "saturn_ingress", "dasha_change", "sade_sati_phase"] as const;

export interface RestrictedTransits {
  readonly context: TransitContext;
  readonly notes: readonly string[];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function inPeriod(iso: string, period: PeriodRange): boolean {
  return day(iso) >= period.start && day(iso) <= period.end;
}

export function timelineCutoffNote(windowEnd: string): string {
  return `Transit events are listed only up to ${windowEnd.slice(0, 7)}. Ask about a later start for the rest.`;
}

/**
 * The engine places every graha once, at the period's first day. Over a month
 * Mars can change sign, so a multi-day result says when its placements hold.
 */
export function placementsAsOfNote(start: string): string {
  return `Planet signs and houses are as of ${start}, the period's first day. Mars can change sign during the period, so do not say it stayed in one sign throughout.`;
}

export function restrictTransitsToPeriod(
  ctx: TransitContext,
  period: PeriodRange,
  multiDay: boolean,
): RestrictedTransits {
  const placements = multiDay
    ? Object.fromEntries(
        Object.entries(ctx.gochara.placements).filter(([, placement]) =>
          SLOW_GRAHAS.includes(placement.graha.toLowerCase()),
        ),
      )
    : ctx.gochara.placements;
  const asOf = multiDay ? [placementsAsOfNote(period.start)] : [];
  const cutoff = day(ctx.timeline.window_end) < period.end ? [timelineCutoffNote(ctx.timeline.window_end)] : [];
  const notes = [...asOf, ...cutoff];
  return {
    context: {
      ...ctx,
      gochara: { ...ctx.gochara, placements },
      slow_hits: ctx.slow_hits.filter((hit) => inPeriod(hit.exact, period)),
      timeline: { ...ctx.timeline, events: ctx.timeline.events.filter((event) => inPeriod(event.date, period)) },
    },
    notes,
  };
}
