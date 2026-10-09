import { describe, expect, it } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";
import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { buildChatMessages, PRIVACY_RULE } from "../prompt";
import { sanitizeChartForLlm, todayAnalysisInstant } from "../sanitize";

const chart = (golden as Record<string, SiderealChart>)["1988-08-08T01:14:00+00:00"] as SiderealChart;

const system = (): string =>
  buildChatMessages(
    sanitizeChartForLlm(chart, todayAnalysisInstant(new Date("2026-06-20T00:00:00Z"))),
    "hi",
  )[0]?.content ?? "";

describe("the narrowed privacy rule", () => {
  it("forbids the birth place and coordinates, and allows places the user typed", () => {
    expect(PRIVACY_RULE).toBe(
      "PRIVACY: never name, guess or echo the birth place (city/state/country) and never output coordinates of any place. " +
        "Refer to it generically as 'birth location'. You may repeat a place the user typed in this conversation.",
    );
  });
});

describe("chat prompt place rules", () => {
  it("turns needs_place into one question and never assumes a place", () => {
    expect(system()).toContain('{ "error": "needs_place" }');
    expect(system()).toContain("Where were you (or will you be) that day?");
    expect(system()).toContain("Never assume a place");
  });

  it("resolves a place the user already named FIRST, then calls get_timing (P4)", () => {
    expect(system()).toContain("call resolve_place first,\nthen get_timing with its place_ref");
  });

  it("never asks for a week or longer, and tells the model not to resolve places for it (P9)", () => {
    expect(system()).toContain("A week or longer never needs a place");
    expect(system()).toContain("don't resolve places for it");
  });
});
