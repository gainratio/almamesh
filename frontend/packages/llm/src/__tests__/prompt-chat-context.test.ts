import { describe, expect, it } from "vitest";

import { buildChatMessages } from "../prompt";
import type { SanitizedChart } from "../sanitize";

// A real-shape SanitizedChart with an exalted planet + a current dasha so the
// engine-derived facts block has identifiable, assertable content.
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
      houses_ruled: [],
      is_yogakaraka: false,
    },
  },
  houses: {},
  yogas: [],
  dashas: {
    maha_dasha_sequence: [],
    current_maha: { lord: "sun", duration_years: 6, months_remaining: 48 },
    current_antar: null,
    current_pratyantar: null,
  },
};

// A distinctive sentinel that could only come from the already-generated reading,
// not from the deterministic facts block.
const INTERP_TEXT = "Summary: A disciplined, public-facing vocation drives this chart.";

function lastUserContent(messages: ReturnType<typeof buildChatMessages>): string {
  return messages[messages.length - 1].content ?? "";
}

describe("buildChatMessages — chart-facts + interpretation grounding (LOCK)", () => {
  it("carries BOTH the chart facts block AND the interpretation text when a reading is provided", () => {
    const msgs = buildChatMessages(CHART, "What does my chart say about work?", "layman", [], [], INTERP_TEXT);
    const userTurn = lastUserContent(msgs);
    // The engine-derived facts block is present (sanitized framing + a real fact).
    expect(userTurn).toMatch(/sanitized/i);
    expect(userTurn).toMatch(/capricorn/i); // exalted Mars sign from the facts block
    expect(userTurn).toMatch(/exalted/i);
    // AND the already-generated reading is folded in, labelled as grounding.
    expect(userTurn).toContain("already generated");
    expect(userTurn).toContain(INTERP_TEXT);
  });

  it("falls back to facts-only (no reading block) when no interpretation is provided", () => {
    const msgs = buildChatMessages(CHART, "What does my chart say about work?");
    const userTurn = lastUserContent(msgs);
    // Facts block still present...
    expect(userTurn).toMatch(/sanitized/i);
    expect(userTurn).toMatch(/capricorn/i);
    // ...but no "already generated" reading block and no sentinel text.
    expect(userTurn).not.toContain("already generated");
    expect(userTurn).not.toContain(INTERP_TEXT);
  });

  it("treats a blank/whitespace interpretation as absent (facts-only)", () => {
    const msgs = buildChatMessages(CHART, "Anything?", "layman", [], [], "   ");
    const userTurn = lastUserContent(msgs);
    expect(userTurn).not.toContain("already generated");
  });
});

const YEAR_2027 = { start: "2027-01-01", end: "2027-12-31" };

describe("buildChatMessages with a pin", () => {
  it("adds the pinned rule to the system prompt only when a pin is given", () => {
    const plain = buildChatMessages(CHART, "Will work get easier?");
    const pinned = buildChatMessages(
      CHART, "Will work get easier?", "layman", [], [], undefined, "en", undefined, undefined, undefined, false,
      { ...YEAR_2027, relative: "future" },
    );
    expect(plain[0]?.content).not.toContain("PINNED PERIOD");
    expect(pinned[0]?.content).toContain("PINNED PERIOD: this conversation is about 2027-01-01 to 2027-12-31");
    expect(pinned[0]?.content).toContain("future tense");
  });

  it("is byte-identical without a pin (snapshot-locked prompts stay put)", () => {
    const before = buildChatMessages(CHART, "q", "layman", [], [], undefined, "en", undefined, undefined, undefined, false);
    const after = buildChatMessages(CHART, "q", "layman", [], [], undefined, "en", undefined, undefined, undefined, false, undefined);
    expect(after).toEqual(before);
  });
});
