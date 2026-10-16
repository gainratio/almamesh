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
  rewordedOr,
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
    // In the remedies task only: a line in the shared rule grows every chat prompt and squeezes small-window models.
    expect(REFLECTION_RULE).not.toContain("IAST");
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
    // Round two: the notice says how to ask instead, in plain words.
    expect(REFLECTION_WITHHELD).toEqual({
      en: "I couldn't word this as a reflection. Try asking what the chart shows for that period instead of what is coming.",
      es: "No pude expresar esto como una reflexión. Prueba a preguntar qué muestra la carta para ese periodo, en lugar de qué viene.",
      pt: "Não consegui formular isto como uma reflexão. Tente perguntar o que o mapa mostra para esse período, em vez do que vem pela frente.",
    });
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

// Round two of the re-grade: the gate re-read the whole prefix at every sentence end, and the
// reading preview calls it on every delta, so a long section cost quadratic time. It now reads only
// the newly completed text (with a little passed context), and a long run with no sentence end is
// released at a length cap, still checked, so it does not look frozen.
describe("the gate's cost and its length cap", () => {
  const answers = (REAL_ANSWERS as readonly { readonly source: string; readonly text: string }[])
    .filter((answer) => !(answer.source in REAL_VIOLATIONS))
    .map((answer) => answer.text);

  function longSection(length: number): string {
    let text = "";
    for (let i = 0; text.length < length; i += 1) text += `${answers[i % answers.length]}\n\n`;
    return text.slice(0, length);
  }

  // The patterns compile on their first use, once per page load; time the checking, not that.
  const warm = () => reflectionIssues(longSection(2_000));

  // Budgets are relative to ONE full check of the same text on the same machine, so they hold on a slow
  // CI runner too (a fixed 200 ms failed there at 743 ms; 20 full checks failed at 22 on main's PR #373 run). An incremental gate costs a few full checks;
  // re-checking the prefix at every delta (the bug this guards) costs hundreds.
  const MAX_FULL_CHECKS = 60;
  function oneFullCheckMs(text: string): number {
    const runs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      reflectionIssues(text);
      runs.push(performance.now() - started);
    }
    return Math.max(1, runs.sort((a, b) => a - b)[2]);
  }

  it("streams a 35k-character section through the gate and the JSON check for a few full checks' cost", () => {
    const text = longSection(35_000);
    warm();
    const budget = MAX_FULL_CHECKS * oneFullCheckMs(text);
    const started = performance.now();
    const gate = reflectionGate();
    for (let end = 20; end < text.length; end += 20) gate.release(text.slice(0, end), false);
    const shown = gate.release(text, true);
    const issues = jsonReflectionIssues(JSON.stringify({ layman: text }));
    const elapsed = performance.now() - started;
    expect(shown).toBe(text);
    expect(issues).toEqual([]);
    expect(elapsed).toBeLessThan(budget);
  });

  it("stays cheap on a long section after a failed sentence", () => {
    const text = `Saturn rules the 10th. You will get married in 2027. ${longSection(35_000)}`;
    warm();
    const budget = MAX_FULL_CHECKS * oneFullCheckMs(text);
    const started = performance.now();
    const gate = reflectionGate();
    for (let end = 20; end < text.length; end += 20) gate.release(text.slice(0, end), false);
    expect(gate.release(text, true)).toBe("Saturn rules the 10th. ");
    expect(performance.now() - started).toBeLessThan(budget);
  });

  const words = (count: number): string => Array.from({ length: count }, (_, i) => `Saturn${i % 10} rules`).join(" ");

  it("releases a long run with no sentence end before the stream ends, at a word boundary", () => {
    const text = words(150); // ~1,600 characters, no full stop
    const gate = reflectionGate();
    const shown: string[] = [];
    for (let end = 9; end <= text.length; end += 9) shown.push(gate.release(text.slice(0, end), false));
    const last = shown.at(-1) ?? "";
    expect(last.length).toBeGreaterThanOrEqual(400);
    expect(last.endsWith(" ")).toBe(true);
    expect(gate.release(text, true)).toBe(text);
  });

  it("checks what it releases at the cap: a foretelling phrase in a long run is never shown", () => {
    const text = `${words(60)} and you will get married in 2027 ${words(120)}`;
    const gate = reflectionGate();
    for (let end = 7; end <= text.length; end += 7) {
      const shown = gate.release(text.slice(0, end), false);
      expect(reflectionIssues(shown)).toEqual([]);
      expect(shown).not.toContain("married");
    }
    const final = gate.release(text, true);
    expect(final).not.toContain("married");
    expect(reflectionIssues(final)).toEqual([]);
  });

  // The first cap cut falls just before character 400: slide the phrase across it, one character at a time.
  const PADS = Array.from({ length: 48 }, (_, pad) => pad);
  const padded = (pad: number, phrase: string): string => `${"a".repeat(pad + 1)} ${words(25)} ${phrase} ${words(60)}`;
  const stream = (text: string, onShown: (shown: string) => void): string => {
    const gate = reflectionGate();
    for (let end = 1; end <= text.length; end += 1) onShown(gate.release(text.slice(0, end), false));
    return gate.release(text, true);
  };

  it("never shows the start of a foretelling phrase that the cap would cut", () => {
    for (const pad of PADS) {
      const final = stream(padded(pad, "and you will get married in 2027"), (shown) => expect(shown).not.toContain("you will"));
      expect(final).not.toContain("you will");
    }
  });

  it("reads a piece after a cap cut with the words before it, so a clause is not misread", () => {
    let cutBeforeCareer = false;
    for (const pad of PADS) {
      const text = padded(pad, "where the 10th house of career will host Jupiter");
      const final = stream(text, (shown) => {
        cutBeforeCareer ||= shown.endsWith("house of ");
      });
      expect(final).toBe(text);
    }
    expect(cutBeforeCareer).toBe(true); // the slide did put a cut between "of" and "career"
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

  it("falls back to the first text when the reword request fails, unless the reading was cancelled", async () => {
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(rewordedOr(section, undefined, offline)).resolves.toBe(section);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(rewordedOr(section, cancelled.signal, offline)).rejects.toThrow("Failed to fetch");
    await expect(rewordedOr(section, undefined, () => Promise.resolve("{}"))).resolves.toBe("{}");
  });

  it("withholds in each app language, in words that pass the check", () => {
    expect(Object.keys(READING_WITHHELD).sort()).toEqual(["en", "es", "pt"]);
    for (const text of Object.values(READING_WITHHELD)) expect(reflectionIssues(text)).toEqual([]);
  });
});
