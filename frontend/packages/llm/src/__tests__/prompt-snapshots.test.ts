// Spec 062 (LLM delta 5): prompt golden-snapshots.
//
// Key-phrase greps can prove a fence phrase EXISTS but cannot catch a dropped
// paragraph, a reordered block, or an accidentally-deleted rule. These
// FULL-OUTPUT snapshots lock every prompt builder byte-for-byte on fixed
// SYNTHETIC fixtures (the mesh edge comes from the synthetic mesh golden), so
// any prompt change — intended or not — shows up as a reviewable snapshot diff.
//
// If a snapshot fails after a DELIBERATE prompt change, review the diff for
// the invariants (OUTPUT_DISCIPLINE_RULES, ANTI_SCAM_RELATIONSHIP_FENCE,
// RECTIFICATION_FENCE, the honesty blocks) and only then update with -u.

import { describe, expect, it } from "vitest";

import meshGolden from "../../../../../backend/tests/fixtures/mesh_golden_de421.json";
import type { ChatTurn } from "../budget";
import { buildMeshFactsBlock } from "../mesh-facts";
import { sanitizeMeshEdgeForLlm } from "../mesh-sanitize";
import type { MeshEdgeContext } from "../mesh-types";
import { buildChatMessages, type ChatRectificationContext } from "../prompt";
import {
  buildInterviewMessages,
  type InterviewGatheredEvent,
} from "../rectification-interview";
import type { SanitizedChart } from "../sanitize";
import { buildSectionMessages } from "../structured-interpretation";

// --- fixed synthetic chart (same synthetic shape the other prompt suites use) --

const CHART: SanitizedChart = {
  as_of: { date: "2026-01-01", basis: "chart" },
  ayanamsa_value: 24.1,
  lagna: {
    longitude: 12.3,
    sign: "aries",
    sign_degrees: 12.3,
    sign_lord: "mars",
    nakshatra: "ashwini",
    nakshatra_pada: 2,
    nakshatra_lord: "ketu",
  },
  planets: {
    mars: {
      name: "mars",
      longitude: 280.5,
      latitude: 0,
      distance: 1,
      speed: 0.5,
      is_retrograde: false,
      sign: "capricorn",
      sign_degrees: 10.5,
      sign_lord: "saturn",
      nakshatra: "shravana",
      nakshatra_pada: 1,
      nakshatra_lord: "moon",
      house: 10,
      dignity: "exalted",
      is_combust: false,
      combustion_separation_deg: null,
      houses_ruled: [1, 8],
      is_yogakaraka: false,
    },
    saturn: {
      name: "saturn",
      longitude: 100.2,
      latitude: 0,
      distance: 1,
      speed: -0.1,
      is_retrograde: true,
      sign: "cancer",
      sign_degrees: 10.2,
      sign_lord: "moon",
      nakshatra: "pushya",
      nakshatra_pada: 2,
      nakshatra_lord: "saturn",
      house: 4,
      dignity: "debilitated",
      is_combust: false,
      combustion_separation_deg: null,
      houses_ruled: [10, 11],
      is_yogakaraka: true,
    },
  },
  houses: {},
  yogas: [
    {
      name: "Gaja Kesari Yoga",
      display_name: "Gaja Kesari Yoga (Jupiter in the 1st from the Moon)",
      category: "auspicious",
      description: "Jupiter angular to the Moon.",
      effects: "Wisdom and prosperity.",
      grade: "moderate",
      strength_factors: [
        {
          factor_type: "dignity",
          planet: "jupiter",
          value: "exalted",
          basis: "Sign dignity per the BPHS exaltation/own-sign doctrine",
        },
      ],
      planets_involved: ["jupiter", "moon"],
      houses_involved: [1, 4],
      planetary_signature: "jupiter_moon_h1_h4",
      formation_rules: [
        {
          rule: "chandra.gaja_kesari",
          description: "Jupiter in the 1st from the Moon",
          source: "BPHS, Chandra-yoga adhyaya",
          planets: ["jupiter", "moon"],
          houses: [1],
        },
      ],
    },
  ],
  dashas: {
    maha_dasha_sequence: [
      { lord: "sun", duration_years: 6, status: "current (4 years remaining)" },
      { lord: "moon", duration_years: 10, status: "future (starts in 4 years)" },
    ],
    current_maha: { lord: "sun", duration_years: 6, months_remaining: 48 },
    current_antar: { lord: "mercury", duration_years: 17, months_remaining: 9 },
    current_pratyantar: null,
  },
  navamsa: {
    name: "D9",
    lagna_sign: "scorpio",
    lagna_sign_lord: "mars",
    planets: {
      mars: { name: "mars", sign: "capricorn", sign_lord: "saturn" },
    },
  },
  predictive: {
    strength: {
      sav_total: 337,
      shadbala: [
        { planet: "saturn", total_rupas: 5.21, required_rupas: 5, meets_minimum: true },
      ],
    },
  },
};

