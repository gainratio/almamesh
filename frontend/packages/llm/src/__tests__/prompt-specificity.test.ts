// Period reading (spec 2026-10-13, "Prompt"): the hedging lines are rewritten so the model is as
// specific as Vedic astrology honestly allows. These pin both halves: the specificity asks, and the
// honesty lines (no concrete event, no invented fact, cite factors) that must survive any rewrite.
import { describe, expect, it } from "vitest";

import { PRATYANTAR_NOTE } from "../period-dashas";
import { estimateTokens } from "../budget";
import { chatPromptBudgetFor } from "../contextBudget";
import { OUTPUT_DISCIPLINE_RULES, buildChatMessages } from "../prompt";
import type { SanitizedChart } from "../sanitize";

const CHART = {
  as_of: { date: "2026-01-01", basis: "chart" },
  ayanamsa_value: 24.1, lagna: { sign: "aries" }, planets: {}, houses: {}, yogas: [],
} as unknown as SanitizedChart;

const chatSystem = () => buildChatMessages(CHART, "How is work?")[0]?.content ?? "";

describe("the derived-fact fence stays, and now lets the model cite what the tools state", () => {
  it("keeps the fence: no lordship, dasha or yoga that no fact states", () => {
    expect(OUTPUT_DISCIPLINE_RULES).toContain("DERIVED-FACT FENCE (ABSOLUTE)");
    expect(OUTPUT_DISCIPLINE_RULES).toContain("do not derive, infer, or guess it");
    expect(OUTPUT_DISCIPLINE_RULES).toContain("NEVER name a period, a lord, or a window that no fact or tool result states");
  });

  it("says a stated lordship, yoga, tag or window in a tool result IS present and must be cited", () => {
    expect(OUTPUT_DISCIPLINE_RULES).toContain("or a tool result");
    expect(OUTPUT_DISCIPLINE_RULES).toMatch(/lordships .*yogas, tags, themes and dated windows in a tool result are engine facts\. Cite them\./s);
  });

  it("drops the line that said dasha periods beyond those stated do not exist", () => {
    expect(OUTPUT_DISCIPLINE_RULES).not.toMatch(/do NOT exist/i);
    expect(chatSystem()).not.toMatch(/do NOT exist/i);
  });
});

describe("the chat prompt asks for specificity and keeps honesty", () => {
  it("asks: Name the life areas and the houses behind them.", () => {
    expect(chatSystem()).toContain("Name the life areas and the houses behind them.");
  });

  // The answer schema checks the place a reading names, not a city invented where the reading had none.
  it("asks: with no place label, name no city and never say a tool left one out", () => {
    expect(chatSystem()).toContain("With no place label, name no city, and never say a tool left one out.");
  });

  // Contract reversed 2026-10-14 (chat tool layer redesign): these checklist lines asked the model to
  // name the period, place, maha/antar with lordships, every Moon tag, each theme's confidence and a
  // dated window. The answer schema (answer.ts) now enforces each of them on every period answer, and
  // the tool-name lines (get_period_detail, get_current_datetime) went with those tools.
  it.each([
    'Name the running maha, antar and pratyantar and what each lord rules',
    "For every theme you cover, give its life area and houses",
    "Name every tag in the reading's sky once",
    "get_current_datetime",
    "Name the place when the reading's place has a label.",
    "Give at least one dated window or change point inside the period",
    "get_period_detail",
    "Every period answer, one month or several",
  ])("no longer asks (the answer schema enforces it): %s", (line) => {
    expect(chatSystem()).not.toContain(line);
  });

  it("keeps the honesty lines: a chart cannot name the event, cite factors, never invent", () => {
    const system = chatSystem();
    expect(system).toContain("HONESTY: a chart cannot name the concrete event.");
    expect(system).toContain("Cite the engine factor behind every claim.");
    expect(system).toContain("never invent a fact");
  });

  it("never asks the model to name a place it was not given (today has no city)", () => {
    expect(chatSystem()).not.toContain("Name the place the reading is for.");
  });

  it("drops the weaker theme and tag asks it replaced", () => {
    expect(chatSystem()).not.toContain("Give each theme's strength and confidence as the reading states them.");
    expect(chatSystem()).not.toContain("Name the tags that apply, e.g.");
  });

  it("drops the old hedges", () => {
    const system = chatSystem();
    expect(system).not.toContain("dasha answers still work");
    expect(system).not.toContain("when it genuinely bears on the answer");
  });
});

