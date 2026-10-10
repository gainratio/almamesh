// Report-v2 prompt golden snapshots: every report section, full and lite, in
// en/es/pt, on the real engine golden chart sanitized at a pinned instant.
// Review a diff for the honesty blocks before updating with -u.

import { describe, expect, it } from "vitest";

import { isReportTimelineSection } from "../report-sections";
import { REPORT_PROMPT_SET, REPORT_SECTIONS, REPORT_WORD_TARGETS } from "../report-targets";
import { buildSectionMessages } from "../structured-interpretation";
import { REPORT_CHART } from "./report-fixture";

const LANGS = ["en", "es", "pt"] as const;
const VARIANTS = [
  ["full", false],
  ["lite", true],
] as const;
const DAY = /\b\d{4}-\d{2}-\d{2}\b/;

const cases = REPORT_SECTIONS.flatMap((section) =>
  VARIANTS.flatMap(([variant, lite]) => LANGS.map((lang) => [section, variant, lite, lang] as const)),
);

describe("report-v2 prompts", () => {
  it.each(cases)("%s/%s (lite=%s)/%s snapshot", (section, _variant, lite, lang) => {
    expect(buildSectionMessages(section, REPORT_CHART, "layman", lite, lang, REPORT_PROMPT_SET)).toMatchSnapshot();
  });

  it.each(cases)("%s/%s (lite=%s)/%s carries no day-precision date", (section, _variant, lite, lang) => {
    expect(
      JSON.stringify(buildSectionMessages(section, REPORT_CHART, "layman", lite, lang, REPORT_PROMPT_SET)),
    ).not.toMatch(DAY);
  });

  it("states each full section's word targets per voice", () => {
    for (const section of REPORT_SECTIONS) {
      const user = buildSectionMessages(section, REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1].content;
      expect(user).toContain("Word targets PER VOICE");
    }
  });

  it("asks guidance1 for family_guidance, full and lite", () => {
    for (const lite of [false, true]) {
      expect(
        buildSectionMessages("guidance1", REPORT_CHART, "layman", lite, "en", REPORT_PROMPT_SET)[1].content,
      ).toContain("family_guidance");
    }
  });

  it("sends the year-ahead quarter keys and no focus field in lite", () => {
    const full = buildSectionMessages("year_ahead", REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1].content;
    const lite = buildSectionMessages("year_ahead", REPORT_CHART, "layman", true, "en", REPORT_PROMPT_SET)[1].content;
    expect(full).toContain('"key":"Q1"');
    expect(full).toContain('"focus"');
    expect(lite).not.toContain('"focus"');
  });

  it("gives timeline sections only their engine slice, never the full chart JSON", () => {
    for (const section of REPORT_SECTIONS.filter(isReportTimelineSection)) {
      const user = buildSectionMessages(section, REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1].content;
      expect(user).toContain("=== ENGINE REPORT FACTS");
      expect(user).not.toContain('"ayanamsa_value"');
      expect(user).not.toContain("=== ENGINE PREDICTIVE CONTEXT");
    }
  });

  it("life_outlook_1 sees only its own domain forecasts", () => {
    const user = buildSectionMessages("life_outlook_1", REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET)[1]
      .content;
    for (const needle of ['"gochara"', '"slow_hits"', '"sav_total"', '"vimshopaka"', '"fusion"']) {
      expect(user).not.toContain(needle);
    }
    for (const domain of ["health", "education", "spiritual"]) expect(user).not.toContain(`"domain":"${domain}"`);
    for (const domain of ["career", "finances", "relationships", "family"]) {
      expect(user).toContain(`"domain":"${domain}"`);
    }
  });

  it("natal report prompts keep the stable-natal fence and drop the as-of date", () => {
    const [system, user] = buildSectionMessages("core", REPORT_CHART, "layman", false, "en", REPORT_PROMPT_SET);
    expect(system.content).toContain("STABLE NATAL ONLY");
    expect(system.content).toContain("Current Period / Year Ahead / This Year");
    expect(user.content).not.toContain('"as_of"');
    expect(user.content).not.toContain('"dashas"');
  });

  it("pins the word targets the cost estimate and the real spec rely on", () => {
    expect(REPORT_WORD_TARGETS).toEqual({
      core: { low: 660, high: 970 },
      yoga: { low: 250, high: 350 },
      guidance1: { low: 600, high: 800 },
      guidance2: { low: 390, high: 520 },
      remedial: { low: 300, high: 400 },
      current_period: { low: 490, high: 770 },
      year_ahead: { low: 800, high: 1110 },
      life_outlook_1: { low: 480, high: 640 },
      life_outlook_2: { low: 360, high: 480 },
    });
  });
});
