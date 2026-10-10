import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "../config";
import {
  REPORT_PROMPT_SET,
  REPORT_SECTION_IDLE_TIMEOUT_MS,
  REPORT_SECTION_TIMEOUT_MS,
  SectionTimeoutError,
  streamNatalInterpretation,
  streamReportTimeline,
  type NatalInterpretationEvent,
  type ReportTimelineEvent,
} from "../index";
import { REPORT_AS_OF, REPORT_RAW_CHART } from "./report-fixture";

// A live run once hung for 40 minutes on a stalled provider. Every report
// section now has time caps: remote = a total wall-clock cap + an idle cap on
// the streamed path; local = the idle cap only (a weak device that is still
// writing must never be cut off). A hit fails only that section.

const OPENROUTER: ProviderConfig = {
  engine: "openai-http", model: "deepseek/deepseek-v4-pro", privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
};
const LOCAL: ProviderConfig = {
  engine: "openai-http", model: "gemma3:4b", privacyMode: "local_only", baseUrl: "http://localhost:11434/v1",
};

const p = (text: string) => ({ layman: text, technical: text });
const REPLIES: Record<string, unknown> = {
  current_period: { maha: p("Steady."), antar: p("Learning."), activates: [], next_change: p("A change comes.") },
  year_ahead: {
    headline: p("Consolidation."),
    quarters: ["Q1", "Q2", "Q3", "Q4"].map((key) => ({ key, ...p(`${key}.`) })),
    focus: p("Rest."),
  },
  life_outlook_1: {
    domains: ["career", "finances", "relationships", "family"].map((domain) => ({ domain, outlook: p(`${domain}.`) })),
  },
  life_outlook_2: {
    domains: ["health", "education", "spiritual"].map((domain) => ({ domain, outlook: p(`${domain}.`) })),
  },
  core: { summary: p("Natal."), strengths: [], challenges: [], life_themes: [] },
  yoga: { integrated_yoga_narrative: p("Yoga.") },
  guidance1: { family_guidance: p("Home.") },
  guidance2: {},
  remedial: { remedial_measures: p("Walk.") },
};

const sectionOf = (init: RequestInit) => /SECTION:([a-z0-9_]+)/.exec(String(init.body))?.[1] ?? "";
const sse = (chunk: Record<string, unknown> | "[DONE]") =>
  `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`;
const delta = (content: string) => sse({ choices: [{ index: 0, delta: { content } }] });
const SSE_HEADERS = { "Content-Type": "text/event-stream" };

function jsonReply(section: string): Response {
  const content = JSON.stringify(REPLIES[section]);
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Headers arrive, then `sent` deltas, then nothing ever again. */
function stalledStream(sent: readonly string[] = []): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of sent) controller.enqueue(encoder.encode(delta(text)));
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

/** The section's reply split into `pieces` deltas, one every `gapMs`. */
function slowStream(section: string, pieces: number, gapMs: number): Response {
  const text = JSON.stringify(REPLIES[section]);
  const size = Math.ceil(text.length / pieces);
  const encoder = new TextEncoder();
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      if (at >= text.length) {
        controller.enqueue(encoder.encode(sse("[DONE]")));
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(delta(text.slice(at, at + size))));
      at += size;
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

type Answer = (init: RequestInit) => Response | Promise<Response>;

function fetchWith(answers: Partial<Record<string, Answer>>) {
  const signals = new Map<string, AbortSignal | undefined>();
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const section = sectionOf(init);
    signals.set(section, init.signal ?? undefined);
    const answer = answers[section];
    return answer ? answer(init) : jsonReply(section);
  }) as unknown as typeof fetch;
  return { fetchImpl, signals };
}

const never = (): Promise<Response> => new Promise<Response>(() => undefined);

