// The agent loop's context budget (spec 2026-10-13, "Context budget for the agentic loop").
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_LIMITS,
  estimateRequestTokens,
  streamAgentChat,
  type AgentRoundUsage,
  type AgentTool,
  type StreamAgentChatOptions,
} from "../index";
import type { ProviderConfig } from "../config";

const CONFIG: ProviderConfig = {
  engine: "openai-http",
  model: "test-model",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};
const NOW = new Date("2030-04-05T06:07:08.000Z");

interface Body {
  readonly messages: ReadonlyArray<{ role: string; content?: string | null; tool_call_id?: string; tool_calls?: ReadonlyArray<{ id: string }> }>;
  readonly tools?: readonly unknown[];
  readonly tool_choice?: string;
}

function call(id: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function decision(toolCalls: readonly Record<string, unknown>[], usage?: Record<string, number>): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls } }], ...(usage ? { usage } : {}) });
}

function streamed(text: string, usage?: Record<string, number>): Response {
  const encoder = new TextEncoder();
  const chunks = [{ choices: [{ delta: { content: text } }] }, ...(usage ? [{ choices: [], usage }] : [])];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }));
}

async function collect(stream: AsyncGenerator<string>): Promise<string> {
  let output = "";
  for await (const token of stream) output += token;
  return output;
}

function lookup(name: string, value: (args: Record<string, unknown>) => unknown): AgentTool {
  return {
    name,
    description: `Look up ${name}.`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn((args) => value(args as Record<string, unknown>)),
  };
}

/** Runs a turn against a scripted provider; `script(n, body)` answers the n-th request (1-based). */
async function run(
  script: (n: number, body: Body) => Response,
  options: Partial<StreamAgentChatOptions> & Pick<StreamAgentChatOptions, "tools">,
): Promise<{ bodies: Body[]; answer: string }> {
  const bodies: Body[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    return script(bodies.length, body);
  });
  const answer = await collect(streamAgentChat({
    config: CONFIG,
    messages: [{ role: "system", content: "System." }, { role: "user", content: "Question." }],
    now: NOW,
    fetchImpl: fetchImpl as typeof fetch,
    ...options,
  }));
  return { bodies, answer };
}

function toolMessages(body: Body) {
  return body.messages.filter((message) => message.role === "tool");
}

function promptTokens(body: Body): number {
  return estimateRequestTokens(body.messages, body.tools ?? []);
}

function expectPaired(body: Body): void {
  const answered = new Set(toolMessages(body).map((message) => message.tool_call_id));
  for (const message of body.messages) {
    for (const toolCall of message.tool_calls ?? []) expect(answered.has(toolCall.id)).toBe(true);
  }
}

