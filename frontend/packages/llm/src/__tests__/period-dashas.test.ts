import { describe, expect, it } from "vitest";

import { NO_TREE_NOTE, PRATYANTAR_NOTE, selectDashasForPeriod } from "../period-dashas";
import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { BIRTH_2000_DASHAS } from "./birth-2000-fixture";

describe("selectDashasForPeriod", () => {
  it("re-picks by date: a period across an antar change lists both antars", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2020-12-01", end: "2021-02-28" });
    expect(result.maha).toEqual([{ lord: "venus", start_month: "2017-09", end_month: "2037-09" }]);
    expect(result.antar).toEqual([
      { maha_lord: "venus", lord: "venus", start_month: "2017-09", end_month: "2021-01" },
      { maha_lord: "venus", lord: "sun", start_month: "2021-01", end_month: "2022-01" },
    ]);
  });

  it("a handover on the period's first day lists both rows", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2021-01-15", end: "2021-01-15" });
    expect(result.antar.map((row) => row.lord)).toEqual(["venus", "sun"]);
  });

  it("a period across a maha change lists both mahas in order", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2017-01-01", end: "2017-12-31" });
    expect(result.maha.map((row) => row.lord)).toEqual(["ketu", "venus"]);
  });

  it("withholds the birth month: the first maha and its first antar start at 'birth'", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2000-06-01", end: "2000-06-30" });
    expect(result.maha[0]).toEqual({ lord: "mercury", start_month: "birth", end_month: "2010-09" });
    expect(result.antar[0]).toMatchObject({ lord: "mercury", start_month: "birth" });
    expect(JSON.stringify(result)).not.toContain("2000-03");
  });

  it("gives pratyantars only inside the chart's current antar", () => {
    const inside = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2022-05-01", end: "2022-05-31" });
    expect(inside.pratyantar).toEqual([{ lord: "rahu", start_month: "2022-04", end_month: "2022-08" }]);
    expect(inside.notes).toEqual([]);

    const outside = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2019-06-01", end: "2019-06-30" });
    expect(outside.pratyantar).toBeUndefined();
    expect(outside.notes).toEqual([PRATYANTAR_NOTE]);
  });

  it("says so when the chart has no dated antar tree (older bundle)", () => {
    const legacy = {
      ...BIRTH_2000_DASHAS,
      maha_dasha_sequence: BIRTH_2000_DASHAS.maha_dasha_sequence.map(({ antar_sequence: _, ...maha }) => maha),
    };
    const result = selectDashasForPeriod(legacy, { start: "2019-06-01", end: "2019-06-30" });
    expect(result.antar).toEqual([]);
    expect(result.notes).toContain(NO_TREE_NOTE);
  });
});

describe("selectDashasForPeriod on real engine output (born 2019-11-09)", () => {
  const realChart = (golden as Record<string, SiderealChart>)["2019-11-09T17:45:00+00:00"]!;
  const dashas = realChart.dashas!;
  const MONTH_OR_BIRTH = /^(\d{4}-\d{2}|birth)$/;

  it("a period inside the first maha never crosses 2019-11; the start is 'birth'", () => {
    const result = selectDashasForPeriod(dashas, { start: "2020-06-01", end: "2020-06-30" });
    expect(result.maha[0]).toMatchObject({ lord: "mercury", start_month: "birth" });
    expect(JSON.stringify(result)).not.toContain("2019-11");
  });

  it.each([
    ["2020-06-01", "2020-06-30"],
    ["2021-01-01", "2021-12-31"],
    ["2045-03-01", "2045-03-31"],
  ])("period %s..%s: every emitted boundary is a month or 'birth'", (start, end) => {
    const result = selectDashasForPeriod(dashas, { start, end });
    const rows = [...result.maha, ...result.antar, ...(result.pratyantar ?? [])];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.start_month).toMatch(MONTH_OR_BIRTH);
      expect(r.end_month).toMatch(MONTH_OR_BIRTH);
    }
  });
});
