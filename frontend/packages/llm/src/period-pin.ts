// Time travel (spec 2026-10-08, Part 3; trip threads 2026-10-13): a thread pinned
// to a period and a place. Pure calendar comparison on YYYY-MM-DD strings; no
// astrology lives here. The brief names the trip and the tools that ground it;
// it never carries pre-computed facts.
import type { PeriodRange } from "./sanitize";

export type PinRelative = "past" | "future" | "contains_today";

/**
 * Where the trip's tools read the sky: a label and a zone, for every trip (the
 * AI must know where the trip is). Never coordinates, and never a marker saying
 * the place is the birth place.
 */
export interface PinnedPlace {
  readonly label: string;
  readonly timezone: string;
}

export interface PinnedPrompt extends PeriodRange {
  readonly relative: PinRelative;
  readonly granularity?: "day" | "month" | "year";
  /** The period in the UI language, e.g. "May 2019". */
  readonly label?: string;
  readonly place?: PinnedPlace;
}

/** Where today falls against the pin. Today on either edge is inside it. */
export function pinRelative(period: PeriodRange, today: string): PinRelative {
  if (today < period.start) return "future";
  if (today > period.end) return "past";
  return "contains_today";
}

const TENSE: Readonly<Record<PinRelative, string>> = {
  past: "Use the past tense: this period is over.",
  future: "Use the future tense: this period has not started yet.",
  contains_today: "Use the present tense: today is inside this period.",
};

const TENSE_WORD: Readonly<Record<PinRelative, string>> = { past: "past", future: "future", contains_today: "present" };

/** The period reading (spec 2026-10-13): dashas to pratyantar, lords, sky, themes, for a bound period and place. */
export const PERIOD_READING_TOOL_NAME = "get_period_reading";
/** The reading's drill-down: one lord, segment, bindu row, the panchang or every dasha span. */
export const PERIOD_DETAIL_TOOL_NAME = "get_period_detail";

/**
 * The tools a trip must call before it answers (chatToolset.ts). The reading
 * carries the period and the place, so get_trip_context and get_timing stay
 * registered but are no longer required.
 */
export const TRIP_GROUNDING_TOOLS = [PERIOD_READING_TOOL_NAME, "get_natal_summary"] as const;

function tripLine(pin: PinnedPrompt): string | undefined {
  if (!pin.granularity || !pin.label) return undefined;
  const trip = `TIME-TRAVEL TRIP: this thread is a time-travel trip to ${pin.label} (${pin.granularity}, ${TENSE_WORD[pin.relative]})`;
  if (!pin.place) return `${trip}.`;
  return `${trip}, when the user lived in ${pin.place.label} (${pin.place.timezone}).`;
}

export function pinnedPeriodRules(pin: PinnedPrompt): string {
  const trip = tripLine(pin);
  return [
    `PINNED PERIOD: this conversation is about ${pin.start} to ${pin.end} (relative: ${pin.relative}).`,
    ...(trip
      ? [
          trip,
          `Before interpreting, call ${TRIP_GROUNDING_TOOLS.join(" and ")}: with no arguments they read this trip's period and place.`,
          `For another month, now or earlier, send ${PERIOD_READING_TOOL_NAME} month "YYYY-MM".`,
          `Use ${PERIOD_DETAIL_TOOL_NAME} to look closer at one lord, segment, bindu row or the panchang.`,
          "Interpret for that place and time.",
        ]
      : []),
    "get_timing without dates reads this period; for another, send its start and end.",
    TENSE[pin.relative],
    "To compare with now, call get_timing with the first and last day of the current month.",
  ].join("\n");
}
