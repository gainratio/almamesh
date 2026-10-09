import { describe, expect, it } from "vitest";

import { buildChartFactsBlock, formatPeriodLabel } from "../facts";
import { buildChatMessages } from "../prompt";
import { periodAnalysisInstant, sanitizeChartForLlm } from "../sanitize";
import { BIRTH_2000_CHART } from "./birth-2000-fixture";
import {
  DOMAINS_CTX_FIXTURE,
  STRENGTH_CTX_FIXTURE,
  TRANSIT_CTX_FIXTURE,
} from "./predictive-fixture";
import type { SiderealChart } from "@almamesh/browser/types";

describe("formatPeriodLabel", () => {
  it.each([
    ["2026-06-01", "2026-06-30", "1–30 June 2026"],
    ["2019-01-01", "2019-12-31", "1 January–31 December 2019"],
    ["2026-06-15", "2026-06-15", "15 June 2026"],
    ["2019-11-01", "2020-02-29", "1 November 2019–29 February 2020"],
  ])("%s..%s reads as %s", (start, end, label) => {
    expect(formatPeriodLabel(start, end)).toBe(label);
  });
});

describe("the facts block under a period basis", () => {
  const block = buildChartFactsBlock(
    sanitizeChartForLlm(BIRTH_2000_CHART, periodAnalysisInstant("2026-06-01", "2026-06-30")),
  );

  it("names the period asked about instead of 'today'", () => {
    expect(block).toContain("as of 1–30 June 2026 (the period asked about)");
    expect(block).not.toContain(", today)");
    expect(block).not.toContain("analysis date");
  });

  it("omits the chart's current maha/antar/pratyantar rows, which describe today", () => {
    expect(block).not.toContain("2022-01 -> 2023-09");
    expect(block).not.toMatch(/- (Mahadasha|Antardasha|Pratyantardasha):/);
    expect(block).not.toContain("Current period (engine-dated)");
  });

  it("omits the upcoming rows derived from today's current rows", () => {
    expect(block).not.toMatch(/Remaining antardashas|Remaining pratyantardashas|Next mahadasha/);
  });
});

describe("a period basis never carries today's predictive sky", () => {
  const withToday = {
    ...BIRTH_2000_CHART,
    transit_context: TRANSIT_CTX_FIXTURE,
    strength_context: STRENGTH_CTX_FIXTURE,
    domains_context: DOMAINS_CTX_FIXTURE,
  } as unknown as SiderealChart;
  const period = buildChartFactsBlock(
    sanitizeChartForLlm(withToday, periodAnalysisInstant("2026-06-01", "2026-06-30")),
  );
  const today = buildChartFactsBlock(
    sanitizeChartForLlm(withToday, { basis: "today", instant: new Date("2030-01-01T00:00:00Z") }),
  );

  it("omits current transits and predictive windows under a period basis", () => {
    expect(period).not.toContain("Current transits");
    expect(period).not.toContain("Upcoming transit windows");
    expect(period).not.toContain("ENGINE PREDICTIVE");
  });

  it("keeps the predictive block for a today basis", () => {
    expect(today).toContain("Current transits");
  });
});

describe("the chat system prompt", () => {
  it("requires the answer to name the period it looked at", () => {
    const [system] = buildChatMessages(
      sanitizeChartForLlm(BIRTH_2000_CHART, { basis: "chart", instant: new Date("2022-06-01T00:00:00Z") }),
      "How was June 2019?",
    );
    expect(system.content).toContain("I looked at 1–30 June 2026.");
    expect(system.content).toContain("available: false");
  });
});
