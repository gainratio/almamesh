// The one reflection check every user-facing text passes before it is shown (northstar, PR #366):
// an answer that foretells, narrates the tools, or guesses lived experience never reaches the user
// unchecked. It reads all three app languages whatever the page language is, after Unicode
// normalization, so a zero-width space or a Cyrillic "е" does not walk a claim past it.
import { describe, expect, it } from "vitest";

import {
  jsonReflectionIssues,
  READING_WITHHELD,
  REFLECTION_RULE,
  REFLECTION_WITHHELD,
  reflectionIssues,
  reflectionGate,
  releasableReflection,
  withholdFailingValues,
} from "../reflection";
import { buildReportMessages } from "../index";
import { TOOLS_UNAVAILABLE_NOTICE } from "../toolsUnavailable";
import { REPORT_AS_OF, REPORT_RAW_CHART } from "./report-fixture";
import {
  FALSE_POSITIVES,
  IMPERSONAL_FUTURES,
  LIKELY_CLAIMS,
  LONG_DEVANAGARI,
  MUST_PASS,
  REFLECTION_PROBES,
} from "./fixtures/reflection-probes";
import REAL_ANSWERS from "./fixtures/reflection-real-answers.json";

const flagged = (text: string): boolean => reflectionIssues(text).length > 0;

describe("the crafted probe corpus", () => {
  it("is the northstar's 104 strings", () => {
    expect(REFLECTION_PROBES).toHaveLength(104);
  });

  it.each(REFLECTION_PROBES.filter((probe) => probe.verdict === "block").map((probe) => [probe.language, probe.text] as const))(
    "blocks [%s] %j",
    (_language, text) => {
      expect(reflectionIssues(text)).not.toEqual([]);
    },
  );

  it.each(REFLECTION_PROBES.filter((probe) => probe.verdict === "pass").map((probe) => [probe.language, probe.text] as const))(
    "passes [%s] %j",
    (_language, text) => {
      expect(reflectionIssues(text)).toEqual([]);
    },
  );
});

describe("sky facts in the future tense", () => {
  it.each(MUST_PASS)("passes %j", (text) => {
    expect(reflectionIssues(text)).toEqual([]);
  });
});

describe("round two of the re-grade", () => {
  it.each(IMPERSONAL_FUTURES)("blocks the impersonal future %j", (text) => {
    expect(reflectionIssues(text)).not.toEqual([]);
  });

  it.each(FALSE_POSITIVES)("passes %j", (text) => {
    expect(reflectionIssues(text)).toEqual([]);
  });

  it.each(LIKELY_CLAIMS)("still blocks the odds in %j", (text) => {
    expect(reflectionIssues(text)).not.toEqual([]);
  });

  it("still holds a Devanagari line longer than a short mantra", () => {
    expect(reflectionIssues(LONG_DEVANAGARI).map((issue) => issue.kind)).toEqual(["unreadable_script"]);
  });

  it("asks for mantras in IAST, so a remedies section is not held for its script", () => {
    expect(REFLECTION_RULE).toContain("IAST");
    for (const lite of [false, true]) {
      const messages = buildReportMessages({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF }, { mode: "layman", language: "en", lite });
      const task = messages.remedial.map((message) => message.content).join("\n").replace(REFLECTION_RULE, "");
      expect(task).toContain("Give each mantra in IAST transliteration");
    }
  });

  it("still holds a short Devanagari line that carries a date", () => {
    expect(reflectionIssues("मार्च 2027 में").map((issue) => issue.kind)).toEqual(["unreadable_script"]);
  });
});

// Every answer the real-model drives of 2026-10-15 put on screen (drive-final5, drive-final,
// reflection-drive*). The ones listed here broke the rule in a way a reader can see; every other
// answer must pass untouched: a false positive is a good answer the user never gets.
const REAL_VIOLATIONS: Readonly<Record<string, string>> = {
  "reflection-drive/deepseek-deepseek-v4-pro-run1.json": "something stalled began to find forward motion",
  "reflection-drive/deepseek-deepseek-v4-pro-run2.json": "something that felt stuck ... began to move forward",
  "reflection-drive/openai-gpt-sol-latest-run1.json": "the reading supplies no specific life-area interpretation",
  "reflection-drive/openai-gpt-sol-latest-run2.json": "the reading supplied no further life-area interpretation",
  "reflection-drive/openai-gpt-sol-latest-run3.json": "the reading supplied no separate life-area interpretation",
  "reflection-drive-v1/deepseek-deepseek-v4-pro-run2.json": "you may have felt drawn to retreat",
  "reflection-drive-v1/deepseek-deepseek-v4-pro-run3.json": "the last week of September likely felt busier",
  "reflection-drive-v1/openai-gpt-sol-latest-run1.json": "supplied no specific life-area interpretation",
  "reflection-drive-v1/openai-gpt-sol-latest-run3.json": "should not be treated as an event prediction",
  "reflection-drive-v2/deepseek-deepseek-v4-pro-run2.json": "the last week of the month likely brought a spike in drive",
  "reflection-drive-v2/openai-gpt-sol-latest-run1.json": "the reading did not specify an additional life-area theme",
  "reflection-drive-v2/openai-gpt-sol-latest-run3.json": "assuming the chart describes what happened",
};

