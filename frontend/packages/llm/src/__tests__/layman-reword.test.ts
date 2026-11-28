import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import type { ProviderConfig } from "../config";
import { buildEvidenceAnnotationMessages } from "../evidence-annotation";
import {
  streamCurrentTimeline,
  streamNatalInterpretation,
  streamReportTimeline,
  type CurrentTimelineEvent,
  type NatalInterpretationEvent,
  type ReportTimelineEvent,
} from "../index";
import {
  jsonLaymanJargon,
  mergeCleanSectionLeaves,
  VOICE_CLARITY_RULE,
} from "../layman-reword";
import {
  lifeGuesses,
  predictionClaims,
  READING_WITHHELD,
  toolNarration,
} from "../reflection";
import { REPORT_PROMPT_SET, REPORT_SECTIONS } from "../report-targets";
import { ALL_SECTIONS, buildSectionMessages } from "../structured-interpretation";
import { REPORT_AS_OF, REPORT_CHART, REPORT_RAW_CHART } from "./report-fixture";

const chart = (golden as Record<string, SiderealChart>)[Object.keys(golden)[0]];
const config: ProviderConfig = {
  engine: "openai-http",
  model: "test-model",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const jsonOf = (content: unknown): Response =>
  new Response(
    JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }),
    { headers: { "Content-Type": "application/json" } },
  );

describe("VOICE_CLARITY_RULE & anti-FEEL prompt hygiene", () => {
  it("passes reflection, narration, and life-guess scans cleanly", () => {
    expect(predictionClaims(VOICE_CLARITY_RULE, "en")).toEqual([]);
    expect(toolNarration(VOICE_CLARITY_RULE, "en")).toEqual([]);
    expect(lifeGuesses(VOICE_CLARITY_RULE, "en")).toEqual([]);
  });

  it("contains no 'FEEL like' or 'feel from the inside' prompt traps across structured and evidence prompts", () => {
    const legacy = ALL_SECTIONS.flatMap((section) =>
      [false, true].map((lite) => buildSectionMessages(section, REPORT_CHART, "layman", lite, "en")),
    );
    const report = REPORT_SECTIONS.flatMap((section) =>
      [false, true].map((lite) =>
        buildSectionMessages(section, REPORT_CHART, "layman", lite, "en", REPORT_PROMPT_SET),
      ),
    );
    const evidence = buildEvidenceAnnotationMessages({
      chart: REPORT_CHART,
      observations: [{ id: "lagna", statement: "Aquarius rises.", evidence: "Aquarius 28.82°" }],
      factorIds: ["lagna"],
      config,
    });
    for (const messages of [...legacy, ...report, evidence]) {
      const fullText = messages.map((m) => m.content).join("\n");
      expect(fullText).not.toMatch(/\bfeel\s+like\b|\bfeels?\s+from\s+the\s+inside\b|\btends?\s+to\s+feel\b|\bhow\s+it\s+feels\b/i);
      expect(fullText).not.toContain("Affection here gets audited");
    }
  });
});

