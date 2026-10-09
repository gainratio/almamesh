// Time travel Inc D (spec 2026-10-08, Part 3): a thread pinned to a period.
// Pure calendar comparison on YYYY-MM-DD strings; no astrology lives here.
import type { PeriodRange } from "./sanitize";

export type PinRelative = "past" | "future" | "contains_today";

export interface PinnedPrompt extends PeriodRange {
  readonly relative: PinRelative;
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

export function pinnedPeriodRules(pin: PinnedPrompt): string {
  return [
    `PINNED PERIOD: this conversation is about ${pin.start} to ${pin.end} (relative: ${pin.relative}).`,
    "get_timing called without dates reads this period. Answer about it unless the user asks about another one.",
    TENSE[pin.relative],
    "To compare with now, call get_timing with the first and last day of the current month.",
  ].join("\n");
}