describe("in-turn compaction", () => {
  // Contract reversed 2026-10-13 (P1 acceptance drive): compaction used to be unconditional, so a
  // 1M-context model answered from one-line notes instead of the period reading it had fetched.
  it("a large budget keeps every consumed result in full through the final answer", async () => {
    const tools = [lookup("first", () => ({ text: "A".repeat(2_000), period: { label: "May 2019" } })), lookup("second", () => ({ text: "B".repeat(2_000) }))];
    const { bodies } = await run((n) => n === 1 ? decision([call("c1", "first")]) : n === 2 ? decision([call("c2", "second")]) : streamed("Done."), { tools, contextTokens: 1_000_000 });

    const final = bodies[2]!;
    expect(JSON.stringify(final.messages)).toContain("A".repeat(2_000));
    expect(JSON.stringify(final.messages)).toContain("B".repeat(2_000));
    expect(final.messages.some((message) => message.content?.includes('"compacted":true'))).toBe(false);
    for (const body of bodies) expectPaired(body);
  });

  it("under budget pressure consumed results go compact oldest first; the newest stays in full", async () => {
    const tools = ["a", "b"].map((name) => lookup(name, () => ({ text: name.repeat(3_000), period: { label: `${name} period` } })));
    const { bodies } = await run((n, body) => body.tool_choice === "none" ? streamed("Done.") : decision([call(`c${n}`, n === 1 ? "a" : "b")]), {
      tools,
      contextTokens: 8_192,
      messages: [{ role: "system", content: "s".repeat(12_000) }, { role: "user", content: "Question." }],
    });

    const final = bodies.at(-1)!;
    expect(bodies).toHaveLength(3);
    expect(final.tool_choice).toBe("none");
    const byId = (id: string) => toolMessages(final).find((message) => message.tool_call_id === id)?.content ?? "";
    expect(JSON.parse(byId("c1"))).toMatchObject({ ok: true, compacted: true, facts: expect.stringContaining("a period") });
    expect(byId("c2")).toContain("b".repeat(3_000));
    for (const body of bodies) {
      expect(promptTokens(body)).toBeLessThanOrEqual(4_096);
      expectPaired(body);
    }
  });

  it("uses the tool's own summarize for the compact line", async () => {
    const tools = [
      { ...lookup("reading", () => ({ text: "A".repeat(2_000) })), summarize: () => ({ line: "Saturn antar, your 12th lord", factors: ["Sade Sati phase 1"] }) },
      lookup("other", () => ({ ok: 1 })),
    ];
    const { bodies } = await run((n, body) => body.tool_choice === "none" ? streamed("Done.") : decision([call(`c${n}`, n === 1 ? "reading" : "other")]), {
      tools,
      contextTokens: 8_192,
      messages: [{ role: "system", content: "s".repeat(14_500) }, { role: "user", content: "Question." }],
    });
    const compact = toolMessages(bodies.at(-1)!).find((message) => message.tool_call_id === "c1");
    expect(JSON.parse(compact?.content ?? "{}")).toEqual({ ok: true, compacted: true, facts: "Saturn antar, your 12th lord", factors: ["Sade Sati phase 1"] });
  });

  it("a round whose results pass the aggregate cap gets the overflow as its summary, not an error that ends the turn", async () => {
    const big = (label: string) => () => ({ text: label.repeat(7_000), period: { label } });
    const tools = [lookup("a", big("a")), lookup("b", big("b")), lookup("c", big("c"))];
    const { bodies } = await run((n) => n === 1 ? decision([call("1", "a"), call("2", "b"), call("3", "c")]) : streamed("Done."), { tools });
    const third = toolMessages(bodies[1]!).find((message) => message.tool_call_id === "3");
    expect(third?.content).not.toContain("aggregate_results_too_large");
    expect(JSON.parse(third?.content ?? "{}")).toMatchObject({ compacted: true, facts: expect.stringContaining("c") });
    expect(bodies[1]?.tool_choice).toBe("auto");
  });
});

describe("in-turn dedupe", () => {
  it("an identical successful call returns a pointer to the earlier result and the turn continues", async () => {
    const tool = lookup("lookup", () => ({ found: true }));
    const { bodies } = await run((n) => n === 1
      ? decision([call("a", "lookup", { x: 1, y: 2 }), call("b", "lookup", { y: 2, x: 1 })])
      : n === 2 ? decision([call("c", "lookup", { x: 3 })]) : streamed("Done."), { tools: [tool] });

    expect(tool.execute).toHaveBeenCalledTimes(2);
    const pointer = toolMessages(bodies[1]!).find((message) => message.tool_call_id === "b");
    expect(pointer?.content).toContain("unchanged; see the earlier result a");
    expect(pointer?.content).not.toContain("duplicate_tool_call");
    // Not forced final: the second request is still a decision round.
    expect(bodies[1]?.tool_choice).toBe("auto");
  });
});