describe("the real-drive corpus", () => {
  const answers = REAL_ANSWERS as readonly { readonly source: string; readonly text: string }[];

  it("holds the 37 distinct answers of the five drives", () => {
    expect(answers).toHaveLength(37);
  });

  it.each(answers.filter((answer) => !(answer.source in REAL_VIOLATIONS)).map((answer) => [answer.source, answer.text] as const))(
    "passes %s",
    (_source, text) => {
      expect(reflectionIssues(text)).toEqual([]);
    },
  );

  it.each(Object.keys(REAL_VIOLATIONS))("blocks %s", (source) => {
    const answer = answers.find((candidate) => candidate.source === source);
    expect(answer && flagged(answer.text)).toBe(true);
  });
});

describe("the app's own words", () => {
  // REFLECTION_RULE is a prompt, not shown text: it names what it forbids ("foretelling", "odds").
  it("pass the check: the withheld notices and the tools-unavailable notice", () => {
    for (const text of [TOOLS_UNAVAILABLE_NOTICE, ...Object.values(REFLECTION_WITHHELD)]) {
      expect(reflectionIssues(text)).toEqual([]);
    }
  });

  it("withholds in each app language", () => {
    expect(Object.keys(REFLECTION_WITHHELD).sort()).toEqual(["en", "es", "pt"]);
    expect(REFLECTION_WITHHELD.en).toBe("I couldn't word this as a reflection. Try asking again.");
  });
});

describe("each issue names what it found", () => {
  it("kinds a future claim, a narration and a guess apart", () => {
    const kinds = (text: string) => reflectionIssues(text).map((issue) => issue.kind);
    expect(kinds("You will get married in 2027.")).toContain("foretelling");
    expect(kinds("The reading is silent on career.")).toContain("narration");
    expect(kinds("You may have felt stuck.")).toContain("life_guess");
    // A short Hindi line is read by its future verb ending now (round two exempts short mantra lines
    // from the script rule); a long one is still held for its script.
    expect(kinds("आपको मार्च में नई नौकरी मिलेगी।")).toContain("foretelling");
    expect(kinds(LONG_DEVANAGARI)).toContain("unreadable_script");
  });
});

describe("releasing streamed text sentence by sentence", () => {
  const clean = "Saturn stations direct on 17 September. Mars enters Virgo on the 25th. ";

  it("holds an unfinished sentence while the stream runs", () => {
    expect(releasableReflection(`${clean}Jupiter rules the 9th`, false)).toBe(clean);
  });

  it("releases the last sentence once the stream ends", () => {
    expect(releasableReflection(`${clean}Jupiter rules the 9th`, true)).toBe(`${clean}Jupiter rules the 9th`);
  });

  it("never releases a rejected sentence, or anything after it", () => {
    const text = `${clean}You will get married in 2027. Venus rules the 7th house.`;
    expect(releasableReflection(text, false)).toBe(clean);
    expect(releasableReflection(text, true)).toBe(clean);
  });

  it.each(REFLECTION_PROBES.filter((probe) => probe.verdict === "block").map((probe) => probe.text))(
    "streams %j only as checked prefixes, never the rejected sentence",
    (probe) => {
      const text = `${clean}${probe} Venus rules the 7th house.`;
      const gate = reflectionGate();
      for (let end = 1; end <= text.length; end += 7) {
        const shown = gate.release(text.slice(0, end), false);
        expect(reflectionIssues(shown)).toEqual([]);
        expect(shown.length).toBeLessThanOrEqual(clean.length);
      }
      expect(gate.release(text, true)).toBe(clean);
    },
  );

  it("releases at line breaks: a bullet without a full stop is a sentence", () => {
    expect(releasableReflection("- **Saturn** rules 10 and 11\n- **Mars", false)).toBe("- **Saturn** rules 10 and 11\n");
  });
});

// Structured readings (northstar, PR #366: the rule was only in their prompts). Every string value
// of a section's JSON is read; one that still fails after the retry is withheld, not shown.
describe("a reading's JSON", () => {
  const section = JSON.stringify({
    title: "Jupiter period",
    layman: "You will get married in 2027.",
    technical: "Jupiter antardasha will begin in March 2027.",
    items: [{ text: "Saturn rules the 10th.", note: "Vas a conseguir un ascenso." }],
  });

  it("finds an issue in any string value, nested or not", () => {
    expect(jsonReflectionIssues(section).map((issue) => issue.phrase)).toEqual(["You will get", "Vas a conseguir"]);
  });

  it("reads keys as structure, not prose", () => {
    expect(jsonReflectionIssues(JSON.stringify({ predicted_events: "Saturn rules the 10th." }))).toEqual([]);
  });

  it("leaves text it cannot parse to the section's own parser", () => {
    expect(jsonReflectionIssues("{not json")).toEqual([]);
  });

  it("withholds only the failing values, keeping the shape", () => {
    const withheld = JSON.parse(withholdFailingValues(section, READING_WITHHELD.en)) as Record<string, unknown>;
    expect(withheld).toEqual({
      title: "Jupiter period",
      layman: READING_WITHHELD.en,
      technical: "Jupiter antardasha will begin in March 2027.",
      items: [{ text: "Saturn rules the 10th.", note: READING_WITHHELD.en }],
    });
  });

  it("withholds in each app language, in words that pass the check", () => {
    expect(Object.keys(READING_WITHHELD).sort()).toEqual(["en", "es", "pt"]);
    for (const text of Object.values(READING_WITHHELD)) expect(reflectionIssues(text)).toEqual([]);
  });
});
