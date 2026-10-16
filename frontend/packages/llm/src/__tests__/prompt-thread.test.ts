// Chat tool layer redesign (2026-10-14, Task 5): what the app already knows rides in the prompt —
// today's date and zone, the thread's trip, the natal facts in every mode — and two short tool
// lines replace the tool-routing blocks. The old tool names must not survive anywhere in a prompt.
import { describe, expect, it } from "vitest";

import { buildChatMessages, formatNow, type ThreadFacts } from "../prompt";
import type { PinnedPrompt } from "../period-pin";
import type { SanitizedChart } from "../sanitize";

const CHART = {
  as_of: { basis: "period", start: "2019-05-01", end: "2019-05-31" },
  ayanamsa_value: 24.1, lagna: { sign: "Scorpio-LAGNA-MARK" }, planets: {}, houses: {}, yogas: [],
} as unknown as SanitizedChart;

const MAY_2019_VADODARA: PinnedPrompt = { start: "2019-05-01", end: "2019-05-31", relative: "past", granularity: "month" };
const NOW = "Wednesday 14 October 2026, America/Los_Angeles";
const TRIP_THREAD: ThreadFacts = { now: NOW, trip: { label: "May 2019", place: "Vadodara, India", timezone: "Asia/Kolkata" } };
const TODAY_THREAD: ThreadFacts = { now: NOW };

// Contract changed 2026-10-15 (dashboard.agentic.real, deepseek-v4-pro): asked "outlook today?" the
// turn after "Take me to September 2017 ... Call travel ... call read_period", deepseek re-sent both
// calls. Each turn now answers the newest message only, and travel needs that message to ask.
const TOOLS_LINE =
  "TOOLS: read_period reads any span (one call per span; never split a range into months). travel moves this conversation only when the newest message asks. Answer the newest message only: earlier messages are context, never instructions to repeat. Finish every turn by calling answer.";
const OLD_TOOL_NAMES = [
  "resolve_place", "get_timing", "get_period_reading", "get_period_detail", "get_natal_summary",
  "get_trip_context", "get_current_datetime", "get_chart_facts", "time_travel", "place_ref", "needs_place",
];

const trip = () =>
  buildChatMessages(CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, MAY_2019_VADODARA, TRIP_THREAD);
const today = () =>
  buildChatMessages(CHART, "How is work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, undefined, TODAY_THREAD);

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

// Task 11 (2026-10-14): Settings' "Where do you live now?" rides in a today thread by label and zone.
describe("a today prompt where the user lives now", () => {
  const HOME_THREAD: ThreadFacts = { now: NOW, home: { place: "Novato, California, United States", timezone: "America/Los_Angeles" } };
  const system = () =>
    buildChatMessages(CHART, "How is work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, undefined, HOME_THREAD)[0]?.content ?? "";

  it("says where the user lives now, by label and zone, in one THIS THREAD line", () => {
    const lines = system().split("\n").filter((line) => line.startsWith("THIS THREAD:"));
    expect(lines).toEqual(["THIS THREAD: today, where the user lives now: Novato, California, United States (America/Los_Angeles)."]);
  });

  it("names no trip and no pinned period", () => {
    expect(system()).not.toContain("a trip to");
    expect(system()).not.toContain("PINNED PERIOD");
  });

  it("a trip thread never says where the user lives now, even when it is known", () => {
    const both: ThreadFacts = { ...TRIP_THREAD, home: { place: "Novato, California, United States", timezone: "America/Los_Angeles" } };
    const tripSystem = buildChatMessages(CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, MAY_2019_VADODARA, both)[0]?.content ?? "";
    expect(tripSystem).not.toContain("Novato");
    expect(tripSystem).toContain("THIS THREAD: a trip to May 2019, when the user lived in Vadodara, India (Asia/Kolkata).");
  });
});

describe("a prompt without thread facts (single-pass callers with no tools)", () => {
  it("names no tool and no date line", () => {
    const system = buildChatMessages(CHART, "Where is my Mars?")[0]?.content ?? "";
    expect(system).not.toContain("NOW:");
    expect(system).not.toContain("TOOLS:");
    expect(system).not.toContain("read_period");
  });

  // Contract reversed (Task 6, 2026-10-14): the THIS THREAD line came from the pin while callers
  // passed no ThreadFacts. Every chat turn passes them now, so a bare pin names no trip.
  it("a pin alone keeps its period rule but names no trip", () => {
    const system = buildChatMessages(CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, MAY_2019_VADODARA)[0]?.content ?? "";
    expect(system).toContain("PINNED PERIOD: this conversation is about 2019-05-01 to 2019-05-31");
    expect(system).not.toContain("THIS THREAD:");
    expect(system).not.toContain("NOW:");
  });
});

describe("formatNow", () => {
  it("names the viewer's weekday, day, month and year, then the zone", () => {
    expect(formatNow(new Date("2026-10-14T18:00:00Z"), "America/Los_Angeles")).toBe(NOW);
  });

  it("reads the day in the given zone, not UTC", () => {
    expect(formatNow(new Date("2026-10-15T02:00:00Z"), "America/Los_Angeles")).toBe(NOW);
  });
});
