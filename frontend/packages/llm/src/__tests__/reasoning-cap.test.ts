import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import type { ProviderConfig } from "../config";
import {
  CHAT_REASONING_MAX_TOKENS,
  LlmRequestError,
  REASONING_TIMEOUT_MS,
  ReasoningTimeoutError,
  SECTION_REASONING_MAX_TOKENS,
  streamAgentChat,
  streamCurrentTimeline,
  type CurrentTimelineEvent,
} from "../index";

// z-ai/glm-5.3-flash once reasoned for 20+ minutes on "The road ahead" without
// writing a word. Two guards: a per-request reasoning budget sent to
// OpenRouter (`reasoning.max_tokens`), and a wall-clock cap that aborts a
// stream which has produced no answer text after REASONING_TIMEOUT_MS. The cap
// is the real guard: live probes showed some upstreams ignore the budget.

const chart = (golden as Record<string, SiderealChart>)[Object.keys(golden)[0]];
const OPENROUTER: ProviderConfig = {
  engine: "openai-http",
  model: "z-ai/glm-5.3-flash",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};
const LOCAL: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const ROAD = JSON.stringify({
  upcoming_periods: [{ title: "Jupiter period", layman: "A season of growth.", technical: "Jupiter MD." }],
});
const SKY = JSON.stringify({ current_sky: [{ title: "Now", layman: "Active", technical: "Saturn" }] });

const encoder = new TextEncoder();
function sse(chunk: Record<string, unknown> | "[DONE]"): string {
  return `data: ${chunk === "[DONE]" ? chunk : JSON.stringify(chunk)}\n\n`;
}
const thought = (text: string) => sse({ choices: [{ delta: { reasoning: text } }] });
const said = (text: string) => sse({ choices: [{ delta: { content: text } }] });

/** A stream that thinks forever (one reasoning chunk every 5 ms) until cancelled. */
function endlessThinking(onCancel: () => void = () => undefined): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(encoder.encode(thought("hmm "))), 5);
    },
    cancel() {
      clearInterval(timer);
      onCancel();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/** Scripted SSE: each [delayMs, event] is sent `delayMs` after the previous one. */
function scripted(steps: ReadonlyArray<readonly [number, string]>): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [delay, event] of steps) {
        await new Promise((r) => setTimeout(r, delay));
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const isRoad = (init: RequestInit) => String(init.body).includes("SECTION:upcoming_periods");

function timelineFetch(road: ReadonlyArray<() => Response>) {
  const bodies: Array<Record<string, unknown>> = [];
  let roadCalls = 0;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (!isRoad(init)) return new Response(said(SKY) + sse("[DONE]"));
    const answer = road[Math.min(roadCalls, road.length - 1)];
    roadCalls += 1;
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, roadCalls: () => roadCalls };
}

