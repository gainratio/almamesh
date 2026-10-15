// Reflection, not prediction (product decision 2026-10-15): a retrodiction eval on licensed
// Astro-Databank events found no lift over chance, so readings are framed as what the chart
// highlights, for reflection. Every reading/chat prompt carries REFLECTION_RULE, and no prompt
// text the model reads may itself claim prediction or accuracy (it primes the answer).
import { describe, expect, it } from "vitest";

import { CHAT_ANSWER_DESCRIPTION, renderAnswer, type ChatAnswer } from "../answer";
import { buildPredictiveFactsBlock } from "../predictive-facts";
import { buildChatMessages, buildInterpretationMessages, type ThreadFacts } from "../prompt";
import { PREDICTION_CLAIM_PATTERNS, predictionClaims, REFLECTION_RULE } from "../reflection";
import { REPORT_PROMPT_SET, REPORT_SECTIONS } from "../report-targets";
import type { SanitizedChart, SanitizedPredictive } from "../sanitize";
import { ALL_SECTIONS, buildSectionMessages } from "../structured-interpretation";
import { ANSWER_TOOL_DESCRIPTION, BUDGET_INSTRUCTION } from "../toolLoop";
import { REPORT_CHART } from "./report-fixture";

const NOW = "Wednesday 14 October 2026, America/Los_Angeles";
const TRIP: ThreadFacts = { now: NOW, trip: { label: "May 2019", place: "Vadodara, India", timezone: "Asia/Kolkata" } };
const TODAY: ThreadFacts = { now: NOW };
const MAY_2019 = { start: "2019-05-01", end: "2019-05-31", relative: "past", granularity: "month" } as const;

const chat = (thread: ThreadFacts, pinned?: typeof MAY_2019) =>
  buildChatMessages(REPORT_CHART, "How was work?", "layman", [], [], undefined, "en", undefined, undefined, undefined, pinned, thread);

const systemOf = (messages: readonly { role: string; content: string }[]): string =>
  messages.find((message) => message.role === "system")?.content ?? "";

const LEGACY_SECTION_SYSTEMS = ALL_SECTIONS.flatMap((section) =>
  [false, true].map((lite) => [`${section} lite=${lite}`, systemOf(buildSectionMessages(section, REPORT_CHART, "layman", lite, "en"))] as const),
);
const REPORT_SECTION_SYSTEMS = REPORT_SECTIONS.flatMap((section) =>
  [false, true].map(
    (lite) => [`report ${section} lite=${lite}`, systemOf(buildSectionMessages(section, REPORT_CHART, "layman", lite, "en", REPORT_PROMPT_SET))] as const,
  ),
);
const SYSTEM_PROMPTS: readonly (readonly [string, string])[] = [
  ["chat, trip thread", systemOf(chat(TRIP, MAY_2019))],
  ["chat, today thread", systemOf(chat(TODAY))],
  ["chat, single pass", systemOf(buildChatMessages(REPORT_CHART, "How is work?"))],
  ["interpretation, layman", systemOf(buildInterpretationMessages(REPORT_CHART, "layman"))],
  ["interpretation, expert", systemOf(buildInterpretationMessages(REPORT_CHART, "expert"))],
  ...LEGACY_SECTION_SYSTEMS,
  ...REPORT_SECTION_SYSTEMS,
];

describe("the reflection rule", () => {
  it("asks for named indicators, comparisons and hard themes, without fear", () => {
    expect(REFLECTION_RULE).toContain("themes to reflect on");
    expect(REFLECTION_RULE).toContain("name the indicators behind every theme");
    expect(REFLECTION_RULE).toContain("the strongest\npressure window of 2019 was March to May");
    expect(REFLECTION_RULE).toContain("legal or official friction, losses and expenses, a job or\ncareer change");
    expect(REFLECTION_RULE).toContain("No fear language");
    expect(REFLECTION_RULE).toContain("never say an event did occur or is bound to occur");
  });

  it("passes its own scan", () => {
    expect(predictionClaims(REFLECTION_RULE, "en")).toEqual([]);
  });

  it.each(SYSTEM_PROMPTS)("rides in the %s system prompt", (_name, system) => {
    expect(system).toContain(REFLECTION_RULE);
  });
});

