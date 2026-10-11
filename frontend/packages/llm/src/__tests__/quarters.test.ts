import { describe, expect, it } from "vitest";

import { computeQuarters, quarterTitle } from "../quarters";

const months = (asOf: string) => computeQuarters(asOf).map((q) => [q.key, ...q.months]);

describe("computeQuarters", () => {
  it("counts four quarters from the as-of month", () => {
    expect(months("2026-10")).toEqual([
      ["Q1", "2026-10", "2026-11", "2026-12"],
      ["Q2", "2027-01", "2027-02", "2027-03"],
      ["Q3", "2027-04", "2027-05", "2027-06"],
      ["Q4", "2027-07", "2027-08", "2027-09"],
    ]);
  });

  it("crosses the year inside Q1 for a November start", () => {
    expect(months("2026-11")).toEqual([
      ["Q1", "2026-11", "2026-12", "2027-01"],
      ["Q2", "2027-02", "2027-03", "2027-04"],
      ["Q3", "2027-05", "2027-06", "2027-07"],
      ["Q4", "2027-08", "2027-09", "2027-10"],
    ]);
  });

  it("handles a December start", () => {
    expect(months("2026-12")).toEqual([
      ["Q1", "2026-12", "2027-01", "2027-02"],
      ["Q2", "2027-03", "2027-04", "2027-05"],
      ["Q3", "2027-06", "2027-07", "2027-08"],
      ["Q4", "2027-09", "2027-10", "2027-11"],
    ]);
  });

  it.each(["2026-13", "2026-00", "2026-1", "2026-10-01", "", "Oct 2026"])("refuses %j", (bad) => {
    expect(() => computeQuarters(bad)).toThrow(/YYYY-MM/);
  });
});

describe("quarterTitle", () => {
  it("names a same-year quarter once", () => {
    expect(quarterTitle(computeQuarters("2026-10")[0])).toBe("Oct-Dec 2026");
  });

  it("names both years when the quarter crosses one", () => {
    expect(quarterTitle(computeQuarters("2026-11")[0])).toBe("Nov 2026-Jan 2027");
  });

  it("localizes month names", () => {
    expect(quarterTitle(computeQuarters("2026-11")[0], "es")).toBe("nov 2026-ene 2027");
    expect(quarterTitle(computeQuarters("2026-11")[0], "pt")).toBe("nov. 2026-jan. 2027");
  });
});
