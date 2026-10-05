import { describe, expect, it } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { buildSectionMessages } from "../structured-interpretation";
import { sanitizeChartForLlm } from "../sanitize";
import {
  DOMAINS_CTX_FIXTURE,
  STRENGTH_CTX_FIXTURE,
  TRANSIT_CTX_FIXTURE,
  VARGA_CTX_FULL_FIXTURE,
} from "./predictive-fixture";

// A canonical engine SiderealChart from the committed golden fixture — carries
// NO predictive contexts (transit_context/strength_context/varga_context_full/
// domains_context all absent), so sanitizing it yields a natal-only chart.
const goldenCharts = golden as Record<string, SiderealChart>;
const [firstKey] = Object.keys(goldenCharts);
const realChart: SiderealChart = goldenCharts[firstKey];

// The same chart, ENRICHED with the full predictive superset (mirrors
// structured-interpretation.test.ts's `predictiveChart`).
const predictiveChart = {
  ...realChart,
  transit_context: TRANSIT_CTX_FIXTURE,
  strength_context: STRENGTH_CTX_FIXTURE,
  varga_context_full: VARGA_CTX_FULL_FIXTURE,
  domains_context: DOMAINS_CTX_FIXTURE,
} as unknown as SiderealChart;

const NOW = new Date("2030-01-01T00:00:00.000Z");

const NATAL_ONLY = sanitizeChartForLlm(realChart, { basis: "chart", instant: NOW });
const WITH_PREDICTIVE = sanitizeChartForLlm(predictiveChart, { basis: "chart", instant: NOW });

function systemText(msgs: { role: string; content: string }[]): string {
  return msgs.find((m) => m.role === "system")?.content ?? "";
}

describe("predictive salience in the interpretation prompt", () => {
  it("when predictive is PRESENT, the system prompt REQUIRES using current timing and never denies transit data", () => {
    const msgs = buildSectionMessages("current_sky", WITH_PREDICTIVE, "layman");
    const sys = systemText(msgs);
    expect(sys).toMatch(/ENGINE PREDICTIVE CONTEXT/i);
    expect(sys).toMatch(/MUST|REQUIRED/); // directive, not "you MAY"
    expect(sys).not.toMatch(/no .* transit data/i); // contradiction removed
  });

  it("when predictive is ABSENT, it stays honest — natal-only, no invented timing", () => {
    const msgs = buildSectionMessages("core", NATAL_ONLY, "layman");
    const sys = systemText(msgs);
    expect(sys).toMatch(/natal/i);
    expect(sys).not.toMatch(/ENGINE PREDICTIVE CONTEXT/i);
  });

  it("keeps timing data out of a stable natal section even when a compatibility caller supplies it", () => {
    const msgs = buildSectionMessages("core", WITH_PREDICTIVE, "layman");
    const wireText = msgs.map((message) => message.content).join("\n");

    expect(wireText).toMatch(/STABLE NATAL ONLY/);
    expect(wireText).not.toMatch(/ENGINE PREDICTIVE CONTEXT/);
    expect(wireText).not.toContain('"dashas"');
    expect(wireText).not.toContain("months_remaining");
    expect(wireText).not.toContain("start_month");
  });
});
