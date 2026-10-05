import { describe, expect, it } from "vitest";

import type { ChatTurn } from "../budget";
import { buildChatMessages } from "../prompt";
import type { SanitizedChart } from "../sanitize";

// A real-shape SanitizedChart: the prompt builder now renders the COMPACT facts
// block (lagna + planets + dasha + yogas), so the fixture must carry those fields.
// The Sun planet lets the layout assertions check that the chart payload rides
// only on the final user turn.
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
    Sun: {
      name: "Sun",
      longitude: 100.2,
      latitude: 0,
      distance: 1,
      speed: 1,
      is_retrograde: false,
      sign: "cancer",
      sign_degrees: 10.2,
      sign_lord: "moon",
      nakshatra: "pushya",
      nakshatra_pada: 2,
      nakshatra_lord: "saturn",
      house: 4,
      dignity: "neutral",
      is_combust: false,
      combustion_separation_deg: null,
      houses_ruled: [],
      is_yogakaraka: false,
    },
  },
  houses: {},
  yogas: [],
  dashas: undefined,
};

describe("buildChatMessages — multi-turn history", () => {
  it("emits [system, user] only when no history is given (back-compatible)", () => {
    const msgs = buildChatMessages(CHART, "Where is my Moon?");
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[1].content).toContain("Where is my Moon?");
  });

  it("inserts prior turns between system and the final chart-bearing user turn", () => {
    const history: ChatTurn[] = [
      { role: "user", content: "Tell me about my career." },
      { role: "assistant", content: "Your 10th house is strong." },
    ];
    const msgs = buildChatMessages(CHART, "And my finances?", "layman", history);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[1].content).toBe("Tell me about my career.");
    expect(msgs[2].content).toBe("Your 10th house is strong.");
    expect(msgs[3].content).toContain("And my finances?");
  });

  it("puts the chart JSON ONLY on the latest user turn, not on history turns", () => {
    const history: ChatTurn[] = [{ role: "user", content: "Earlier question" }];
    const msgs = buildChatMessages(CHART, "Latest question", "layman", history);
    // layout: [system, history-user, final-user]
    expect(msgs).toHaveLength(3);
    // history turn carries no chart payload
    expect(msgs[1].content).not.toContain("Sun");
    // final user turn carries the sanitized chart
    expect(msgs[2].content).toContain("Sun");
  });
});