async function collect<E>(gen: AsyncGenerator<E>): Promise<E[]> {
  const out: E[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

type AnyEvent = ReportTimelineEvent | NatalInterpretationEvent;
const errorsOf = (events: readonly AnyEvent[]) => events.filter((e) => e.type === "error");
const completed = (events: readonly AnyEvent[]) =>
  events.filter((e) => e.type === "section_complete").map((e) => ("section" in e ? e.section : ""));
const progress = () => undefined;

afterEach(() => {
  vi.useRealTimers();
});

describe("report section time caps", () => {
  it("remote: a stalled stream fails that section with an idle timeout; the rest complete", async () => {
    const { fetchImpl, signals } = fetchWith({ year_ahead: () => stalledStream() });
    const events = await collect(streamReportTimeline({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl,
      onSectionProgress: progress, sectionIdleTimeoutMs: 40, sectionTimeoutMs: 5_000,
    }));
    const [error] = errorsOf(events);
    expect(errorsOf(events)).toHaveLength(1);
    expect(error).toMatchObject({ section: "year_ahead" });
    const timeout = error.type === "error" ? error.timeout : undefined;
    expect(timeout).toBeInstanceOf(SectionTimeoutError);
    expect(timeout).toMatchObject({ name: "SectionTimeoutError", kind: "idle", limitMs: 40 });
    expect(completed(events).sort()).toEqual(["current_period", "life_outlook_1", "life_outlook_2"]);
    expect(signals.get("year_ahead")?.aborted).toBe(true);
    expect(events.at(-1)?.type).toBe("complete");
  });

  it("remote: a never-resolving non-streamed fetch fails with a total timeout within the cap", async () => {
    const { fetchImpl, signals } = fetchWith({ current_period: never });
    const started = Date.now();
    const events = await collect(streamReportTimeline({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl, sectionTimeoutMs: 50,
    }));
    expect(Date.now() - started).toBeLessThan(2_000);
    const [error] = errorsOf(events);
    expect(error).toMatchObject({ section: "current_period" });
    expect(error.type === "error" ? error.timeout : undefined).toMatchObject({ kind: "total", limitMs: 50 });
    expect(signals.get("current_period")?.aborted).toBe(true);
    expect(completed(events)).toHaveLength(3);
  });

  it("remote: the report natal set is capped too, and the message carries no prompt text", async () => {
    const { fetchImpl } = fetchWith({ core: never });
    const events = await collect(streamNatalInterpretation({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl,
      promptSet: REPORT_PROMPT_SET, sectionTimeoutMs: 50,
    }));
    const [error] = errorsOf(events);
    expect(error).toMatchObject({ section: "core" });
    expect(error.type === "error" ? error.timeout : undefined).toMatchObject({ kind: "total" });
    expect(error.type === "error" ? error.message : "").toBe("Section timed out: no result within 50 ms");
    expect(completed(events)).toHaveLength(4);
  });

  it("local: a slow stream that keeps writing outlives the remote total cap and completes", async () => {
    const { fetchImpl } = fetchWith({
      current_period: () => slowStream("current_period", 6, 30),
      year_ahead: () => slowStream("year_ahead", 6, 30),
    });
    const events = await collect(streamReportTimeline({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: LOCAL, fetchImpl,
      onSectionProgress: progress, sectionIdleTimeoutMs: 100, sectionTimeoutMs: 60,
    }));
    expect(errorsOf(events)).toEqual([]);
    expect(completed(events)).toEqual(["current_period", "year_ahead", "life_outlook_1", "life_outlook_2"]);
  });

  it("local: a stream that stalls past the idle limit fails with an idle timeout", async () => {
    const { fetchImpl } = fetchWith({ current_period: () => stalledStream(["{\"maha\":"]) });
    const events = await collect(streamReportTimeline({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: LOCAL, fetchImpl,
      onSectionProgress: progress, sectionIdleTimeoutMs: 40,
    }));
    const [error] = errorsOf(events);
    expect(error).toMatchObject({ section: "current_period" });
    expect(error.type === "error" ? error.timeout : undefined).toMatchObject({ kind: "idle", limitMs: 40 });
    expect(completed(events)).toEqual(["year_ahead", "life_outlook_1", "life_outlook_2"]);
  });

  it("a caller abort still aborts the run with an AbortError, not a timeout", async () => {
    const controller = new AbortController();
    const { fetchImpl, signals } = fetchWith({
      year_ahead: (init) => new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    setTimeout(() => controller.abort(), 30);
    const run = collect(streamReportTimeline({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl,
      signal: controller.signal, sectionTimeoutMs: 5_000,
    }));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(signals.get("year_ahead")?.aborted).toBe(true);
  });

  it("legacy (non-report) natal sections keep their old behaviour: no cap", async () => {
    const controller = new AbortController();
    const { fetchImpl, signals } = fetchWith({ core: never });
    const run = collect(streamNatalInterpretation({
      chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl,
      signal: controller.signal, sectionTimeoutMs: 20,
    }));
    const settled = await Promise.race([run.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("open"), 150))]);
    expect(settled).toBe("open");
    expect(signals.get("core")).toBe(controller.signal);
    controller.abort();
  });

  it("defaults: a remote section is cut at exactly 300 s", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = fetchWith({ current_period: never });
    const events: ReportTimelineEvent[] = [];
    const run = (async () => {
      for await (const e of streamReportTimeline({ chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: OPENROUTER, fetchImpl })) {
        events.push(e);
      }
    })();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(errorsOf(events)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(errorsOf(events)[0]).toMatchObject({ section: "current_period", timeout: { kind: "total", limitMs: 300_000 } });
  });

  it("defaults: a local streamed section idles out at exactly 120 s", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = fetchWith({ current_period: () => stalledStream() });
    const events: ReportTimelineEvent[] = [];
    const run = (async () => {
      for await (const e of streamReportTimeline({
        chart: REPORT_RAW_CHART, asOf: REPORT_AS_OF, config: LOCAL, fetchImpl, onSectionProgress: progress,
      })) {
        events.push(e);
      }
    })();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(errorsOf(events)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(errorsOf(events)[0]).toMatchObject({ section: "current_period", timeout: { kind: "idle", limitMs: 120_000 } });
  });

  it("pins the promised literal values", () => {
    expect(REPORT_SECTION_TIMEOUT_MS).toBe(300_000);
    expect(REPORT_SECTION_IDLE_TIMEOUT_MS).toBe(120_000);
  });
});