describe("layman jargon coherent reword before stripLaymanJargon", () => {
  it("detects jargon across layman, lean_into, and watch_for leaves while ignoring technical leaves", () => {
    const raw = JSON.stringify({
      domains: {
        career: {
          outlook: { layman: "Work moves steadily.", technical: "Saturn in the 10th house." },
          lean_into: "Watch for a clear sign to ask for help.",
          watch_for: "Keeping your house disorganized.",
        },
      },
    });
    expect(jsonLaymanJargon(raw)).toEqual(["sign", "house"]);
  });

  it("rewords a layman homograph leak coherently in one retry without dropping sentences", async () => {
    const leakyCore = {
      summary: {
        layman: "You build trust patiently. A tired mind is a sign to step back and rest.",
        technical: "Leo lagna; Sun in the 12th house.",
      },
      strengths: [],
      challenges: [],
      life_themes: [],
    };
    const rewordedCore = {
      ...leakyCore,
      summary: {
        layman: "You build trust patiently. A tired mind is a clear signal to step back and rest.",
        technical: "Leo lagna; Sun in the 12th house.",
      },
    };
    let coreCalls = 0;
    const prompts: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const bodyStr = String(init.body);
      if (bodyStr.includes("SECTION:core")) {
        prompts.push(bodyStr);
        coreCalls += 1;
        return jsonOf(coreCalls === 1 ? leakyCore : rewordedCore);
      }
      return jsonOf({
        integrated_yoga_narrative: { layman: "Steady growth.", technical: "Raja Yoga." },
        health_guidance: { layman: "Sleep well.", technical: "1st house." },
        education_guidance: { layman: "Stay curious.", technical: "5th house." },
        career_guidance: { layman: "Lead calmly.", technical: "10th house." },
        relationship_guidance: { layman: "Listen closely.", technical: "7th house." },
        finances_guidance: { layman: "Save steadily.", technical: "2nd house." },
        spiritual_guidance: { layman: "Take quiet walks.", technical: "12th house." },
        life_evolution_guidance: { layman: "Keep learning.", technical: "9th house." },
        remedial_measures: { layman: "Breathe slowly each morning.", technical: "Sun." },
      });
    }) as unknown as typeof fetch;

    const events: NatalInterpretationEvent[] = [];
    for await (const ev of streamNatalInterpretation({ chart, config, fetchImpl })) events.push(ev);
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("expected completion");

    expect(coreCalls).toBe(2);
    const retryMessages = (JSON.parse(prompts[1] ?? "{}") as { messages: Array<{ content: string }> }).messages;
    expect(retryMessages.at(-1)?.content).toContain('"sign"');
    // Both sentences survive intact because the LLM reworded "sign" -> "signal" before stripLaymanJargon ran!
    expect(complete.interpretation.summary.layman).toBe(
      "You build trust patiently. A tired mind is a clear signal to step back and rest.",
    );
  });

  it("heals single-sentence timeline layman homographs on retry instead of failing the section", async () => {
    let roadCalls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (!String(init.body).includes("SECTION:upcoming_periods")) {
        return jsonOf({ current_sky: [{ title: "Now", layman: "Steady focus helps.", technical: "Saturn." }] });
      }
      roadCalls += 1;
      return jsonOf({
        upcoming_periods: [
          {
            title: "Sun antardasha — 2027-01 to 2028-01",
            layman: roadCalls === 1 ? "Fatigue is a sign to rest early." : "Fatigue is a clear clue to rest early.",
            technical: "Sun in the 12th house.",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const events: CurrentTimelineEvent[] = [];
    for await (const ev of streamCurrentTimeline({ chart, config, fetchImpl })) events.push(ev);
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("expected timeline completion");

    expect(roadCalls).toBe(2);
    expect(complete.timeline.upcoming_periods[0]?.layman).toBe("Fatigue is a clear clue to rest early.");
  });

  it("combines reflection issues and layman jargon leaks into a single retry call", async () => {
    let outlookCalls = 0;
    let retryPayload = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const bodyStr = String(init.body);
      if (bodyStr.includes("SECTION:life_outlook_2")) {
        outlookCalls += 1;
        if (outlookCalls === 2) retryPayload = bodyStr;
        return jsonOf({
          domains: {
            health: {
              outlook: {
                layman: outlookCalls === 1 ? "You will get healthier soon." : "Steady sleep habits support daily energy.",
                technical: "6th house.",
              },
              lean_into: outlookCalls === 1 ? "Daily yoga stretches." : "Gentle morning stretching.",
              watch_for: "Skipping rest.",
            },
            education: {
              outlook: { layman: "Practical study works well.", technical: "5th house." },
              lean_into: "Short study blocks.",
              watch_for: "Scattered notes.",
            },
            spiritual: {
              outlook: { layman: "Quiet time clears your head.", technical: "12th house." },
              lean_into: "Evening walks.",
              watch_for: "Overbooking weekends.",
            },
          },
        });
      }
      if (bodyStr.includes("SECTION:current_period")) {
        return jsonOf({
          maha: { layman: "Steady work.", technical: "Saturn." },
          antar: { layman: "Clear routines.", technical: "Mercury." },
          activates: [{ title: "Work", layman: "Practical focus.", technical: "10th house." }],
          next_change: { layman: "Pace shifts gradually.", technical: "Venus." },
        });
      }
      if (bodyStr.includes("SECTION:year_ahead")) {
        return jsonOf({
          headline: { layman: "A steady year.", technical: "Saturn." },
          quarters: {
            Q1: { layman: "Build habits.", technical: "Q1." },
            Q2: { layman: "Pace effort.", technical: "Q2." },
            Q3: { layman: "Review budgets.", technical: "Q3." },
            Q4: { layman: "Rest well.", technical: "Q4." },
          },
          focus: { layman: "Keep routines simple.", technical: "Saturn." },
        });
      }
      return jsonOf({
        domains: {
          career: { outlook: { layman: "Steady work.", technical: "10th." }, lean_into: "Clear priorities.", watch_for: "Rushing." },
          finances: { outlook: { layman: "Steady savings.", technical: "2nd." }, lean_into: "Simple budgets.", watch_for: "Impulse buys." },
          relationships: { outlook: { layman: "Honest talks.", technical: "7th." }, lean_into: "Listening first.", watch_for: "Assumptions." },
          family: { outlook: { layman: "Calm routines.", technical: "4th." }, lean_into: "Shared meals.", watch_for: "Overcommitting." },
        },
      });
    }) as unknown as typeof fetch;

    const events: ReportTimelineEvent[] = [];
    for await (const ev of streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config, fetchImpl })) {
      events.push(ev);
    }
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("expected report timeline completion");

    expect(outlookCalls).toBe(2);
    const outlookRetryText = (JSON.parse(retryPayload || "{}") as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? "";
    expect(outlookRetryText).toContain('"You will get"');
    expect(outlookRetryText).toContain('"yoga"');
    const health = complete.timeline.life_outlook.life_outlook_2?.domains.find((d) => d.domain === "health");
    expect(health?.outlook.layman).toBe("Steady sleep habits support daily energy.");
    expect(health?.lean_into).toBe("Gentle morning stretching.");
    expect(health?.outlook.layman).not.toBe(READING_WITHHELD.en);
  });

  it("mergeCleanSectionLeaves keeps already-clean paragraphs if retry regresses into jargon", () => {
    const first = JSON.stringify({
      summary: { layman: "Clear everyday summary.", technical: "Mars in 10th." },
      health_guidance: { layman: "A tired mind is a sign to rest.", technical: "6th house." },
    });
    const regressedRetry = JSON.stringify({
      summary: { layman: "Mars makes your house strong.", technical: "Mars in 10th." },
      health_guidance: { layman: "A tired mind is a clear clue to rest.", technical: "6th house." },
    });
    expect(JSON.parse(mergeCleanSectionLeaves(first, regressedRetry))).toEqual({
      summary: { layman: "Clear everyday summary.", technical: "Mars in 10th." },
      health_guidance: { layman: "A tired mind is a clear clue to rest.", technical: "6th house." },
    });
  });

  it("withholds a reflection-failing layman leaf instead of crashing timeline when retry strips to empty", async () => {
    let roadCalls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (!String(init.body).includes("SECTION:upcoming_periods")) {
        return jsonOf({ current_sky: [{ title: "Now", layman: "Steady focus helps.", technical: "Saturn." }] });
      }
      roadCalls += 1;
      return jsonOf({
        upcoming_periods: [
          {
            title: "Saturn antardasha — 2027-01 to 2028-01",
            layman: roadCalls === 1 ? "You will get married in 2027." : "Saturn rules your house.",
            technical: "Saturn in the 10th house.",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const events: CurrentTimelineEvent[] = [];
    for await (const ev of streamCurrentTimeline({ chart, config, fetchImpl })) events.push(ev);
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("expected timeline completion");

    expect(roadCalls).toBe(2);
    expect(complete.timeline.upcoming_periods[0]?.layman).toBe(READING_WITHHELD.en);
  });

  it("adopts a partial plain-language retry when it leaves surviving sentences over an all-jargon first reply", () => {
    const first = JSON.stringify({
      summary: { layman: "Saturn rules this house.", technical: "Saturn." },
    });
    const partialRetry = JSON.stringify({
      summary: { layman: "Steady daily habits build calm. Your house is busy.", technical: "Saturn." },
    });
    expect(JSON.parse(mergeCleanSectionLeaves(first, partialRetry))).toEqual({
      summary: { layman: "Steady daily habits build calm. Your house is busy.", technical: "Saturn." },
    });
  });

  it("ignores Object.prototype properties when retry omits keys", () => {
    const first = '{"__proto__":{"layman":"You will get rich."},"constructor":{"layman":"Clear."},"toString":"Steady."}';
    const merged = JSON.parse(mergeCleanSectionLeaves(first, "{}")) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(merged, "__proto__")).toBe(true);
    expect(merged["constructor"]).toEqual({ layman: "Clear." });
    expect(merged["toString"]).toBe("Steady.");
  });
});
