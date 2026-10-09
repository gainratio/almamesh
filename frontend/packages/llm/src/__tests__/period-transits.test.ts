import type { TransitContext } from "@almamesh/browser/types";
import { describe, expect, it } from "vitest";

import { COVERED_EVENTS, restrictTransitsToPeriod, timelineCutoffNote } from "../period-transits";
import { TRANSIT_CTX_FIXTURE } from "./predictive-fixture";

const saturn = TRANSIT_CTX_FIXTURE.gochara.placements.saturn;
const [saturnIngress] = TRANSIT_CTX_FIXTURE.timeline.events;
const CTX: TransitContext = {
  ...TRANSIT_CTX_FIXTURE,
  gochara: {
    ...TRANSIT_CTX_FIXTURE.gochara,
    placements: {
      saturn,
      moon: { ...saturn, graha: "moon", sign: "aries" },
      sun: { ...saturn, graha: "sun", sign: "capricorn" },
      jupiter: { ...saturn, graha: "jupiter", sign: "cancer" },
      mars: { ...saturn, graha: "mars", sign: "leo" },
    },
  },
  timeline: {
    ...TRANSIT_CTX_FIXTURE.timeline,
    events: [
      saturnIngress, // 2030-03-29
      { ...saturnIngress, date: "2030-07-02T00:00:00Z", graha: "jupiter", descriptor: "Jupiter enters Cancer" },
    ],
  },
};

describe("restrictTransitsToPeriod", () => {
  it("a month keeps only slow grahas and only that month's events", () => {
    const { context, notes } = restrictTransitsToPeriod(CTX, { start: "2030-03-01", end: "2030-03-31" }, true);
    expect(Object.keys(context.gochara.placements).sort()).toEqual(["jupiter", "mars", "saturn"]);
    expect(context.timeline.events.map((event) => event.date)).toEqual(["2030-03-29T00:00:00Z"]);
    expect(context.slow_hits).toEqual([]); // the fixture's hit is 2030-05-20
    expect(notes).toEqual([]);
  });

  it("keeps a slow hit whose exact day falls inside the period", () => {
    const { context } = restrictTransitsToPeriod(CTX, { start: "2030-05-01", end: "2030-05-31" }, true);
    expect(context.slow_hits.map((hit) => hit.exact)).toEqual(["2030-05-20T00:00:00Z"]);
  });

  it("a single day keeps every graha, the Moon included", () => {
    const { context } = restrictTransitsToPeriod(CTX, { start: "2030-03-29", end: "2030-03-29" }, false);
    expect(Object.keys(context.gochara.placements)).toContain("moon");
    expect(context.timeline.events).toHaveLength(1);
  });

  it("notes when the period runs past the engine's timeline window", () => {
    const { notes } = restrictTransitsToPeriod(CTX, { start: "2030-01-01", end: "2031-06-30" }, true);
    expect(notes).toEqual([timelineCutoffNote("2031-01-01T00:00:00Z")]);
    expect(notes[0]).toContain("2031-01");
  });
});

describe("COVERED_EVENTS", () => {
  it("claims only what the engine checks before Inc B", () => {
    expect(COVERED_EVENTS).toEqual(["jupiter_ingress", "saturn_ingress", "dasha_change", "sade_sati_phase"]);
    expect(COVERED_EVENTS).not.toContain("mars_ingress");
  });
});
