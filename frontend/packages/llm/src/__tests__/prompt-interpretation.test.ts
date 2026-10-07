import { describe, expect, it } from "vitest";
import type { VedicInterpretation } from "@almamesh/shared-types";

import { buildChatMessages, serializeInterpretationForChat, INTERP_TOKEN_BUDGET } from "../prompt";
import { estimateTokens } from "../budget";
import type { SanitizedChart } from "../sanitize";

// A minimal SanitizedChart so we can build the chat prompt with/without a reading.
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
  planets: {},
  houses: {},
  yogas: [],
  dashas: {
    maha_dasha_sequence: [],
    current_maha: { lord: "sun", duration_years: 6, months_remaining: 48 },
    current_antar: null,
    current_pratyantar: null,
  },
};

// A realistic reading with dual-mode fields, plus a null/empty section to prove
// those are skipped.
const INTERP: VedicInterpretation = {
  summary: {
    layman: "A grounded, determined chart with a strong public vocation.",
    technical: "Exalted 10th-lord drive defines a public vocation of duty.",
  },
  strengths: [
    {
      title: "Disciplined Drive",
      layman: "You finish what you start and earn trust through consistency.",
      technical: "Exalted Mars in the 10th lends sustained karmic momentum.",
    },
  ],
  challenges: [
    {
      title: "Restlessness",
      layman: "You can burn out chasing the next milestone.",
      technical: "Mars-Saturn tension can over-tax the nervous system.",
    },
  ],
  life_themes: [
    {
      title: "Public Service",
      layman: "Your path bends toward visible, responsible roles.",
      technical: "10th-lord strength foregrounds a vocation of duty.",
    },
  ],
  integrated_yoga_narrative: {
    layman: "Several patterns reinforce leadership and resilience.",
    technical: "Ruchaka-adjacent dignities concentrate authority.",
  },
  career_guidance: {
    layman: "Roles with clear ladders and accountability suit you.",
    technical: "10th-house emphasis favors institutional advancement.",
  },
  // A null section that must be skipped entirely.
  health_guidance: null,
  // An empty section that must also be skipped.
  finances_guidance: { layman: "", technical: "" },
};

describe("serializeInterpretationForChat", () => {
  it("includes the summary and the layman text for layman mode", () => {
    const out = serializeInterpretationForChat(INTERP, "layman");
    expect(out).toContain("A grounded, determined chart");
    expect(out).toContain("You finish what you start");
    expect(out).toContain("Disciplined Drive");
    // The technical variant of that strength must NOT appear in layman mode.
    expect(out).not.toContain("Exalted Mars in the 10th lends");
    // The technical SUMMARY voice must NOT leak into layman mode.
    expect(out).not.toContain("Exalted 10th-lord drive");
  });

  it("includes the technical text for expert mode", () => {
    const out = serializeInterpretationForChat(INTERP, "expert");
    expect(out).toContain("Exalted Mars in the 10th lends");
    expect(out).not.toContain("You finish what you start");
  });

  it("renders the summary in the SELECTED voice — layman vs expert differ", () => {
    const layman = serializeInterpretationForChat(INTERP, "layman");
    const expert = serializeInterpretationForChat(INTERP, "expert");
    // Layman summary in the layman serialization; technical summary in expert.
    expect(layman).toContain("A grounded, determined chart with a strong public vocation.");
    expect(expert).toContain("Exalted 10th-lord drive defines a public vocation of duty.");
    // And neither leaks the other's summary voice.
    expect(layman).not.toContain("Exalted 10th-lord drive defines");
    expect(expert).not.toContain("A grounded, determined chart with a strong public vocation.");
  });

  it("omits null and empty sections", () => {
    const out = serializeInterpretationForChat(INTERP, "layman");
    // career_guidance is present...
    expect(out).toContain("Roles with clear ladders");
    // ...but health_guidance is null and finances_guidance is empty.
    expect(out.toLowerCase()).not.toContain("health");
    expect(out.toLowerCase()).not.toContain("finances");
  });

  it("includes the Road Ahead windows when the reading carries upcoming_periods", () => {
    const withRoadAhead: VedicInterpretation = {
      ...INTERP,
      upcoming_periods: [
        {
          title: "Sun antardasha — 2027-01 to 2028-01",
          layman: "A visible, vital year for your work.",
          technical: "The Sun period (2027-01 to 2028-01) foregrounds its ruled houses.",
        },
      ],
    };
    const out = serializeInterpretationForChat(withRoadAhead, "layman");
    expect(out).toContain("Upcoming periods:");
    expect(out).toContain("Sun antardasha — 2027-01 to 2028-01");
    expect(out).toContain("A visible, vital year for your work.");
  });

  it("emits no Upcoming-periods group for a legacy reading without the section", () => {
    // INTERP predates the 6th section — serialization must stay unchanged.
    expect("upcoming_periods" in INTERP).toBe(false);
    const out = serializeInterpretationForChat(INTERP, "layman");
    expect(out).not.toContain("Upcoming periods");
  });
});

describe("serializeInterpretationForChat — budget", () => {
  it("truncates an over-budget reading to <= INTERP_TOKEN_BUDGET with an ellipsis marker", () => {
    const huge = "x".repeat(INTERP_TOKEN_BUDGET * 4 * 5);
    const bloated: VedicInterpretation = {
      ...INTERP,
      summary: { layman: huge, technical: huge },
    };
    const out = serializeInterpretationForChat(bloated, "layman");
    expect(estimateTokens(out)).toBeLessThanOrEqual(INTERP_TOKEN_BUDGET);
    expect(out).toContain("reading truncated");
  });
});

describe("buildChatMessages — interpretation injection", () => {
  it("injects the 'Your chart reading' block with the interpretation content", () => {
    const text = serializeInterpretationForChat(INTERP, "layman");
    const msgs = buildChatMessages(CHART, "How is my career?", "layman", [], [], text);
    const userTurn = msgs[msgs.length - 1].content ?? "";
    expect(userTurn).toMatch(/Your chart reading/i);
    expect(userTurn).toContain("A grounded, determined chart");
    expect(userTurn).toContain("Roles with clear ladders");
  });

  it("places the reading AFTER the facts block and BEFORE retrieved context", () => {
    const text = serializeInterpretationForChat(INTERP, "layman");
    const msgs = buildChatMessages(CHART, "q", "layman", [], ["Earlier note."], text);
    const userTurn = msgs[msgs.length - 1].content ?? "";
    const factsIdx = userTurn.indexOf("Chart facts");
    const readingIdx = userTurn.indexOf("Your chart reading");
    const ragIdx = userTurn.indexOf("Relevant earlier conversation");
    expect(factsIdx).toBeGreaterThanOrEqual(0);
    expect(readingIdx).toBeGreaterThan(factsIdx);
    expect(ragIdx).toBeGreaterThan(readingIdx);
  });

  it("is byte-identical to the no-interpretation prompt when no reading is passed (fallback)", () => {
    const withParam = buildChatMessages(CHART, "q", "layman", [], []);
    const without = buildChatMessages(CHART, "q", "layman", [], [], undefined);
    expect(JSON.stringify(without)).toBe(JSON.stringify(withParam));
    // And the legacy 5-arg call must match too.
    const legacy = buildChatMessages(CHART, "q", "layman");
    expect(JSON.stringify(without)).toBe(JSON.stringify(legacy));
  });
});
