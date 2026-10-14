// Chat tool layer redesign (2026-10-14, Task 5): what the app already knows rides in the prompt —
// today's date and zone, the thread's trip, the natal facts in every mode — and two short tool
// lines replace the tool-routing blocks. The old tool names must not survive anywhere in a prompt.
import { describe, expect, it } from "vitest";

import { buildChatMessages, type ThreadFacts } from "../prompt";
import type { PinnedPrompt } from "../period-pin";
import type { SanitizedChart } from "../sanitize";

const CHART = {
  as_of: { basis: "period", start: "2019-05-01", end: "2019-05-31" },
  ayanamsa_value: 24.1, lagna: { sign: "Scorpio-LAGNA-MARK" }, planets: {}, houses: {}, yogas: [],
} as unknown as SanitizedChart;

const MAY_2019_VADODARA: PinnedPrompt = {
  start: "2019-05-01", end: "2019-05-31", relative: "past", granularity: "month", label: "May 2019",
  place: { label: "Vadodara, India", timezone: "Asia/Kolkata" },
};
const NOW = "Wednesday 14 October 2026, America/Los_Angeles";
const TRIP_THREAD: ThreadFacts = { now: NOW, trip: { label: "May 2019", place: "Vadodara, India", timezone: "Asia/Kolkata" } };
const TODAY_THREAD: ThreadFacts = { now: NOW };

const TOOLS_LINE =
  "TOOLS: read_period reads any span (one call per span; never split a range into months). travel moves this conversation only when asked. Finish every turn by calling answer.";
const OLD_TOOL_NAMES = [
  "resolve_place", "get_timing", "get_period_reading", "get_period_detail", "get_natal_summary",
  "get_trip_context", "get_current_datetime", "get_chart_facts", "time_travel", "place_ref", "needs_place",
];

const trip = () =>
  buildChatMessages(CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, true, MAY_2019_VADODARA, TRIP_THREAD);
const today = () =>
  buildChatMessages(CHART, "How is work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, true, undefined, TODAY_THREAD);

describe("a trip prompt carries today, the trip and the natal facts", () => {
  it("states today's date and zone", () => {
    expect(trip()[0]?.content).toContain(`NOW: today is ${NOW}.`);
  });

  it("states the thread's trip and where the user lived", () => {
    expect(trip()[0]?.content).toContain("THIS THREAD: a trip to May 2019, when the user lived in Vadodara, India (Asia/Kolkata).");
  });

  it("keeps the pinned period and its tense", () => {
    const system = trip()[0]?.content ?? "";
    expect(system).toContain("PINNED PERIOD: this conversation is about 2019-05-01 to 2019-05-31 (relative: past).");
    expect(system).toContain("Use the past tense: this period is over.");
  });

  it("carries the compact natal facts block in the user turn (trips used to omit it)", () => {
    const user = trip().at(-1)?.content ?? "";
    expect(user).toContain("Chart facts (sanitized; no identifying information):");
    expect(user).toContain("Scorpio-LAGNA-MARK");
  });

  it("ends the system prompt with the two-tool line", () => {
    expect(trip()[0]?.content).toContain(TOOLS_LINE);
  });

  it.each(OLD_TOOL_NAMES)("names no old tool: %s", (name) => {
    for (const message of [...trip(), ...today()]) expect(message.content).not.toContain(name);
  });
});

describe("a today prompt", () => {
  it("states today's date and the tool line, and no trip", () => {
    const system = today()[0]?.content ?? "";
    expect(system).toContain(`NOW: today is ${NOW}.`);
    expect(system).toContain(TOOLS_LINE);
    expect(system).not.toContain("THIS THREAD");
    expect(system).not.toContain("PINNED PERIOD");
  });

  it("drops the present-day routing rule and the place rules", () => {
    const system = today()[0]?.content ?? "";
    expect(system).not.toContain("PRESENT-DAY PERIODS");
    expect(system).not.toContain("PLACES:");
  });
});

describe("a prompt without thread facts (single-pass callers with no tools)", () => {
  it("names no tool and no date line", () => {
    const system = buildChatMessages(CHART, "Where is my Mars?")[0]?.content ?? "";
    expect(system).not.toContain("NOW:");
    expect(system).not.toContain("TOOLS:");
    expect(system).not.toContain("read_period");
  });

  // Until every caller passes ThreadFacts, a pin with a label and a place still names the trip.
  it("a pinned trip still gets its THIS THREAD line from the pin", () => {
    const system = buildChatMessages(CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, true, MAY_2019_VADODARA)[0]?.content ?? "";
    expect(system).toContain("THIS THREAD: a trip to May 2019, when the user lived in Vadodara, India (Asia/Kolkata).");
    expect(system).not.toContain("NOW:");
  });
});
