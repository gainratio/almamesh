// Time travel (spec 2026-10-08, Part 3; trip threads 2026-10-13): a thread pinned
// to a period and a place. Pure calendar comparison on YYYY-MM-DD strings; no
// astrology lives here. The brief names the period and its tense; it never
// carries pre-computed facts and never names a tool.
import type { PeriodRange } from "./sanitize";

export type PinRelative = "past" | "future" | "contains_today";

export interface PinnedPrompt extends PeriodRange {
  readonly relative: PinRelative;
  readonly granularity?: "day" | "month" | "year";
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

/** The pinned period and its tense. The trip's label and place ride in the THIS THREAD line (prompt.ts). */
export function pinnedPeriodRules(pin: PinnedPrompt): string {
  return [
    `PINNED PERIOD: this conversation is about ${pin.start} to ${pin.end} (relative: ${pin.relative}).`,
    TENSE[pin.relative],
  ].join("\n");
}