describe("the dasha table's pratyantar note points at the reading", () => {
  it("no longer says pratyantars exist only for the current antar", () => {
    expect(PRATYANTAR_NOTE).not.toMatch(/only available/i);
    expect(PRATYANTAR_NOTE).toContain("read_period gives the pratyantar for any date");
    expect(PRATYANTAR_NOTE).not.toContain("get_period_reading");
  });
});

// 2026-10-14, live on ba4430ce: a today thread asked "What does this month look like for me?" and the
// follow-up "And next month?" answered with no tool. Contract reversed the same day (chat tool layer
// redesign): the PRESENT-DAY PERIODS routing rule and the "every period answer names..." line go. The
// NOW line gives today, read_period takes any span, and the answer schema demands the place, a Moon
// tag and a confidence on every period answer.
describe("present-day periods need no routing rule", () => {
  it("neither a today nor a trip prompt carries the routing rule or the old checklist line", () => {
    const pinned = { start: "2019-05-01", end: "2019-05-31", relative: "past", granularity: "month", label: "May 2019", place: { label: "Singapore", timezone: "Asia/Singapore" } } as const;
    const trip = buildChatMessages(CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, true, pinned)[0]?.content ?? "";
    for (const system of [chatSystem(), trip]) {
      expect(system).not.toContain("PRESENT-DAY PERIODS");
      expect(system).not.toContain("Every period answer, one month or several, names the place");
    }
  });
});

// 2026-10-14 (obstacles domain): Harish's 2019 was a new job and legal trouble. The engine now
// reads the 6th/8th/12th as an obstacles theme; the model may name it by its classical meaning,
// as a theme to watch with its factor and confidence, never as an event and never with fear.
describe("the obstacles theme", () => {
  const PINNED = { start: "2019-05-01", end: "2019-05-31", relative: "past", granularity: "month", label: "May 2019", place: { label: "Singapore", timezone: "Asia/Singapore" } } as const;
  const trip = (mode: "layman" | "expert") =>
    buildChatMessages(CHART, "What did September 2019 look like for me?", mode, [], [], undefined, "en", undefined, undefined, chatPromptBudgetFor(8_192), true, PINNED);

  it("names a strong or moderate obstacles theme by its classical meaning, as a theme to watch", () => {
    const system = chatSystem();
    expect(system).toContain("OBSTACLES (6th/8th/12th): name a strong or moderate obstacles theme as a theme to watch");
    for (const meaning of ["friction with rules or authorities", "legal or administrative matters", "unexpected setbacks", "losses and expenses"]) expect(system).toContain(meaning);
    // Matrix 2026-10-14: gpt-sol named the theme and its factor but never its 25 Sep Mars window.
    expect(system).toMatch(/obstacles theme[^\n]*its factor and its dated window/);
    expect(system).toMatch(/obstacles theme[^\n]*never say it happened[^\n]*no fear words/);
    expect(system).toContain("Never say what did or will happen, and never invent a fact.");
  });

  it("the plain-language register gives obstacles a lived-experience reading", () => {
    expect(trip("layman")[1]?.content).toContain("- an obstacles theme → a stretch to watch rules, paperwork and spending, not a prediction");
    expect(trip("expert")[1]?.content).not.toContain("- an obstacles theme →");
  });

  // The trip-fix drive left an 8k trip turn about one token from its limit: the rule is paid for
  // elsewhere. Before it: system 1,435 tokens, layman user 192, expert user 71.
  it("an 8k trip prompt does not grow", () => {
    const tokens = (mode: "layman" | "expert") => trip(mode).map((message) => estimateTokens(message.content)) as [number, number];
    expect(tokens("layman")[0]).toBeLessThanOrEqual(1_435);
    expect(tokens("layman")[0] + tokens("layman")[1]).toBeLessThanOrEqual(1_435 + 192);
    expect(tokens("expert")[0] + tokens("expert")[1]).toBeLessThanOrEqual(1_435 + 71);
  });
});
