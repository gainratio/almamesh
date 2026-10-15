import { describe, expect, it } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";
import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { buildChatMessages, PRIVACY_RULE } from "../prompt";
import { buildSectionMessages } from "../structured-interpretation";
import { sanitizeChartForLlm, todayAnalysisInstant } from "../sanitize";

const chart = (golden as Record<string, SiderealChart>)["1988-08-08T01:14:00+00:00"] as SiderealChart;

const systemFor = (places: boolean): string =>
  buildChatMessages(
    sanitizeChartForLlm(chart, todayAnalysisInstant(new Date("2026-06-20T00:00:00Z"))),
    "hi",
    "layman",
    [],
    [],
    undefined,
    "en",
    undefined,
    undefined,
    undefined,
    places,
  )[0]?.content ?? "";

describe("the narrowed privacy rule", () => {
  it("forbids the birth place and coordinates, and allows places the user typed", () => {
    expect(PRIVACY_RULE).toBe(
      "PRIVACY: never name, guess or echo the birth place (city/state/country) and never output coordinates of any place. " +
        "Refer to it generically as 'birth location'. You may repeat a place the user typed in this conversation.",
    );
  });
});

// Contract reversed 2026-10-14 (chat tool layer redesign): PLACE_RULES told the model to turn
// needs_place into a question and to call resolve_place before get_timing with its place_ref. Places
// are now a plain city name on read_period/travel, resolved on the device (a picker on ambiguity),
// and a needs_place result carries its own "ask". No tier carries place-routing rules any more.
describe("no place-routing rules in any tier", () => {
  it.each([false, true])("places=%s carries no resolve_place, place_ref or needs_place text", (places) => {
    for (const phrase of ["needs_place", "resolve_place", "place_ref", "Where were you", "PLACES:"]) {
      expect(systemFor(places)).not.toContain(phrase);
    }
  });

  it("both tiers carry the narrowed privacy rule", () => {
    expect(systemFor(true)).toContain(PRIVACY_RULE);
    expect(systemFor(false)).toContain(PRIVACY_RULE);
  });

  it.each([false, true])("the structured prompt (lite=%s) shares PRIVACY_RULE, not its own sentence", (lite) => {
    const sanitized = sanitizeChartForLlm(chart, todayAnalysisInstant(new Date("2026-06-20T00:00:00Z")));
    const content = buildSectionMessages("core", sanitized, "layman", lite)[0]?.content ?? "";
    expect(content).toContain(PRIVACY_RULE);
    expect(content).not.toContain("never mention any city/state/country name");
  });
});
