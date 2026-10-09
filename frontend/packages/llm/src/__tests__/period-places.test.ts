import { describe, expect, it } from "vitest";

import {
  PLACE_CONFLICT_ERROR,
  PLACE_REF_ERROR,
  SEGMENTS_ORDER_ERROR,
  SEGMENTS_SHAPE_ERROR,
  SEGMENTS_WITH_DATES_ERROR,
  TIME_FORMAT_ERROR,
  TIME_NEEDS_DAY_ERROR,
  MAX_SEGMENTS,
  NEEDS_PLACE_ERROR,
  PLACE_NEEDED_BELOW_DAYS,
  PLACE_REF_ARG_PATTERN,
  TIME_NEEDS_PLACE_ERROR,
  TIME_OF_DAY_PATTERN,
  needsPlace,
  parseTimingArgs,
} from "../period-places";

const LA = "city:101";
const BOG = "city:202";

describe("parseTimingArgs", () => {
  it("keeps Inc A behaviour: no dates is today; start/end is a period", () => {
    expect(parseTimingArgs({ section: "transits" })).toEqual({ kind: "today" });
    expect(parseTimingArgs({ start: "2026-06-01", end: "2026-06-30" })).toEqual({
      kind: "period",
      period: { start: "2026-06-01", end: "2026-06-30" },
    });
  });

  it("merges ordered segments into one period and keeps them", () => {
    const segments = [
      { start: "2026-06-01", end: "2026-06-15", place_ref: LA },
      { start: "2026-06-16", end: "2026-06-30", place_ref: BOG },
    ];
    expect(parseTimingArgs({ segments })).toEqual({
      kind: "period",
      period: { start: "2026-06-01", end: "2026-06-30" },
      segments,
    });
  });

  it("allows a gap between segments", () => {
    const parsed = parseTimingArgs({ segments: [{ start: "2026-06-01", end: "2026-06-10" }, { start: "2026-06-20", end: "2026-06-30" }] });
    expect(parsed.kind).toBe("period");
  });

  it.each([
    [{ start: "2026-06-01", segments: [{ start: "2026-06-01", end: "2026-06-02" }] }, SEGMENTS_WITH_DATES_ERROR],
    [{ segments: [] }, SEGMENTS_SHAPE_ERROR],
    [{ segments: "June" }, SEGMENTS_SHAPE_ERROR],
    [{ segments: Array.from({ length: 5 }, () => ({ start: "2026-06-01", end: "2026-06-01" })) }, SEGMENTS_SHAPE_ERROR],
    [{ segments: [{ start: "2026-06-01" }] }, SEGMENTS_SHAPE_ERROR],
    [{ segments: [{ start: "2026-06-10", end: "2026-06-01" }] }, "end is before start"],
    [{ segments: [{ start: "2026-6-1", end: "2026-06-02" }] }, "start must be a date like 2026-06-01"],
    [{ segments: [{ start: "2026-06-01", end: "2026-06-15" }, { start: "2026-06-15", end: "2026-06-30" }] }, SEGMENTS_ORDER_ERROR],
    [{ segments: [{ start: "2026-06-16", end: "2026-06-30" }, { start: "2026-06-01", end: "2026-06-15" }] }, SEGMENTS_ORDER_ERROR],
    [{ segments: [{ start: "2026-06-01", end: "2026-06-02", place_ref: "bogota" }] }, PLACE_REF_ERROR],
    [{ start: "2026-06-15", place_ref: 7 }, PLACE_REF_ERROR],
    [{ start: "2026-06-15", place_ref: BOG, time: "3pm" }, TIME_FORMAT_ERROR],
    [{ start: "2026-06-15", place_ref: BOG, time: "24:00" }, TIME_FORMAT_ERROR],
    [{ start: "2026-06-01", end: "2026-06-30", place_ref: BOG, time: "15:00" }, TIME_NEEDS_DAY_ERROR],
    [{ time: "15:00" }, TIME_NEEDS_DAY_ERROR],
    [{ start: "2026-06-15", time: "15:00" }, TIME_NEEDS_PLACE_ERROR],
    [{ segments: [{ start: "2026-06-15", end: "2026-06-15", place_ref: LA }], place_ref: BOG }, PLACE_CONFLICT_ERROR],
  ])("refuses %j", (args, error) => {
    expect(parseTimingArgs(args)).toEqual({ kind: "invalid", error });
  });

  it("takes a single day's place from its one segment", () => {
    expect(parseTimingArgs({ segments: [{ start: "2026-06-15", end: "2026-06-15", place_ref: BOG }], time: "15:00" })).toEqual({
      kind: "period",
      period: { start: "2026-06-15", end: "2026-06-15" },
      segments: [{ start: "2026-06-15", end: "2026-06-15", place_ref: BOG }],
      placeRef: BOG,
      time: "15:00",
    });
  });

  it("accepts a place_ref on a multi-day period (the tool notes it changes nothing)", () => {
    expect(parseTimingArgs({ start: "2026-06-01", end: "2026-06-30", place_ref: BOG })).toEqual({
      kind: "period",
      period: { start: "2026-06-01", end: "2026-06-30" },
      placeRef: BOG,
    });
  });
});

