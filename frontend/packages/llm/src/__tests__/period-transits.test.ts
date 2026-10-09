import type { TransitContext } from "@almamesh/browser/types";
import { describe, expect, it } from "vitest";

import { COVERED_EVENTS, placementsAsOfNote, restrictTransitsToPeriod, timelineCutoffNote } from "../period-transits";
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
    expect(notes).toEqual([placementsAsOfNote("2030-03-01")]);
  });

  it("labels a multi-day result's placements as of the period's first day", () => {
    const { notes } = restrictTransitsToPeriod(CTX, { start: "2030-03-01", end: "2030-03-31" }, true);
    expect(notes).toContain(
      "Planet signs and houses are as of 2030-03-01, the period's first day. Sign changes and stations during the period are listed in the timeline.",
    );
  });

  it("a single day needs no as-of label", () => {
    const { notes } = restrictTransitsToPeriod(CTX, { start: "2030-03-29", end: "2030-03-29" }, false);
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
    expect(notes).toEqual([placementsAsOfNote("2030-01-01"), timelineCutoffNote("2031-01-01T00:00:00Z")]);
    expect(notes[1]).toContain("2031-01");
  });

  it("notes a window that ends during the period's last day, to the minute", () => {
    const ctx = { ...CTX, timeline: { ...CTX.timeline, window_end: "2028-12-31T06:00:00Z" } };
    const { notes } = restrictTransitsToPeriod(ctx, { start: "2028-01-01", end: "2028-12-31" }, true);
    expect(notes).toContain("Transit events are listed only until 2028-12-31 06:00 UTC. Ask about a later start for the rest.");
  });

  it("adds no cutoff note when the window outlasts the period's last day", () => {
    const ctx = { ...CTX, timeline: { ...CTX.timeline, window_end: "2028-01-01T06:00:00Z" } };
    const { notes } = restrictTransitsToPeriod(ctx, { start: "2027-01-01", end: "2027-12-31" }, true);
    expect(notes.some((note) => note.startsWith("Transit events are listed only until"))).toBe(false);
  });

  it("a 731-day period outlasts the 24-month window (730.5 days) and names the exact UTC instant", () => {
    const ctx = { ...CTX, timeline: { ...CTX.timeline, window_end: "2028-12-31T12:00:00Z" } };
    const { notes } = restrictTransitsToPeriod(ctx, { start: "2027-01-01", end: "2028-12-31" }, true);
    expect(notes).toContain("Transit events are listed only until 2028-12-31 12:00 UTC. Ask about a later start for the rest.");
  });
});

describe("COVERED_EVENTS", () => {
  it("claims exactly what the Inc B engine timeline checks", () => {
    expect(COVERED_EVENTS).toEqual([
      "jupiter_ingress",
      "saturn_ingress",
      "mars_ingress",
      "rahu_ingress",
      "ketu_ingress",
      "jupiter_station",
      "saturn_station",
      "mars_station",
      "dasha_change",
      "sade_sati_phase",
    ]);
  });
});
