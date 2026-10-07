import { describe, expect, it, vi } from "vitest";

import type { SiderealChart } from "@almamesh/browser/types";

import golden from "../../../../../backend/tests/fixtures/chart_golden_de421.json";
import type { ProviderConfig } from "../config";
import { streamChartChat } from "../index";

// A REAL engine chart from the golden fixture: exercises sanitize -> facts ->
// prompt -> single streaming pass on BOTH the cloud and local config.
const goldenCharts = golden as Record<string, SiderealChart>;
const [firstKey] = Object.keys(goldenCharts);
const realChart: SiderealChart = goldenCharts[firstKey];

const CLOUD_CFG: ProviderConfig = {
  engine: "openai-http",
  model: "deepseek/deepseek-v4-pro",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-secret",
};

const LOCAL_CFG: ProviderConfig = {
  engine: "openai-http",
  model: "llama3.1",
  privacyMode: "local_only",
  baseUrl: "http://localhost:11434/v1",
};

const NOW = new Date("2030-01-01T00:00:00.000Z");

function sseAnswer(...tokens: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const t of tokens) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const token of gen) out.push(token);
  return out;
}

describe("streamChartChat — cloud path is a SINGLE streaming pass (no blocking pre-call)", () => {
  it("invokes fetch EXACTLY ONCE with stream:true and yields the tokens", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return sseAnswer("Your Mars ", "is exalted.");
    });

    const tokens = await collect(
      streamChartChat({
        chart: realChart,
        question: "Where is my Mars?",
        config: CLOUD_CFG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: NOW },
      }),
    );

    // Tokens streamed straight through.
    expect(tokens.join("")).toBe("Your Mars is exalted.");
    // Exactly one HTTP call — proves there is NO blocking non-streaming decision pass.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(bodies[0]);
    expect(body.stream).toBe(true);
    // No tool plumbing rides anymore.
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("rides the engine FACTS block, not a raw chart JSON dump", async () => {
    let body = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return sseAnswer("ok");
    });
    await collect(
      streamChartChat({
        chart: realChart,
        question: "Tell me about my chart.",
        config: CLOUD_CFG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: NOW },
      }),
    );
    // The compact facts block, not the structural JSON keys.
    expect(body).not.toContain("ayanamsa_value");
    expect(body).not.toContain("nakshatra_pada");
  });

  it("never leaks identifiers on the cloud path (sanitized chart only)", async () => {
    let body = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return sseAnswer("ok");
    });
    await collect(
      streamChartChat({
        chart: realChart,
        question: "Tell me about my chart.",
        config: CLOUD_CFG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: NOW },
      }),
    );
    expect(body).not.toMatch(/chart_id|generated_at|calculation_timestamp/);
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("streamChartChat — local path is also a single streaming pass", () => {
  it("sends NO tools and streams directly (single request)", async () => {
    let body = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return sseAnswer("Local answer.");
    });
    const tokens = await collect(
      streamChartChat({
        chart: realChart,
        question: "Where is my Mars?",
        config: LOCAL_CFG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: NOW },
      }),
    );
    expect(tokens.join("")).toBe("Local answer.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(body);
    expect(parsed.stream).toBe(true);
    expect(parsed.tools).toBeUndefined();
  });
});

describe("streamChartChat — RAG retrievedContext threads through", () => {
  it("injects the retrieved context into the streamed request body", async () => {
    let body = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return sseAnswer("ok");
    });
    await collect(
      streamChartChat({
        chart: realChart,
        question: "And my career path?",
        config: CLOUD_CFG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        asOf: { basis: "chart", instant: NOW },
        retrievedContext: ["Earlier we discussed a Saturn return."],
      }),
    );
    expect(body).toContain("Earlier we discussed a Saturn return.");
    expect(body).toMatch(/Relevant earlier conversation/i);
  });
});
