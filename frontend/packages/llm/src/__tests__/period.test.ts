import { describe, expect, it } from "vitest";

import {
  BEFORE_BIRTH_MESSAGE,
  OVER_TWO_YEARS_NOTE,
  PAST_EPHEMERIS_NOTE,
  parsePeriodArgs,
  periodEcho,
  periodLimits,
  startsBeforeBirth,
} from "../period";

describe("parsePeriodArgs", () => {
  it("no dates means today", () => {
    expect(parsePeriodArgs({})).toEqual({ kind: "today" });
  });

  it("start alone is a single day", () => {
    expect(parsePeriodArgs({ start: "2019-03-12" })).toEqual({
      kind: "period",
      period: { start: "2019-03-12", end: "2019-03-12" },
    });
  });

  it("accepts a real leap day", () => {
    expect(parsePeriodArgs({ start: "2024-02-29" }).kind).toBe("period");
  });

  it.each([
    [{ start: "2026-02-30" }, "start must be a date like 2026-06-01"],
    [{ start: "2026-02-31" }, "start must be a date like 2026-06-01"],
    [{ start: "2026-13-01" }, "start must be a date like 2026-06-01"],
    [{ start: "2023-02-29" }, "start must be a date like 2026-06-01"],
    [{ start: "2026-6-1" }, "start must be a date like 2026-06-01"],
    [{ start: 20260601 }, "start must be a date like 2026-06-01"],
    [{ start: "2026-06-01", end: "June" }, "end must be a date like 2026-06-01"],
    [{ start: "2026-06-01", end: "2026-02-31" }, "end must be a date like 2026-06-01"],
    [{ start: "2026-06-01", end: "2026-13-01" }, "end must be a date like 2026-06-01"],
    [{ start: "2026-06-30", end: "2026-06-01" }, "end is before start"],
    [{ end: "2026-06-30" }, "start is required when end is given"],
  ])("rejects %j with a reason the model can act on", (args, error) => {
    expect(parsePeriodArgs(args)).toEqual({ kind: "invalid", error });
  });
});

describe("periodEcho", () => {
  it("counts days inclusively", () => {
    expect(periodEcho({ start: "2026-06-01", end: "2026-06-30" }, "period")).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
      days: 30,
      basis: "period",
    });
    expect(periodEcho({ start: "2024-01-01", end: "2024-12-31" }, "period").days).toBe(366);
  });
});

describe("startsBeforeBirth", () => {
  it("refuses only periods that start before the birth day", () => {
    expect(startsBeforeBirth({ start: "1990-01-14", end: "1990-02-01" }, "1990-01-15")).toBe(true);
    expect(startsBeforeBirth({ start: "1990-01-15", end: "1990-02-01" }, "1990-01-15")).toBe(false);
    expect(startsBeforeBirth({ start: "1800-01-01", end: "1800-01-01" }, undefined)).toBe(false);
  });

  it("the refusal text never carries a date", () => {
    expect(BEFORE_BIRTH_MESSAGE).toBe(
      "This period starts before the birth date. Ask about a period after it.",
    );
    expect(BEFORE_BIRTH_MESSAGE).not.toMatch(/\d/);
  });
});

describe("periodLimits", () => {
  it("allows exactly two years", () => {
    expect(periodLimits({ start: "2019-01-01", end: "2020-12-31" })).toEqual({ dashasOnly: false, notes: [] });
  });

  it("a 25-month span is dashas only, with the spec's note", () => {
    expect(periodLimits({ start: "2019-01-01", end: "2021-01-31" })).toEqual({
      dashasOnly: true,
      notes: [OVER_TWO_YEARS_NOTE],
    });
    expect(OVER_TWO_YEARS_NOTE).toBe(
      "Over 2 years: showing dashas only. Ask about a shorter span for transits.",
    );
  });

  it("any day after 2052-12-31 is dashas only", () => {
    expect(periodLimits({ start: "2052-12-31", end: "2052-12-31" }).dashasOnly).toBe(false);
    expect(periodLimits({ start: "2053-01-05", end: "2053-01-05" })).toEqual({
      dashasOnly: true,
      notes: [PAST_EPHEMERIS_NOTE],
    });
  });
});
