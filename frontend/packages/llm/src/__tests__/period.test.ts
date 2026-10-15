import { describe, expect, it } from "vitest";

import {
  ENGINE_DAYS_PER_MONTH,
  EPHEMERIS_LAST_YEAR,
  LONG_PERIOD_WINDOW_MONTHS,
  periodWindowMonths,
  instantEndsBeforePeriodEnd,
  BIRTH_YEAR_SKY_NOTE,
  endsBeforeBirthYear,
  startsInOrBeforeBirthYear,
} from "../period";

describe("endsBeforeBirthYear", () => {
  // REVERSED CONTRACT (PR #298): this used to refuse any period starting before the
  // birth DAY. That is a 1-bit oracle on the birth date; the boundary is now the year.
  it("refuses only periods that end before 1 January of the birth year", () => {
    expect(endsBeforeBirthYear({ start: "1989-01-01", end: "1989-12-31" }, 1990)).toBe(true);
    expect(endsBeforeBirthYear({ start: "1989-06-01", end: "1990-01-01" }, 1990)).toBe(false);
    expect(endsBeforeBirthYear({ start: "1990-01-14", end: "1990-02-01" }, 1990)).toBe(false);
    expect(endsBeforeBirthYear({ start: "1800-01-01", end: "1800-01-01" }, undefined)).toBe(false);
  });
});

describe("startsInOrBeforeBirthYear", () => {
  it("withholds the sky for any period starting on or before 31 December of the birth year", () => {
    expect(startsInOrBeforeBirthYear({ start: "1990-12-31", end: "1991-02-01" }, 1990)).toBe(true);
    expect(startsInOrBeforeBirthYear({ start: "1990-01-01", end: "1990-01-01" }, 1990)).toBe(true);
    expect(startsInOrBeforeBirthYear({ start: "1991-01-01", end: "1991-01-01" }, 1990)).toBe(false);
    expect(startsInOrBeforeBirthYear({ start: "1990-06-01", end: "1990-06-01" }, undefined)).toBe(false);
  });

  it("says so in constant words", () => {
    expect(BIRTH_YEAR_SKY_NOTE).toBe("Planet timing for the year of birth isn't available; showing periods only.");
  });
});

describe("periodWindowMonths", () => {
  it("keeps the engine's default window when 12 engine months cover the whole period", () => {
    expect(periodWindowMonths({ start: "2026-06-01", end: "2026-06-30" })).toBeUndefined();
    expect(periodWindowMonths({ start: "2027-01-01", end: "2027-12-31" })).toBeUndefined();
  });

  it("asks for 24 months when 12 would stop short, a leap year's 31 December included", () => {
    expect(periodWindowMonths({ start: "2028-01-01", end: "2028-12-31" })).toBe(24);
    expect(periodWindowMonths({ start: "2027-01-01", end: "2028-06-30" })).toBe(24);
  });

  it("pins the engine's month length and the long window", () => {
    expect(ENGINE_DAYS_PER_MONTH).toBe(30.4375);
    expect(LONG_PERIOD_WINDOW_MONTHS).toBe(24);
  });
});

describe("periodWindowMonths at a leap year's end", () => {
  it("compares the 12-month window's end instant with the end of the period's last day", () => {
    expect(periodWindowMonths({ start: "2028-01-01", end: "2028-12-31" })).toBe(LONG_PERIOD_WINDOW_MONTHS);
    expect(periodWindowMonths({ start: "2027-01-01", end: "2027-12-31" })).toBeUndefined();
  });
});

describe("instantEndsBeforePeriodEnd", () => {
  const period = { start: "2027-01-01", end: "2027-12-31" };
  const endOfLastDay = Date.parse("2028-01-01T00:00:00Z");

  it("is false when the window ends exactly at the end of the last day", () => {
    expect(instantEndsBeforePeriodEnd(endOfLastDay, period)).toBe(false);
  });

  it("is true one millisecond earlier", () => {
    expect(instantEndsBeforePeriodEnd(endOfLastDay - 1, period)).toBe(true);
  });

  it("is true for the 2028-12-31T06:00Z leap-year window end", () => {
    const leap = { start: "2028-01-01", end: "2028-12-31" };
    expect(instantEndsBeforePeriodEnd(Date.parse("2028-12-31T06:00:00Z"), leap)).toBe(true);
  });
});

describe("EPHEMERIS_LAST_YEAR", () => {
  // Pinned to the literal: backend positions.py EPHEMERIS_LAST_INSTANT is 2053-01-01 (exclusive),
  // so 2052 is the last year the engine computes.
  it("is the engine's last supported year", () => {
    expect(EPHEMERIS_LAST_YEAR).toBe(2052);
  });
});