describe("needsPlace (coordinator Ruling 1)", () => {
  const day = { start: "2026-06-15", end: "2026-06-15" };
  it("a day, a few days, or 6 days without a place needs one", () => {
    expect(needsPlace(day, {})).toBe(true);
    expect(needsPlace({ start: "2026-06-01", end: "2026-06-03" }, {})).toBe(true);
    expect(needsPlace({ start: "2027-02-01", end: "2027-02-06" }, {})).toBe(true);
  });

  it("7 days or more never needs one", () => {
    expect(needsPlace({ start: "2027-02-01", end: "2027-02-07" }, {})).toBe(false);
    expect(needsPlace({ start: "2026-06-01", end: "2026-06-30" }, {})).toBe(false);
  });

  it("a place_ref, or segments that all carry one, satisfy it", () => {
    expect(needsPlace(day, { placeRef: BOG })).toBe(false);
    expect(needsPlace({ start: "2026-06-01", end: "2026-06-05" }, {
      segments: [{ start: "2026-06-01", end: "2026-06-02", place_ref: LA }, { start: "2026-06-03", end: "2026-06-05", place_ref: BOG }],
    })).toBe(false);
  });

  it("segments with a missing place do not", () => {
    expect(needsPlace({ start: "2026-06-01", end: "2026-06-05" }, {
      segments: [{ start: "2026-06-01", end: "2026-06-02", place_ref: LA }, { start: "2026-06-03", end: "2026-06-05" }],
    })).toBe(true);
  });

  it("the error is the constant the prompt teaches", () => {
    expect(NEEDS_PLACE_ERROR).toBe("needs_place");
    expect(PLACE_NEEDED_BELOW_DAYS).toBe(7);
  });
});

describe("pinned literals", () => {
  it("pins the documented values, not values derived from themselves", () => {
    expect(PLACE_NEEDED_BELOW_DAYS).toBe(7);
    expect(MAX_SEGMENTS).toBe(4);
    expect(PLACE_REF_ARG_PATTERN).toBe("^city:\\d{1,6}$");
    expect(TIME_OF_DAY_PATTERN).toBe("^([01]\\d|2[0-3]):[0-5]\\d$");
  });

  it("takes 4 segments and refuses 5", () => {
    const seg = (d: number) => ({ start: `2026-06-${String(d).padStart(2, "0")}`, end: `2026-06-${String(d).padStart(2, "0")}` });
    expect(parseTimingArgs({ segments: [1, 3, 5, 7].map(seg) }).kind).toBe("period");
    expect(parseTimingArgs({ segments: [1, 3, 5, 7, 9].map(seg) })).toEqual({ kind: "invalid", error: SEGMENTS_SHAPE_ERROR });
  });

  it("a place alone with no dates stays today", () => {
    expect(parseTimingArgs({ place_ref: BOG })).toEqual({ kind: "today" });
  });
});
