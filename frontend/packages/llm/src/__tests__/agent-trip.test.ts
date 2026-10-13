import { describe, expect, it, vi } from "vitest";

import { LlmRequestError, streamAgentChat, type AgentTool, type AgentToolCallRecord } from "../index";
import type { ProviderConfig } from "../config";

const CONFIG: ProviderConfig = {
  engine: "openai-http",
  model: "test-model",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};
const NOW = new Date("2030-04-05T06:07:08.000Z");

function decision(message: Record<string, unknown>): Response {
  return Response.json({ choices: [{ message }] });
}

function call(id: string, name: string, argumentsJson = "{}"): Record<string, unknown> {
  return { id, type: "function", function: { name, arguments: argumentsJson } };
}

function streamed(text: string): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: AsyncGenerator<string>): Promise<string> {
  let output = "";
  for await (const token of stream) output += token;
  return output;
}

const TRIP_TOOL: AgentTool = {
  name: "get_trip_context",
  description: "This trip's period and place.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: () => ({ period: { start: "2019-05-01", end: "2019-05-31" }, place: { label: "Singapore", timezone: "Asia/Singapore" } }),
};

function bodies(fetchImpl: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

describe("streamAgentChat on a trip's first round", () => {
  it("sends tool_choice required on the first round only, then auto", async () => {
    let requests = 0;
    const fetchImpl = vi.fn(async () => ++requests === 1
      ? decision({ role: "assistant", content: null, tool_calls: [call("a", "get_trip_context")] })
      : decision({ role: "assistant", content: "Singapore, May 2019." }));
    const answer = await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "How was work?" }], tools: [TRIP_TOOL], now: NOW,
      firstRoundToolChoice: "required", fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(answer).toBe("Singapore, May 2019.");
    expect(bodies(fetchImpl).map((body) => body.tool_choice)).toEqual(["required", "auto"]);
  });

  it("keeps tool_choice required until every grounding tool has run, then auto", async () => {
    const TIMING: AgentTool = { ...TRIP_TOOL, name: "get_timing", execute: () => ({ data: { maha: [] } }) };
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      if (requests === 1) return decision({ role: "assistant", content: null, tool_calls: [call("a", "get_trip_context")] });
      if (requests === 2) return decision({ role: "assistant", content: null, tool_calls: [call("b", "get_timing", '{"section":"transits"}')] });
      return streamed("Grounded.");
    });
    // Two decision rounds is the budget (AGENT_LIMITS): the second stays required, then the final answer streams.
    await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [TRIP_TOOL, TIMING], now: NOW,
      firstRoundToolChoice: "required", requiredToolNames: ["get_trip_context", "get_timing", "not_registered"],
      fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(bodies(fetchImpl).map((body) => body.tool_choice)).toEqual(["required", "required", "none"]);
  });

  it("a first round that asks for more calls than the per-round cap still gets its second required round", async () => {
    const NATAL: AgentTool = { ...TRIP_TOOL, name: "get_natal_summary", execute: () => ({ lagna: "leo" }) };
    const TIMING: AgentTool = { ...TRIP_TOOL, name: "get_timing", execute: () => ({ data: {} }) };
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      if (requests === 1) return decision({ role: "assistant", content: null, tool_calls: [call("a", "get_natal_summary"), call("b", "get_trip_context"), call("c", "get_timing", '{"section":"transits"}')] });
      if (requests === 2) return decision({ role: "assistant", content: null, tool_calls: [call("d", "get_timing", '{"section":"transits"}')] });
      return streamed("Grounded.");
    });
    const calls: AgentToolCallRecord[] = [];
    await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [NATAL, TRIP_TOOL, TIMING], now: NOW,
      firstRoundToolChoice: "required", requiredToolNames: ["get_natal_summary", "get_trip_context", "get_timing"],
      onToolCall: (record) => calls.push(record), fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(bodies(fetchImpl).map((body) => body.tool_choice)).toEqual(["required", "required", "none"]);
    expect(calls.map((c) => c.toolName)).toEqual(["get_natal_summary", "get_trip_context", "get_timing"]);
  });

  it("a trip's grounding calls do not spend the model's own tool-call budget", async () => {
    const NATAL: AgentTool = { ...TRIP_TOOL, name: "get_natal_summary", execute: () => ({ lagna: "leo" }) };
    const TIMING: AgentTool = { ...TRIP_TOOL, name: "get_timing", execute: (args) => ({ section: args.section }) };
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      if (requests === 1) return decision({ role: "assistant", content: null, tool_calls: [call("a", "get_natal_summary"), call("b", "get_trip_context")] });
      if (requests === 2) return decision({ role: "assistant", content: null, tool_calls: [call("c", "get_timing", '{"section":"domains"}'), call("d", "get_timing", '{"section":"transits"}')] });
      return streamed("Grounded.");
    });
    const calls: AgentToolCallRecord[] = [];
    await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [NATAL, TRIP_TOOL, TIMING], now: NOW,
      firstRoundToolChoice: "required", requiredToolNames: ["get_natal_summary", "get_trip_context", "get_timing"],
      onToolCall: (record) => calls.push(record), fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(calls.map((c) => [c.toolName, c.status])).toEqual([
      ["get_natal_summary", "complete"], ["get_trip_context", "complete"], ["get_timing", "complete"], ["get_timing", "complete"],
    ]);
  });

  it("a grounding call that returns an error does not count as run: the model may retry until it succeeds", async () => {
    let timingCalls = 0;
    const TIMING: AgentTool = { ...TRIP_TOOL, name: "get_timing", execute: () => (++timingCalls === 1 ? { error: "send either start/end or segments, not both" } : { data: { maha: [] } }) };
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      if (requests === 1) return decision({ role: "assistant", content: null, tool_calls: [call("a", "get_trip_context"), call("b", "get_timing", '{"section":"transits","start":"x"}')] });
      if (requests === 2) return decision({ role: "assistant", content: null, tool_calls: [call("c", "get_timing", '{"section":"transits"}')] });
      return streamed("Grounded.");
    });
    const calls: AgentToolCallRecord[] = [];
    const answer = await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [TRIP_TOOL, TIMING], now: NOW,
      firstRoundToolChoice: "required", requiredToolNames: ["get_trip_context", "get_timing"],
      onToolCall: (record) => calls.push(record), fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(answer).toBe("Grounded.");
    expect(bodies(fetchImpl).map((body) => body.tool_choice)).toEqual(["required", "required", "none"]);
    expect(calls.map((c) => c.status)).toEqual(["complete", "complete", "complete"]);
    expect(calls.map((c) => c.toolName)).toEqual(["get_trip_context", "get_timing", "get_timing"]);
  });

  it("retries are bounded; if timing never succeeds the final answer is told to say so plainly", async () => {
    const TIMING: AgentTool = { ...TRIP_TOOL, name: "get_timing", execute: () => ({ error: "engine unavailable" }) };
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      if (requests <= 4) return decision({ role: "assistant", content: null, tool_calls: [call(`t${requests}`, "get_timing", `{"section":"transits","n":${requests}}`)] });
      return streamed("I could not read the transits for that month.");
    });
    await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [TRIP_TOOL, TIMING], now: NOW,
      firstRoundToolChoice: "required", requiredToolNames: ["get_timing"], fetchImpl: fetchImpl as typeof fetch,
    }));
    const all = bodies(fetchImpl);
    expect(all.length).toBeLessThanOrEqual(5);
    expect(all.at(-1)?.tool_choice).toBe("none");
    const finalMessages = all.at(-1)?.messages as Array<{ role: string; content: string }>;
    expect(finalMessages.some((m) => m.role === "system" && m.content.includes("get_timing did not succeed"))).toBe(true);
  });

  it("once the grounding tools have run, the next round is auto", async () => {
    let requests = 0;
    const fetchImpl = vi.fn(async () => ++requests === 1
      ? decision({ role: "assistant", content: null, tool_calls: [call("a", "get_trip_context")] })
      : decision({ role: "assistant", content: "Done." }));
    await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [TRIP_TOOL], now: NOW,
      firstRoundToolChoice: "required", requiredToolNames: ["get_trip_context"], fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(bodies(fetchImpl).map((body) => body.tool_choice)).toEqual(["required", "auto"]);
  });

  it("defaults to auto when no first-round choice is given", async () => {
    const fetchImpl = vi.fn(async () => decision({ role: "assistant", content: "Hi." }));
    await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Hi" }], tools: [TRIP_TOOL], now: NOW, fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(bodies(fetchImpl)[0]?.tool_choice).toBe("auto");
  });

  it("reports every executed call with its args and the sanitized value the model got", async () => {
    let requests = 0;
    const fetchImpl = vi.fn(async () => ++requests === 1
      ? decision({ role: "assistant", content: null, tool_calls: [call("a", "get_trip_context"), call("b", "missing_tool")] })
      : streamed("Done."));
    const calls: AgentToolCallRecord[] = [];
    await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [TRIP_TOOL], now: NOW,
      onToolCall: (record) => calls.push(record), fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(calls).toEqual([
      { toolCallId: "a", toolName: "get_trip_context", args: {}, status: "complete",
        result: { period: { start: "2019-05-01", end: "2019-05-31" }, place: { label: "Singapore", timezone: "Asia/Singapore" } } },
      { toolCallId: "b", toolName: "missing_tool", args: {}, status: "error",
        result: { code: "unknown_tool", message: "The requested tool is not allowlisted." } },
    ]);
    // The model got exactly what the UI shows.
    const toolMessage = (bodies(fetchImpl)[1]?.messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
    expect(JSON.parse(toolMessage!.content)).toEqual({ ok: true, value: calls[0]!.result });
  });

  it("when tool_choice required is refused, runs the grounding tool itself and hands it over as a tool result", async () => {
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      if (requests === 1) {
        return new Response('{"error":"tool_choice required is not supported by this model"}', { status: 400, statusText: "Bad Request" });
      }
      return decision({ role: "assistant", content: "From the trip context." });
    });
    const calls: AgentToolCallRecord[] = [];
    const answer = await collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "system", content: "S" }, { role: "user", content: "Q" }], tools: [TRIP_TOOL], now: NOW,
      firstRoundToolChoice: "required", groundingToolName: "get_trip_context",
      onToolCall: (record) => calls.push(record), fetchImpl: fetchImpl as typeof fetch,
    }));
    expect(answer).toBe("From the trip context.");
    const second = bodies(fetchImpl)[1]!;
    expect(second.tool_choice).toBe("auto");
    const messages = second.messages as Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>;
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toHaveLength(1);
    const result = messages.find((m) => m.role === "tool");
    expect(JSON.parse(result!.content).value.place.label).toBe("Singapore");
    // Not prompt text: no system/user message carries the trip facts.
    expect(messages.filter((m) => m.role !== "tool").some((m) => String(m.content ?? "").includes("Singapore"))).toBe(false);
    expect(calls.map((c) => c.toolName)).toEqual(["get_trip_context"]);
  });

  it("a grounding tool that is not registered is a programming error", async () => {
    await expect(collect(streamAgentChat({
      config: CONFIG, messages: [{ role: "user", content: "Q" }], tools: [TRIP_TOOL], now: NOW,
      firstRoundToolChoice: "required", groundingToolName: "nope", fetchImpl: vi.fn() as unknown as typeof fetch,
    }))).rejects.toBeInstanceOf(LlmRequestError);
  });
});