const HISTORY: ChatTurn[] = [
  { role: "user", content: "What does my chart say about work?" },
  { role: "assistant", content: "Your tenth-house Mars anchors a determined career story." },
];

const RECTIFICATION: ChatRectificationContext = {
  band: "leans",
  originalSign: "pisces",
  rectifiedSign: "aquarius",
  mode: "cusp",
};

describe("prompt golden-snapshots (Spec 062 delta 5)", () => {
  it("buildChatMessages — natal-only minimal path", () => {
    expect(buildChatMessages(CHART, "Where is my Mars?")).toMatchSnapshot();
  });

  it("buildChatMessages — fully loaded (history + RAG + reading + rectification)", () => {
    expect(
      buildChatMessages(
        CHART,
        "Should I change jobs this year?",
        "expert",
        HISTORY,
        ["Earlier you said your job feels stagnant."],
        "Summary: A grounded, patient builder.",
        "en",
        undefined,
        RECTIFICATION,
      ),
    ).toMatchSnapshot();
  });

  it("buildSectionMessages — core section, full prompt, en", () => {
    expect(buildSectionMessages("core", CHART, "layman", false, "en")).toMatchSnapshot();
  });

  // Legacy section prompts beyond core/full/en: pinned before the report-v2
  // refactor made the system prompts functions and split the user builders, so
  // these prove the legacy (no promptSet) text did not move by a byte.
  const { predictive: _predictive, ...CHART_WITHOUT_PREDICTIVE } = CHART;
  const LEGACY_CASES = [
    ["core", "lite", true, "layman", "en", "with predictive", CHART],
    ["core", "full", false, "expert", "en", "with predictive", CHART],
    ["core", "lite", true, "expert", "es", "with predictive", CHART],
    ["guidance1", "full", false, "layman", "en", "with predictive", CHART],
    ["guidance1", "lite", true, "layman", "en", "with predictive", CHART],
    ["upcoming_periods", "full", false, "layman", "en", "with predictive", CHART],
    ["upcoming_periods", "lite", true, "layman", "en", "with predictive", CHART],
    ["upcoming_periods", "lite", true, "layman", "pt", "no predictive", CHART_WITHOUT_PREDICTIVE],
    ["current_sky", "full", false, "layman", "en", "no predictive", CHART_WITHOUT_PREDICTIVE],
  ] as const;

  it.each(LEGACY_CASES)(
    "buildSectionMessages — legacy %s / %s (lite=%s) / %s / %s / %s",
    (section, _variant, lite, mode, lang, _chartLabel, chart) => {
      expect(buildSectionMessages(section, chart, mode, lite, lang)).toMatchSnapshot();
    },
  );

  it("buildMeshFactsBlock — spouse edge from the synthetic mesh golden", () => {
    const edges = Object.values(meshGolden as unknown as Record<string, MeshEdgeContext>);
    const spouse = edges.find((e) => e.relationship === "spouse");
    if (!spouse) {
      throw new Error("mesh golden carries no spouse edge");
    }
    expect(buildMeshFactsBlock(sanitizeMeshEdgeForLlm(spouse))).toMatchSnapshot();
  });

  it("buildInterviewMessages — persona + gathered-state block", () => {
    const state: InterviewGatheredEvent[] = [
      { date: "2004-06-15", category: "marriage", precision: "month" },
      { date: "2011-02-01", category: "relocation", precision: "exact" },
    ];
    expect(
      buildInterviewMessages([{ role: "user", content: "I married in 2004" }], "en", state),
    ).toMatchSnapshot();
  });
});
