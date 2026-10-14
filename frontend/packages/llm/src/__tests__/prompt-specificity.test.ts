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
  it.each([
    "Name the life areas and the houses behind them.",
    'Name the running maha, antar and pratyantar and what each lord rules, e.g. "Saturn, your 12th lord".',
    'For every theme you cover, give its life area and houses, its direction, its strength and its confidence in words (e.g. "strong, medium confidence"), the engine factor behind it, and its dated window when it has one.',
    "Name every tag in the reading's sky once, with what it traditionally signifies: a Sade Sati phase, Kantaka or Ashtama Shani, Jupiter Nth from the Moon.",
    "For the user's own date, time and zone today, use the reading's period and place.current. get_current_datetime scope chart is the birth place's zone, not where the user is now.",
    "Name the place when the reading's place has a label. With no label, name no city and never say a tool left one out.",
    'Give at least one dated window or change point inside the period, with its day.',
    "Use get_period_detail to look closer at a lord, a segment, the bindus or the panchang.",
  ])("asks: %s", (line) => {
    expect(chatSystem()).toContain(line);
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
    expect(PRATYANTAR_NOTE).toContain("get_period_reading");
  });
});

// 2026-10-14, live on ba4430ce: a today thread asked "What does this month look like for me?" and the
// follow-up "And next month?" answered with no tool, naming no place, Moon tag or confidence.
describe("present-day periods read the period reading, every time", () => {
  it.each([
    'PRESENT-DAY PERIODS (a today thread): for "this month", "next month" or "the next few weeks", call get_period_reading in every turn, follow-ups included, with granularity "month" (add month "YYYY-MM" for a later month; for "the next few weeks" read this month and the next; "day" is today only).',
    // 2026-10-14 acceptance matrix: multi-month answers ("the next 3 months") dropped the tag or the confidence.
    'Every period answer, one month or several, names the place, a Moon-based tag by name (e.g. "Jupiter 8th from your Moon") and a confidence level.',
  ])("states: %s", (line) => {
    expect(chatSystem()).toContain(line);
  });

  it("a trip prompt leaves the today-only rule out (an 8k model keeps its budget for tool results)", () => {
    const pinned = { start: "2019-05-01", end: "2019-05-31", relative: "past", granularity: "month", label: "May 2019", place: { label: "Singapore", timezone: "Asia/Singapore" } } as const;
    const trip = buildChatMessages(CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, true, pinned)[0]?.content ?? "";
    expect(trip).not.toContain("PRESENT-DAY PERIODS");
    expect(trip).toContain("Every period answer, one month or several, names the place");
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
    expect(system).toMatch(/obstacles theme[^\n]*its factor and its confidence/);
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
