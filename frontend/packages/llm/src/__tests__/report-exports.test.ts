import { describe, expect, it } from "vitest";

import * as llm from "../index";
import type {
  CostEstimate,
  CurrentPeriodSection,
  CurrentTimelineContent,
  LifeOutlookDomain,
  LifeOutlookSection,
  ModelPricing,
  Quarter,
  QuarterKey,
  QuarterProse,
  ReadingOutputBudget,
  ReportMessages,
  ReportSectionKey,
  ReportTimelineContent,
  ReportTimelineEvent,
  ReportTimelineSectionKey,
  SanitizedHouseLord,
  YearAheadSection,
} from "../index";

describe("@almamesh/llm report surface", () => {
  it.each([
    "buildReportMessages",
    "computeQuarters",
    "quarterTitle",
    "quarterEvents",
    "validateTimelineDates",
    "monthsIn",
    "estimateReadingCost",
    "parseModelPricing",
    "findModelPricing",
    "streamReportTimeline",
    "reportAsOfMonth",
    "currentPeriodSlice",
    "yearAheadSlice",
    "lifeOutlookSlice",
    "ReportParseError",
    "REPORT_SECTION_ORDER",
    "READING_OUTPUT_BUDGET",
    "buildReportFactsBlock",
    // kept for readers of stored v1 timelines until PR 3 removes v1 generation
    "streamCurrentTimeline",
    "CURRENT_TIMELINE_SECTIONS",
    "SectionTimeoutError",
    "REPORT_SECTION_TIMEOUT_MS",
    "REPORT_SECTION_IDLE_TIMEOUT_MS",
  ])("exports %s", (name) => {
    expect((llm as Record<string, unknown>)[name]).toBeDefined();
  });

  it("pins the literal constants", () => {
    expect(llm.REPORT_PROMPT_SET).toBe("report-v2");
    expect(llm.REPORT_SECTION_REASONING_MAX_TOKENS).toBe(6000);
    expect(llm.REPORT_SECTION_TIMEOUT_MS).toBe(300_000);
    expect(llm.REPORT_SECTION_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(new llm.SectionTimeoutError("idle", 120_000)).toMatchObject({
      name: "SectionTimeoutError",
      kind: "idle",
      limitMs: 120_000,
    });
    expect(llm.REPORT_TIMELINE_SECTIONS).toEqual(["current_period", "year_ahead", "life_outlook_1", "life_outlook_2"]);
    expect(llm.LIFE_OUTLOOK_GROUPS).toEqual({
      life_outlook_1: ["career", "finances", "relationships", "family"],
      life_outlook_2: ["health", "education", "spiritual"],
    });
    expect(llm.CURRENT_TIMELINE_SECTIONS).toEqual(["upcoming_periods", "current_sky"]);
  });

  it("keeps the v1 reader type assignable from stored content", () => {
    const stored: CurrentTimelineContent = { upcoming_periods: [], current_sky: [] };
    expect(stored.current_sky).toEqual([]);
  });
});

// Compile-time only: every contract type is importable.
export type _ReportTypes = [
  CostEstimate,
  CurrentPeriodSection,
  LifeOutlookDomain,
  LifeOutlookSection,
  ModelPricing,
  Quarter,
  QuarterKey,
  QuarterProse,
  ReadingOutputBudget,
  ReportMessages,
  ReportSectionKey,
  ReportTimelineContent,
  ReportTimelineEvent,
  ReportTimelineSectionKey,
  SanitizedHouseLord,
  YearAheadSection,
];