async function collect(events: AsyncGenerator<CurrentTimelineEvent>): Promise<CurrentTimelineEvent[]> {
  const out: CurrentTimelineEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("reasoning cap: documented limits", () => {
  it("pins the thinking-time cap at 3 minutes and the reasoning budgets", () => {
    expect(REASONING_TIMEOUT_MS).toBe(180_000);
    expect(SECTION_REASONING_MAX_TOKENS).toBe(12_000);
    expect(CHAT_REASONING_MAX_TOKENS).toBe(6_000);
  });

  it("is a 504 LlmRequestError with the ai.reasoning_timeout code", () => {
    const err = new ReasoningTimeoutError(180_000);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect(err.name).toBe("ReasoningTimeoutError");
    expect(err.code).toBe("ai.reasoning_timeout");
    expect(err.status).toBe(504);
    expect(err.message).toBe("No answer after 180s of reasoning (ai.reasoning_timeout)");
  });
});

describe("reasoning cap: timeline sections", () => {
  it("sends the section reasoning budget to OpenRouter, streamed or not", async () => {
    const streamed = timelineFetch([() => new Response(said(ROAD) + sse("[DONE]"))]);
    await collect(
      streamCurrentTimeline({ chart, config: OPENROUTER, fetchImpl: streamed.fetchImpl, onSectionProgress: () => undefined }),
    );
    expect(streamed.bodies).toHaveLength(2);
    for (const body of streamed.bodies) expect(body.reasoning).toEqual({ max_tokens: 12_000 });

    const plain = vi.fn(async (_url: string, init: RequestInit) => {
      const content = isRoad(init) ? ROAD : SKY;
      return Response.json({ choices: [{ message: { content } }] });
    });
    await collect(streamCurrentTimeline({ chart, config: OPENROUTER, fetchImpl: plain as unknown as typeof fetch }));
    for (const [, init] of plain.mock.calls) {
      expect(JSON.parse(String(init.body)).reasoning).toEqual({ max_tokens: 12_000 });
    }
  });

  it("never sends the OpenRouter-only reasoning field to other endpoints", async () => {
    const { fetchImpl, bodies } = timelineFetch([() => new Response(said(ROAD) + sse("[DONE]"))]);
    await collect(streamCurrentTimeline({ chart, config: LOCAL, fetchImpl, onSectionProgress: () => undefined }));
    for (const body of bodies) expect(body).not.toHaveProperty("reasoning");
  });

  it("aborts a section that only thinks, retries once, then fails with ai.reasoning_timeout", async () => {
    let cancelled = 0;
    const { fetchImpl, roadCalls } = timelineFetch([() => endlessThinking(() => (cancelled += 1))]);
    const events = await collect(
      streamCurrentTimeline({
        chart,
        config: OPENROUTER,
        fetchImpl,
        onSectionProgress: () => undefined,
        reasoningTimeoutMs: 40,
      }),
    );
    expect(roadCalls()).toBe(2);
    expect(cancelled).toBe(2);
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({
      type: "error",
      section: "upcoming_periods",
      status: 504,
      message: "No answer after 0s of reasoning (ai.reasoning_timeout)",
    });
    expect(events.some((e) => e.type === "complete")).toBe(true);
  });

  it("completes when the retry answers after the first attempt timed out", async () => {
    const { fetchImpl, roadCalls } = timelineFetch([
      () => endlessThinking(),
      () => new Response(thought("quick") + said(ROAD) + sse("[DONE]")),
    ]);
    const events = await collect(
      streamCurrentTimeline({ chart, config: OPENROUTER, fetchImpl, onSectionProgress: () => undefined, reasoningTimeoutMs: 40 }),
    );
    expect(roadCalls()).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("missing completion");
    expect(complete.timeline.upcoming_periods[0]?.title).toBe("Jupiter period");
  });

  it("does not cut off an answer that started before the cap but finishes after it", async () => {
    const half = Math.floor(ROAD.length / 2);
    const { fetchImpl, roadCalls } = timelineFetch([
      () =>
        scripted([
          [5, thought("thinking")],
          [20, said(ROAD.slice(0, half))],
          [80, said(ROAD.slice(half))],
          [5, sse("[DONE]")],
        ]),
    ]);
    const events = await collect(
      streamCurrentTimeline({ chart, config: OPENROUTER, fetchImpl, onSectionProgress: () => undefined, reasoningTimeoutMs: 50 }),
    );
    expect(roadCalls()).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("reasoning cap: agent chat", () => {
  const chatOptions = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
    config: OPENROUTER,
    messages: [{ role: "user" as const, content: "What about my career?" }],
    tools: [
      {
        name: "get_current_datetime",
        description: "Read the pinned current time.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        statusLabel: "Checking the current time",
        execute: () => ({}),
      },
    ],
    now: new Date("2030-04-05T06:07:08.000Z"),
    fetchImpl,
    ...extra,
  });

  async function drain(gen: AsyncGenerator<string>): Promise<string> {
    let text = "";
    for await (const token of gen) text += token;
    return text;
  }

  it("sends the chat reasoning budget to OpenRouter", async () => {
    const fetchImpl = vi.fn(async () => new Response(said("Your tenth house.") + sse("[DONE]")));
    await drain(streamAgentChat(chatOptions(fetchImpl as unknown as typeof fetch)));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.reasoning).toEqual({ max_tokens: 6_000 });
  });

  it("aborts a chat turn that only thinks with ai.reasoning_timeout", async () => {
    let cancelled = 0;
    const fetchImpl = vi.fn(async () => endlessThinking(() => (cancelled += 1)));
    const run = drain(streamAgentChat(chatOptions(fetchImpl as unknown as typeof fetch, { reasoningTimeoutMs: 40 })));
    await expect(run).rejects.toBeInstanceOf(ReasoningTimeoutError);
    expect(cancelled).toBe(1);
  });
});
