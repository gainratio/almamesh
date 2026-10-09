import { describe, expect, it } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";
import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import { buildChatMessages } from "../prompt";
import { periodAnalysisInstant, sanitizeChartForLlm } from "../sanitize";

// Seeded the way snapshot-egress.test.ts seeds it: the birth place rides on the chart object.
const BIRTH_PLACE_CHART = {
  ...(golden as Record<string, SiderealChart>)["1988-08-08T01:14:00+00:00"],
  location_name: "Bengaluru, Karnataka",
  latitude: 12.9716,
  longitude: 77.5946,
} as unknown as SiderealChart;
const BIRTH_PLACE = [/Bengaluru/i, /Karnataka/i, /12\.97/, /77\.59/];
// Planets legitimately carry ecliptic "latitude" keys, so the key names are checked on the prompt only.
const FORBIDDEN = [...BIRTH_PLACE, /"latitude"/, /"longitude"/];

describe("the birth place never reaches the model", () => {
  it("is absent from the chat prompt, even when the user names other places", () => {
    const sanitized = sanitizeChartForLlm(BIRTH_PLACE_CHART, periodAnalysisInstant("2026-06-01", "2026-06-30"));
    // The chat facts block is its own allowlist, so the sanitizer is pinned directly too.
    for (const pattern of BIRTH_PLACE) expect(JSON.stringify(sanitized)).not.toMatch(pattern);
    const messages = buildChatMessages(
      sanitized,
      "How was June? I was in LA the first half, then Bogotá.",
    );
    const body = JSON.stringify(messages);
    for (const pattern of FORBIDDEN) expect(body).not.toMatch(pattern);
    expect(body).toContain("never name, guess or echo the birth place");
    expect(body).toContain("Bogotá");
  });
});
