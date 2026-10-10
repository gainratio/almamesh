// The report-v2 prompt set: one version stamp for provenance (PR 3 stores it)
// and the length targets the prompts ask for, the cost estimate budgets for,
// and the real spec checks (+/-30 %). Words are PER VOICE (layman and
// technical each).

import { REPORT_TIMELINE_SECTIONS, type ReportTimelineSectionKey } from "./report-sections";
import type { NatalInterpretationSectionKey } from "./structured-interpretation";

export const REPORT_PROMPT_SET = "report-v2" as const;
export type ReportPromptSet = typeof REPORT_PROMPT_SET;

export type ReportSectionKey = NatalInterpretationSectionKey | ReportTimelineSectionKey;

export const REPORT_SECTIONS: readonly ReportSectionKey[] = [
  "core",
  "yoga",
  "guidance1",
  "guidance2",
  "remedial",
  ...REPORT_TIMELINE_SECTIONS,
];

/** Run order for nine requests: natal first, the two life-outlook calls last (ruling 7). */
export const REPORT_SECTION_ORDER: readonly ReportSectionKey[] = REPORT_SECTIONS;

/** A section's length target in words, per voice. */
export interface WordTarget {
  readonly low: number;
  readonly high: number;
}

export const REPORT_WORD_TARGETS: Readonly<Record<ReportSectionKey, WordTarget>> = {
  core: { low: 660, high: 970 }, //            summary 120-160 + 9 items x 60-90
  yoga: { low: 250, high: 350 },
  guidance1: { low: 600, high: 800 }, //       5 guidances x 120-160
  guidance2: { low: 390, high: 520 }, //       2 x 120-160 + life_evolution 150-200
  remedial: { low: 300, high: 400 },
  current_period: { low: 490, high: 770 }, // maha 150-200, antar 120-160, 2-3 x 60-90, next 100-140
  year_ahead: { low: 800, high: 1110 }, //    headline 100-140, 4 x 160-220, focus 60-90
  life_outlook_1: { low: 480, high: 640 }, //  4 x 120-160
  life_outlook_2: { low: 360, high: 480 }, //  3 x 120-160
};

/** The per-field targets the full prompt states, one sentence per section. */
export const REPORT_FIELD_TARGETS: Readonly<Record<ReportSectionKey, string>> = {
  core: "summary 120-160 words; each strengths, challenges and life_themes item 60-90 words, 3 items each",
  yoga: "integrated_yoga_narrative 250-350 words",
  guidance1: "each of the five guidances 120-160 words",
  guidance2: "finances_guidance and spiritual_guidance 120-160 words each; life_evolution_guidance 150-200 words",
  remedial: "remedial_measures 300-400 words",
  current_period: "maha 150-200 words; antar 120-160; each activates item 60-90 (2-3 items); next_change 100-140",
  year_ahead: "headline 100-140 words; each quarter 160-220; focus 60-90",
  life_outlook_1:
    "each area's outlook 120-160 words; lean_into and watch_for one plain sentence each, under 25 words",
  life_outlook_2:
    "each area's outlook 120-160 words; lean_into and watch_for one plain sentence each, under 25 words",
};
