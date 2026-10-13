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

/** The tools a trip thread registers to ground itself (chatToolset.ts / chatToolkit.ts). */
export const TRIP_GROUNDING_TOOLS = ["get_natal_summary", "get_trip_context", "get_timing"] as const;

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
          `Before interpreting, use ${TRIP_GROUNDING_TOOLS.join(", ")} (sections dashas, transits, strength, domains); they already read this trip's period and place, so call them without dates or a place.`,
          "Interpret for that place and time.",
        ]
      : []),
    "get_timing called without dates reads this period. Answer about it unless the user asks about another one.",
    TENSE[pin.relative],
    "To compare with now, call get_timing with the first and last day of the current month.",
  ].join("\n");
}
