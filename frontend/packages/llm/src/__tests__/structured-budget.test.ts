// Spec 062 (LLM delta 6): budget the 6× chart dump.
//
// The structured generator used to pretty-print the FULL sanitized chart JSON
// into all six section prompts. Now:
//   - every section embeds COMPACT JSON (no two-space pretty printing);
//   - when the compact full chart exceeds SECTION_CHART_TOKEN_BUDGET
//     (estimateTokens guard), the slim-eligible sections (remedial +
//     upcoming_periods) get only the slices their tasks actually read —
//     planets + dashas + yogas — while core/yoga/guidance keep the full chart;
//   - under the budget, nothing is slimmed (no information loss on small charts).

import { describe, expect, it } from "vitest";

import { estimateTokens } from "../budget";
import {
  buildSectionMessages,
  SECTION_CHART_TOKEN_BUDGET,
} from "../structured-interpretation";
import type { SanitizedChart } from "../sanitize";

const SMALL_CHART: SanitizedChart = {
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
      houses_ruled: [10, 11],
      is_yogakaraka: true,
    },
  },
  houses: { 1: { house_number: 1, sign: "aries" } } as unknown as SanitizedChart["houses"],
  yogas: [],
  dashas: {
    maha_dasha_sequence: [],
    current_maha: { lord: "sun", duration_years: 6, months_remaining: 48 },
    current_antar: null,
    current_pratyantar: null,
  },
};

// Pad the houses map with synthetic bulk until the compact chart JSON is
// guaranteed past the token budget — the shape mirrors real house rows but the
// content is meaningless filler (synthetic fixture; no real birth data).
function oversizedChart(): SanitizedChart {
  const bulk: Record<string, unknown> = {};
  const target = (SECTION_CHART_TOKEN_BUDGET + 512) * 4; // chars
  let size = 0;
  let i = 0;
  while (size < target) {
    const row = {
      house_number: (i % 12) + 1,
      sign: "aries",
      filler: `synthetic-padding-${"x".repeat(64)}-${i}`,
    };
    bulk[`h${i}`] = row;
    size += JSON.stringify(row).length + 8;
    i += 1;
  }
  return { ...SMALL_CHART, houses: bulk as unknown as SanitizedChart["houses"] };
}

function userContent(section: Parameters<typeof buildSectionMessages>[0], chart: SanitizedChart): string {
  const msgs = buildSectionMessages(section, chart, "layman", false, "en");
  return msgs[msgs.length - 1].content ?? "";
}

describe("buildSectionMessages — compact chart JSON (Spec 062 delta 6)", () => {
  it("embeds COMPACT JSON, not the old pretty-printed dump", () => {
    const content = userContent("core", SMALL_CHART);
    expect(content).toContain('"ayanamsa_value":24.1'); // compact — no space after :
    expect(content).not.toContain('  "ayanamsa_value"'); // no 2-space indentation
  });

  it("keeps the full chart for every section when under the token budget", () => {
    for (const section of ["core", "remedial", "upcoming_periods"] as const) {
      const content = userContent(section, SMALL_CHART);
      expect(content).toContain('"houses"');
      expect(content).toContain('"lagna"');
    }
  });
});

describe("buildSectionMessages — per-section slimming over the budget", () => {
  const chart = oversizedChart();

  it("slims remedial + upcoming_periods while keeping timing only in Road Ahead", () => {
    for (const section of ["remedial", "upcoming_periods"] as const) {
      const content = userContent(section, chart);
      expect(content).toContain('"planets"');
      expect(content).toContain('"yogas"');
      if (section === "upcoming_periods") {
        expect(content).toContain('"dashas"');
      } else {
        expect(content).not.toContain('"dashas"');
      }
      expect(content).not.toContain('"houses"');
      expect(content).not.toContain('"ayanamsa_value"');
      // The slimmed prompt actually fits meaningfully under the oversized one.
      expect(estimateTokens(content)).toBeLessThan(SECTION_CHART_TOKEN_BUDGET);
    }
  });

  it("keeps the FULL chart for core (and the other narrative sections)", () => {
    for (const section of ["core", "yoga", "guidance1", "guidance2"] as const) {
      const content = userContent(section, chart);
      expect(content).toContain('"houses"');
      expect(content).toContain('"lagna"');
    }
  });

  it("rides predictive facts only on the slimmed timeline section", () => {
    const withPredictive: SanitizedChart = {
      as_of: { date: "2026-01-01", basis: "chart" },
      ...chart,
      predictive: {
        strength: {
          sav_total: 337,
          shadbala: [
            { planet: "saturn", total_rupas: 5.21, required_rupas: 5, meets_minimum: true },
          ],
        },
      },
    };
    const remedial = userContent("remedial", withPredictive);
    const upcoming = userContent("upcoming_periods", withPredictive);
    expect(remedial).not.toContain("ENGINE PREDICTIVE CONTEXT");
    expect(remedial).not.toContain("337");
    expect(upcoming).toContain("ENGINE PREDICTIVE CONTEXT");
    expect(upcoming).toContain("337");
  });
});
