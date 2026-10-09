import { describe, expect, it } from "vitest";

import { BIRTH_YEAR_ROWS_NOTE, NO_TREE_NOTE, PRATYANTAR_NOTE, selectDashasForPeriod } from "../period-dashas";
import type { SiderealChart, VimshottariDasha } from "@almamesh/browser/types";

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

  it("the birth rows cover the whole birth year, so their presence is no birth-day oracle", () => {
    // Born 2000-03: a January 2000 period must read exactly like a June 2000 one.
    const january = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2000-01-01", end: "2000-01-31" }, 2000);
    const june = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2000-06-01", end: "2000-06-30" }, 2000);
    expect(january.maha).toEqual([{ lord: "mercury", start_month: "birth", end_month: "2010-09" }]);
    expect(january).toEqual(june);
    const before = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "1999-12-01", end: "1999-12-31" }, 2000);
    expect(before.maha).toEqual([]);
    expect(before.antar).toEqual([]);
  });

  it("clamps the birth rows to the LOCAL birth year, not the UTC year of the birth instant", () => {
    // Born 1990-12-31 20:00 PST = 1991-01-01T04:00Z: local year 1990, UTC year 1991.
    const treeFrom = (birth: string): VimshottariDasha => ({
      maha_dasha_sequence: [
        {
          lord: "rahu", start_date: birth, end_date: "2007-06-01T00:00:00Z", duration_years: 16,
          antar_sequence: [{ lord: "rahu", start_date: birth, end_date: "1993-06-01T00:00:00Z", duration_years: 2 }],
        },
      ],
      current_maha: null,
      current_antar: null,
      current_pratyantar: null,
    } as unknown as VimshottariDasha);
    const june1990 = { start: "1990-06-01", end: "1990-06-30" };
    const pstEdge = selectDashasForPeriod(treeFrom("1991-01-01T04:00:00Z"), june1990, 1990);
    const midYear = selectDashasForPeriod(treeFrom("1990-06-15T12:00:00Z"), june1990, 1990);
    expect(pstEdge.maha).toEqual([{ lord: "rahu", start_month: "birth", end_month: "2007-06" }]);
    expect(pstEdge).toEqual(midYear);
  });

  it("notes, in constant words, that the birth-year rows begin during the year of birth", () => {
    expect(BIRTH_YEAR_ROWS_NOTE).toBe(
      "The first period row begins during the year of birth; months before birth don't apply.",
    );
    const inYear = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "1999-06-01", end: "2000-01-31" }, 2000);
    expect(inYear.notes).toContain(BIRTH_YEAR_ROWS_NOTE);
    const lateInYear = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2000-12-31", end: "2001-02-01" }, 2000);
    expect(lateInYear.notes).toContain(BIRTH_YEAR_ROWS_NOTE);
    const nextYear = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2001-01-01", end: "2001-01-31" }, 2000);
    expect(nextYear.notes).not.toContain(BIRTH_YEAR_ROWS_NOTE);
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
