import { describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "../config";
import {
  REPORT_PROMPT_SET,
  REPORT_PROVIDER_ROUTING,
  REPORT_SECTION_REASONING_MAX_TOKENS,
  SECTION_REASONING_MAX_TOKENS,
  streamNatalInterpretation,
  streamReportTimeline,
  type ReportTimelineEvent,
} from "../index";
import { REPORT_AS_OF, REPORT_RAW_CHART } from "./report-fixture";

const OPENROUTER: ProviderConfig = {
  engine: "openai-http", model: "deepseek/deepseek-v4.1-flash", privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
};
const LOCAL: ProviderConfig = {
  engine: "openai-http", model: "gemma3:4b", privacyMode: "local_only", baseUrl: "http://localhost:11434/v1",
};

const p = (text: string) => ({ layman: text, technical: text });
// As-of month is 2026-06 (REPORT_AS_OF), so Q1 = 2026-06..08.
// Each timeline section carries one invented month that is in none of the four
// engine input slices (2031-01, 2041-03), in the layman voice or the technical one,
// so each section's date guard is proven separately.
const REPLIES: Record<string, unknown> = {
  current_period: {
    maha: { layman: "Steady building. A shift arrives in March 2041.", technical: "Steady building." },
    antar: p("A learning sub-chapter."), activates: [], next_change: p("A change comes.") },
  year_ahead: {
    headline: p("A year of consolidation."),
    quarters: [
      { key: "Q1", layman: "Settle in.", technical: "Fine. Invented window 2031-01 for Saturn." },
      { key: "Q2", ...p("Q2.") }, { key: "Q3", ...p("Q3.") }, { key: "Q4", ...p("Q4.") },
    ],
    focus: p("Rest."),
  },
  life_outlook_1: {
    domains: ["career", "finances", "relationships", "family"].map((domain) => ({
      domain,
      outlook: domain === "career" ? { layman: "career.", technical: "career. Jupiter peaks in 2041-03." } : p(`${domain}.`),
    })),
  },
  life_outlook_2: {
    domains: ["health", "education", "spiritual"].map((domain) => ({
      domain,
      outlook: domain === "health" ? { layman: "health. Rest well in 2041-03.", technical: "health." } : p(`${domain}.`),
    })),
  },
  core: { summary: p("Natal."), strengths: [], challenges: [], life_themes: [] },
  yoga: { integrated_yoga_narrative: p("Yoga.") },
  guidance1: { family_guidance: p("Home.") },
  guidance2: {},
  remedial: { remedial_measures: p("Walk.") },
};

const sectionOf = (body: string) => /SECTION:([a-z0-9_]+)/.exec(body)?.[1] ?? "";

function stubFetch(log: { section: string; body: Record<string, unknown> }[], replies = REPLIES) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const section = sectionOf(String(init.body));
    log.push({ section, body });
    const content = JSON.stringify(replies[section]);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<ReportTimelineEvent>): Promise<ReportTimelineEvent[]> {
  const out: ReportTimelineEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("streamReportTimeline", () => {
  it("runs the four timeline sections and completes with the as-of month", async () => {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log) }));
    expect(log.map((r) => r.section).sort()).toEqual(["current_period", "life_outlook_1", "life_outlook_2", "year_ahead"]);
    const complete = events.find((e) => e.type === "complete");
    expect(complete?.type).toBe("complete");
    if (complete?.type !== "complete") return;
    expect(complete.asOfMonth).toBe("2026-06");
    expect(complete.timeline.life_outlook.life_outlook_1?.domains.map((d) => d.domain)).toEqual([
      "career", "finances", "relationships", "family",
    ]);
    expect(complete.timeline.life_outlook.life_outlook_2?.domains.map((d) => d.domain)).toEqual([
      "health", "education", "spiritual",
    ]);
  });

  it("removes the invented month from every timeline section and counts each", async () => {
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch([]) }));
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    expect(complete.dateGuardRemovals).toBe(4);
    const { current_period, year_ahead, life_outlook } = complete.timeline;
    // current_period, layman voice
    expect(current_period?.maha.layman).toBe("Steady building.");
    // year_ahead, technical voice
    expect(year_ahead?.quarters[0].technical).toBe("Fine.");
    // life_outlook_1, technical voice
    expect(life_outlook.life_outlook_1?.domains[0].outlook.technical).toBe("career.");
    // life_outlook_2, layman voice
    expect(life_outlook.life_outlook_2?.domains[0].outlook.layman).toBe("health.");
  });

  it("starts no further section after an abort on a local endpoint", async () => {
    const controller = new AbortController();
    const sections: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const section = sectionOf(String(init.body));
      sections.push(section);
      controller.abort();
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLIES[section]) } }] }));
    }) as unknown as typeof fetch;
    await expect(
      collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: LOCAL, fetchImpl, signal: controller.signal })),
    ).rejects.toThrow(/aborted/);
    await new Promise((r) => setTimeout(r, 10));
    expect(sections).toEqual(["current_period"]);
  });

  it("fails only year_ahead when the model invents a quarter key", async () => {
    const replies = { ...REPLIES, year_ahead: { headline: p("h"), quarters: [{ key: "Q9", ...p("x") }] } };
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch([], replies) }));
    expect(events.filter((e) => e.type === "error").map((e) => e.type === "error" && e.section)).toEqual(["year_ahead"]);
    const complete = events.find((e) => e.type === "complete");
    expect(complete?.type === "complete" && complete.timeline.year_ahead).toBeNull();
  });

  it("marks a failed outlook call as null, keeping the other", async () => {
    const replies = { ...REPLIES, life_outlook_2: { domains: [{ domain: "career", outlook: p("x") }] } };
    const events = await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch([], replies) }));
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("no complete event");
    expect(complete.timeline.life_outlook.life_outlook_2).toBeNull();
    expect(complete.timeline.life_outlook.life_outlook_1?.domains).toHaveLength(4);
  });

  it("caps reasoning at 6,000 tokens on every report section", async () => {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log) }));
    for await (const _ of streamNatalInterpretation({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log), promptSet: REPORT_PROMPT_SET })) {
      // drain
    }
    expect(REPORT_SECTION_REASONING_MAX_TOKENS).toBe(6000);
    expect(log).toHaveLength(9);
    for (const row of log) expect(row.body.reasoning).toEqual({ max_tokens: 6000 });
    expect(log.every((row) => !("max_tokens" in row.body))).toBe(true);
  });

  async function allReportBodies(config: ProviderConfig, streamed = false) {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    const progress = streamed ? { onSectionProgress: () => undefined } : {};
    await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config, fetchImpl: stubFetch(log), ...progress }));
    for await (const _ of streamNatalInterpretation({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config, fetchImpl: stubFetch(log), promptSet: REPORT_PROMPT_SET, ...progress })) {
      // drain
    }
    return log;
  }

  it("asks OpenRouter for the cheapest provider on every report section", async () => {
    expect(REPORT_PROVIDER_ROUTING).toEqual({ sort: "price", preferred_min_throughput: { p50: 25 } });
    for (const streamed of [false, true]) {
      const log = await allReportBodies(OPENROUTER, streamed);
      expect(log).toHaveLength(9);
      for (const row of log) expect(row.body.provider).toEqual({ sort: "price", preferred_min_throughput: { p50: 25 } });
    }
  });

  it("sends no provider field to a local or a non-OpenRouter endpoint", async () => {
    const other: ProviderConfig = { ...OPENROUTER, baseUrl: "https://api.together.xyz/v1" };
    for (const config of [LOCAL, other]) {
      const log = await allReportBodies(config);
      expect(log).toHaveLength(9);
      expect(log.every((row) => !("provider" in row.body))).toBe(true);
    }
  });

  it("sends no provider field on legacy natal calls, even on OpenRouter", async () => {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    for await (const _ of streamNatalInterpretation({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log) })) {
      // drain
    }
    expect(log.length).toBeGreaterThan(0);
    for (const row of log) expect(Object.keys(row.body)).toEqual(["model", "messages", "stream", "response_format", "reasoning"]);
  });

  it("leaves legacy natal calls at the 12,000 cap", async () => {
    const log: { section: string; body: Record<string, unknown> }[] = [];
    for await (const _ of streamNatalInterpretation({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl: stubFetch(log) })) {
      // drain
    }
    expect(SECTION_REASONING_MAX_TOKENS).toBe(12000);
    for (const row of log) expect(row.body.reasoning).toEqual({ max_tokens: 12000 });
  });

  it("on a local endpoint runs one request at a time, life_outlook last", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const section = sectionOf(String(init.body));
      order.push(section);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLIES[section]) } }] }));
    }) as unknown as typeof fetch;
    await collect(streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: LOCAL, fetchImpl }));
    expect(order).toEqual(["current_period", "year_ahead", "life_outlook_1", "life_outlook_2"]);
    expect(maxInFlight).toBe(1);
  });

  it("reports progress per report section when streaming", async () => {
    const seen = new Set<string>();
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const content = JSON.stringify(REPLIES[sectionOf(String(init.body))]);
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(encoder.encode(sse), { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    await collect(streamReportTimeline({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl,
      onSectionProgress: (section) => seen.add(section),
    }));
    expect([...seen].sort()).toEqual(["current_period", "life_outlook_1", "life_outlook_2", "year_ahead"]);
  });
});
