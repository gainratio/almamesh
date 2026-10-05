import { describe, expect, it } from "vitest";

import { buildChatMessages, buildInterpretationMessages } from "../prompt";
import type { SanitizedChart } from "../sanitize";

// A minimal SanitizedChart sufficient to build either prompt.
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

describe("buildChatMessages — language awareness", () => {
  it("injects a Spanish instruction into the system prompt for es", () => {
    const msgs = buildChatMessages(CHART, "How is my year?", "layman", [], [], undefined, "es");
    const system = msgs[0].content ?? "";
    expect(system).toMatch(/Spanish/);
    expect(system).toMatch(/Español/);
    // Unambiguous: respond ENTIRELY in the target language.
    expect(system).toMatch(/entire response in Spanish/i);
  });

  it("injects a Portuguese instruction into the system prompt for pt", () => {
    const msgs = buildChatMessages(CHART, "How is my year?", "layman", [], [], undefined, "pt");
    const system = msgs[0].content ?? "";
    expect(system).toMatch(/Portuguese/);
    expect(system).toMatch(/Português/);
    expect(system).toMatch(/entire response in Portuguese/i);
  });

  it("preserves Sanskrit / astrology proper-noun guidance in non-English instructions", () => {
    const msgs = buildChatMessages(CHART, "q", "layman", [], [], undefined, "es");
    const system = msgs[0].content ?? "";
    // Proper nouns / Sanskrit terms may stay in their canonical form.
    expect(system.toLowerCase()).toMatch(/sanskrit|proper noun|nakshatra/);
  });

  it("does NOT mention Spanish/Portuguese for en (default)", () => {
    const enExplicit = buildChatMessages(CHART, "q", "layman", [], [], undefined, "en")[0].content ?? "";
    const enDefault = buildChatMessages(CHART, "q", "layman")[0].content ?? "";
    expect(enExplicit).not.toMatch(/Spanish|Español|Portuguese|Português/);
    // Default (no language arg) is back-compatible and also English-only.
    expect(enDefault).not.toMatch(/Spanish|Español|Portuguese|Português/);
  });
});

describe("buildInterpretationMessages — language awareness", () => {
  it("injects a Spanish instruction into the system prompt for es", () => {
    const msgs = buildInterpretationMessages(CHART, "layman", "es");
    const system = msgs[0].content ?? "";
    expect(system).toMatch(/Spanish/);
    expect(system).toMatch(/entire response in Spanish/i);
  });

  it("injects a Portuguese instruction into the system prompt for pt", () => {
    const msgs = buildInterpretationMessages(CHART, "layman", "pt");
    const system = msgs[0].content ?? "";
    expect(system).toMatch(/Portuguese/);
    expect(system).toMatch(/entire response in Portuguese/i);
  });

  it("is English-only for the default (no language) call", () => {
    const system = buildInterpretationMessages(CHART, "layman")[0].content ?? "";
    expect(system).not.toMatch(/Spanish|Español|Portuguese|Português/);
  });
});
