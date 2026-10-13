import { describe, expect, it } from "vitest";

import { normalizeTimingArgs, parseTimingArgs, SEGMENTS_WITH_DATES_ERROR, TIME_IGNORED_NOTE } from "../index";

// The exact arguments a real model (openai/gpt-sol-latest) sent on 2026-10-13 in a May 2019 trip.
const HARISH_ARGS = {
  section: "transits",
  start: "2019-05-01", end: "2019-05-31", place_ref: "city:0", time: "12:00",
  segments: [{ start: "2019-05-01", end: "2019-05-31", place_ref: "city:0" }],
};

describe("normalizeTimingArgs: redundant but consistent arguments are accepted", () => {
  it("the 2026-10-13 regression: dates + one equal segment + the same place + a time on a month", () => {
    const { args, notes } = normalizeTimingArgs(HARISH_ARGS);
    expect(parseTimingArgs(args)).toEqual({ kind: "period", period: { start: "2019-05-01", end: "2019-05-31" }, placeRef: "city:0" });
    expect(notes).toEqual([TIME_IGNORED_NOTE]);
  });

  it("dates equal to the segments' span are dropped; the segments stay", () => {
    const segments = [{ start: "2019-05-01", end: "2019-05-10", place_ref: "city:1" }, { start: "2019-05-11", end: "2019-05-31", place_ref: "city:2" }];
    const { args } = normalizeTimingArgs({ section: "transits", start: "2019-05-01", end: "2019-05-31", segments });
    expect(args).toEqual({ section: "transits", segments });
  });

  it("a top-level place fills segments that have none", () => {
    const { args } = normalizeTimingArgs({ section: "transits", place_ref: "city:1", segments: [{ start: "2019-05-01", end: "2019-05-10" }, { start: "2019-05-11", end: "2019-05-31" }] });
    expect(args).toEqual({ section: "transits", segments: [{ start: "2019-05-01", end: "2019-05-10", place_ref: "city:1" }, { start: "2019-05-11", end: "2019-05-31", place_ref: "city:1" }] });
  });

  it("a time on a single day is kept", () => {
    const { args, notes } = normalizeTimingArgs({ section: "transits", start: "2019-05-04", place_ref: "city:1", time: "12:00" });
    expect(args).toMatchObject({ time: "12:00" });
    expect(notes).toEqual([]);
  });

  it("a real conflict is left for the parser to reject: dates that differ from the segments", () => {
    const { args } = normalizeTimingArgs({ section: "transits", start: "2019-04-01", end: "2019-05-31", segments: [{ start: "2019-05-01", end: "2019-05-31" }] });
    expect(parseTimingArgs(args)).toEqual({ kind: "invalid", error: SEGMENTS_WITH_DATES_ERROR });
  });

  it("anything malformed passes through untouched", () => {
    const raw = { section: "transits", segments: "nope", start: "2019-05-01" };
    expect(normalizeTimingArgs(raw)).toEqual({ args: raw, notes: [] });
  });
});
