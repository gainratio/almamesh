// The report fixture must be one coherent instant: the running dasha periods
// contain the as-of month, and they are the lords the predictive fusion row
// (computed by the engine at the same instant) says are running.

import { describe, expect, it } from "vitest";

import { reportAsOfMonth } from "../report-sections";
import { REPORT_CHART } from "./report-fixture";

describe("report fixture coherence", () => {
  const asOf = reportAsOfMonth(REPORT_CHART);
  const dashas = REPORT_CHART.dashas;

  it("runs the current maha, antar and pratyantar over the as-of month", () => {
    for (const period of [dashas?.current_maha, dashas?.current_antar, dashas?.current_pratyantar]) {
      expect(period?.start_month).toBeDefined();
      expect(period?.end_month).toBeDefined();
      expect(period?.start_month?.localeCompare(asOf)).toBeLessThanOrEqual(0);
      expect(period?.end_month?.localeCompare(asOf)).toBeGreaterThanOrEqual(0);
    }
  });

  it("names the same running lords as the engine's fusion row", () => {
    const fusion = REPORT_CHART.predictive?.transits?.fusion;
    expect(dashas?.current_maha?.lord).toBe(fusion?.maha_lord);
    expect(dashas?.current_antar?.lord).toBe(fusion?.antar_lord);
  });
});
