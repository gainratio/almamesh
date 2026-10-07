/**
 * One analysis instant: the prompt reads the chart's own stored instant.
 *
 * The engine pins the "current" dasha to the chart's `reference_date`. The
 * prompt used to re-decide "current" from the wall clock, so five years after a
 * chart was computed the AI was told a different maha than the screen showed.
 * Here the clock is moved five years past the chart's instant and the prompt
 * must still name the engine's maha, "as of" the chart's own date. "Today" is
 * still available, but only as an explicit, labelled basis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";
import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import {
  chartAnalysisInstant,
  sanitizeChartForLlm,
  todayAnalysisInstant,
} from "../sanitize";
import { buildChartFactsBlock } from "../facts";
import { buildInterpretationMessages } from "../prompt";

// Bengaluru 1988: Jupiter maha at the chart's instant (2025-01-01), Saturn by 2030.
const chart = (golden as Record<string, SiderealChart>)["1988-08-08T01:14:00+00:00"]!;
const R = chart.snapshot!.reference_date;
const FIVE_YEARS_LATER = new Date("2030-01-01T12:00:00Z");

function localIsoDate(instant: string): string {
  const d = new Date(instant);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

beforeEach(() => {
  vi.useFakeTimers({ now: FIVE_YEARS_LATER, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("chartAnalysisInstant", () => {
  it("is the instant recorded in the chart's snapshot", () => {
    expect(chartAnalysisInstant(chart)).toEqual({ basis: "chart", instant: new Date(R) });
  });

  it("uses the stored calculation instant for a chart that predates snapshots", () => {
    const { snapshot: _none, ...legacy } = chart;

    expect(chartAnalysisInstant(legacy, "2024-06-01T10:00:00.000Z").instant).toEqual(
      new Date("2024-06-01T10:00:00.000Z"),
    );
  });

  it("refuses to guess an instant when the chart records none", () => {
    const { snapshot: _none, ...legacy } = chart;

    expect(() => chartAnalysisInstant(legacy)).toThrow(/analysis instant/);
  });
});

describe("the prompt, five years after the chart was computed", () => {
  it("marks the engine's current maha as current, not the wall clock's", () => {
    const sanitized = sanitizeChartForLlm(chart, chartAnalysisInstant(chart));

    const current = sanitized.dashas!.maha_dasha_sequence.filter((row) =>
      "status" in row && String(row.status).startsWith("current"),
    );
    expect(current.map((row) => row.lord)).toEqual(["jupiter"]);
    expect(sanitized.dashas!.current_maha!.lord).toBe("jupiter");
  });

  it("names the chart's own as-of date in the facts block and the reading JSON", () => {
    const sanitized = sanitizeChartForLlm(chart, chartAnalysisInstant(chart));

    expect(sanitized.as_of).toEqual({ date: localIsoDate(R), basis: "chart" });
    expect(buildChartFactsBlock(sanitized)).toContain(
      `Current dasha period (as of ${localIsoDate(R)}, the chart's analysis date):`,
    );
    const prompt = buildInterpretationMessages(sanitized, "layman", "en")
      .map((m) => m.content)
      .join("\n");
    expect(prompt).toContain(`"date": "${localIsoDate(R)}"`);
    expect(prompt).not.toContain("2030-01-01");
  });

  it("labels 'today' explicitly when a caller genuinely asks about today", () => {
    const sanitized = sanitizeChartForLlm(chart, todayAnalysisInstant(new Date()));

    expect(sanitized.as_of).toEqual({ date: "2030-01-01", basis: "today" });
    expect(buildChartFactsBlock(sanitized)).toContain("(as of 2030-01-01, today)");
  });
});