describe("prompt text claims no prediction or accuracy", () => {
  it.each(SYSTEM_PROMPTS)("%s system prompt", (_name, system) => {
    expect(predictionClaims(system, "en")).toEqual([]);
  });

  it.each(REPORT_SECTIONS.flatMap((section) => [false, true].map((lite) => [section, lite] as const)))(
    "report %s (lite=%s) task text",
    (section, lite) => {
      const user = buildSectionMessages(section, REPORT_CHART, "layman", lite, "en", REPORT_PROMPT_SET)[1]?.content ?? "";
      expect(predictionClaims(user, "en")).toEqual([]);
    },
  );

  it("the tool-loop and answer descriptions", () => {
    for (const text of [ANSWER_TOOL_DESCRIPTION, CHAT_ANSWER_DESCRIPTION, BUDGET_INSTRUCTION]) {
      expect(predictionClaims(text, "en")).toEqual([]);
    }
  });

  it("the engine timing block the model reads", () => {
    const predictive = (REPORT_CHART as SanitizedChart & { predictive?: SanitizedPredictive }).predictive;
    const block = buildPredictiveFactsBlock(predictive);
    expect(block).not.toBe("");
    expect(predictionClaims(block, "en")).toEqual([]);
  });
});

describe("a rendered period answer", () => {
  const answer: ChatAnswer = {
    kind: "period",
    period: "September 2019",
    place: "Vadodara, India",
    opening: "Work asked for patience.",
    dashas: {
      maha: { lord: "jupiter", rules: [2, 11], note: "Income and friendships." },
      antar: { lord: "saturn", rules: [1, 12], note: "It slows things down." },
      pratyantar: null,
    },
    moon: [],
    themes: [
      { area: "career", direction: "supportive", confidence: "high", text: "A senior person speaks up for your work.", obstacle: null },
      { area: "obstacles", direction: "challenging", confidence: "low", text: "Paperwork friction.", obstacle: null },
    ],
    windows: [],
    advice: null,
  };

  it("says how many indicators agree, not how confident a reading is", () => {
    const en = renderAnswer(answer, { voice: "layman", language: "en" });
    expect(en).toContain("(supportive, most indicators agree)");
    expect(en).toContain("(challenging, few indicators agree)");
    expect(en).not.toMatch(/confidence/i);
    expect(renderAnswer(answer, { voice: "layman", language: "es" })).not.toMatch(/confianza/i);
    expect(renderAnswer(answer, { voice: "layman", language: "pt" })).not.toMatch(/confiança/i);
  });
});

describe("the scan can fail", () => {
  it.each([
    ["en", "This chart predicts a move."],
    ["en", "Our forecast for May."],
    ["en", "Readings are accurate."],
    ["en", "A change is likely."],
    ["en", "Something will happen in June."],
    ["en", "This is what happened in 2019."],
    ["es", "La carta predice un cambio."],
    ["es", "Pronóstico del motor"],
    ["es", "Es probable que cambie."],
    ["es", "Esto ocurrirá en junio."],
    ["pt", "Previsão do motor"],
    ["pt", "O mapa prevê uma mudança."],
    ["pt", "Provavelmente muda."],
    ["pt", "Isso acontecerá em junho."],
  ] as const)("%s: %s", (language, text) => {
    expect(predictionClaims(text, language)).not.toEqual([]);
  });

  it("leaves ordinary words alone", () => {
    expect(predictionClaims("an unpredictable inaccurate unlikely day", "en")).toEqual([]);
    expect(predictionClaims("Fecha exacta; precisión de la fecha", "es")).toEqual([]);
    expect(predictionClaims("O AlmaMesh precisa de permissão; prevenção", "pt")).toEqual([]);
  });

  it("covers the three app languages", () => {
    expect(Object.keys(PREDICTION_CLAIM_PATTERNS).sort()).toEqual(["en", "es", "pt"]);
  });
});
