// Reflection, not prediction (product decision 2026-10-15): a retrodiction eval on licensed
// Astro-Databank events found no lift over chance, so readings are framed as what the chart
// highlights, for reflection. Every reading/chat prompt carries REFLECTION_RULE, and no prompt
// text the model reads may itself claim prediction or accuracy (it primes the answer).
import { describe, expect, it } from "vitest";

import { CHAT_ANSWER_DESCRIPTION, renderAnswer, type ChatAnswer } from "../answer";
import { buildPredictiveFactsBlock } from "../predictive-facts";
import { buildChatMessages, buildInterpretationMessages, type ThreadFacts } from "../prompt";
import { lifeGuesses, PREDICTION_CLAIM_PATTERNS, predictionClaims, REFLECTION_RULE, toolNarration } from "../reflection";
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

  // Live drive 2026-10-15 (3 runs x 2 models): one answer guessed how a week "felt", one denied
  // making a "prediction" (the word itself), none compared periods on a one-month read.
  it("forbids guessing how a period felt and writing about foretelling even to deny it", () => {
    expect(REFLECTION_RULE).toContain("never guess how a period felt or what the person did");
    expect(REFLECTION_RULE).toContain("Do not write about foretelling at all, not even to deny it.");
  });

  it("asks a one-month answer to compare within the month or against its dasha chapter, from the reading only", () => {
    expect(REFLECTION_RULE).toContain("for a single month, compare its parts");
    expect(REFLECTION_RULE).toContain("never invent another period's facts");
  });

  // Live drive 2026-10-15: gpt-sol wrote "the reading supplies no specific life-area interpretation
  // for it"; deepseek wrote "something stalled began to find forward motion after mid-month".
  it("forbids narrating what a reading lacks and describing how the period went for the person", () => {
    expect(REFLECTION_RULE).toContain("Never narrate the tools or what a reading leaves out");
    expect(REFLECTION_RULE).toContain("never describe what the person\nwent through or how things went for them");
  });

  it("passes its own scans", () => {
    expect(predictionClaims(REFLECTION_RULE, "en")).toEqual([]);
    expect(toolNarration(REFLECTION_RULE, "en")).toEqual([]);
    expect(lifeGuesses(REFLECTION_RULE, "en")).toEqual([]);
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

// The answer check's second scan (2026-10-15): answers that narrate the tools, or guess what the
// person lived through. Every caught sentence is from a real drive answer; every passed sentence is
// the comparative, indicator-naming style the rule asks for, so the check costs no good answer.
describe("the narration scans", () => {
  it.each([
    ["en", "Mars enters Virgo: a late-month shift, but the reading supplies no specific life-area interpretation for it."],
    ["en", "Mars entered Virgo; the reading did not specify an additional life-area theme for this change."],
    ["en", "The read_period result lists no theme here."],
    ["es", "Marte entra en Virgo; la lectura no especifica un tema para este cambio."],
    ["pt", "Marte entra em Virgem; a leitura não especifica um tema para essa mudança."],
  ] as const)("tool narration, %s: %s", (language, text) => {
    expect(toolNarration(text, language)).not.toEqual([]);
  });

  it.each([
    ["en", "Something stalled began to find forward motion after mid-month."],
    ["en", "Something that felt stuck or delayed began to move forward."],
    ["en", "You may have felt drawn to retreat and reflection."],
    ["en", "The last week of September felt busier and more direct."],
    ["es", "Puede que hayas sentido el impulso de retirarte."],
    ["pt", "Você pode ter sentido vontade de se recolher."],
  ] as const)("a guess at lived experience, %s: %s", (language, text) => {
    expect(lifeGuesses(text, language)).not.toEqual([]);
  });

  it.each([
    "Saturn stations direct on 17 September 2019; the weeks after it carry the Sade Sati theme more strongly than the weeks before.",
    "Mercury, your antar lord, rules your 1st and 4th houses, so home and self-direction are the month's main themes.",
    "Compared with the Rahu maha dasha as a whole, this month's career theme is mixed rather than supportive.",
    "Jupiter began its transit of your 2nd house on 26 November 2027, the strongest supportive window of the span.",
    "The reading's strongest theme is obstacles: high confidence, with three techniques agreeing.",
    "This window asks for patience with paperwork and official matters.",
    "Mars moves into your 3rd house on 25 September, highlighting communication and short trips in the last week.",
    "The dasha chapter runs from 2017 to 2020; this month sits in its first half.",
    "Saturn began to move direct on 17 September, after five months retrograde.",
  ])("leaves an indicator sentence alone: %s", (text) => {
    expect([...toolNarration(text, "en"), ...lifeGuesses(text, "en")]).toEqual([]);
  });

  it("leaves Spanish and Portuguese indicator sentences alone", () => {
    expect([...toolNarration("Saturno se estaciona directo el 17; la lectura destaca la casa 9.", "es"), ...lifeGuesses("Saturno se estaciona directo el 17.", "es")]).toEqual([]);
    expect([...toolNarration("Saturno fica direto no dia 17; a leitura destaca a casa 9.", "pt"), ...lifeGuesses("Saturno fica direto no dia 17.", "pt")]).toEqual([]);
  });
});