describe("parallel-call bound", () => {
  it("pins the bound at 4 calls per round and 6 model calls per turn", () => {
    expect(AGENT_LIMITS.maxToolCallsPerRound).toBe(4);
    expect(AGENT_LIMITS.maxToolCalls).toBe(6);
    expect(AGENT_LIMITS.maxDecisionRounds).toBe(2);
  });

  it("calls past the bound get a short skipped result, keep their pairing, and do not end the turn", async () => {
    const tool = lookup("lookup", () => ({ found: true }));
    const calls = Array.from({ length: 6 }, (_, i) => call(`c${i}`, "lookup", { n: i }));
    const { bodies } = await run((n) => n === 1 ? decision(calls) : streamed("Done."), { tools: [tool] });

    expect(tool.execute).toHaveBeenCalledTimes(4);
    const second = bodies[1]!;
    expect(second.messages.find((message) => message.role === "assistant")?.tool_calls).toHaveLength(6);
    const skipped = toolMessages(second).filter((message) => message.content?.includes("skipped: too many calls this round"));
    expect(skipped.map((message) => message.tool_call_id)).toEqual(["c4", "c5"]);
    expect(second.tool_choice).toBe("auto");
    expectPaired(second);
  });
});

describe("stable prefix", () => {
  it("system prompt and tool schemas (sorted by name) are byte-identical across rounds and turns", async () => {
    const zeta = lookup("zeta", () => ({ ok: 1 }));
    const alpha = lookup("alpha", () => ({ ok: 2 }));
    const turn1 = await run((n) => n === 1 ? decision([call("c1", "zeta")]) : n === 2 ? decision([call("c2", "alpha")]) : streamed("One."), { tools: [zeta, alpha] });
    const turn2 = await run((n) => n === 1 ? decision([call("d1", "alpha")]) : streamed("Two."), { tools: [alpha, zeta] });

    const prefix = (body: Body) => JSON.stringify([body.messages[0], body.tools]);
    const all = [...turn1.bodies, ...turn2.bodies];
    for (const body of all) expect(prefix(body)).toBe(prefix(all[0]!));
    expect((all[0]?.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("per-turn token budget", () => {
  it("when the budget would be exceeded, one final round runs with tools off and says what it could not check", async () => {
    const tool = lookup("lookup", () => ({ text: "r".repeat(3_000) }));
    const system = "s".repeat(15_000);
    const { bodies, answer } = await run((n) => n === 1 ? decision([call("c1", "lookup")]) : streamed("Partial answer."), {
      tools: [tool],
      contextTokens: 8_192,
      messages: [{ role: "system", content: system }, { role: "user", content: "Question." }],
    });

    expect(answer).toBe("Partial answer.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.tool_choice).toBe("none");
    expect(JSON.stringify(bodies[1]?.messages)).toContain("could not check");
    // The final answer fits too: the newest round goes compact rather than overflowing.
    expect(promptTokens(bodies[1]!)).toBeLessThanOrEqual(4_096);
    expect(JSON.parse(toolMessages(bodies[1]!)[0]?.content ?? "{}")).toMatchObject({ compacted: true });
  });

  it("an 8k-context model still answers within budget after several tool rounds", async () => {
    const tools = ["natal", "period", "timing"].map((name) => lookup(name, () => ({ text: name.repeat(1_200), period: { label: `${name} facts` } })));
    const order = ["natal", "period", "timing"];
    const { bodies, answer } = await run((n) => n <= 3 ? decision([call(`c${n}`, order[n - 1]!)]) : streamed("Small model answer."), {
      tools,
      contextTokens: 8_192,
      firstRoundToolChoice: "required",
      requiredToolNames: order,
      messages: [{ role: "system", content: "s".repeat(6_000) }, { role: "user", content: "Question." }],
    });

    expect(answer).toBe("Small model answer.");
    expect(bodies.filter((body) => body.tool_choice !== "none").length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) {
      expect(promptTokens(body)).toBeLessThanOrEqual(4_096);
      expectPaired(body);
    }
  });

  it("when the budget closes a trip turn with a required grounding tool still missing, the loop runs it itself first", async () => {
    const natal = lookup("natal", () => ({ text: "n".repeat(8_000) }));
    const trip = lookup("trip", () => ({ place: { label: "Singapore" }, period: { label: "May 2019" } }));
    const { bodies } = await run((n) => n === 1 ? decision([call("c1", "natal")]) : streamed("Answer with the trip."), {
      tools: [natal, trip],
      contextTokens: 8_192,
      firstRoundToolChoice: "required",
      requiredToolNames: ["natal", "trip"],
      groundingCalls: [{ name: "natal", args: {} }, { name: "trip", args: {} }],
      messages: [{ role: "system", content: "s".repeat(8_000) }, { role: "user", content: "Question." }],
    });

    expect(trip.execute).toHaveBeenCalledTimes(1);
    expect(natal.execute).toHaveBeenCalledTimes(1);
    const final = bodies.at(-1)!;
    expect(final.tool_choice).toBe("none");
    expect(JSON.stringify(final.messages)).toContain("Singapore");
    expect(JSON.stringify(final.messages)).not.toContain("trip did not succeed");
    expect(promptTokens(final)).toBeLessThanOrEqual(4_096);
    expectPaired(final);
  });

  it("a 1M-context model keeps every result in full: nothing is compacted early", async () => {
    const tools = [lookup("a", () => ({ text: "A".repeat(4_000) })), lookup("b", () => ({ text: "B".repeat(4_000) }))];
    const { bodies } = await run((n) => n === 1 ? decision([call("1", "a"), call("2", "b")]) : streamed("Done."), { tools, contextTokens: 1_000_000 });
    expect(JSON.stringify(bodies[1]?.messages)).toContain("A".repeat(4_000));
    expect(JSON.stringify(bodies[1]?.messages)).toContain("B".repeat(4_000));
  });

  it("drops earlier conversation turns before giving up on tools when the window is small", async () => {
    const tool = lookup("lookup", () => ({ ok: true }));
    const history = Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", content: `turn ${i} ${"h".repeat(3_000)}` }));
    const { bodies } = await run((n) => n === 1 ? decision([call("c1", "lookup")]) : streamed("Done."), {
      tools: [tool],
      contextTokens: 8_192,
      messages: [{ role: "system", content: "System." }, ...history, { role: "user", content: "Latest question." }],
    });
    expect(bodies[0]?.tool_choice).toBe("auto");
    for (const body of bodies) {
      expect(promptTokens(body)).toBeLessThanOrEqual(4_096);
      expect(JSON.stringify(body.messages)).toContain("Latest question.");
    }
  });
});

describe("round telemetry", () => {
  it("reports each request's tokens, preferring the provider's usage, and calibrates later estimates by it", async () => {
    const rounds: AgentRoundUsage[] = [];
    const tool = lookup("lookup", () => ({ ok: true }));
    await run((n, body) => n === 1
      ? decision([call("c1", "lookup")], { prompt_tokens: promptTokens(body) * 3, completion_tokens: 7 })
      : streamed("Done."), { tools: [tool], contextTokens: 1_000_000, onRoundUsage: (usage) => rounds.push(usage) });

    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ round: 1, completion_tokens: 7, estimated: false, budget: 500_000, compacted: 0 });
    expect(rounds[0]!.prompt_tokens).toBe(rounds[0]!.estimate * 3);
    expect(rounds[1]).toMatchObject({ round: 2, estimated: true, completion_tokens: null, budget: 500_000, phase: "decision" });
    // The second estimate is calibrated by the first round's provider count (3x).
    expect(rounds[1]!.estimate).toBeGreaterThanOrEqual(rounds[0]!.estimate * 3);
    expect(rounds[1]!.prompt_tokens).toBe(rounds[1]!.estimate);
  });

  it("reads usage from the final SSE chunk of a streamed answer", async () => {
    const rounds: AgentRoundUsage[] = [];
    const tool = lookup("lookup", () => ({ ok: true }));
    await run(() => streamed("Direct.", { prompt_tokens: 123, completion_tokens: 4 }), { tools: [tool], onRoundUsage: (usage) => rounds.push(usage) });
    expect(rounds).toEqual([expect.objectContaining({ round: 1, phase: "decision", prompt_tokens: 123, completion_tokens: 4, estimated: false })]);
  });

  it("a throwing telemetry sink never changes the turn", async () => {
    const tool = lookup("lookup", () => ({ ok: true }));
    const { answer } = await run(() => streamed("Fine."), { tools: [tool], onRoundUsage: () => { throw new Error("sink"); } });
    expect(answer).toBe("Fine.");
  });
});
