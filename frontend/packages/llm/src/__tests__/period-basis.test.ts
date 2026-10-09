import { afterEach, describe, expect, it } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { periodAnalysisInstant, sanitizeChartForLlm } from "../sanitize";
import type { SanitizedDashas } from "../sanitize";
import { BIRTH_2000_CHART } from "./birth-2000-fixture";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  // Assigning undefined would set the string "undefined"; delete instead.
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("periodAnalysisInstant", () => {
  it("is the period's first day at UTC midnight, labelled 'period'", () => {
    expect(periodAnalysisInstant("2026-06-01", "2026-06-30")).toEqual({
      basis: "period",
      instant: new Date("2026-06-01T00:00:00.000Z"),
      period: { start: "2026-06-01", end: "2026-06-30" },
    });
  });

  it.each([
    ["2026-6-1", "2026-06-30"],
    ["2026-06-30", "2026-06-01"],
  ])("refuses a malformed or reversed period %s..%s", (start, end) => {
    expect(() => periodAnalysisInstant(start, end)).toThrow(/period/);
  });
});

describe("sanitizeChartForLlm with a period basis", () => {
  it("stamps as_of with the period, not the runtime's calendar day", () => {
    process.env.TZ = "America/Los_Angeles"; // UTC midnight is the PREVIOUS day here
    const chart = sanitizeChartForLlm(BIRTH_2000_CHART, periodAnalysisInstant("2026-06-01", "2026-06-30"));
    expect(chart.as_of).toEqual({
      date: "2026-06-01",
      basis: "period",
      period_start: "2026-06-01",
      period_end: "2026-06-30",
    });
  });

  it("reports the birth row's start as 'birth', never its month", () => {
    const chart = sanitizeChartForLlm(BIRTH_2000_CHART, periodAnalysisInstant("2000-06-01", "2000-06-30"));
    const serialized = JSON.stringify(chart);
    expect(serialized).not.toContain("2000-03");
    expect(chart.dashas?.maha_dasha_sequence[0]).toMatchObject({ lord: "mercury", start_month: "birth" });
    expect(chart.dashas?.maha_dasha_sequence[0].antar_sequence?.[0]).toMatchObject({
      lord: "mercury",
      start_month: "birth",
    });
  });

  it("leaves chart and today stamps exactly as before", () => {
    const chart = sanitizeChartForLlm(BIRTH_2000_CHART, {
      basis: "chart",
      instant: new Date("2022-06-01T12:00:00.000Z"),
    });
    expect(chart.as_of).toEqual({ date: expect.stringMatching(/^2022-06-0[12]$/), basis: "chart" });
  });
});

// Real engine output (proportional antars), not the synthetic fixture above.
// Today's egress already lets a model derive this native's birth DATE from the
// verbatim planets (Sun longitude + ayanamsa_value), so month-precision dasha
// boundaries add no exposure. What the period basis must still guarantee: no
// boundary finer than a month, and the first maha's start is "birth", never
// the literal birth month.
describe("period output on real engine dashas (born 2019-11-09)", () => {
  const BIRTH_KEY = "2019-11-09T17:45:00+00:00";
  const BIRTH_MONTH = "2019-11";
  const realChart = (golden as Record<string, SiderealChart>)[BIRTH_KEY]!;
  const MONTH_OR_BIRTH = /^(\d{4}-\d{2}|birth)$/;

  function boundaries(dashas: SanitizedDashas): string[] {
    const rows = [
      ...dashas.maha_dasha_sequence,
      ...dashas.maha_dasha_sequence.flatMap((m) => m.antar_sequence ?? []),
      ...(dashas.pratyantar_sequence ?? []),
      dashas.current_maha,
      dashas.current_antar,
      dashas.current_pratyantar,
    ];
    return rows.flatMap((r) => (r ? [r.start_month, r.end_month] : [])).filter((b) => b !== undefined);
  }

  it.each([
    ["2020-06-01", "2020-06-30"],
    ["2021-01-01", "2021-12-31"],
    ["2045-03-01", "2045-03-31"],
  ])("period %s..%s: every dasha boundary is a month or 'birth'", (start, end) => {
    const dashas = sanitizeChartForLlm(realChart, periodAnalysisInstant(start, end)).dashas!;
    const found = boundaries(dashas);
    expect(found.length).toBeGreaterThan(0);
    for (const boundary of found) expect(boundary).toMatch(MONTH_OR_BIRTH);
  });

  it("a period inside the first maha shows its start as 'birth', never 2019-11", () => {
    const dashas = sanitizeChartForLlm(realChart, periodAnalysisInstant("2020-06-01", "2020-06-30")).dashas!;
    expect(dashas.maha_dasha_sequence[0]).toMatchObject({ lord: "mercury", start_month: "birth" });
    expect(dashas.maha_dasha_sequence[0].antar_sequence?.[0]).toMatchObject({ start_month: "birth" });
    expect(dashas.current_maha).toMatchObject({ lord: "mercury", start_month: "birth" });
    expect(boundaries(dashas)).not.toContain(BIRTH_MONTH);
  });
});
