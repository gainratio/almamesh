import { describe, expect, it } from "vitest";

import { buildReportFactsBlock } from "../predictive-facts";
import { computeQuarters } from "../quarters";
import {
  currentPeriodSlice,
  lifeOutlookSlice,
  quarterEvents,
  reportAsOfMonth,
  yearAheadSlice,
} from "../report-sections";
import type { SanitizedChart } from "../sanitize";
import { REPORT_CHART } from "./report-fixture";

const DAY = /\b\d{4}-\d{2}-\d{2}\b/;

// Small hand-built chart for exact event placement.
const SMALL: SanitizedChart = {
  ...REPORT_CHART,
  as_of: { date: "2026-10-10", basis: "chart" },
  dashas: {
    maha_dasha_sequence: [
      {
        lord: "saturn", status: "current (3 years remaining)", start_month: "2010-05", end_month: "2029-05",
        antar_sequence: [
          { lord: "mercury", start_month: "2025-02", end_month: "2026-12" },
          { lord: "ketu", start_month: "2026-12", end_month: "2028-01" },
        ],
      },
      { lord: "mercury", status: "future (starts in 3 years)", start_month: "2029-05", end_month: "2046-05" },
    ],
    current_maha: { lord: "saturn", months_remaining: 31, start_month: "2010-05", end_month: "2029-05" },
    current_antar: { lord: "mercury", months_remaining: 2, start_month: "2025-02", end_month: "2026-12" },
    current_pratyantar: null,
  },
  predictive: {
    transits: {
      gochara: [],
      sade_sati: { is_active: true, current_phase: "setting", natal_moon_sign: "aquarius", until_month: "2027-02" },
      fusion: {
        maha_lord: "saturn", antar_lord: "mercury", maha_lord_transit_house_from_moon: 2,
        maha_lord_transit_house_from_lagna: 11, reinforcing: [], afflicting: ["mars"], severity: "mixed",
      },
      slow_hits: [{ graha: "jupiter", kind: "return", natal_point: "jupiter", month: "2027-05", severity: "supportive" }],
      timeline: [
        { month: "2026-11", kind: "sign_ingress", graha: "mars", from_sign: "libra", to_sign: "scorpio",
          station_direction: null, station_sign: null, severity: "neutral", descriptor: "Mars changes sign" },
        { month: "2028-01", kind: "sign_ingress", graha: "saturn", from_sign: "pisces", to_sign: "aries",
          station_direction: null, station_sign: null, severity: "challenging", descriptor: "Outside the year" },
      ],
    },
    domains: REPORT_CHART.predictive?.domains ?? [],
    domain_houses: REPORT_CHART.predictive?.domain_houses ?? {},
    strength: { sav_total: 337, shadbala: [] },
  },
};

describe("reportAsOfMonth", () => {
  it("is the month of the chart's as-of date", () => {
    expect(reportAsOfMonth(SMALL)).toBe("2026-10");
  });
});

describe("currentPeriodSlice", () => {
  it("carries the running periods, the current maha's antars, the next maha, fusion and lord facts", () => {
    const slice = currentPeriodSlice(SMALL);
    expect(slice.as_of_month).toBe("2026-10");
    expect(slice.current_maha?.lord).toBe("saturn");
    expect(slice.antar_sequence.map((r) => r.lord)).toEqual(["mercury", "ketu"]);
    expect(slice.next_maha).toEqual({ lord: "mercury", start_month: "2029-05", end_month: "2046-05" });
    expect(slice.fusion?.severity).toBe("mixed");
    expect(slice.lord_facts.map((f) => f.lord)).toEqual(["saturn", "mercury"]);
  });

  it("carries nothing else from the predictive block", () => {
    const json = JSON.stringify(currentPeriodSlice(SMALL));
    for (const needle of ["gochara", "slow_hits", "sav_total", "\"domain\"", "descriptor"]) {
      expect(json).not.toContain(needle);
    }
  });
});

describe("quarterEvents / yearAheadSlice", () => {
  it("files each engine event under the quarter whose months contain it", () => {
    const [q1, q2, q3] = computeQuarters("2026-10");
    expect(quarterEvents(SMALL, q1).map((e) => `${e.month} ${e.source}`)).toEqual([
      "2026-11 transit",
      "2026-12 dasha",
    ]);
    expect(quarterEvents(SMALL, q2).map((e) => `${e.month} ${e.source}`)).toEqual(["2027-02 sade_sati"]);
    expect(quarterEvents(SMALL, q3).map((e) => `${e.month} ${e.source}`)).toEqual(["2027-05 slow_hit"]);
  });

  it("leaves events outside the twelve months out", () => {
    expect(JSON.stringify(yearAheadSlice(SMALL))).not.toContain("Outside the year");
  });

  it("sends the four quarter keys and their months", () => {
    const slice = yearAheadSlice(SMALL);
    expect(slice.quarters.map((q) => q.key)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(slice.quarters[0].months).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
});

describe("lifeOutlookSlice", () => {
  it("passes life_outlook_1 only its four domain forecasts plus their house-lord rows", () => {
    const slice = lifeOutlookSlice(REPORT_CHART, "life_outlook_1");
    expect(slice.domains.map((d) => d.domain)).toEqual(["career", "finances", "relationships", "family"]);
    expect(slice.domains[0].house_lords.length).toBeGreaterThan(0);
    const json = JSON.stringify(slice);
    for (const needle of ["gochara", "\"sade_sati\"", "fusion", "slow_hits", "sav_total", "vimshopaka", "\"timeline\""]) {
      expect(json).not.toContain(needle);
    }
    for (const other of ["health", "education", "spiritual"]) {
      expect(json).not.toContain(`"domain":"${other}"`);
    }
  });

  it("passes life_outlook_2 the other three", () => {
    expect(lifeOutlookSlice(REPORT_CHART, "life_outlook_2").domains.map((d) => d.domain)).toEqual([
      "health", "education", "spiritual",
    ]);
  });
});

describe("buildReportFactsBlock", () => {
  it("wraps a slice in the engine-facts delimiters with no day-precision date", () => {
    for (const slice of [currentPeriodSlice(REPORT_CHART), yearAheadSlice(REPORT_CHART), lifeOutlookSlice(REPORT_CHART, "life_outlook_1")]) {
      const block = buildReportFactsBlock(slice);
      expect(block.startsWith("=== ENGINE REPORT FACTS")).toBe(true);
      expect(block).toContain("=== END ENGINE REPORT FACTS ===");
      expect(block).not.toMatch(DAY);
    }
  });
});
