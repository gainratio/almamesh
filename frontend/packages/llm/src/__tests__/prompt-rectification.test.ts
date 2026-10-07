// Spec 062 (LLM delta 3): chat grounded in the CONFIRMED rectification record.
//
// The optional `ChatRectificationContext` carries ONLY the PII-safe slice of a
// confirmed record — the qualitative band, the entered vs working rising SIGNS,
// and the cusp status. NO dates, NO clock times, NO percentages: the type is
// the boundary, and these tests lock both the labelled line and the
// byte-identical absence path (no record → today's prompt, byte for byte).

import { describe, expect, it } from "vitest";

import { buildChatMessages, type ChatRectificationContext } from "../prompt";
import type { SanitizedChart } from "../sanitize";

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
};

const CUSP_RECORD: ChatRectificationContext = {
  band: "leans",
  originalSign: "pisces",
  rectifiedSign: "aquarius",
  mode: "cusp",
};

describe("buildChatMessages — rectification record grounding (Spec 062 delta 3)", () => {
  it("carries a labelled line with band + entered/working signs + cusp status", () => {
    const msgs = buildChatMessages(
      CHART,
      "What is my rising sign?",
      "layman",
      [],
      [],
      undefined,
      "en",
      undefined,
      CUSP_RECORD,
    );
    const userTurn = msgs[msgs.length - 1].content ?? "";
    expect(userTurn).toContain("Birth-time rectification (engine record");
    expect(userTurn).toContain("band: leans");
    expect(userTurn).toContain("entered rising sign: pisces");
    expect(userTurn).toContain("working rising sign: aquarius");
    expect(userTurn).toMatch(/cusp/i);
    // Honesty framing: the band is a convention, never a verdict.
    expect(userTurn).toMatch(/never a verdict/i);
  });

  it("describes the window (unknown/rough time) mode without inventing a cusp", () => {
    const msgs = buildChatMessages(
      CHART,
      "q",
      "layman",
      [],
      [],
      undefined,
      "en",
      undefined,
      { band: "consistent", originalSign: null, rectifiedSign: "leo", mode: "window" },
    );
    const userTurn = msgs[msgs.length - 1].content ?? "";
    expect(userTurn).toContain("band: consistent");
    expect(userTurn).toContain("no recorded rising sign");
    expect(userTurn).toContain("working rising sign: leo");
    expect(userTurn).toMatch(/unknown|rough/i);
  });

  it("carries NO dates, times, or percentages (PII boundary of the slice)", () => {
    const msgs = buildChatMessages(
      CHART,
      "q",
      "layman",
      [],
      [],
      undefined,
      "en",
      undefined,
      CUSP_RECORD,
    );
    const userTurn = msgs[msgs.length - 1].content ?? "";
    const rectSection = userTurn.slice(userTurn.indexOf("Birth-time rectification"));
    const beforeQuestion = rectSection.slice(0, rectSection.indexOf("Question:"));
    expect(beforeQuestion).not.toMatch(/\d{4}-\d{2}/); // no dates, month or day
    expect(beforeQuestion).not.toMatch(/\d{1,2}:\d{2}/); // no clock times
    expect(beforeQuestion).not.toMatch(/\d+\s*%/); // no percent confidence
  });

  it("is byte-identical to today's prompt when no record exists", () => {
    const withUndefined = buildChatMessages(
      CHART,
      "q",
      "layman",
      [],
      [],
      undefined,
      "en",
      undefined,
      undefined,
    );
    const legacyArity = buildChatMessages(CHART, "q");
    expect(withUndefined).toEqual(legacyArity);
    const joined = legacyArity.map((m) => m.content ?? "").join("\n");
    expect(joined).not.toContain("Birth-time rectification");
  });
});
